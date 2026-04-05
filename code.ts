figma.showUI(__html__, { width: 360, height: 720 });

// ─── Init (async; dynamic-page documentAccess forbids sync getLocal*Styles) ─
void (async function sendInit(): Promise<void> {
  const [paintStyles, textStyles, effectStyles] = await Promise.all([
    figma.getLocalPaintStylesAsync(),
    figma.getLocalTextStylesAsync(),
    figma.getLocalEffectStylesAsync(),
  ]);
  figma.ui.postMessage({
    type: 'init',
    payload: {
      fileName:              figma.root.name,
      currentPageId:         figma.currentPage.id,
      currentPageName:       figma.currentPage.name,
      pages:                 figma.root.children.map(p => ({
        id: p.id, name: p.name, isCurrent: p.id === figma.currentPage.id,
      })),
      localPaintStyleCount:  paintStyles.length,
      localTextStyleCount:   textStyles.length,
      localEffectStyleCount: effectStyles.length,
      hasSelection:          figma.currentPage.selection.length > 0,
      selectionCount:        figma.currentPage.selection.length,
    },
  });
  void initLibraryStyles();
})();

figma.on('selectionchange', () => {
  figma.ui.postMessage({
    type: 'selection-changed',
    hasSelection: figma.currentPage.selection.length > 0,
  });
});

// ─── Style + variable cache ────────────────────────────────────────────────────
// Populated by initLibraryStyles (local + optional library imports).
// Reset via 'clear-cache' message when the designer changes library styles.
let cachedPaintStyles: PaintStyle[]  | null = null;
let cachedTextStyles:  TextStyle[]   | null = null;
let cachedColorVariables: Variable[] | null = null;
let cachedVariableColorIndex: VariableColorEntry[] | null = null;
let libraryStylesReady = false;

function postLibraryStylesReady(): void {
  figma.ui.postMessage({
    type: 'library-styles-ready',
    paintStyleCount:  cachedPaintStyles?.length ?? 0,
    textStyleCount:   cachedTextStyles?.length ?? 0,
    variableCount:    cachedColorVariables?.length ?? 0,
  });
}

async function initLibraryStyles(): Promise<void> {
  libraryStylesReady = false;
  const [localPaint, localText, localColorVars] = await Promise.all([
    figma.getLocalPaintStylesAsync(),
    figma.getLocalTextStylesAsync(),
    figma.variables.getLocalVariablesAsync('COLOR'),
  ]);
  cachedPaintStyles       = localPaint;
  cachedTextStyles        = localText;
  cachedColorVariables    = localColorVars;
  cachedVariableColorIndex = null;

  // Library paint styles
  const getLibStyles = (figma as PluginAPI & {
    getAvailableLibraryStylesAsync?: () => Promise<{ key: string; styleType: string }[]>;
  }).getAvailableLibraryStylesAsync;
  try {
    if (typeof getLibStyles === 'function') {
      const libPaintStyles = await getLibStyles.call(figma);
      const resolved = await Promise.all(
        (libPaintStyles || [])
          .filter(s => s.styleType === 'PAINT')
          .map(s => figma.importStyleByKeyAsync(s.key).catch(() => null)),
      );
      const freshPaint = resolved.filter((s): s is PaintStyle => s !== null && s.type === 'PAINT');
      const paintIds = new Set((cachedPaintStyles ?? []).map(s => s.id));
      cachedPaintStyles = [...(cachedPaintStyles ?? []), ...freshPaint.filter(s => !paintIds.has(s.id))];
    }
  } catch { /* Library styles unavailable */ }

  // Library color variables (the main path for design-system aliases / themes)
  // Uses figma.teamLibrary — returns ALL org-enabled library variable collections.
  // Requires those collections to be enabled in this file via the Libraries panel.
  try {
    const teamLib = figma.teamLibrary as typeof figma.teamLibrary | undefined;
    const getLibColls = teamLib?.getAvailableLibraryVariableCollectionsAsync?.bind(teamLib);
    const getLibVars  = teamLib?.getVariablesInLibraryCollectionAsync?.bind(teamLib);

    if (typeof getLibColls !== 'function' || typeof getLibVars !== 'function') {
      console.warn('[audit] figma.teamLibrary variable methods not available in this runtime');
    } else {
      const libColls = await getLibColls();
      console.log(`[audit] found ${libColls.length} library variable collection(s)`);
      const allImported: Variable[] = [];
      for (const col of libColls) {
        const libVars = await getLibVars(col.key);
        const colorKeys = libVars.filter(v => v.resolvedType === 'COLOR').map(v => v.key);
        console.log(`[audit] collection "${col.name}": ${colorKeys.length} COLOR variable(s)`);
        const resolved = await Promise.all(
          colorKeys.map(k => figma.variables.importVariableByKeyAsync(k).catch(() => null)),
        );
        allImported.push(...resolved.filter((v): v is Variable => v !== null));
      }
      const existingIds = new Set((cachedColorVariables ?? []).map(v => v.id));
      const freshVars = allImported.filter(v => !existingIds.has(v.id));
      cachedColorVariables = [...(cachedColorVariables ?? []), ...freshVars];
      console.log(`[audit] total color variables loaded: ${cachedColorVariables?.length ?? 0}`);
    }
  } catch (err) {
    console.error('[audit] library variable loading error:', err);
  }

  libraryStylesReady = true;
  postLibraryStylesReady();
}

function isOnCurrentPage(node: BaseNode): boolean {
  let current: BaseNode | null = node;
  while (current !== null) {
    if (current.type === 'PAGE') {
      return current.id === figma.currentPage.id;
    }
    current = current.parent;
  }
  return false;
}

// ─── Suppression list ─────────────────────────────────────────────────────────
// Fill rawValues (uppercase hex) excluded from scan results. Extend freely.
const DEFAULT_SUPPRESSED_VALUES = new Set([
  'FFFFFF', // pure white
  '000000', // pure black
]);

// ─── Node traversal ──────────────────────────────────────────────────────────

const CONTAINER_TYPES = new Set([
  'FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION',
]);

type ContainerNode =
  | FrameNode | GroupNode | ComponentNode
  | ComponentSetNode | InstanceNode | SectionNode;

function traverseNodes(node: SceneNode, callback: (node: SceneNode) => void): void {
  if ('locked' in node && node.locked) return;
  if ('visible' in node && node.visible === false) return;
  callback(node);
  if (CONTAINER_TYPES.has(node.type)) {
    for (const child of (node as ContainerNode).children) {
      traverseNodes(child, callback);
    }
  }
}

// ─── Variable binding helpers ─────────────────────────────────────────────────

type BoundVarsMap = Record<string, unknown> | null | undefined;

// True if a scalar property is bound to a Figma variable.
function isScalarBound(node: SceneNode, key: string): boolean {
  if (!('boundVariables' in node)) return false;
  const bv = (node as any).boundVariables as BoundVarsMap;
  return bv != null && key in bv && bv[key] != null;
}

// True if a specific fill paint (by index) has any variable binding.
function isFillIndexBound(node: SceneNode, index: number): boolean {
  if (!('boundVariables' in node)) return false;
  const bv = (node as any).boundVariables as BoundVarsMap;
  if (!bv || !Array.isArray(bv.fills)) return false;
  const entry = bv.fills[index];
  return entry != null && typeof entry === 'object' && Object.keys(entry as object).length > 0;
}

// True if a specific stroke paint (by index) has any variable binding.
function isStrokeIndexBound(node: SceneNode, index: number): boolean {
  if (!('boundVariables' in node)) return false;
  const bv = (node as any).boundVariables as BoundVarsMap;
  if (!bv || !Array.isArray(bv.strokes)) return false;
  const entry = bv.strokes[index];
  return entry != null && typeof entry === 'object' && Object.keys(entry as object).length > 0;
}

// ─── Noise node filter ────────────────────────────────────────────────────────

function isNoiseNode(node: SceneNode): boolean {
  const name = node.name;
  if (!name || name.trim() === '') return true;
  if (node.type === 'VECTOR' && name.length === 1) return true;
  if (node.type === 'VECTOR') {
    const cp = name.codePointAt(0);
    if (cp !== undefined && cp > 127) return true;
  }
  return false;
}

// ─── Raw paint extraction ─────────────────────────────────────────────────────

interface RawPaintRecord {
  nodeId: string;
  nodeName: string;
  property: 'fill' | 'stroke';
  rawValue: string; // uppercase 6-digit hex e.g. "FF6B6B"
}

function toHex(c: number): string {
  return Math.round(c * 255).toString(16).padStart(2, '0').toUpperCase();
}

function solidPaintToHex(paint: SolidPaint): string {
  return toHex(paint.color.r) + toHex(paint.color.g) + toHex(paint.color.b);
}

function getRawPaintValues(node: SceneNode): RawPaintRecord[] {
  if (isNoiseNode(node)) return [];
  const records: RawPaintRecord[] = [];

  if ('fills' in node && Array.isArray(node.fills)) {
    const styleUnbound = !('fillStyleId' in node) || node.fillStyleId === '';
    if (styleUnbound) {
      (node.fills as Paint[]).forEach((paint, i) => {
        if (paint.type === 'SOLID' && !isFillIndexBound(node, i)) {
          records.push({
            nodeId: node.id, nodeName: node.name,
            property: 'fill', rawValue: solidPaintToHex(paint as SolidPaint),
          });
        }
      });
    }
  }

  if ('strokes' in node && Array.isArray(node.strokes)) {
    const styleUnbound = !('strokeStyleId' in node) || node.strokeStyleId === '';
    if (styleUnbound) {
      (node.strokes as Paint[]).forEach((paint, i) => {
        if (paint.type === 'SOLID' && !isStrokeIndexBound(node, i)) {
          records.push({
            nodeId: node.id, nodeName: node.name,
            property: 'stroke', rawValue: solidPaintToHex(paint as SolidPaint),
          });
        }
      });
    }
  }

  return records;
}

// ─── Raw text style extraction ────────────────────────────────────────────────

interface RawTextRecord {
  nodeId: string;
  nodeName: string;
  property: 'text';
  rawValue: string; // "fontSize/lineHeight/fontFamily"
}

function getRawTextStyles(node: SceneNode): RawTextRecord[] {
  if (node.type !== 'TEXT') return [];
  const styleId = node.textStyleId;
  if (styleId !== figma.mixed && styleId !== '') return [];
  if (isScalarBound(node, 'fontSize') || isScalarBound(node, 'fontFamily')) return [];

  const fontSize = typeof node.fontSize === 'number' ? String(node.fontSize) : 'mixed';
  let lineHeight: string;
  if (node.lineHeight === figma.mixed) {
    lineHeight = 'mixed';
  } else if (node.lineHeight.unit === 'AUTO') {
    lineHeight = 'auto';
  } else {
    lineHeight = node.lineHeight.unit === 'PERCENT'
      ? `${node.lineHeight.value}%`
      : String(node.lineHeight.value);
  }
  const fontFamily = node.fontName === figma.mixed ? 'mixed' : node.fontName.family;
  return [{
    nodeId: node.id, nodeName: node.name,
    property: 'text', rawValue: `${fontSize}/${lineHeight}/${fontFamily}`,
  }];
}

// ─── Raw effect extraction ────────────────────────────────────────────────────

interface RawEffectRecord {
  nodeId: string;
  nodeName: string;
  property: 'effect';
  rawValue: string; // e.g. "DROP_SHADOW"
}

const RECORDABLE_EFFECTS = new Set<Effect['type']>([
  'DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR',
]);

function getRawEffectValues(node: SceneNode): RawEffectRecord[] {
  if (!('effectStyleId' in node) || !('effects' in node)) return [];
  if ((node as any).effectStyleId !== '') return [];
  if (isScalarBound(node, 'effects')) return [];
  const effects = (node as any).effects as Effect[];
  if (!Array.isArray(effects) || effects.length === 0) return [];
  const records: RawEffectRecord[] = [];
  for (const effect of effects) {
    if (!effect.visible || !RECORDABLE_EFFECTS.has(effect.type)) continue;
    records.push({ nodeId: node.id, nodeName: node.name, property: 'effect', rawValue: effect.type });
  }
  return records;
}

// ─── Raw spacing extraction ───────────────────────────────────────────────────

type SpacingKey = 'paddingTop' | 'paddingBottom' | 'paddingLeft' | 'paddingRight' | 'itemSpacing';

interface RawSpacingRecord {
  nodeId: string;
  nodeName: string;
  property: 'spacing';
  rawValue: string;    // e.g. "paddingTop: 10"
  spacingKey: SpacingKey;
}

function getRawSpacingValues(node: SceneNode): RawSpacingRecord[] {
  if (!('layoutMode' in node) || (node as FrameNode).layoutMode === 'NONE') return [];
  const frame = node as FrameNode;
  const keys: SpacingKey[] = ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'itemSpacing'];
  const records: RawSpacingRecord[] = [];
  for (const key of keys) {
    if (isScalarBound(node, key)) continue;
    const val = (frame as any)[key];
    if (typeof val !== 'number') continue;
    if (val % 4 !== 0) {
      records.push({
        nodeId: node.id, nodeName: node.name,
        property: 'spacing', rawValue: `${key}: ${val}`, spacingKey: key,
      });
    }
  }
  return records;
}

// ─── Raw radius extraction ────────────────────────────────────────────────────

interface RawRadiusRecord {
  nodeId: string;
  nodeName: string;
  property: 'radius';
  rawValue: string; // numeric string e.g. "5"
}

function getRawRadiusValues(node: SceneNode): RawRadiusRecord[] {
  if (!('cornerRadius' in node)) return [];
  const keys = [
    'cornerRadius', 'topLeftRadius', 'topRightRadius',
    'bottomLeftRadius', 'bottomRightRadius',
  ] as const;
  const seen = new Set<number>();
  const records: RawRadiusRecord[] = [];
  for (const key of keys) {
    if (isScalarBound(node, key)) continue;
    const val = (node as any)[key];
    if (typeof val !== 'number' || val === 0 || seen.has(val)) continue;
    if (val % 2 !== 0) {
      seen.add(val);
      records.push({ nodeId: node.id, nodeName: node.name, property: 'radius', rawValue: String(val) });
    }
  }
  return records;
}

// ─── Raw opacity extraction ───────────────────────────────────────────────────

interface RawOpacityRecord {
  nodeId: string;
  nodeName: string;
  property: 'opacity';
  rawValue: string; // e.g. "75%"
}

function getRawOpacityValues(node: SceneNode): RawOpacityRecord[] {
  if (!('opacity' in node)) return [];
  if (isScalarBound(node, 'opacity')) return [];
  const opacity = (node as any).opacity as number;
  if (typeof opacity !== 'number' || opacity === 1 || opacity === 0) return [];
  return [{
    nodeId: node.id, nodeName: node.name,
    property: 'opacity', rawValue: `${Math.round(opacity * 100)}%`,
  }];
}

// ─── Grouping ────────────────────────────────────────────────────────────────

interface GroupedIssue {
  rawValue: string;
  property: string;
  layers: Array<{ nodeId: string; nodeName: string }>;
  layerCount: number;
}

type AnyRawRecord = { nodeId: string; nodeName: string; property: string; rawValue: string };

function groupRecords(records: AnyRawRecord[], flatten = false): GroupedIssue[] {
  if (flatten) {
    // One row per individual instance — lets designers pick the right token per layer
    return records.map(r => ({
      rawValue: r.rawValue, property: r.property,
      layers: [{ nodeId: r.nodeId, nodeName: r.nodeName }], layerCount: 1,
    }));
  }
  const map = new Map<string, GroupedIssue>();
  for (const r of records) {
    if (!map.has(r.rawValue)) {
      map.set(r.rawValue, { rawValue: r.rawValue, property: r.property, layers: [], layerCount: 0 });
    }
    const g = map.get(r.rawValue)!;
    g.layers.push({ nodeId: r.nodeId, nodeName: r.nodeName });
    g.layerCount++;
  }
  // Sort most-affected first
  return Array.from(map.values()).sort((a, b) => b.layerCount - a.layerCount);
}

// ─── Library info ─────────────────────────────────────────────────────────────

interface LibraryInfo {
  name: string;
  styleCount: number;
  connected: boolean;
}

async function collectLibraryInfo(): Promise<LibraryInfo[]> {
  const [paintStyles, textStyles] = await Promise.all([
    figma.getLocalPaintStylesAsync(),
    figma.getLocalTextStylesAsync(),
  ]);
  const localTotal = paintStyles.length + textStyles.length;
  return [
    { name: figma.root.name, styleCount: localTotal, connected: localTotal > 0 },
  ];
}

// ─── Master scan ──────────────────────────────────────────────────────────────

async function runScan(scope: 'selection' | 'page'): Promise<void> {
  const rawFills:   RawPaintRecord[]   = [];
  const rawStrokes: RawPaintRecord[]   = [];
  const rawText:    RawTextRecord[]    = [];
  const rawSpacing: RawSpacingRecord[] = [];
  const rawRadius:  RawRadiusRecord[]  = [];
  const rawOpacity: RawOpacityRecord[] = [];
  const rawEffects: RawEffectRecord[]  = [];
  let layerCount = 0;

  // Resolve roots based on scope
  const selection = figma.currentPage.selection;
  const useSelection = scope === 'selection' && selection.length > 0;
  const roots: readonly SceneNode[] = useSelection
    ? selection
    : figma.currentPage.children;
  const scopeUsed: 'selection' | 'page' = useSelection ? 'selection' : 'page';

  for (const root of roots) {
    traverseNodes(root, (node) => {
      layerCount++;
      for (const r of getRawPaintValues(node)) {
        if (r.property === 'fill') {
          if (!DEFAULT_SUPPRESSED_VALUES.has(r.rawValue.toUpperCase())) rawFills.push(r);
        } else {
          rawStrokes.push(r);
        }
      }
      rawText.push(...getRawTextStyles(node));
      rawSpacing.push(...getRawSpacingValues(node));
      rawRadius.push(...getRawRadiusValues(node));
      rawOpacity.push(...getRawOpacityValues(node));
      rawEffects.push(...getRawEffectValues(node));
    });
  }

  const libraries = await collectLibraryInfo();

  // ── scan-start ──────────────────────────────────────────────────────────────
  figma.ui.postMessage({ type: 'scan-start', scopeUsed, nodeCount: layerCount, libraries });

  // Helper to yield between category posts so the UI can repaint
  const yield_ = () => new Promise<void>(resolve => setTimeout(resolve, 0));

  // ── per-category streaming ────────────────────────────────────────────────
  type Category = { category: string; groups: GroupedIssue[] };
  const categories: Category[] = [
    { category: 'fills',   groups: groupRecords(rawFills,   true)  },
    { category: 'strokes', groups: groupRecords(rawStrokes, true)  },
    { category: 'text',    groups: groupRecords(rawText)           },
    { category: 'spacing', groups: groupRecords(rawSpacing)        },
    { category: 'radius',  groups: groupRecords(rawRadius)         },
    { category: 'effects', groups: groupRecords(rawEffects)        },
    { category: 'opacity', groups: groupRecords(rawOpacity)        },
  ];

  let totalIssues = 0;
  for (const { category, groups } of categories) {
    const count = groups.reduce((s, g) => s + g.layerCount, 0);
    totalIssues += count;
    figma.ui.postMessage({ type: 'scan-category', category, groups, count });
    await yield_();
  }

  // ── scan-complete ─────────────────────────────────────────────────────────
  figma.ui.postMessage({ type: 'scan-complete', totalIssues, totalLayers: layerCount, scopeUsed });
}

// ─── Color space math ─────────────────────────────────────────────────────────

interface SrgbTriplet { r: number; g: number; b: number; }
interface Lab { L: number; a: number; b: number; }

function hexToRgb(hex: string): SrgbTriplet {
  const n = parseInt(hex.replace('#', ''), 16);
  return {
    r: ((n >> 16) & 0xff) / 255,
    g: ((n >>  8) & 0xff) / 255,
    b: ( n        & 0xff) / 255,
  };
}

// sRGB → linear light (IEC 61966-2-1)
function linearise(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Linear RGB → CIE XYZ (D65 illuminant)
function rgbToXyz(rgb: SrgbTriplet): { X: number; Y: number; Z: number } {
  const r = linearise(rgb.r), g = linearise(rgb.g), b = linearise(rgb.b);
  return {
    X: r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    Y: r * 0.2126729 + g * 0.7151522 + b * 0.0721750,
    Z: r * 0.0193339 + g * 0.1191920 + b * 0.9503041,
  };
}

// CIE XYZ → CIE Lab (D65 reference white)
function xyzToLab(X: number, Y: number, Z: number): Lab {
  const refX = 0.95047, refY = 1.00000, refZ = 1.08883;
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + (16 / 116);
  const fx = f(X / refX), fy = f(Y / refY), fz = f(Z / refZ);
  return { L: (116 * fy) - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function hexToLab(hex: string): Lab {
  const { X, Y, Z } = rgbToXyz(hexToRgb(hex));
  return xyzToLab(X, Y, Z);
}

// CIE76 Delta E
function deltaE76(a: Lab, b: Lab): number {
  return Math.sqrt(
    Math.pow(a.L - b.L, 2) + Math.pow(a.a - b.a, 2) + Math.pow(a.b - b.b, 2),
  );
}

// ─── Color matching ───────────────────────────────────────────────────────────

interface VariableColorMode {
  modeId: string;
  modeName: string;
  hex: string;
}

interface VariableColorEntry {
  variableId: string;
  variableName: string;
  collectionName: string;
  modes: VariableColorMode[];
}

/** True when this variable binds via VARIABLE_ALIAS (semantic token), not raw RGBA (primitive). */
function variableUsesAliasInAnyMode(variable: Variable, collection: VariableCollection): boolean {
  for (const mode of collection.modes) {
    const raw = variable.valuesByMode[mode.modeId];
    if (raw === undefined) continue;
    if (typeof raw !== 'object' || raw === null) continue;
    const alias = raw as VariableAlias;
    if (alias.type === 'VARIABLE_ALIAS') return true;
  }
  return false;
}

interface ColorMatch {
  // Paint style match (optional — absent for variable matches)
  styleId?: string;
  styleName?: string;
  // Variable match (optional — absent for style matches)
  variableId?: string;
  variableName?: string;
  collectionName?: string;
  variableModes?: VariableColorMode[];
  // Common
  hexValue: string;
  distanceScore: number;
}

// Resolve a VariableValue (possibly an alias chain) down to a concrete RGBA.
// Falls back to figma.variables.getVariableByIdAsync for primitives that
// weren't explicitly imported (e.g. when only the Aliases collection is enabled).
async function resolveVariableValue(
  val: VariableValue,
  varById: Map<string, Variable>,
  visited: Set<string>,
): Promise<RGBA | null> {
  if (typeof val !== 'object' || val === null) return null;
  if ('r' in val && 'g' in val && 'b' in val && 'a' in val) return val as RGBA;
  const alias = val as VariableAlias;
  if (alias.type !== 'VARIABLE_ALIAS') return null;
  if (visited.has(alias.id)) return null;

  let target = varById.get(alias.id);
  if (!target) {
    // Primitive not in our explicit cache — fetch it directly.
    // Figma makes transitively-referenced variables accessible by ID once an
    // alias that references them has been imported.
    try {
      const fetched = await figma.variables.getVariableByIdAsync(alias.id);
      if (fetched) { target = fetched; varById.set(fetched.id, fetched); }
    } catch { /* variable not accessible */ }
  }
  if (!target) return null;

  const next = new Set(visited);
  next.add(alias.id);
  for (const modeId of Object.keys(target.valuesByMode)) {
    const r = await resolveVariableValue(target.valuesByMode[modeId], varById, next);
    if (r) return r;
  }
  return null;
}

async function buildVariableColorIndex(): Promise<VariableColorEntry[]> {
  if (!cachedColorVariables || cachedColorVariables.length === 0) return [];
  const varById = new Map<string, Variable>();
  for (const v of cachedColorVariables) varById.set(v.id, v);

  const collById = new Map<string, VariableCollection | null>();
  for (const v of cachedColorVariables) {
    if (!collById.has(v.variableCollectionId)) {
      collById.set(
        v.variableCollectionId,
        await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId),
      );
    }
  }

  const entries: VariableColorEntry[] = [];
  let resolved = 0, unresolved = 0, skippedPrimitives = 0;
  for (const variable of cachedColorVariables) {
    const collection = collById.get(variable.variableCollectionId);
    if (!collection) continue;
    if (!variableUsesAliasInAnyMode(variable, collection)) {
      skippedPrimitives++;
      continue;
    }
    const modes: VariableColorMode[] = [];
    for (const mode of collection.modes) {
      const raw = variable.valuesByMode[mode.modeId];
      if (raw === undefined) continue;
      const rgba = await resolveVariableValue(raw, varById, new Set([variable.id]));
      if (!rgba) continue;
      modes.push({ modeId: mode.modeId, modeName: mode.name, hex: toHex(rgba.r) + toHex(rgba.g) + toHex(rgba.b) });
    }
    if (modes.length > 0) {
      entries.push({ variableId: variable.id, variableName: variable.name, collectionName: collection.name, modes });
      resolved++;
    } else {
      unresolved++;
    }
  }
  console.log(
    `[audit] variable index: ${resolved} alias color tokens, ${skippedPrimitives} primitives skipped, ${unresolved} unresolved`,
  );
  return entries;
}

async function getClosestColorMatches(rawHex: string): Promise<ColorMatch[]> {
  if (!cachedVariableColorIndex) cachedVariableColorIndex = await buildVariableColorIndex();

  const targetLab = hexToLab(rawHex);
  const candidates: ColorMatch[] = [];

  // Only color variables that bind via alias (semantic tokens), never primitives or paint styles
  for (const entry of cachedVariableColorIndex) {
    let bestDist = Infinity, bestHex = '';
    for (const mode of entry.modes) {
      const d = deltaE76(targetLab, hexToLab(mode.hex));
      if (d < bestDist) { bestDist = d; bestHex = mode.hex; }
    }
    if (bestHex) {
      candidates.push({
        variableId: entry.variableId, variableName: entry.variableName,
        collectionName: entry.collectionName, variableModes: entry.modes,
        hexValue: bestHex,
        distanceScore: Math.round(bestDist * 100) / 100,
      });
    }
  }

  candidates.sort((a, b) => a.distanceScore - b.distanceScore);
  return candidates.slice(0, 5);
}

// ─── Typography matching ──────────────────────────────────────────────────────

interface TypographyMatch {
  styleId: string;
  styleName: string;
  previewLabel: string;
  score: number; // higher is better
}

interface TypographyInput { fontSize: number; fontFamily: string; fontWeight: number; }

function fontStyleToWeight(style: string): number {
  const s = style.toLowerCase();
  if (s.includes('thin'))        return 100;
  if (s.includes('extralight') || s.includes('extra light') || s.includes('ultralight')) return 200;
  if (s.includes('light'))       return 300;
  if (s.includes('medium'))      return 500;
  if (s.includes('semibold') || s.includes('semi bold') || s.includes('demibold'))       return 600;
  if (s.includes('extrabold') || s.includes('extra bold') || s.includes('ultrabold'))    return 800;
  if (s.includes('black') || s.includes('heavy')) return 900;
  if (s.includes('bold'))        return 700;
  return 400;
}

async function getClosestTextMatches(input: TypographyInput): Promise<TypographyMatch[]> {
  if (!cachedTextStyles) cachedTextStyles = await figma.getLocalTextStylesAsync();
  const styles = cachedTextStyles;
  const matches: TypographyMatch[] = [];
  for (const style of styles) {
    let score = 0;
    if (style.fontName.family.toLowerCase() === input.fontFamily.toLowerCase()) score += 10;
    score += Math.max(0, 5 - Math.abs(style.fontSize - input.fontSize) * 0.5);
    score += Math.max(0, 3 - Math.abs(fontStyleToWeight(style.fontName.style) - input.fontWeight) / 133);
    matches.push({
      styleId: style.id, styleName: style.name,
      previewLabel: `${style.fontName.family} / ${style.fontSize} / ${style.fontName.style}`,
      score,
    });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 3);
}

// ─── Message bridge ───────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg: { type: string; [key: string]: any }) => {

  if (msg.type === 'ping') {
    figma.ui.postMessage({ type: 'pong' });

  } else if (msg.type === 'clear-cache') {
    cachedPaintStyles = null;
    cachedTextStyles  = null;
    cachedColorVariables = null;
    cachedVariableColorIndex = null;
    libraryStylesReady = false;
    void initLibraryStyles();

  } else if (msg.type === 'run-scan') {
    const scope: 'selection' | 'page' = msg.scope === 'selection' ? 'selection' : 'page';
    await runScan(scope);

  } else if (msg.type === 'get-closest-match') {
    const { property, rawValue, matchSeq } = msg as unknown as {
      property: string;
      rawValue: string;
      matchSeq?: number;
    };
    const reply = (payload: { matches: ColorMatch[] | TypographyMatch[]; error?: string }) =>
      figma.ui.postMessage({ type: 'closest-match-result', matchSeq, ...payload });
    try {
      let matches: ColorMatch[] | TypographyMatch[] = [];
      if (property === 'fill' || property === 'stroke') {
        matches = await getClosestColorMatches(rawValue);
      } else if (property === 'text') {
        const parts = rawValue.split('/');
        matches = await getClosestTextMatches({
          fontSize: parseFloat(parts[0]) || 0,
          fontFamily: parts[2] || '',
          fontWeight: 400,
        });
      }
      reply({ matches });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('[audit] get-closest-match:', error);
      reply({ matches: [], error });
    }

  } else if (msg.type === 'switch-page') {
    const page = figma.root.children.find(p => p.id === msg.pageId);
    if (page) {
      await figma.setCurrentPageAsync(page);
      figma.ui.postMessage({
        type: 'page-switched',
        pageId:       page.id,
        pageName:     page.name,
        hasSelection: figma.currentPage.selection.length > 0,
      });
    }

  } else if (msg.type === 'navigate-to') {
    const ids = msg.nodeIds as string[];
    // dynamic-page requires the async variant of getNodeById
    const resolved = await Promise.all(ids.map(id => figma.getNodeByIdAsync(id)));
    const candidates = resolved.filter((n): n is SceneNode =>
      n !== null && n.type !== 'DOCUMENT' && n.type !== 'PAGE',
    );
    console.log(`[audit] navigate-to: requested=${ids.length} candidates=${candidates.length} page="${figma.currentPage.name}"`);
    if (candidates.length === 0) {
      figma.notify('Layer not found — re-run the scan', { error: true, timeout: 2000 });
      figma.ui.postMessage({ type: 'navigation-done', count: 0, error: 'Layer not found — re-run scan' });
    } else {
      try {
        figma.currentPage.selection = candidates;
        figma.viewport.scrollAndZoomIntoView(candidates);
        figma.ui.postMessage({ type: 'navigation-done', count: candidates.length });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        figma.notify('Wrong page — switch to the scanned page and re-run', { error: true, timeout: 3000 });
        figma.ui.postMessage({ type: 'navigation-done', count: 0, error: 'Layer is on a different page. Switch page and re-run scan.' });
        console.error('[audit] navigate-to error:', detail);
      }
    }

  } else if (msg.type === 'apply-style') {
    const { nodeIds, property, styleId } = msg as unknown as {
      nodeIds: string[];
      property: 'fill' | 'stroke' | 'text' | 'effect';
      styleId: string;
    };
    const errors: string[] = [];
    for (const nodeId of nodeIds) {
      const node = await figma.getNodeByIdAsync(nodeId);
      if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') {
        errors.push(`${nodeId}: not found`);
        continue;
      }
      try {
        const scene = node as SceneNode;
        switch (property) {
          case 'fill':
            if ('fillStyleId' in scene) (scene as GeometryMixin).fillStyleId = styleId;
            break;
          case 'stroke':
            if ('strokeStyleId' in scene) (scene as GeometryMixin).strokeStyleId = styleId;
            break;
          case 'text':
            if (scene.type === 'TEXT') (scene as TextNode).textStyleId = styleId;
            break;
          case 'effect':
            if ('effectStyleId' in scene) (scene as BlendMixin).effectStyleId = styleId;
            break;
        }
      } catch (err) {
        errors.push(`${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    figma.ui.postMessage({ type: 'apply-style-result', ok: errors.length === 0, errors });

  } else if (msg.type === 'apply-variable') {
    const { nodeIds, property, variableId } = msg as unknown as {
      nodeIds: string[];
      property: 'fill' | 'stroke';
      variableId: string;
    };
    const variable = await figma.variables.getVariableByIdAsync(variableId);
    if (!variable) {
      figma.ui.postMessage({ type: 'apply-style-result', ok: false, errors: ['Variable not found'] });
      return;
    }
    const errors: string[] = [];
    for (const nodeId of nodeIds) {
      const node = await figma.getNodeByIdAsync(nodeId);
      if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') {
        errors.push(`${nodeId}: not found`);
        continue;
      }
      try {
        const scene = node as SceneNode;
        if (property === 'fill' && 'fills' in scene) {
          const fills = [...(scene as GeometryMixin).fills as Paint[]];
          for (let i = 0; i < fills.length; i++) {
            if (fills[i].type === 'SOLID') {
              fills[i] = figma.variables.setBoundVariableForPaint(fills[i] as SolidPaint, 'color', variable) as Paint;
              break;
            }
          }
          (scene as GeometryMixin).fills = fills;
        } else if (property === 'stroke' && 'strokes' in scene) {
          const strokes = [...(scene as GeometryMixin).strokes as Paint[]];
          for (let i = 0; i < strokes.length; i++) {
            if (strokes[i].type === 'SOLID') {
              strokes[i] = figma.variables.setBoundVariableForPaint(strokes[i] as SolidPaint, 'color', variable) as Paint;
              break;
            }
          }
          (scene as GeometryMixin).strokes = strokes;
        }
      } catch (err) {
        errors.push(`${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    figma.ui.postMessage({ type: 'apply-style-result', ok: errors.length === 0, errors });
  }
};

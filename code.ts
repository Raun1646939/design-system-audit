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
  /** fill = shape fill; textColor = TEXT node glyph fill; stroke = stroke paint */
  property: 'fill' | 'stroke' | 'textColor';
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
      const fillKind: 'fill' | 'textColor' = node.type === 'TEXT' ? 'textColor' : 'fill';
      (node.fills as Paint[]).forEach((paint, i) => {
        if (paint.type === 'SOLID' && !isFillIndexBound(node, i)) {
          records.push({
            nodeId: node.id, nodeName: node.name,
            property: fillKind, rawValue: solidPaintToHex(paint as SolidPaint),
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

/** Audited token slots (linked + not) vs issues — mirrors each getRaw* rule for TOKENSURE %. */
function accumulatePaintAudit(node: SceneNode): { total: number; issues: number } {
  if (isNoiseNode(node)) return { total: 0, issues: 0 };
  let total = 0;
  let issues = 0;
  if ('fills' in node && Array.isArray(node.fills)) {
    const styleUnbound = !('fillStyleId' in node) || node.fillStyleId === '';
    if (styleUnbound) {
      (node.fills as Paint[]).forEach((paint, i) => {
        if (paint.type !== 'SOLID') return;
        const hex = solidPaintToHex(paint as SolidPaint).toUpperCase();
        if (isFillIndexBound(node, i)) {
          total++;
        } else if (DEFAULT_SUPPRESSED_VALUES.has(hex)) {
          /* same as scan: suppressed rogue fills/strokes omitted */
        } else {
          total++;
          issues++;
        }
      });
    }
  }
  if ('strokes' in node && Array.isArray(node.strokes)) {
    const styleUnbound = !('strokeStyleId' in node) || node.strokeStyleId === '';
    if (styleUnbound) {
      (node.strokes as Paint[]).forEach((paint, i) => {
        if (paint.type !== 'SOLID') return;
        const hex = solidPaintToHex(paint as SolidPaint).toUpperCase();
        if (isStrokeIndexBound(node, i)) {
          total++;
        } else if (DEFAULT_SUPPRESSED_VALUES.has(hex)) {
          /* omitted */
        } else {
          total++;
          issues++;
        }
      });
    }
  }
  return { total, issues };
}

function accumulateTextAudit(node: SceneNode): { total: number; issues: number } {
  if (node.type !== 'TEXT') return { total: 0, issues: 0 };
  const styleId = node.textStyleId;
  if (styleId !== figma.mixed && styleId !== '') return { total: 0, issues: 0 };
  if (isScalarBound(node, 'fontSize') || isScalarBound(node, 'fontFamily')) return { total: 1, issues: 0 };
  return { total: 1, issues: 1 };
}

const SPACING_AUDIT_KEYS: SpacingKey[] = ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'itemSpacing'];

function accumulateSpacingAudit(node: SceneNode): { total: number; issues: number } {
  if (!('layoutMode' in node) || (node as FrameNode).layoutMode === 'NONE') return { total: 0, issues: 0 };
  const frame = node as FrameNode;
  let total = 0;
  let issues = 0;
  for (const key of SPACING_AUDIT_KEYS) {
    if (isScalarBound(node, key)) continue;
    const val = (frame as any)[key] as number;
    if (typeof val !== 'number') continue;
    total++;
    if (val % 4 !== 0) issues++;
  }
  return { total, issues };
}

function accumulateRadiusAudit(node: SceneNode): { total: number; issues: number } {
  if (!('cornerRadius' in node)) return { total: 0, issues: 0 };
  const keys = [
    'cornerRadius', 'topLeftRadius', 'topRightRadius',
    'bottomLeftRadius', 'bottomRightRadius',
  ] as const;
  const seen = new Set<number>();
  let total = 0;
  let issues = 0;
  for (const key of keys) {
    if (isScalarBound(node, key)) continue;
    const val = (node as any)[key] as number;
    if (typeof val !== 'number' || val === 0 || seen.has(val)) continue;
    seen.add(val);
    total++;
    if (val % 2 !== 0) issues++;
  }
  return { total, issues };
}

function accumulateOpacityAudit(node: SceneNode): { total: number; issues: number } {
  if (!('opacity' in node)) return { total: 0, issues: 0 };
  if (isScalarBound(node, 'opacity')) return { total: 0, issues: 0 };
  const opacity = (node as any).opacity as number;
  if (typeof opacity !== 'number' || opacity === 1 || opacity === 0) return { total: 0, issues: 0 };
  return { total: 1, issues: 1 };
}

function accumulateEffectAudit(node: SceneNode): { total: number; issues: number } {
  if (!('effectStyleId' in node) || !('effects' in node)) return { total: 0, issues: 0 };
  if ((node as any).effectStyleId !== '') return { total: 0, issues: 0 };
  if (isScalarBound(node, 'effects')) return { total: 0, issues: 0 };
  const effects = (node as any).effects as Effect[];
  if (!Array.isArray(effects) || effects.length === 0) return { total: 0, issues: 0 };
  let total = 0;
  let issues = 0;
  for (const effect of effects) {
    if (!effect.visible || !RECORDABLE_EFFECTS.has(effect.type)) continue;
    total++;
    issues++;
  }
  return { total, issues };
}

function accumulateNodeTokenAudit(node: SceneNode): { total: number; issues: number } {
  let total = 0;
  let issues = 0;
  for (const part of [
    accumulatePaintAudit(node),
    accumulateTextAudit(node),
    accumulateSpacingAudit(node),
    accumulateRadiusAudit(node),
    accumulateOpacityAudit(node),
    accumulateEffectAudit(node),
  ]) {
    total += part.total;
    issues += part.issues;
  }
  return { total, issues };
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
  /** All rogue solid colors: shape fills, text fills, strokes — shown under COLORS tab */
  const rawColors:  RawPaintRecord[]   = [];
  const rawText:    RawTextRecord[]    = [];
  const rawSpacing: RawSpacingRecord[] = [];
  const rawRadius:  RawRadiusRecord[]  = [];
  const rawOpacity: RawOpacityRecord[] = [];
  const rawEffects: RawEffectRecord[]  = [];
  let layerCount = 0;
  let auditTotal = 0;
  let auditIssues = 0;

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
      const audit = accumulateNodeTokenAudit(node);
      auditTotal += audit.total;
      auditIssues += audit.issues;
      for (const r of getRawPaintValues(node)) {
        if (!DEFAULT_SUPPRESSED_VALUES.has(r.rawValue.toUpperCase())) rawColors.push(r);
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
    { category: 'fills',   groups: groupRecords(rawColors, true) },
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
  const tokensurePercent = auditTotal === 0
    ? 100
    : Math.min(100, Math.max(0, Math.round((100 * (auditTotal - auditIssues)) / auditTotal)));
  figma.ui.postMessage({
    type: 'scan-complete',
    totalIssues,
    totalLayers: layerCount,
    scopeUsed,
    tokensurePercent,
  });
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
  /** CIE76 ΔE vs best-mode resolved hex (lower = closer) */
  distanceScore: number;
  /** 0–100 blended perceptual + semantic confidence (alias color matches only) */
  confidence?: number;
  /** True for slot 3: closest ΔE in pool without role re-score (drawer labels this “COLOR MATCH”). */
  isColorFirst?: boolean;
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

/** Lowercase path-ish string with slashes/dots treated as token separators */
function normalizeTokenLabel(entry: VariableColorEntry): string {
  return `${entry.variableName} ${entry.collectionName}`
    .toLowerCase()
    .replace(/[\\/._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** FILL / shape: never suggest aliases whose names imply text, stroke, or border UI roles */
function isExcludedAliasForFill(norm: string): boolean {
  if (/\bborder\b/.test(norm)) return true;
  if (/\bstroke\b/.test(norm)) return true;
  if (/\bdivider\b/.test(norm) || /\bseparator\b/.test(norm) || /\boutline\b/.test(norm) || /\bhairline\b/.test(norm)) return true;
  if (/\btext-inverse\b/.test(norm) || norm.includes('text-inverse')) return true;
  if (/\btext\b/.test(norm)) return true;
  if (/\b(fg|foreground)\b/.test(norm)) return true;
  if (/\blabel\b/.test(norm) || /\bheading\b/.test(norm) || /\bcaption\b/.test(norm)) return true;
  if (/\bon[\s\-_]/.test(norm)) return true;
  if (/\bplaceholder\b/.test(norm)) return true;
  if (/\bcaret\b/.test(norm)) return true;
  if (/\blink\b/.test(norm)) return true;
  if (/\bvisited\b/.test(norm)) return true;
  return false;
}

/**
 * Perceptual confidence from ΔE76 (piecewise, similar to common QC bands).
 * Not CIEDE2000 — kept lightweight; weights lean on semantics for ties.
 */
function perceptualConfidenceFromDeltaE76(deltaE: number): number {
  if (!isFinite(deltaE) || deltaE < 0) return 0;
  if (deltaE <= 0.5) return 100;
  if (deltaE <= 1) return 97;
  if (deltaE <= 1.5) return 93;
  if (deltaE <= 2) return 89;
  if (deltaE <= 3) return 83;
  if (deltaE <= 4) return 77;
  if (deltaE <= 5) return 72;
  if (deltaE <= 6) return 67;
  if (deltaE <= 8) return 58;
  if (deltaE <= 10) return 49;
  if (deltaE <= 12) return 41;
  if (deltaE <= 15) return 33;
  return Math.max(8, Math.round(28 - deltaE * 1.1));
}

/** Semantic fit 0–100 for TEXT node fill (glyph) color */
function semanticConfidenceTextColor(norm: string): number {
  if (/\btext-inverse\b/.test(norm) || /inverse[-\s]?text/.test(norm)) return 100;
  if (norm.includes('text-inverse')) return 100;
  if (/\bborder\b/.test(norm) && !/\btext\b/.test(norm)) return 34;
  if (/\bborder\b/.test(norm)) return 46;
  if (/\btext\b/.test(norm)) return 94;
  if (/\b(fg|foreground)\b/.test(norm)) return 82;
  if (/\bheading\b/.test(norm)) return 76;
  if (/\blabel\b/.test(norm) || /\bcaption\b/.test(norm) || /\bbody\b/.test(norm)) return 72;
  return 45;
}

/** Semantic fit 0–100 for stroke / border color */
function semanticConfidenceStroke(norm: string): number {
  if (/\bborder\b/.test(norm)) return 100;
  if (/\b(outline|stroke|divider|separator|hairline)\b/.test(norm)) return 86;
  if (/\btext\b/.test(norm) && !/\bborder\b/.test(norm)) return 36;
  return 45;
}

/** Semantic fit 0–100 for shape / surface fill (tokens already filtered) */
function semanticConfidenceFill(norm: string): number {
  if (/\b(bg|background|surface|canvas|container|layer|fill|base)\b/.test(norm)) return 90;
  if (/\b(icon|illustration|graphic|decoration)\b/.test(norm)) return 84;
  if (/\b(overlay|scrim|backdrop)\b/.test(norm)) return 80;
  if (/\bmuted\b/.test(norm) || /\bsubtle\b/.test(norm)) return 76;
  return 45;
}

function semanticConfidenceForRole(role: ColorPropertyRole, norm: string): number {
  if (role === 'textColor') return semanticConfidenceTextColor(norm);
  if (role === 'stroke') return semanticConfidenceStroke(norm);
  return semanticConfidenceFill(norm);
}

/**
 * Blend perceptual + semantic (industry-style weighted score).
 * Perceptual dominates; semantic breaks ties and down-ranks wrong-role tokens.
 */
const CONF_WEIGHT_PERCEPTUAL = 0.62;
const CONF_WEIGHT_SEMANTIC = 0.38;

function blendAliasConfidence(perceptual: number, semantic: number): number {
  const v = CONF_WEIGHT_PERCEPTUAL * perceptual + CONF_WEIGHT_SEMANTIC * semantic;
  return Math.min(100, Math.max(0, Math.round(v)));
}

type ColorPropertyRole = 'fill' | 'stroke' | 'textColor';

/** Rule-validated slots (1–2) + optional color-first slot 3 */
const CLOSEST_ALIAS_MATCH_COUNT = 3;

/** Perceptual pool size before role filtering / re-ranking */
const CANDIDATE_POOL_SIZE = 20;

const MIN_ALIAS_CONFIDENCE_THRESHOLD = 55;

interface ClosestColorMatchResult {
  matches: ColorMatch[];
  /** Present when no match passes confidence threshold (or no candidates). */
  reason?: string;
}

function finalizeColorMatchesFromScored(scored: ScoredColorMatch[]): ClosestColorMatchResult {
  const top = sliceTopMatches(scored, CLOSEST_ALIAS_MATCH_COUNT);
  const filtered = top.filter(m => (m.confidence ?? 0) >= MIN_ALIAS_CONFIDENCE_THRESHOLD);
  if (filtered.length === 0) {
    return { matches: [], reason: 'No confident match found in library' };
  }
  return { matches: filtered };
}

/**
 * Text glyph color aliases: paths under `text`, `text/inverse`, emphasis steps, etc.
 * Excludes border-only container tokens (see border bucket).
 */
function inTextAliasBucket(norm: string): boolean {
  if (/\bborder\b/.test(norm) && !/\btext\b/.test(norm)) return false;
  if (/\btext\b/.test(norm)) return true;
  if (/(highest|high|med|medium|low)\s+emphasis/.test(norm)) return true;
  if (/\bdisabled\b/.test(norm) && !/\bborder\b/.test(norm)) return true;
  return false;
}

/**
 * Stroke aliases: paths with `border` (e.g. container/border/tertiary) or explicit `stroke`.
 */
function inBorderAliasBucket(norm: string): boolean {
  return /\bborder\b/.test(norm) || /\bstroke\b/.test(norm);
}

type ScoredColorMatch = { match: ColorMatch; confidence: number; distanceScore: number };

function scoreAliasEntries(
  targetLab: Lab,
  role: ColorPropertyRole,
  entries: VariableColorEntry[],
  includeIf: ((norm: string) => boolean) | null,
): ScoredColorMatch[] {
  const scored: ScoredColorMatch[] = [];
  for (const entry of entries) {
    const norm = normalizeTokenLabel(entry);
    if (includeIf !== null && !includeIf(norm)) continue;
    if (role === 'fill' && isExcludedAliasForFill(norm)) continue;

    let bestDist = Infinity, bestHex = '';
    for (const mode of entry.modes) {
      const d = deltaE76(targetLab, hexToLab(mode.hex));
      if (d < bestDist) { bestDist = d; bestHex = mode.hex; }
    }
    if (!bestHex) continue;

    const distanceScore = Math.round(bestDist * 100) / 100;
    const perceptual = perceptualConfidenceFromDeltaE76(bestDist);
    const semantic = semanticConfidenceForRole(role, norm);
    const confidence = blendAliasConfidence(perceptual, semantic);

    const match: ColorMatch = {
      variableId: entry.variableId, variableName: entry.variableName,
      collectionName: entry.collectionName, variableModes: entry.modes,
      hexValue: bestHex,
      distanceScore,
      confidence,
    };
    scored.push({ match, confidence, distanceScore });
  }

  scored.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.distanceScore - b.distanceScore;
  });
  return scored;
}

function sliceTopMatches(scored: ScoredColorMatch[], n: number): ColorMatch[] {
  return scored.slice(0, n).map(s => s.match);
}

/** One row in the ΔE-only candidate pool (see generateCandidates). */
interface CandidateEntry {
  entry: VariableColorEntry;
  deltaE: number;
  bestModeHex: string;
}

/**
 * Color-first pool: every alias token scored by minimum ΔE76 across modes only.
 * Pure; read-only index.
 */
function generateCandidates(targetLab: Lab, fullIndex: VariableColorEntry[]): CandidateEntry[] {
  const rows: CandidateEntry[] = [];
  for (const entry of fullIndex) {
    let bestDist = Infinity;
    let bestHex = '';
    for (const mode of entry.modes) {
      const d = deltaE76(targetLab, hexToLab(mode.hex));
      if (d < bestDist) {
        bestDist = d;
        bestHex = mode.hex;
      }
    }
    if (!bestHex) continue;
    rows.push({ entry, deltaE: bestDist, bestModeHex: bestHex });
  }
  rows.sort((a, b) => a.deltaE - b.deltaE);
  return rows.slice(0, CANDIDATE_POOL_SIZE);
}

function poolHasTextAliasMember(pool: CandidateEntry[]): boolean {
  return pool.some(c => inTextAliasBucket(normalizeTokenLabel(c.entry)));
}

function poolHasBorderAliasMember(pool: CandidateEntry[]): boolean {
  return pool.some(c => inBorderAliasBucket(normalizeTokenLabel(c.entry)));
}

/** Bucket A: candidates that pass role rules (within the current pool). Pure. */
function passesRoleRulesForBucketA(c: CandidateEntry, role: ColorPropertyRole, pool: CandidateEntry[]): boolean {
  const norm = normalizeTokenLabel(c.entry);
  if (role === 'fill') return !isExcludedAliasForFill(norm);
  if (role === 'textColor') {
    if (poolHasTextAliasMember(pool)) return inTextAliasBucket(norm);
    return true;
  }
  if (role === 'stroke') {
    if (poolHasBorderAliasMember(pool)) return inBorderAliasBucket(norm);
    return true;
  }
  return true;
}

function scoredFromCandidateForRole(c: CandidateEntry, role: ColorPropertyRole): ScoredColorMatch {
  const { entry, deltaE, bestModeHex } = c;
  const norm = normalizeTokenLabel(entry);
  const distanceScore = Math.round(deltaE * 100) / 100;
  const perceptual = perceptualConfidenceFromDeltaE76(deltaE);
  const semantic = semanticConfidenceForRole(role, norm);
  const confidence = blendAliasConfidence(perceptual, semantic);
  const match: ColorMatch = {
    variableId: entry.variableId,
    variableName: entry.variableName,
    collectionName: entry.collectionName,
    variableModes: entry.modes,
    hexValue: bestModeHex,
    distanceScore,
    confidence,
    isColorFirst: false,
  };
  return { match, confidence, distanceScore };
}

function colorFirstMatchFromCandidate(c: CandidateEntry): ColorMatch {
  const { entry, deltaE, bestModeHex } = c;
  const distanceScore = Math.round(deltaE * 100) / 100;
  return {
    variableId: entry.variableId,
    variableName: entry.variableName,
    collectionName: entry.collectionName,
    variableModes: entry.modes,
    hexValue: bestModeHex,
    distanceScore,
    isColorFirst: true,
  };
}

/**
 * Re-rank the top-N ΔE pool: up to 2 rule-scored matches (threshold on those only) + 1 color-first slot.
 * Pure; read-only candidates.
 */
function rerankCandidates(candidates: CandidateEntry[], role: ColorPropertyRole): ClosestColorMatchResult {
  if (candidates.length === 0) {
    return { matches: [], reason: 'No confident match found in library' };
  }
  const pool = candidates;

  const bucketA = pool.filter(c => passesRoleRulesForBucketA(c, role, pool));
  const scoredA: ScoredColorMatch[] = bucketA.map(c => scoredFromCandidateForRole(c, role));
  scoredA.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.distanceScore - b.distanceScore;
  });

  const top2Scored = scoredA.slice(0, 2);
  const slots12: ColorMatch[] = top2Scored
    .filter(s => (s.match.confidence ?? 0) >= MIN_ALIAS_CONFIDENCE_THRESHOLD)
    .map(s => s.match);

  const used = new Set(slots12.map(m => m.variableId).filter((id): id is string => Boolean(id)));
  let slot3: ColorMatch | null = null;
  for (const c of pool) {
    if (used.has(c.entry.variableId)) continue;
    slot3 = colorFirstMatchFromCandidate(c);
    break;
  }

  const matches: ColorMatch[] = [...slots12];
  if (slot3) matches.push(slot3);

  if (matches.length === 0) {
    return { matches: [], reason: 'No confident match found in library' };
  }
  return { matches };
}

async function getClosestColorMatches(rawHex: string, role: ColorPropertyRole): Promise<ClosestColorMatchResult> {
  if (!cachedVariableColorIndex) cachedVariableColorIndex = await buildVariableColorIndex();

  const targetLab = hexToLab(rawHex);
  const entries = cachedVariableColorIndex;
  const candidates = generateCandidates(targetLab, entries);
  return rerankCandidates(candidates, role);
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
    const reply = (payload: {
      matches: ColorMatch[] | TypographyMatch[];
      error?: string;
      reason?: string;
    }) => figma.ui.postMessage({ type: 'closest-match-result', matchSeq, ...payload });
    try {
      if (property === 'fill' || property === 'stroke' || property === 'textColor') {
        const colorResult = await getClosestColorMatches(rawValue, property as ColorPropertyRole);
        if (colorResult.matches.length === 0 && colorResult.reason) {
          reply({ matches: [], reason: colorResult.reason });
        } else {
          reply({ matches: colorResult.matches });
        }
      } else if (property === 'text') {
        const parts = rawValue.split('/');
        const matches = await getClosestTextMatches({
          fontSize: parseFloat(parts[0]) || 0,
          fontFamily: parts[2] || '',
          fontWeight: 400,
        });
        reply({ matches });
      } else {
        reply({ matches: [] });
      }
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
      property: 'fill' | 'stroke' | 'textColor' | 'text' | 'effect';
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
          case 'textColor':
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
      property: 'fill' | 'stroke' | 'textColor';
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
        if ((property === 'fill' || property === 'textColor') && 'fills' in scene) {
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

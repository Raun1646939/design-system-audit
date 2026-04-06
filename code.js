"use strict";
figma.showUI(__html__, { width: 360, height: 720 });
// ─── Init (async; dynamic-page documentAccess forbids sync getLocal*Styles) ─
void (async function sendInit() {
    const [paintStyles, textStyles, effectStyles] = await Promise.all([
        figma.getLocalPaintStylesAsync(),
        figma.getLocalTextStylesAsync(),
        figma.getLocalEffectStylesAsync(),
    ]);
    figma.ui.postMessage({
        type: 'init',
        payload: {
            fileName: figma.root.name,
            currentPageId: figma.currentPage.id,
            currentPageName: figma.currentPage.name,
            pages: figma.root.children.map(p => ({
                id: p.id, name: p.name, isCurrent: p.id === figma.currentPage.id,
            })),
            localPaintStyleCount: paintStyles.length,
            localTextStyleCount: textStyles.length,
            localEffectStyleCount: effectStyles.length,
            hasSelection: figma.currentPage.selection.length > 0,
            selectionCount: figma.currentPage.selection.length,
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
let cachedPaintStyles = null;
let cachedTextStyles = null;
let cachedColorVariables = null;
let cachedVariableColorIndex = null;
let libraryStylesReady = false;
function postLibraryStylesReady() {
    var _a, _b, _c;
    figma.ui.postMessage({
        type: 'library-styles-ready',
        paintStyleCount: (_a = cachedPaintStyles === null || cachedPaintStyles === void 0 ? void 0 : cachedPaintStyles.length) !== null && _a !== void 0 ? _a : 0,
        textStyleCount: (_b = cachedTextStyles === null || cachedTextStyles === void 0 ? void 0 : cachedTextStyles.length) !== null && _b !== void 0 ? _b : 0,
        variableCount: (_c = cachedColorVariables === null || cachedColorVariables === void 0 ? void 0 : cachedColorVariables.length) !== null && _c !== void 0 ? _c : 0,
    });
}
async function initLibraryStyles() {
    var _a, _b, _c;
    libraryStylesReady = false;
    const [localPaint, localText, localColorVars] = await Promise.all([
        figma.getLocalPaintStylesAsync(),
        figma.getLocalTextStylesAsync(),
        figma.variables.getLocalVariablesAsync('COLOR'),
    ]);
    cachedPaintStyles = localPaint;
    cachedTextStyles = localText;
    cachedColorVariables = localColorVars;
    cachedVariableColorIndex = null;
    // Library paint styles
    const getLibStyles = figma.getAvailableLibraryStylesAsync;
    try {
        if (typeof getLibStyles === 'function') {
            const libPaintStyles = await getLibStyles.call(figma);
            const resolved = await Promise.all((libPaintStyles || [])
                .filter(s => s.styleType === 'PAINT')
                .map(s => figma.importStyleByKeyAsync(s.key).catch(() => null)));
            const freshPaint = resolved.filter((s) => s !== null && s.type === 'PAINT');
            const paintIds = new Set((cachedPaintStyles !== null && cachedPaintStyles !== void 0 ? cachedPaintStyles : []).map(s => s.id));
            cachedPaintStyles = [...(cachedPaintStyles !== null && cachedPaintStyles !== void 0 ? cachedPaintStyles : []), ...freshPaint.filter(s => !paintIds.has(s.id))];
        }
    }
    catch ( /* Library styles unavailable */_d) { /* Library styles unavailable */ }
    // Library color variables (the main path for design-system aliases / themes)
    // Uses figma.teamLibrary — returns ALL org-enabled library variable collections.
    // Requires those collections to be enabled in this file via the Libraries panel.
    try {
        const teamLib = figma.teamLibrary;
        const getLibColls = (_a = teamLib === null || teamLib === void 0 ? void 0 : teamLib.getAvailableLibraryVariableCollectionsAsync) === null || _a === void 0 ? void 0 : _a.bind(teamLib);
        const getLibVars = (_b = teamLib === null || teamLib === void 0 ? void 0 : teamLib.getVariablesInLibraryCollectionAsync) === null || _b === void 0 ? void 0 : _b.bind(teamLib);
        if (typeof getLibColls !== 'function' || typeof getLibVars !== 'function') {
            console.warn('[audit] figma.teamLibrary variable methods not available in this runtime');
        }
        else {
            const libColls = await getLibColls();
            console.log(`[audit] found ${libColls.length} library variable collection(s)`);
            const allImported = [];
            for (const col of libColls) {
                const libVars = await getLibVars(col.key);
                const colorKeys = libVars.filter(v => v.resolvedType === 'COLOR').map(v => v.key);
                console.log(`[audit] collection "${col.name}": ${colorKeys.length} COLOR variable(s)`);
                const resolved = await Promise.all(colorKeys.map(k => figma.variables.importVariableByKeyAsync(k).catch(() => null)));
                allImported.push(...resolved.filter((v) => v !== null));
            }
            const existingIds = new Set((cachedColorVariables !== null && cachedColorVariables !== void 0 ? cachedColorVariables : []).map(v => v.id));
            const freshVars = allImported.filter(v => !existingIds.has(v.id));
            cachedColorVariables = [...(cachedColorVariables !== null && cachedColorVariables !== void 0 ? cachedColorVariables : []), ...freshVars];
            console.log(`[audit] total color variables loaded: ${(_c = cachedColorVariables === null || cachedColorVariables === void 0 ? void 0 : cachedColorVariables.length) !== null && _c !== void 0 ? _c : 0}`);
        }
    }
    catch (err) {
        console.error('[audit] library variable loading error:', err);
    }
    libraryStylesReady = true;
    postLibraryStylesReady();
}
function isOnCurrentPage(node) {
    let current = node;
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
function traverseNodes(node, callback) {
    if ('locked' in node && node.locked)
        return;
    if ('visible' in node && node.visible === false)
        return;
    callback(node);
    if (CONTAINER_TYPES.has(node.type)) {
        for (const child of node.children) {
            traverseNodes(child, callback);
        }
    }
}
// True if a scalar property is bound to a Figma variable.
function isScalarBound(node, key) {
    if (!('boundVariables' in node))
        return false;
    const bv = node.boundVariables;
    return bv != null && key in bv && bv[key] != null;
}
// True if a specific fill paint (by index) has any variable binding.
function isFillIndexBound(node, index) {
    if (!('boundVariables' in node))
        return false;
    const bv = node.boundVariables;
    if (!bv || !Array.isArray(bv.fills))
        return false;
    const entry = bv.fills[index];
    return entry != null && typeof entry === 'object' && Object.keys(entry).length > 0;
}
// True if a specific stroke paint (by index) has any variable binding.
function isStrokeIndexBound(node, index) {
    if (!('boundVariables' in node))
        return false;
    const bv = node.boundVariables;
    if (!bv || !Array.isArray(bv.strokes))
        return false;
    const entry = bv.strokes[index];
    return entry != null && typeof entry === 'object' && Object.keys(entry).length > 0;
}
// ─── Noise node filter ────────────────────────────────────────────────────────
function isNoiseNode(node) {
    const name = node.name;
    if (!name || name.trim() === '')
        return true;
    if (node.type === 'VECTOR' && name.length === 1)
        return true;
    if (node.type === 'VECTOR') {
        const cp = name.codePointAt(0);
        if (cp !== undefined && cp > 127)
            return true;
    }
    return false;
}
function toHex(c) {
    return Math.round(c * 255).toString(16).padStart(2, '0').toUpperCase();
}
function solidPaintToHex(paint) {
    return toHex(paint.color.r) + toHex(paint.color.g) + toHex(paint.color.b);
}
function getRawPaintValues(node) {
    if (isNoiseNode(node))
        return [];
    const records = [];
    if ('fills' in node && Array.isArray(node.fills)) {
        const styleUnbound = !('fillStyleId' in node) || node.fillStyleId === '';
        if (styleUnbound) {
            const fillKind = node.type === 'TEXT' ? 'textColor' : 'fill';
            node.fills.forEach((paint, i) => {
                if (paint.type === 'SOLID' && !isFillIndexBound(node, i)) {
                    records.push({
                        nodeId: node.id, nodeName: node.name,
                        property: fillKind, rawValue: solidPaintToHex(paint),
                    });
                }
            });
        }
    }
    if ('strokes' in node && Array.isArray(node.strokes)) {
        const styleUnbound = !('strokeStyleId' in node) || node.strokeStyleId === '';
        if (styleUnbound) {
            node.strokes.forEach((paint, i) => {
                if (paint.type === 'SOLID' && !isStrokeIndexBound(node, i)) {
                    records.push({
                        nodeId: node.id, nodeName: node.name,
                        property: 'stroke', rawValue: solidPaintToHex(paint),
                    });
                }
            });
        }
    }
    return records;
}
function getRawTextStyles(node) {
    if (node.type !== 'TEXT')
        return [];
    const styleId = node.textStyleId;
    if (styleId !== figma.mixed && styleId !== '')
        return [];
    if (isScalarBound(node, 'fontSize') || isScalarBound(node, 'fontFamily'))
        return [];
    const fontSize = typeof node.fontSize === 'number' ? String(node.fontSize) : 'mixed';
    let lineHeight;
    if (node.lineHeight === figma.mixed) {
        lineHeight = 'mixed';
    }
    else if (node.lineHeight.unit === 'AUTO') {
        lineHeight = 'auto';
    }
    else {
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
const RECORDABLE_EFFECTS = new Set([
    'DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR',
]);
function getRawEffectValues(node) {
    if (!('effectStyleId' in node) || !('effects' in node))
        return [];
    if (node.effectStyleId !== '')
        return [];
    if (isScalarBound(node, 'effects'))
        return [];
    const effects = node.effects;
    if (!Array.isArray(effects) || effects.length === 0)
        return [];
    const records = [];
    for (const effect of effects) {
        if (!effect.visible || !RECORDABLE_EFFECTS.has(effect.type))
            continue;
        records.push({ nodeId: node.id, nodeName: node.name, property: 'effect', rawValue: effect.type });
    }
    return records;
}
function getRawSpacingValues(node) {
    if (!('layoutMode' in node) || node.layoutMode === 'NONE')
        return [];
    const frame = node;
    const keys = ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'itemSpacing'];
    const records = [];
    for (const key of keys) {
        if (isScalarBound(node, key))
            continue;
        const val = frame[key];
        if (typeof val !== 'number')
            continue;
        if (val % 4 !== 0) {
            records.push({
                nodeId: node.id, nodeName: node.name,
                property: 'spacing', rawValue: `${key}: ${val}`, spacingKey: key,
            });
        }
    }
    return records;
}
function getRawRadiusValues(node) {
    if (!('cornerRadius' in node))
        return [];
    const keys = [
        'cornerRadius', 'topLeftRadius', 'topRightRadius',
        'bottomLeftRadius', 'bottomRightRadius',
    ];
    const seen = new Set();
    const records = [];
    for (const key of keys) {
        if (isScalarBound(node, key))
            continue;
        const val = node[key];
        if (typeof val !== 'number' || val === 0 || seen.has(val))
            continue;
        if (val % 2 !== 0) {
            seen.add(val);
            records.push({ nodeId: node.id, nodeName: node.name, property: 'radius', rawValue: String(val) });
        }
    }
    return records;
}
function getRawOpacityValues(node) {
    if (!('opacity' in node))
        return [];
    if (isScalarBound(node, 'opacity'))
        return [];
    const opacity = node.opacity;
    if (typeof opacity !== 'number' || opacity === 1 || opacity === 0)
        return [];
    return [{
            nodeId: node.id, nodeName: node.name,
            property: 'opacity', rawValue: `${Math.round(opacity * 100)}%`,
        }];
}
function groupRecords(records, flatten = false) {
    if (flatten) {
        // One row per individual instance — lets designers pick the right token per layer
        return records.map(r => ({
            rawValue: r.rawValue, property: r.property,
            layers: [{ nodeId: r.nodeId, nodeName: r.nodeName }], layerCount: 1,
        }));
    }
    const map = new Map();
    for (const r of records) {
        if (!map.has(r.rawValue)) {
            map.set(r.rawValue, { rawValue: r.rawValue, property: r.property, layers: [], layerCount: 0 });
        }
        const g = map.get(r.rawValue);
        g.layers.push({ nodeId: r.nodeId, nodeName: r.nodeName });
        g.layerCount++;
    }
    // Sort most-affected first
    return Array.from(map.values()).sort((a, b) => b.layerCount - a.layerCount);
}
async function collectLibraryInfo() {
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
async function runScan(scope) {
    /** All rogue solid colors: shape fills, text fills, strokes — shown under COLORS tab */
    const rawColors = [];
    const rawText = [];
    const rawSpacing = [];
    const rawRadius = [];
    const rawOpacity = [];
    const rawEffects = [];
    let layerCount = 0;
    // Resolve roots based on scope
    const selection = figma.currentPage.selection;
    const useSelection = scope === 'selection' && selection.length > 0;
    const roots = useSelection
        ? selection
        : figma.currentPage.children;
    const scopeUsed = useSelection ? 'selection' : 'page';
    for (const root of roots) {
        traverseNodes(root, (node) => {
            layerCount++;
            for (const r of getRawPaintValues(node)) {
                if (!DEFAULT_SUPPRESSED_VALUES.has(r.rawValue.toUpperCase()))
                    rawColors.push(r);
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
    const yield_ = () => new Promise(resolve => setTimeout(resolve, 0));
    const categories = [
        { category: 'fills', groups: groupRecords(rawColors, true) },
        { category: 'text', groups: groupRecords(rawText) },
        { category: 'spacing', groups: groupRecords(rawSpacing) },
        { category: 'radius', groups: groupRecords(rawRadius) },
        { category: 'effects', groups: groupRecords(rawEffects) },
        { category: 'opacity', groups: groupRecords(rawOpacity) },
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
function hexToRgb(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return {
        r: ((n >> 16) & 0xff) / 255,
        g: ((n >> 8) & 0xff) / 255,
        b: (n & 0xff) / 255,
    };
}
// sRGB → linear light (IEC 61966-2-1)
function linearise(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
// Linear RGB → CIE XYZ (D65 illuminant)
function rgbToXyz(rgb) {
    const r = linearise(rgb.r), g = linearise(rgb.g), b = linearise(rgb.b);
    return {
        X: r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
        Y: r * 0.2126729 + g * 0.7151522 + b * 0.0721750,
        Z: r * 0.0193339 + g * 0.1191920 + b * 0.9503041,
    };
}
// CIE XYZ → CIE Lab (D65 reference white)
function xyzToLab(X, Y, Z) {
    const refX = 0.95047, refY = 1.00000, refZ = 1.08883;
    const f = (t) => t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + (16 / 116);
    const fx = f(X / refX), fy = f(Y / refY), fz = f(Z / refZ);
    return { L: (116 * fy) - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}
function hexToLab(hex) {
    const { X, Y, Z } = rgbToXyz(hexToRgb(hex));
    return xyzToLab(X, Y, Z);
}
// CIE76 Delta E
function deltaE76(a, b) {
    return Math.sqrt(Math.pow(a.L - b.L, 2) + Math.pow(a.a - b.a, 2) + Math.pow(a.b - b.b, 2));
}
/** True when this variable binds via VARIABLE_ALIAS (semantic token), not raw RGBA (primitive). */
function variableUsesAliasInAnyMode(variable, collection) {
    for (const mode of collection.modes) {
        const raw = variable.valuesByMode[mode.modeId];
        if (raw === undefined)
            continue;
        if (typeof raw !== 'object' || raw === null)
            continue;
        const alias = raw;
        if (alias.type === 'VARIABLE_ALIAS')
            return true;
    }
    return false;
}
// Resolve a VariableValue (possibly an alias chain) down to a concrete RGBA.
// Falls back to figma.variables.getVariableByIdAsync for primitives that
// weren't explicitly imported (e.g. when only the Aliases collection is enabled).
async function resolveVariableValue(val, varById, visited) {
    if (typeof val !== 'object' || val === null)
        return null;
    if ('r' in val && 'g' in val && 'b' in val && 'a' in val)
        return val;
    const alias = val;
    if (alias.type !== 'VARIABLE_ALIAS')
        return null;
    if (visited.has(alias.id))
        return null;
    let target = varById.get(alias.id);
    if (!target) {
        // Primitive not in our explicit cache — fetch it directly.
        // Figma makes transitively-referenced variables accessible by ID once an
        // alias that references them has been imported.
        try {
            const fetched = await figma.variables.getVariableByIdAsync(alias.id);
            if (fetched) {
                target = fetched;
                varById.set(fetched.id, fetched);
            }
        }
        catch ( /* variable not accessible */_a) { /* variable not accessible */ }
    }
    if (!target)
        return null;
    const next = new Set(visited);
    next.add(alias.id);
    for (const modeId of Object.keys(target.valuesByMode)) {
        const r = await resolveVariableValue(target.valuesByMode[modeId], varById, next);
        if (r)
            return r;
    }
    return null;
}
async function buildVariableColorIndex() {
    if (!cachedColorVariables || cachedColorVariables.length === 0)
        return [];
    const varById = new Map();
    for (const v of cachedColorVariables)
        varById.set(v.id, v);
    const collById = new Map();
    for (const v of cachedColorVariables) {
        if (!collById.has(v.variableCollectionId)) {
            collById.set(v.variableCollectionId, await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId));
        }
    }
    const entries = [];
    let resolved = 0, unresolved = 0, skippedPrimitives = 0;
    for (const variable of cachedColorVariables) {
        const collection = collById.get(variable.variableCollectionId);
        if (!collection)
            continue;
        if (!variableUsesAliasInAnyMode(variable, collection)) {
            skippedPrimitives++;
            continue;
        }
        const modes = [];
        for (const mode of collection.modes) {
            const raw = variable.valuesByMode[mode.modeId];
            if (raw === undefined)
                continue;
            const rgba = await resolveVariableValue(raw, varById, new Set([variable.id]));
            if (!rgba)
                continue;
            modes.push({ modeId: mode.modeId, modeName: mode.name, hex: toHex(rgba.r) + toHex(rgba.g) + toHex(rgba.b) });
        }
        if (modes.length > 0) {
            entries.push({ variableId: variable.id, variableName: variable.name, collectionName: collection.name, modes });
            resolved++;
        }
        else {
            unresolved++;
        }
    }
    console.log(`[audit] variable index: ${resolved} alias color tokens, ${skippedPrimitives} primitives skipped, ${unresolved} unresolved`);
    return entries;
}
/** Lowercase path-ish string with slashes/dots treated as token separators */
function normalizeTokenLabel(entry) {
    return `${entry.variableName} ${entry.collectionName}`
        .toLowerCase()
        .replace(/[\\/._]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
/** FILL / shape: never suggest aliases whose names imply text, stroke, or border UI roles */
function isExcludedAliasForFill(norm) {
    if (/\bborder\b/.test(norm))
        return true;
    if (/\bstroke\b/.test(norm))
        return true;
    if (/\bdivider\b/.test(norm) || /\bseparator\b/.test(norm) || /\boutline\b/.test(norm) || /\bhairline\b/.test(norm))
        return true;
    if (/\btext-inverse\b/.test(norm) || norm.includes('text-inverse'))
        return true;
    if (/\btext\b/.test(norm))
        return true;
    if (/\b(fg|foreground)\b/.test(norm))
        return true;
    if (/\blabel\b/.test(norm) || /\bheading\b/.test(norm) || /\bcaption\b/.test(norm))
        return true;
    return false;
}
/**
 * Perceptual confidence from ΔE76 (piecewise, similar to common QC bands).
 * Not CIEDE2000 — kept lightweight; weights lean on semantics for ties.
 */
function perceptualConfidenceFromDeltaE76(deltaE) {
    if (!isFinite(deltaE) || deltaE < 0)
        return 0;
    if (deltaE <= 0.5)
        return 100;
    if (deltaE <= 1)
        return 97;
    if (deltaE <= 1.5)
        return 93;
    if (deltaE <= 2)
        return 89;
    if (deltaE <= 3)
        return 83;
    if (deltaE <= 4)
        return 77;
    if (deltaE <= 5)
        return 72;
    if (deltaE <= 6)
        return 67;
    if (deltaE <= 8)
        return 58;
    if (deltaE <= 10)
        return 49;
    if (deltaE <= 12)
        return 41;
    if (deltaE <= 15)
        return 33;
    return Math.max(8, Math.round(28 - deltaE * 1.1));
}
/** Semantic fit 0–100 for TEXT node fill (glyph) color */
function semanticConfidenceTextColor(norm) {
    if (/\btext-inverse\b/.test(norm) || /inverse[-\s]?text/.test(norm))
        return 100;
    if (norm.includes('text-inverse'))
        return 100;
    if (/\bborder\b/.test(norm) && !/\btext\b/.test(norm))
        return 34;
    if (/\bborder\b/.test(norm))
        return 46;
    if (/\btext\b/.test(norm))
        return 94;
    if (/\b(fg|foreground)\b/.test(norm))
        return 82;
    if (/\bheading\b/.test(norm))
        return 76;
    if (/\blabel\b/.test(norm) || /\bcaption\b/.test(norm) || /\bbody\b/.test(norm))
        return 72;
    return 56;
}
/** Semantic fit 0–100 for stroke / border color */
function semanticConfidenceStroke(norm) {
    if (/\bborder\b/.test(norm))
        return 100;
    if (/\b(outline|stroke|divider|separator|hairline)\b/.test(norm))
        return 86;
    if (/\btext\b/.test(norm) && !/\bborder\b/.test(norm))
        return 36;
    return 54;
}
/** Semantic fit 0–100 for shape / surface fill (tokens already filtered) */
function semanticConfidenceFill(norm) {
    if (/\b(bg|background|surface|canvas|container|layer|fill|base)\b/.test(norm))
        return 90;
    if (/\b(icon|illustration|graphic|decoration)\b/.test(norm))
        return 84;
    if (/\b(overlay|scrim|backdrop)\b/.test(norm))
        return 80;
    if (/\bmuted\b/.test(norm) || /\bsubtle\b/.test(norm))
        return 76;
    return 70;
}
function semanticConfidenceForRole(role, norm) {
    if (role === 'textColor')
        return semanticConfidenceTextColor(norm);
    if (role === 'stroke')
        return semanticConfidenceStroke(norm);
    return semanticConfidenceFill(norm);
}
/**
 * Blend perceptual + semantic (industry-style weighted score).
 * Perceptual dominates; semantic breaks ties and down-ranks wrong-role tokens.
 */
const CONF_WEIGHT_PERCEPTUAL = 0.62;
const CONF_WEIGHT_SEMANTIC = 0.38;
function blendAliasConfidence(perceptual, semantic) {
    const v = CONF_WEIGHT_PERCEPTUAL * perceptual + CONF_WEIGHT_SEMANTIC * semantic;
    return Math.min(100, Math.max(0, Math.round(v)));
}
/** Alias suggestions returned to UI (inline row shows the first only) */
const CLOSEST_ALIAS_MATCH_COUNT = 1;
/**
 * Text glyph color aliases: paths under `text`, `text/inverse`, emphasis steps, etc.
 * Excludes border-only container tokens (see border bucket).
 */
function inTextAliasBucket(norm) {
    if (/\bborder\b/.test(norm) && !/\btext\b/.test(norm))
        return false;
    if (/\btext\b/.test(norm))
        return true;
    if (/(highest|high|med|medium|low)\s+emphasis/.test(norm))
        return true;
    if (/\bdisabled\b/.test(norm) && !/\bborder\b/.test(norm))
        return true;
    return false;
}
/**
 * Stroke aliases: paths with `border` (e.g. container/border/tertiary) or explicit `stroke`.
 */
function inBorderAliasBucket(norm) {
    return /\bborder\b/.test(norm) || /\bstroke\b/.test(norm);
}
function scoreAliasEntries(targetLab, role, entries, includeIf) {
    const scored = [];
    for (const entry of entries) {
        const norm = normalizeTokenLabel(entry);
        if (includeIf !== null && !includeIf(norm))
            continue;
        if (role === 'fill' && isExcludedAliasForFill(norm))
            continue;
        let bestDist = Infinity, bestHex = '';
        for (const mode of entry.modes) {
            const d = deltaE76(targetLab, hexToLab(mode.hex));
            if (d < bestDist) {
                bestDist = d;
                bestHex = mode.hex;
            }
        }
        if (!bestHex)
            continue;
        const distanceScore = Math.round(bestDist * 100) / 100;
        const perceptual = perceptualConfidenceFromDeltaE76(bestDist);
        const semantic = semanticConfidenceForRole(role, norm);
        const confidence = blendAliasConfidence(perceptual, semantic);
        const match = {
            variableId: entry.variableId, variableName: entry.variableName,
            collectionName: entry.collectionName, variableModes: entry.modes,
            hexValue: bestHex,
            distanceScore,
            confidence,
        };
        scored.push({ match, confidence, distanceScore });
    }
    scored.sort((a, b) => {
        if (b.confidence !== a.confidence)
            return b.confidence - a.confidence;
        return a.distanceScore - b.distanceScore;
    });
    return scored;
}
function sliceTopMatches(scored, n) {
    return scored.slice(0, n).map(s => s.match);
}
async function getClosestColorMatches(rawHex, role) {
    if (!cachedVariableColorIndex)
        cachedVariableColorIndex = await buildVariableColorIndex();
    const targetLab = hexToLab(rawHex);
    const entries = cachedVariableColorIndex;
    const n = CLOSEST_ALIAS_MATCH_COUNT;
    if (role === 'fill') {
        return sliceTopMatches(scoreAliasEntries(targetLab, role, entries, null), n);
    }
    if (role === 'textColor') {
        const inBucket = scoreAliasEntries(targetLab, role, entries, inTextAliasBucket);
        // Always prefer text-bucket aliases when any exist — do not fall through to “outside”
        // just because confidence is modest (perceptual closeness to tertiary text still wins).
        if (inBucket.length > 0)
            return sliceTopMatches(inBucket, n);
        const outside = scoreAliasEntries(targetLab, role, entries, norm => !inTextAliasBucket(norm));
        return sliceTopMatches(outside, n);
    }
    if (role === 'stroke') {
        const inBucket = scoreAliasEntries(targetLab, role, entries, inBorderAliasBucket);
        // Same as text: border/stroke bucket first by sorted confidence, never swap in
        // background/divider tokens just because border aliases scored below an arbitrary threshold.
        if (inBucket.length > 0)
            return sliceTopMatches(inBucket, n);
        const outside = scoreAliasEntries(targetLab, role, entries, norm => !inBorderAliasBucket(norm));
        return sliceTopMatches(outside, n);
    }
    return sliceTopMatches(scoreAliasEntries(targetLab, role, entries, null), n);
}
function fontStyleToWeight(style) {
    const s = style.toLowerCase();
    if (s.includes('thin'))
        return 100;
    if (s.includes('extralight') || s.includes('extra light') || s.includes('ultralight'))
        return 200;
    if (s.includes('light'))
        return 300;
    if (s.includes('medium'))
        return 500;
    if (s.includes('semibold') || s.includes('semi bold') || s.includes('demibold'))
        return 600;
    if (s.includes('extrabold') || s.includes('extra bold') || s.includes('ultrabold'))
        return 800;
    if (s.includes('black') || s.includes('heavy'))
        return 900;
    if (s.includes('bold'))
        return 700;
    return 400;
}
async function getClosestTextMatches(input) {
    if (!cachedTextStyles)
        cachedTextStyles = await figma.getLocalTextStylesAsync();
    const styles = cachedTextStyles;
    const matches = [];
    for (const style of styles) {
        let score = 0;
        if (style.fontName.family.toLowerCase() === input.fontFamily.toLowerCase())
            score += 10;
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
figma.ui.onmessage = async (msg) => {
    if (msg.type === 'ping') {
        figma.ui.postMessage({ type: 'pong' });
    }
    else if (msg.type === 'clear-cache') {
        cachedPaintStyles = null;
        cachedTextStyles = null;
        cachedColorVariables = null;
        cachedVariableColorIndex = null;
        libraryStylesReady = false;
        void initLibraryStyles();
    }
    else if (msg.type === 'run-scan') {
        const scope = msg.scope === 'selection' ? 'selection' : 'page';
        await runScan(scope);
    }
    else if (msg.type === 'get-closest-match') {
        const { property, rawValue, matchSeq } = msg;
        const reply = (payload) => figma.ui.postMessage(Object.assign({ type: 'closest-match-result', matchSeq }, payload));
        try {
            let matches = [];
            if (property === 'fill' || property === 'stroke' || property === 'textColor') {
                matches = await getClosestColorMatches(rawValue, property);
            }
            else if (property === 'text') {
                const parts = rawValue.split('/');
                matches = await getClosestTextMatches({
                    fontSize: parseFloat(parts[0]) || 0,
                    fontFamily: parts[2] || '',
                    fontWeight: 400,
                });
            }
            reply({ matches });
        }
        catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            console.error('[audit] get-closest-match:', error);
            reply({ matches: [], error });
        }
    }
    else if (msg.type === 'switch-page') {
        const page = figma.root.children.find(p => p.id === msg.pageId);
        if (page) {
            await figma.setCurrentPageAsync(page);
            figma.ui.postMessage({
                type: 'page-switched',
                pageId: page.id,
                pageName: page.name,
                hasSelection: figma.currentPage.selection.length > 0,
            });
        }
    }
    else if (msg.type === 'navigate-to') {
        const ids = msg.nodeIds;
        // dynamic-page requires the async variant of getNodeById
        const resolved = await Promise.all(ids.map(id => figma.getNodeByIdAsync(id)));
        const candidates = resolved.filter((n) => n !== null && n.type !== 'DOCUMENT' && n.type !== 'PAGE');
        console.log(`[audit] navigate-to: requested=${ids.length} candidates=${candidates.length} page="${figma.currentPage.name}"`);
        if (candidates.length === 0) {
            figma.notify('Layer not found — re-run the scan', { error: true, timeout: 2000 });
            figma.ui.postMessage({ type: 'navigation-done', count: 0, error: 'Layer not found — re-run scan' });
        }
        else {
            try {
                figma.currentPage.selection = candidates;
                figma.viewport.scrollAndZoomIntoView(candidates);
                figma.ui.postMessage({ type: 'navigation-done', count: candidates.length });
            }
            catch (err) {
                const detail = err instanceof Error ? err.message : String(err);
                figma.notify('Wrong page — switch to the scanned page and re-run', { error: true, timeout: 3000 });
                figma.ui.postMessage({ type: 'navigation-done', count: 0, error: 'Layer is on a different page. Switch page and re-run scan.' });
                console.error('[audit] navigate-to error:', detail);
            }
        }
    }
    else if (msg.type === 'apply-style') {
        const { nodeIds, property, styleId } = msg;
        const errors = [];
        for (const nodeId of nodeIds) {
            const node = await figma.getNodeByIdAsync(nodeId);
            if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') {
                errors.push(`${nodeId}: not found`);
                continue;
            }
            try {
                const scene = node;
                switch (property) {
                    case 'fill':
                    case 'textColor':
                        if ('fillStyleId' in scene)
                            scene.fillStyleId = styleId;
                        break;
                    case 'stroke':
                        if ('strokeStyleId' in scene)
                            scene.strokeStyleId = styleId;
                        break;
                    case 'text':
                        if (scene.type === 'TEXT')
                            scene.textStyleId = styleId;
                        break;
                    case 'effect':
                        if ('effectStyleId' in scene)
                            scene.effectStyleId = styleId;
                        break;
                }
            }
            catch (err) {
                errors.push(`${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        figma.ui.postMessage({ type: 'apply-style-result', ok: errors.length === 0, errors });
    }
    else if (msg.type === 'apply-variable') {
        const { nodeIds, property, variableId } = msg;
        const variable = await figma.variables.getVariableByIdAsync(variableId);
        if (!variable) {
            figma.ui.postMessage({ type: 'apply-style-result', ok: false, errors: ['Variable not found'] });
            return;
        }
        const errors = [];
        for (const nodeId of nodeIds) {
            const node = await figma.getNodeByIdAsync(nodeId);
            if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') {
                errors.push(`${nodeId}: not found`);
                continue;
            }
            try {
                const scene = node;
                if ((property === 'fill' || property === 'textColor') && 'fills' in scene) {
                    const fills = [...scene.fills];
                    for (let i = 0; i < fills.length; i++) {
                        if (fills[i].type === 'SOLID') {
                            fills[i] = figma.variables.setBoundVariableForPaint(fills[i], 'color', variable);
                            break;
                        }
                    }
                    scene.fills = fills;
                }
                else if (property === 'stroke' && 'strokes' in scene) {
                    const strokes = [...scene.strokes];
                    for (let i = 0; i < strokes.length; i++) {
                        if (strokes[i].type === 'SOLID') {
                            strokes[i] = figma.variables.setBoundVariableForPaint(strokes[i], 'color', variable);
                            break;
                        }
                    }
                    scene.strokes = strokes;
                }
            }
            catch (err) {
                errors.push(`${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        figma.ui.postMessage({ type: 'apply-style-result', ok: errors.length === 0, errors });
    }
};

"use strict";
figma.showUI(__html__, { width: 360, height: 720 });
// ─── Node traversal ──────────────────────────────────────────────────────────
const CONTAINER_TYPES = new Set([
    'FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION',
]);
function traverseNodes(node, callback) {
    // Skip locked or hidden layers.
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
function toHex(c) {
    return Math.round(c * 255).toString(16).padStart(2, '0').toUpperCase();
}
function solidPaintToHex(paint) {
    return toHex(paint.color.r) + toHex(paint.color.g) + toHex(paint.color.b);
}
function getRawPaintValues(node) {
    const records = [];
    // Fills
    if ('fills' in node && Array.isArray(node.fills)) {
        const unbound = !('fillStyleId' in node) || node.fillStyleId === '';
        if (unbound) {
            for (const paint of node.fills) {
                if (paint.type === 'SOLID') {
                    records.push({
                        nodeId: node.id,
                        nodeName: node.name,
                        property: 'fill',
                        rawValue: solidPaintToHex(paint),
                    });
                }
            }
        }
    }
    // Strokes
    if ('strokes' in node && Array.isArray(node.strokes)) {
        const unbound = !('strokeStyleId' in node) || node.strokeStyleId === '';
        if (unbound) {
            for (const paint of node.strokes) {
                if (paint.type === 'SOLID') {
                    records.push({
                        nodeId: node.id,
                        nodeName: node.name,
                        property: 'stroke',
                        rawValue: solidPaintToHex(paint),
                    });
                }
            }
        }
    }
    return records;
}
function getRawTextStyles(node) {
    if (node.type !== 'TEXT')
        return [];
    // figma.mixed means segments with different style ids — treat as unlinked.
    const styleId = node.textStyleId;
    const unbound = styleId === figma.mixed || styleId === '';
    if (!unbound)
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
        const value = node.lineHeight.unit === 'PERCENT'
            ? `${node.lineHeight.value}%`
            : String(node.lineHeight.value);
        lineHeight = value;
    }
    const fontFamily = node.fontName === figma.mixed ? 'mixed' : node.fontName.family;
    return [{
            nodeId: node.id,
            nodeName: node.name,
            property: 'typography',
            rawValue: `${fontSize}/${lineHeight}/${fontFamily}`,
        }];
}
const RECORDABLE_EFFECTS = new Set([
    'DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR',
]);
function getRawEffectValues(node) {
    if (!('effectStyleId' in node) || !('effects' in node))
        return [];
    if (node.effectStyleId !== '')
        return []; // bound to a style
    if (!Array.isArray(node.effects) || node.effects.length === 0)
        return [];
    const records = [];
    for (const effect of node.effects) {
        if (!effect.visible)
            continue;
        if (RECORDABLE_EFFECTS.has(effect.type)) {
            records.push({
                nodeId: node.id,
                nodeName: node.name,
                property: 'effect',
                rawValue: effect.type,
            });
        }
    }
    return records;
}
function runScan() {
    const results = { fills: [], strokes: [], typography: [], effects: [] };
    for (const root of figma.currentPage.children) {
        traverseNodes(root, (node) => {
            for (const record of getRawPaintValues(node)) {
                if (record.property === 'fill')
                    results.fills.push(record);
                else
                    results.strokes.push(record);
            }
            results.typography.push(...getRawTextStyles(node));
            results.effects.push(...getRawEffectValues(node));
        });
    }
    figma.ui.postMessage({ type: 'scan-results', data: results });
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
    const r = linearise(rgb.r);
    const g = linearise(rgb.g);
    const b = linearise(rgb.b);
    return {
        X: r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
        Y: r * 0.2126729 + g * 0.7151522 + b * 0.0721750,
        Z: r * 0.0193339 + g * 0.1191920 + b * 0.9503041,
    };
}
// CIE XYZ → CIE Lab (D65 reference white)
function xyzToLab(X, Y, Z) {
    const refX = 0.95047, refY = 1.00000, refZ = 1.08883;
    function f(t) {
        return t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + (16 / 116);
    }
    const fx = f(X / refX);
    const fy = f(Y / refY);
    const fz = f(Z / refZ);
    return {
        L: (116 * fy) - 16,
        a: 500 * (fx - fy),
        b: 200 * (fy - fz),
    };
}
function hexToLab(hex) {
    const { X, Y, Z } = rgbToXyz(hexToRgb(hex));
    return xyzToLab(X, Y, Z);
}
// CIE76 Delta E — sufficient for "closest design token" use cases
function deltaE76(a, b) {
    return Math.sqrt(Math.pow(a.L - b.L, 2) +
        Math.pow(a.a - b.a, 2) +
        Math.pow(a.b - b.b, 2));
}
async function getClosestColorMatches(rawHex) {
    const targetLab = hexToLab(rawHex);
    // Collect all paint styles: local + available library styles.
    const localStyles = figma.getLocalPaintStyles();
    const libraryStyles = [];
    // getAvailableLibraryStylesAsync was added in a later plugin API version; guard it.
    if (typeof figma.getAvailableLibraryStylesAsync === 'function') {
        try {
            const raw = await figma.getAvailableLibraryStylesAsync();
            libraryStyles.push(...raw);
        }
        catch (_) { /* library not available in this context */ }
    }
    const candidates = [];
    for (const style of [...localStyles, ...libraryStyles]) {
        for (const paint of style.paints) {
            if (paint.type !== 'SOLID')
                continue;
            const styleHex = solidPaintToHex(paint);
            const styleLab = hexToLab(styleHex);
            candidates.push({
                styleId: style.id,
                styleName: style.name,
                hexValue: styleHex,
                distanceScore: Math.round(deltaE76(targetLab, styleLab) * 100) / 100,
            });
            break; // one candidate per style (use the first solid paint)
        }
    }
    candidates.sort((a, b) => a.distanceScore - b.distanceScore);
    return candidates.slice(0, 3);
}
function getClosestTextMatches(input) {
    const styles = figma.getLocalTextStyles();
    const matches = [];
    for (const style of styles) {
        let score = 0;
        // Family match is the strongest signal (weight 10).
        const familyMatch = style.fontName.family.toLowerCase() === input.fontFamily.toLowerCase();
        if (familyMatch)
            score += 10;
        // Font size proximity: score decays linearly, capped at 0.
        // Within 1pt → 5 pts, at 10pt off → 0 pts.
        const sizeDelta = Math.abs(style.fontSize - input.fontSize);
        score += Math.max(0, 5 - sizeDelta * 0.5);
        // Weight proximity: map named style string to a numeric weight for comparison.
        const styleWeight = fontStyleToWeight(style.fontName.style);
        const weightDelta = Math.abs(styleWeight - input.fontWeight);
        // Within 100 units → 3 pts, at 400 units off → 0 pts.
        score += Math.max(0, 3 - weightDelta / 133);
        const previewLabel = `${style.fontName.family} / ${style.fontSize} / ${style.fontName.style}`;
        matches.push({ styleId: style.id, styleName: style.name, previewLabel, score });
    }
    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, 3);
}
// Map Figma's free-form font style strings to approximate numeric weights.
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
    return 400; // Regular / Normal / Roman / etc.
}
// ─── Message bridge ───────────────────────────────────────────────────────────
figma.ui.onmessage = async (msg) => {
    if (msg.type === 'ping') {
        figma.ui.postMessage({ type: 'pong' });
    }
    else if (msg.type === 'run-scan') {
        runScan();
    }
    else if (msg.type === 'get-closest-match') {
        const { property, rawValue } = msg;
        let matches = [];
        if (property === 'fill' || property === 'stroke') {
            matches = await getClosestColorMatches(rawValue);
        }
        else if (property === 'typography') {
            // rawValue format: "fontSize/lineHeight/fontFamily"
            const parts = rawValue.split('/');
            const fontSize = parseFloat(parts[0]) || 0;
            const fontFamily = parts[2] || '';
            // Weight isn't carried in rawValue yet; default to 400 until it is added.
            matches = getClosestTextMatches({ fontSize, fontFamily, fontWeight: 400 });
        }
        figma.ui.postMessage({ type: 'closest-match-result', matches });
    }
    else if (msg.type === 'apply-style') {
        const { nodeId, property, styleId } = msg;
        const node = figma.getNodeById(nodeId);
        if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') {
            figma.ui.postMessage({ type: 'apply-style-result', ok: false, nodeId, error: 'Node not found' });
            return;
        }
        try {
            const scene = node;
            switch (property) {
                case 'fill':
                    if ('fillStyleId' in scene)
                        scene.fillStyleId = styleId;
                    break;
                case 'stroke':
                    if ('strokeStyleId' in scene)
                        scene.strokeStyleId = styleId;
                    break;
                case 'typography':
                    if (scene.type === 'TEXT')
                        scene.textStyleId = styleId;
                    break;
                case 'effect':
                    if ('effectStyleId' in scene)
                        scene.effectStyleId = styleId;
                    break;
            }
            // Re-scan the single node so the UI can drop it if the issue is resolved.
            const updatedPaints = getRawPaintValues(scene);
            const updatedText = getRawTextStyles(scene);
            const updatedEffects = getRawEffectValues(scene);
            const stillHasIssue = updatedPaints.length > 0 || updatedText.length > 0 || updatedEffects.length > 0;
            figma.ui.postMessage({ type: 'apply-style-result', ok: true, nodeId, property, stillHasIssue });
        }
        catch (err) {
            figma.ui.postMessage({
                type: 'apply-style-result',
                ok: false,
                nodeId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
};

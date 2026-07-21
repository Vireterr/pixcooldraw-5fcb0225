import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback, Component, type ReactNode } from "react";
import { GIFEncoder, quantize, applyPalette } from "gifenc";
// PIXI v7 specifically (npm i pixi.js@^7) — v8 dropped/destabilized BaseTexture.fromBuffer, which is
// the exact primitive the main canvas blit below relies on to push the CPU pixel buffer to the GPU.
import * as PIXI from "pixi.js";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Living Pixels — Animated Brush Studio" },
      { name: "description", content: "Draw with living animated brushes, layers, undo/redo and quality export to GIF/MP4." },
    ],
  }),
  component: Index,
});

type BrushKind =
  | "ink"
  | "ribbon"
  | "lightning"
  | "pixelRain"
  | "pixelGlitch"
  | "mosaic"
  | "embers"
  | "fill"
  | "eraser"
  | "eyedropper";

type ModeKind = "normal" | "rainbow" | "gradient" | "pulse" | "spray" | "mirror" | "glitch" | "rgbShift" | "chrome";

interface StrokePoint { x: number; y: number; t: number; pressure?: number }

interface Stroke {
  id: number;
  kind: BrushKind;
  mode: ModeKind;
  size: number;
  hue: number;
  speed: number;
  density: number;
  noise: number;
  intensity: number;
  dynamics: number;
  // Decouples mode animation (pulse's breathing rate, glitch's flicker rate) from the brush's own
  // `speed` (which drives the BRUSH's physical drawing dynamics — ink wobble, rain fall, dt scaling).
  // Before this, every mode's color animation was forced to run at whatever rate the brush's speed
  // slider happened to be at, with no independent control — this is that independent control.
  // Rainbow and gradient modes keep their own separate speed sliders (rainbowFlowSpeed/gradientSpeed)
  // unchanged; this only applies to modes that had no speed control of their own at all.
  modeSpeed: number;
  rainbowFlow: boolean;
  rainbowFlowSpeed: number;
  rainbowBlinkSpeed: number;
  gradientSpeed: number;
  gradientScale: number;
  gradientColors: { hue: number; weight: number }[];
  gradientAngle: number;
  // Set once when the stroke is created from the "Анимация" toggle's state at that moment — frozen
  // strokes render with time locked to their birth instant, so they paint once and never animate
  // again. Toggling the button later never touches strokes that already exist (see tick()/onDown()).
  frozen: boolean;
  points: StrokePoint[];
  born: number;
  // Real flood-fill data (kind === "fill" only): which pixels of the canvas, at the moment of the
  // click, got selected — run-length encoded (alternating not-filled/filled run lengths, starting
  // with a not-filled run) so a fill covering most of a large canvas doesn't bloat undo/redo history
  // the way a raw per-pixel boolean array would. fillW/fillH record the canvas size the mask was
  // built for; if the canvas is resized later the stale mask is simply skipped (see renderStroke).
  fillRuns?: number[];
  fillW?: number;
  fillH?: number;
  // transient per-brush buckets (not serialized in history)
  ink?: { phase: number };
  rain?: { x: number; y: number; vy: number; hue: number; len: number; seed: number }[];
  embers?: { x: number; y: number; hue: number; seed: number; period: number; bornAt: number; life: number }[];
  // Lazily decoded from fillRuns the first time this stroke is rendered (same lazy/cached pattern
  // as segCache below) — decoding a run-length list into a full pixel mask every single animation
  // frame would be wasted work since fillRuns never changes after the fill is made.
  fillMaskCache?: Uint8Array;
  // PERF: the tightest rectangle actually covered by the mask, computed once alongside
  // fillMaskCache (not serialized, rebuilt the same lazy way). A fill's mask is almost always a
  // small fraction of the full canvas, so every per-frame render loop below scans just this
  // rectangle instead of every pixel on the canvas.
  fillBBox?: { x0: number; y0: number; x1: number; y1: number };
  // PERF: cached per-segment geometry for ink/ribbon (nx,ny = unit normal, len = segment length,
  // num = interpolation steps) — these never change once a segment is finalized, only the point
  // count grows while actively drawing. Built lazily, extended as new points arrive, reset by
  // eraseAt() whenever points get removed/reindexed (see there for why).
  segCache?: { nx: number; ny: number; len: number; num: number }[];
  // PERF (frozen strokes only): a one-time full-canvas-sized render of this stroke, built the first
  // time it's drawn while s.frozen is true. From then on tick() blits only this cache's touched
  // pixels instead of recomputing the stroke's animation math every frame — safe because a frozen
  // stroke's output never changes ONCE ITS POINTS STOP GROWING. Invalidated (set back to null) by
  // eraseAt() when this stroke's points change, so a partially-erased frozen stroke re-bakes instead
  // of showing stale pixels. Also carries pointCount so the bake/composite call sites can detect a
  // still-in-progress frozen stroke (points still being added while the pointer drags) and rebuild
  // instead of freezing on whatever partial path existed at the very first animation frame after
  // the stroke was born. Never serialized — always rebuilt lazily after undo/redo since deserialized
  // strokes are fresh objects.
  bakedCache?: { data: Uint8ClampedArray; alpha: Uint8ClampedArray; touched: number[]; pointCount: number } | null;
}

interface Layer {
  id: number;
  name: string;
  visible: boolean;
  strokes: Stroke[];
  // Imported raster (PNG/JPG/GIF — GIF only its first frame, since decoding it is just an <img>
  // draw, not a real animated-GIF decoder). Stored as a data URL (serializable, survives
  // undo/redo/JSON history) so re-importing isn't needed after an undo.
  image?: { url: string } | null;
  // Transient (never serialized, rebuilt lazily — same pattern as Stroke.bakedCache/fillMaskCache):
  // the actual decoded <img>, built once per `image.url` seen.
  imageEl?: HTMLImageElement;
  // Transient live-preview pixel cache: imageEl drawn "contain"-fit into an offscreen canvas at the
  // CURRENT live canvas size (imagePixelsW/H record that size so a resize invalidates and rebuilds
  // it). The live tick loop paints raw bytes (no ctx), so it needs real pixels, not just the <img>;
  // exports use ctx.drawImage on imageEl directly instead (see renderScene) since that respects the
  // export's resolution/scale natively instead of upscaling this lower-res cache.
  imagePixels?: Uint8ClampedArray | null;
  imagePixelsW?: number;
  imagePixelsH?: number;
}

const BRUSHES: { id: BrushKind; label: string }[] = [
  { id: "ink", label: "Чернила" },
  { id: "ribbon", label: "Лента" },
  { id: "lightning", label: "Молния" },
  { id: "pixelRain", label: "Пикс. дождь" },
  { id: "pixelGlitch", label: "Глитч" },
  { id: "mosaic", label: "Мозаика" },
  { id: "embers", label: "Угли" },
];

// Not brushes in the "animated stroke" sense — one-shot/utility actions on the canvas. Kept as a
// separate list/UI section from BRUSHES purely for organization; `brush` state and every render/
// pointer-handling code path that switches on BrushKind is untouched, since fill/eraser/eyedropper
// are still members of the same BrushKind union.
const TOOLS: { id: BrushKind; label: string }[] = [
  { id: "fill", label: "Заливка" },
  { id: "eraser", label: "Ластик" },
  { id: "eyedropper", label: "Пипетка" },
];

const MODES: { id: ModeKind; label: string }[] = [
  { id: "normal", label: "Обычный" },
  { id: "rainbow", label: "Радуга" },
  { id: "gradient", label: "Градиент" },
  { id: "pulse", label: "Пульс" },
  { id: "spray", label: "Распыление" },
  { id: "mirror", label: "Зеркало" },
  { id: "glitch", label: "Глитч" },
  { id: "rgbShift", label: "RGB сдвиг" },
  { id: "chrome", label: "Хром" },
];

const GIF_PRESETS = {
  low:    { colors: 64,  label: "Низкое" },
  medium: { colors: 128, label: "Среднее" },
  high:   { colors: 256, label: "Высокое" },
} as const;
type GifQ = keyof typeof GIF_PRESETS;

const MP4_PRESETS = {
  low:    { bps: 2_500_000, label: "Низкое" },
  medium: { bps: 6_000_000, label: "Среднее" },
  high:   { bps: 12_000_000, label: "Высокое" },
} as const;
type Mp4Q = keyof typeof MP4_PRESETS;

const SCALES = [1, 2, 3] as const;

const HISTORY_LIMIT = 60;
const MAX_POINTS_PER_STROKE = 600;

// ==== PERF: tunables ====
// Global cap on live pixelRain particles across the ENTIRE scene (was 200 PER STROKE before).
const GLOBAL_RAIN_CAP = 2000;

// FIX: the previous version multiplied n*n*15731 in ordinary floating-point arithmetic before
// masking to 32 bits. That product exceeds 2^53 (float64's exact-integer limit) for almost any
// realistic seed — pixel coordinates, a growing animation-time counter — at which point the bits
// the final "&" needs have already been silently rounded away, and hash() collapses to a CONSTANT
// 1.0 for every call past roughly n > ~1000 (verified: was returning exactly 1.0 for 99%+ of a
// 100,000-sample sweep). That flattened dither/mosaic's per-cell "grain" texture to near-uniform
// once its inputs got big, froze pixelGlitch's per-frame slice jitter after the first couple
// seconds of runtime, and heavily biased the new "Глитч" mode's 3-way hue pick toward one branch
// almost all the time. Math.imul does real 32-bit integer multiplication with exact wraparound —
// no float precision loss, however large n gets.
function hash(n: number) {
  n = n | 0;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b) | 0;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b) | 0;
  n = (n ^ (n >>> 16)) | 0;
  return 1 - ((n & 0x7fffffff) / 1073741823.5);
}
// PERF: precomputed noise table. hash() itself is cheap, but it's called once per grid-cell for
// dither grain, and that argument (gx + gy*7) is an INTEGER grid coordinate that never changes
// frame to frame for a given cell — the exact same result gets recomputed every single frame for
// every on-screen cell. Build the same values once into a lookup table and index into it instead.
// (Only used where the hash's input is this kind of frame-invariant integer — the other hash()
// call sites feed it a continuously-changing phase/time value, where a static table would visibly
// quantize what's supposed to be smooth motion, so those keep calling hash() live.)
const NOISE_TABLE_SIZE = 4096;
const noiseTable = new Float32Array(NOISE_TABLE_SIZE);
for (let i = 0; i < NOISE_TABLE_SIZE; i++) noiseTable[i] = hash(i);
function noiseAt(n: number): number {
  return noiseTable[((n % NOISE_TABLE_SIZE) + NOISE_TABLE_SIZE) % NOISE_TABLE_SIZE];
}

// ==== Custom gradient tool: color <-> hue conversion + multi-stop interpolation ====
function hexToHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0;
  if (max !== min) {
    const d = max - min;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return Math.round(h);
}
function hueToHex(hue: number): string {
  const s = 0.9, l = 0.6;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (hue < 60) { r = c; g = x; b = 0; }
  else if (hue < 120) { r = x; g = c; b = 0; }
  else if (hue < 180) { r = 0; g = c; b = x; }
  else if (hue < 240) { r = 0; g = x; b = c; }
  else if (hue < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
// Cyclic interpolation across N user-picked hues, each with its own WEIGHT controlling how much
// of the 0..1 cycle it occupies (higher weight = that color dominates a larger stretch, and the
// transition into/out of it takes proportionally longer). t travels continuously (not clamped to
// [0,1]), so feeding it a growing time-based value makes the palette flow endlessly along the stroke.
// Always takes the shortest hue-wheel arc between adjacent stops (e.g. blue -> magenta goes
// straight through violet, never the long way through every intervening hue) — an honest direct
// transition between the colors actually picked, nothing extra.
function sampleGradient(stops: { hue: number; weight: number }[], t: number): number {
  const n = stops.length;
  if (n === 0) return 0;
  if (n === 1) return stops[0].hue;
  const totalW = stops.reduce((a, s) => a + Math.max(0.05, s.weight), 0);
  const norm = ((t % 1) + 1) % 1;
  let acc = 0;
  let idx = n - 1;
  let segStart = 0, segEnd = 1;
  for (let i = 0; i < n; i++) {
    const w = Math.max(0.05, stops[i].weight) / totalW;
    const next = acc + w;
    if (norm < next || i === n - 1) { idx = i; segStart = acc; segEnd = next; break; }
    acc = next;
  }
  const frac = segEnd > segStart ? (norm - segStart) / (segEnd - segStart) : 0;
  const c0 = stops[idx].hue;
  const c1 = stops[(idx + 1) % n].hue;
  const diff = ((c1 - c0 + 540) % 360) - 180; // shortest angular path between the two stops
  return (c0 + diff * frac + 360) % 360;
}

// ==== PERF: pixel-buffer painting (replaces per-pixel ctx.fillStyle/fillRect calls) ====
// Every brush used to do `ctx.fillStyle = \`hsla(...)\`; ctx.fillRect(x,y,w,h);` per pixel-block —
// building and parsing a color string on the canvas API is real, measurable overhead at thousands
// of calls/frame. paint() instead writes straight into a raw RGBA byte buffer (blended in memory,
// same source-over alpha math the canvas itself uses), and the whole frame is flushed to the
// screen with ONE putImageData call. Pixel-for-pixel identical output, far cheaper to compute.
// Exports keep using the direct-to-canvas path (mode: "ctx") since createLinearGradient etc. are
// genuinely cheaper done natively for a one-off render — export speed was never the complaint.
interface PaintTarget {
  mode: "buffer" | "ctx" | "iso";
  buf?: Uint8ClampedArray;
  // PERF: a Uint32Array view over the same ArrayBuffer as `buf`, "buffer" mode only. Lets paint()
  // write a fully-opaque pixel as ONE 32-bit store instead of four separate byte stores — only
  // valid when there's no real blending to do (alpha >= 1), since it overwrites all 4 channels at
  // once with no mixing against what's underneath.
  buf32?: Uint32Array;
  bw?: number;
  bh?: number;
  ctx?: CanvasRenderingContext2D;
  // "iso" mode only: a real per-pixel alpha channel (0-255), tracked separately because "buffer"
  // mode's buf always carries alpha=255 as a "something was painted here" flag, not true opacity —
  // that shortcut only works when compositing straight onto an already-opaque background. Baking a
  // stroke in isolation starts from full transparency, so touches need real "over" compositing to
  // combine correctly no matter how many times the same stroke paints over itself.
  alphaBuf?: Uint8ClampedArray;
  // Set for the duration of one stroke's render pass when its mode is "Распыление" (spray) AND its
  // brush isn't "ink" (which already has its own bespoke airbrush scatter, done differently, inside
  // its own point loop). Every paint()/paintRGB() call then randomly skips or jitters — the generic
  // mechanism that makes spray actually do something for EVERY other brush (ribbon, dither, mosaic,
  // lightning, embers, the glitch brush...), instead of silently having no effect on all of them.
  spray?: number;
  // Probability a given spray-scattered paint() call actually lands, instead of being randomly
  // skipped — set alongside `spray` above. Without this every brush's spray looked identical
  // regardless of the "Плотность" (density) slider, since the skip chance was a hardcoded constant.
  sprayKeep?: number;
  // Set for the duration of one stroke's render pass when its MODE is "RGB сдвиг" — same generic
  // pattern as spray/sprayKeep above, so it works for every brush automatically instead of needing
  // brush-specific code. Holds the pixel offset magnitude; paint() then splits that one call's
  // color into its real r/g/b channels and blits each channel at a slightly different position
  // (true chromatic-aberration-style misregistration), instead of tinting everything one flat hue.
  rgbShift?: number;
  // Set for the duration of one stroke's render pass when its MODE is "Глитч" — same generic
  // pattern as spray/rgbShift above. Holds the pixel offset magnitude; paint() then draws the
  // SAME call three times, tinted 0°/+120°/+240° off the real hue, each copy at a slightly
  // different x/y — a spatial misalignment (like a badly registered color print), which is what
  // actually reads as glitch. This used to be baked into just the pixelGlitch brush; now every
  // brush that calls paint() gets it automatically when this mode is selected.
  glitchSplit?: number;
  // Set for the duration of one stroke's render pass when its MODE is "Хром" — same generic
  // per-paint-call pattern as spray/rgbShift/glitchSplit above. Simulates a metallic sheen: a
  // traveling bright/dark band (a sine wave projected along the stroke's own direction) drains
  // saturation toward silver and pushes lightness toward the band's highlight/shadow extremes,
  // independent of whichever hue the brush/mode would otherwise have painted. chromeFreq being
  // unset/0 means the mode is off — checked instead of a separate boolean so there's only one
  // thing to clear in the cleanup below.
  chromeCos?: number;
  chromeSin?: number;
  chromeFreq?: number;
  chromePhase?: number;
  // 0..1 — how much the "Хром" sheen's hue rotates as it sweeps (see paint()'s chrome branch).
  // Driven by the stroke's own "Шум" slider; 0 = plain single-hue metal.
  chromeColorAmt?: number;
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  s = Math.min(1, Math.max(0, s / 100));
  l = Math.min(1, Math.max(0, l / 100));
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}
// PERF: memoized HSL->RGB. The math above is cheap per call in isolation, but paint() calls it
// once per grid-cell, and a busy frame across several live strokes can add up to thousands of
// calls. Real (h, s, l) triples repeat constantly — same hue sampled a moment later, same
// lightness edge-falloff value reused across many cells of the same stroke — so most calls are
// pure repeat work. Round to whole-degree hue / whole-percent s & l (finer than the input ever
// meaningfully varies, and far finer than an 8-bit RGB channel can visibly distinguish) and cache
// the result: same visual output, but a repeat lookup is an array read instead of the full formula.
// Grows to at most 360*101*101 entries (~3.7M) in the most degenerate case, bounded and harmless.
const hslRgbCache = new Map<number, [number, number, number]>();
function getHslRgb(h: number, s: number, l: number): [number, number, number] {
  const hi = Math.round(((h % 360) + 360) % 360) % 360;
  const si = Math.max(0, Math.min(100, Math.round(s)));
  const li = Math.max(0, Math.min(100, Math.round(l)));
  const key = (hi * 101 + si) * 101 + li;
  let v = hslRgbCache.get(key);
  if (v === undefined) {
    v = hslToRgb(hi, si, li);
    hslRgbCache.set(key, v);
  }
  return v;
}
// Inverse of the above — used only by the eyedropper (sample a pixel off the actual canvas, hand
// back the hue this app's single-hue color model can use). Saturation/lightness of the sampled
// pixel are intentionally dropped: every brush already picks its own s/l per effect, all that's
// shared app-wide is one hue value from the palette slider.
function rgbToHue(r: number, g: number, b: number): number {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const d = max - min;
  if (d === 0) return 0; // grayscale pixel — no meaningful hue, keep whatever's currently selected
  let h: number;
  if (max === rf) h = ((gf - bf) / d) % 6;
  else if (max === gf) h = (bf - rf) / d + 2;
  else h = (rf - gf) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
// Real Porter-Duff "over" for one pixel of an isolated (non-opaque) buffer — used only while baking
// a frozen stroke, which happens once per stroke rather than every frame, so the extra per-pixel
// cost here is a one-time bill instead of a recurring one.
function blendIsoPixel(buf: Uint8ClampedArray, alphaBuf: Uint8ClampedArray, idx: number, aIdx: number, r: number, g: number, b: number, srcA: number) {
  const dstA = alphaBuf[aIdx] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  const ia = dstA * (1 - srcA);
  buf[idx] = (r * srcA + buf[idx] * ia) / outA;
  buf[idx + 1] = (g * srcA + buf[idx + 1] * ia) / outA;
  buf[idx + 2] = (b * srcA + buf[idx + 2] * ia) / outA;
  alphaBuf[aIdx] = outA * 255;
}
// Plot a solid sizeW×sizeH block at (x,y) in hue/sat%/light%/alpha — the ONE call brush code makes
// instead of touching ctx.fillStyle/fillRect directly. Same call works for either painting mode.
// Paint a solid block from RAW r/g/b (0-255) instead of h/s/l — used for effects that need to
// isolate one real color channel of an actual picked color (chromatic-aberration-style channel
// split), where converting through hue rotation would substitute an unrelated color instead of a
// true single-channel tint of the color that's actually there.
function paintRGB(target: PaintTarget, x: number, y: number, sizeW: number, sizeH: number, r: number, g: number, b: number, a: number) {
  if (a <= 0) return;
  if (target.spray) {
    if (Math.random() > (target.sprayKeep ?? 0.55)) return;
    x += (Math.random() - 0.5) * target.spray;
    y += (Math.random() - 0.5) * target.spray;
  }
  if (target.mode === "ctx") {
    target.ctx!.fillStyle = `rgba(${r},${g},${b},${a})`;
    target.ctx!.fillRect(x, y, sizeW, sizeH);
    return;
  }
  const buf = target.buf!, bw = target.bw!, bh = target.bh!;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(bw, Math.floor(x) + Math.max(1, Math.round(sizeW)));
  const y1 = Math.min(bh, Math.floor(y) + Math.max(1, Math.round(sizeH)));
  if (x1 <= x0 || y1 <= y0) return;
  const alpha = Math.min(1, a);
  if (target.mode === "iso") {
    const alphaBuf = target.alphaBuf!;
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const idx = (yy * bw + xx) * 4;
        blendIsoPixel(buf, alphaBuf, idx, yy * bw + xx, r, g, b, alpha);
      }
    }
    return;
  }
  const ia = 1 - alpha;
  for (let yy = y0; yy < y1; yy++) {
    let idx = (yy * bw + x0) * 4;
    for (let xx = x0; xx < x1; xx++, idx += 4) {
      buf[idx] = r * alpha + buf[idx] * ia;
      buf[idx + 1] = g * alpha + buf[idx + 1] * ia;
      buf[idx + 2] = b * alpha + buf[idx + 2] * ia;
      buf[idx + 3] = 255;
    }
  }
}
function paint(target: PaintTarget, x: number, y: number, sizeW: number, sizeH: number, h: number, s: number, l: number, a: number) {
  if (a <= 0) return;
  // Generic "Распыление" scatter: random sparse skip + small positional jitter, applied at the one
  // place every brush's coloring funnels through — so spray mode does something for whichever brush
  // is active, without needing brush-specific spray code everywhere.
  if (target.spray) {
    if (Math.random() > (target.sprayKeep ?? 0.55)) return;
    x += (Math.random() - 0.5) * target.spray;
    y += (Math.random() - 0.5) * target.spray;
  }
  // Generic "Хром" mode: recolor toward a metallic sheen BEFORE the real color is computed —
  // unlike spray/glitchSplit/rgbShift above, this doesn't fork into multiple paint calls, it just
  // reshapes h/s/l for the one call about to happen. `band` is a plain sine of a spatial
  // projection — always a real -1..1 swing, so the highlight/shadow range can never collapse to a
  // single flat value the way an accumulated multi-term threshold could (see the pixelDither
  // rewrite for why that failure mode matters).
  // REWORKED: this used to slam saturation down to a flat ~25% regardless of the picked hue, so
  // changing "Оттенок" barely changed anything — every color looked like the same generic silver.
  // Real metal doesn't desaturate uniformly — it goes WHITE at the highlight (where the light
  // source reflects straight back) and shows its true, richly saturated color in the shadow. So
  // `band` now drives lightness AND saturation together: toward the highlight (`hi`) lightness
  // rises toward white and saturation drops (a blown-out reflection); toward the shadow (`lo`)
  // lightness falls and saturation RISES above the base (the picked color reads at its deepest and
  // most vivid there) — anchored on whatever hue was actually picked, copper stays copper, blue
  // steel stays blue. "Шум" now only adds a small, tight hue drift (±25°, not the old ±70°) for a
  // bit of iridescence at the edges of that same color — enough to feel alive without drifting
  // into an unrelated hue that fights the color you chose.
  if (target.chromeFreq) {
    const proj = (x * (target.chromeCos ?? 1) + y * (target.chromeSin ?? 0)) * target.chromeFreq + (target.chromePhase ?? 0);
    const band = Math.sin(proj);
    const colorAmt = target.chromeColorAmt ?? 0;
    const colorBand = Math.sin(proj * 1.7 + 2.1);
    h = h + colorBand * 25 * colorAmt;
    const hi = Math.max(0, band);  // 0..1 toward the highlight
    const lo = Math.max(0, -band); // 0..1 toward the shadow
    l = Math.max(4, Math.min(97, l * 0.4 + 50 + hi * 45 - lo * 30));
    s = Math.max(0, Math.min(100, s * (0.7 + lo * 0.55 - hi * 0.45)));
  }
  const [r, g, b] = getHslRgb(h, s, l);
  // Generic "Глитч" mode: paint the SAME call three times, tinted 0°/+120°/+240° off the real
  // hue, each copy offset a few pixels apart along x — a spatial misalignment (like a badly
  // registered color print), not a color that cycles over time. This is exactly what the
  // pixelGlitch brush used to do only for itself; living here means every brush gets it.
  if (target.glitchSplit) {
    const off = target.glitchSplit;
    const [r1, g1, b1] = getHslRgb((h + 120) % 360, s, l);
    const [r2, g2, b2] = getHslRgb((h + 240) % 360, s, l);
    paintRGB(target, x - off, y, sizeW, sizeH, r, g, b, a);
    paintRGB(target, x, y, sizeW, sizeH, r1, g1, b1, a);
    paintRGB(target, x + off, y, sizeW, sizeH, r2, g2, b2, a);
    return;
  }
  // Generic "RGB сдвиг" mode: instead of one flat-colored blit, split the real color into its r/g/b
  // channels and paint each one offset a few pixels apart — a genuine channel misregistration
  // (magenta/cyan fringing) rather than a hue-rotation trick, and because it lives here inside the
  // one paint() every brush already calls through, it works for any brush, not just one dedicated
  // glitch brush. Mirrors the pixelGlitch brush's own real r/g/b split (see there), just applied
  // generically at the shared color-plotting call site instead of that one brush's bespoke loop.
  if (target.rgbShift) {
    const off = target.rgbShift;
    paintRGB(target, x - off, y, sizeW, sizeH, r, 0, 0, a);
    paintRGB(target, x, y, sizeW, sizeH, 0, g, 0, a);
    paintRGB(target, x + off, y, sizeW, sizeH, 0, 0, b, a);
    return;
  }
  if (target.mode === "ctx") {
    target.ctx!.fillStyle = `hsla(${h}, ${s}%, ${l}%, ${a})`;
    target.ctx!.fillRect(x, y, sizeW, sizeH);
    return;
  }
  const buf = target.buf!, bw = target.bw!, bh = target.bh!;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(bw, Math.floor(x) + Math.max(1, Math.round(sizeW)));
  const y1 = Math.min(bh, Math.floor(y) + Math.max(1, Math.round(sizeH)));
  if (x1 <= x0 || y1 <= y0) return;
  const alpha = Math.min(1, a);
  if (target.mode === "iso") {
    const alphaBuf = target.alphaBuf!;
    for (let yy = y0; yy < y1; yy++) {
      let idx = (yy * bw + x0) * 4, aIdx = yy * bw + x0;
      for (let xx = x0; xx < x1; xx++, idx += 4, aIdx++) blendIsoPixel(buf, alphaBuf, idx, aIdx, r, g, b, alpha);
    }
    return;
  }
  const ia = 1 - alpha;
  // PERF: alpha >= 1 means "just overwrite, no blending with what's underneath" — the exact case a
  // packed 32-bit write handles in one store per pixel (R|G<<8|B<<16|A<<24 in little-endian byte
  // order) instead of four separate byte stores with a multiply-add each. Many brushes paint fully
  // opaque blocks (grid cells at alphaMul effectively 1, or edge=1 falloff center pixels), so this
  // path is hit constantly. Falls back to the per-byte blend below whenever real blending is needed.
  if (ia <= 0 && target.buf32) {
    const packed = (255 << 24) | (b << 16) | (g << 8) | r;
    const buf32 = target.buf32;
    for (let yy = y0; yy < y1; yy++) {
      let p = yy * bw + x0;
      for (let xx = x0; xx < x1; xx++, p++) buf32[p] = packed;
    }
    return;
  }
  for (let yy = y0; yy < y1; yy++) {
    let idx = (yy * bw + x0) * 4;
    for (let xx = x0; xx < x1; xx++, idx += 4) {
      buf[idx] = r * alpha + buf[idx] * ia;
      buf[idx + 1] = g * alpha + buf[idx + 1] * ia;
      buf[idx + 2] = b * alpha + buf[idx + 2] * ia;
      buf[idx + 3] = 255;
    }
  }
}

// ==== Imported layer image (PNG/JPG/GIF-first-frame) ====
// Lazily (re)creates the decoded <img> for a layer whenever its stored data URL changes, mirroring
// the lazy-cache pattern used for Stroke.bakedCache/fillMaskCache elsewhere in this file. Decoding
// an <img> is asynchronous, so right after import (or right after undo/redo hands back a fresh
// deserialized layer with no cached element yet) this can return null for a frame or two until the
// image finishes loading — callers just skip painting it for those frames.
function ensureLayerImageEl(layer: Layer): HTMLImageElement | null {
  if (!layer.image) return null;
  if (!layer.imageEl || layer.imageEl.dataset.srcUrl !== layer.image.url) {
    const img = new Image();
    img.src = layer.image.url;
    img.dataset.srcUrl = layer.image.url;
    layer.imageEl = img;
    layer.imagePixels = null;
  }
  return layer.imageEl.complete && layer.imageEl.naturalWidth > 0 ? layer.imageEl : null;
}
// Live-preview-only pixel cache: draws the imported image "contain"-fit (centered, aspect
// preserved, transparent padding) into an offscreen canvas sized to the CURRENT live canvas, then
// caches the raw RGBA bytes so the tick loop can blit them directly instead of re-drawing +
// re-reading every single frame. Invalidated whenever the live canvas is resized.
function ensureLayerImagePixels(layer: Layer, w: number, h: number): Uint8ClampedArray | null {
  const el = ensureLayerImageEl(layer);
  if (!el) return null;
  if (layer.imagePixels && layer.imagePixelsW === w && layer.imagePixelsH === h) return layer.imagePixels;
  const off = document.createElement("canvas");
  off.width = w; off.height = h;
  const octx = off.getContext("2d")!;
  const fitScale = Math.min(w / el.naturalWidth, h / el.naturalHeight);
  const dw = el.naturalWidth * fitScale, dh = el.naturalHeight * fitScale;
  octx.drawImage(el, (w - dw) / 2, (h - dh) / 2, dw, dh);
  layer.imagePixels = new Uint8ClampedArray(octx.getImageData(0, 0, w, h).data);
  layer.imagePixelsW = w; layer.imagePixelsH = h;
  return layer.imagePixels;
}
// Composite imported-image pixels onto the live (always-opaque) frame buffer — real "over"
// blending using the image's own alpha, same math paint()/compositeBakedStroke use.
function blitLayerImage(buf: Uint8ClampedArray, img: Uint8ClampedArray) {
  for (let i = 0; i < img.length; i += 4) {
    const a = img[i + 3] / 255;
    if (a <= 0) continue;
    const ia = 1 - a;
    buf[i] = img[i] * a + buf[i] * ia;
    buf[i + 1] = img[i + 1] * a + buf[i + 1] * ia;
    buf[i + 2] = img[i + 2] * a + buf[i + 2] * ia;
    buf[i + 3] = 255;
  }
}
// Same, but onto a still-transparent destination (the 3D layer-preview buffers) — needs the real
// "over" formula against whatever alpha is already there.
function blitLayerImageIso(buf: Uint8ClampedArray, alphaBuf: Uint8ClampedArray, img: Uint8ClampedArray) {
  for (let i = 0, ai = 0; i < img.length; i += 4, ai++) {
    const a = img[i + 3] / 255;
    if (a <= 0) continue;
    blendIsoPixel(buf, alphaBuf, i, ai, img[i], img[i + 1], img[i + 2], a);
  }
}


// Reads whatever is actually on screen at the click point (not brush params) and selects either
// the connected region of similar color ("Связная") or every matching pixel on the canvas
// regardless of position ("Всё выделение"), within a tolerance threshold (0..255, max channel diff).
function pixelAt(buf: Uint8ClampedArray, w: number, x: number, y: number): [number, number, number] {
  const idx = (y * w + x) * 4;
  return [buf[idx], buf[idx + 1], buf[idx + 2]];
}
function computeFloodMask(
  buf: Uint8ClampedArray, w: number, h: number, sx: number, sy: number,
  tolerance: number, contiguous: boolean
): Uint8Array {
  const mask = new Uint8Array(w * h);
  const [tr, tg, tb] = pixelAt(buf, w, sx, sy);
  const matches = (x: number, y: number) => {
    const idx = (y * w + x) * 4;
    return Math.max(Math.abs(buf[idx] - tr), Math.abs(buf[idx + 1] - tg), Math.abs(buf[idx + 2] - tb)) <= tolerance;
  };
  if (!contiguous) {
    for (let i = 0, y = 0; y < h; y++) for (let x = 0; x < w; x++, i++) if (matches(x, y)) mask[i] = 1;
    return mask;
  }
  // Stack-based scanline flood fill (4-connected) — expands each seed left/right along its row,
  // then scans the rows directly above/below that span for new seeds. Far fewer stack pushes than
  // a naive 4-neighbor flood fill, which matters at up to millions of pixels on a large canvas.
  const stack: number[] = [sy * w + sx];
  mask[sy * w + sx] = 1;
  while (stack.length) {
    const seed = stack.pop()!;
    const y = Math.floor(seed / w);
    let xl = seed - y * w, xr = xl;
    while (xl > 0 && !mask[y * w + xl - 1] && matches(xl - 1, y)) { xl--; mask[y * w + xl] = 1; }
    while (xr < w - 1 && !mask[y * w + xr + 1] && matches(xr + 1, y)) { xr++; mask[y * w + xr] = 1; }
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      let inSpan = false;
      for (let xx = xl; xx <= xr; xx++) {
        const idx = ny * w + xx;
        if (!mask[idx] && matches(xx, ny)) {
          mask[idx] = 1;
          if (!inSpan) { stack.push(idx); inSpan = true; }
        } else {
          inSpan = false;
        }
      }
    }
  }
  return mask;
}
// Run-length encode a 0/1 mask as alternating (not-filled, filled, not-filled, filled, ...) run
// lengths, always starting with a (possibly zero) not-filled run. Cheap to store in undo/redo
// history even for a fill that covers most of a large canvas — far smaller than a raw byte array.
function encodeMaskRLE(mask: Uint8Array): number[] {
  const runs: number[] = [];
  let cur = 0, runLen = 0;
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 1 : 0;
    if (v === cur) runLen++;
    else { runs.push(runLen); cur = v; runLen = 1; }
  }
  runs.push(runLen);
  return runs;
}
function decodeMaskRLE(runs: number[], size: number): Uint8Array {
  const mask = new Uint8Array(size);
  let pos = 0, v = 0;
  for (const runLen of runs) {
    if (v) mask.fill(1, pos, pos + runLen);
    pos += runLen;
    v = 1 - v;
  }
  return mask;
}


// Falls back to 0 for a stroke with no real movement (e.g. a single-click "Заливка" — in that
// case the gradientAngle slider becomes the sole, absolute angle control since there's no
// natural stroke direction to derive from).
function strokeAutoAngleDeg(pts: StrokePoint[]): number {
  if (pts.length < 2) return 0;
  const p0 = pts[0], p1 = pts[pts.length - 1];
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  if (Math.hypot(dx, dy) < 1) return 0;
  return ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
}

let strokeIdCounter = 0;
let layerIdCounter = 0;

// PERF: history used to re-JSON.stringify EVERY stroke's full point list on EVERY pushHistory()
// call, even for strokes that hadn't changed since the last snapshot — cost grew with the whole
// picture's total data, not with what was actually drawn since the last undo step. This cache
// keyed by stroke object identity (WeakMap — entries vanish on their own once a stroke is
// discarded, no manual cleanup needed) remembers each stroke's serialized JSON fragment and only
// recomputes it when the stroke's geometry actually changes.
// Safe because strokes are effectively append-only once created: after a stroke is finished
// (pushHistory happens once per completed stroke, at pointer-up — never mid-draw), its style
// fields (hue/size/mode/etc.) are never mutated again — only its POINTS can still change later,
// via erase/move/rotate/scale. Every one of those mutation sites already resets segCache/bakedCache
// to invalidate cached geometry/render state (search "s.segCache = undefined") — this cache is
// invalidated at those exact same sites, so it can never go stale.
const strokeSerCache = new WeakMap<Stroke, string>();
function serializeStroke(s: Stroke): string {
  const cached = strokeSerCache.get(s);
  if (cached !== undefined) return cached;
  const json = JSON.stringify({
    id: s.id, kind: s.kind, mode: s.mode, size: s.size, hue: s.hue,
    speed: s.speed, density: s.density, noise: s.noise,
    intensity: s.intensity, dynamics: s.dynamics, modeSpeed: s.modeSpeed,
    rainbowFlow: s.rainbowFlow, rainbowFlowSpeed: s.rainbowFlowSpeed, rainbowBlinkSpeed: s.rainbowBlinkSpeed, gradientSpeed: s.gradientSpeed, gradientScale: s.gradientScale,
    gradientColors: s.gradientColors, gradientAngle: s.gradientAngle,
    frozen: s.frozen,
    points: s.points, born: s.born,
    fillRuns: s.fillRuns, fillW: s.fillW, fillH: s.fillH,
  });
  strokeSerCache.set(s, json);
  return json;
}

// Strip transient fields for history snapshots. Layer-level JSON is still rebuilt fresh every
// call (layers/strokes-array shape changes constantly — adds/removes/reorders), but each
// individual stroke's fragment comes from the cache above instead of being re-stringified.
function serializeLayers(layers: Layer[]): string {
  const layerParts = layers.map(l => {
    const strokeParts = l.strokes.map(serializeStroke).join(",");
    return `{"id":${l.id},"name":${JSON.stringify(l.name)},"visible":${l.visible},"image":${JSON.stringify(l.image ?? null)},"strokes":[${strokeParts}]}`;
  });
  return `[${layerParts.join(",")}]`;
}
function deserializeLayers(str: string): Layer[] {
  return JSON.parse(str) as Layer[];
}



// ==== PERF: render options ====
// step: for ink/ribbon, how many points to skip per iteration during LIVE preview (1 = full quality,
//       used always for exports). Scales automatically with total scene load.
// rainBudget: a MUTABLE shared object so pixelRain strokes across the whole frame collectively respect
//       one global particle cap instead of each stroke keeping its own separate 200-particle pool.
interface RenderOpts {
  step: number;
  rainBudget: { left: number };
}
const FULL_QUALITY_OPTS: RenderOpts = { step: 1, rainBudget: { left: Infinity } };

// PERF: lazily build/extend the per-segment geometry cache on a stroke (used by ink/ribbon). Only
// ever APPENDS — a segment that's already cached never changes (points aren't mutated in place,
// only added by drawing or removed wholesale by the eraser, which resets segCache — see eraseAt).
// So this loop only actually does work for brand-new segments; for a finished stroke it's a no-op.
function getSegCache(s: Stroke, pts: StrokePoint[], grid: number): { nx: number; ny: number; len: number; num: number }[] {
  if (!s.segCache) s.segCache = [];
  const cache = s.segCache;
  while (cache.length < pts.length - 1) {
    const i = cache.length;
    const p = pts[i], nxt = pts[i + 1];
    const dx = nxt.x - p.x, dy = nxt.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    cache.push({ nx: -dy / len, ny: dx / len, len, num: Math.max(1, Math.floor(len / grid)) });
  }
  return cache;
}

// Without this, ANY uncaught error ANYWHERE in the app (a WebGL context that failed to allocate,
// a stray undefined access, anything) unmounts the entire React tree and leaves a blank page — no
// message, no way to tell what happened, "просто падает веб" with nothing to go on. This catches
// that, shows the actual error text (so it can actually be reported/fixed) and offers a recovery
// path that does NOT reload the tab — undo history lives only in memory (historyRef), so a hard
// reload would silently lose every stroke since the last export. "Продолжить" instead just clears
// the error and re-mounts the canvas editor fresh; strokes drawn before the crash are still gone
// (the crash could have happened mid-mutation, so there's no safe partial state to resume from) but
// at least a page reload isn't forced on top of that.
class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-[#05060c] p-6 text-center text-white">
          <div className="text-sm tracking-widest text-white/70">ЧТО-ТО СЛОМАЛОСЬ</div>
          <pre className="max-w-2xl overflow-auto rounded-md border border-white/10 bg-black/40 p-3 text-left text-[11px] text-red-300">
            {this.state.error.message}
            {this.state.error.stack ? "\n\n" + this.state.error.stack : ""}
          </pre>
          <div className="text-[11px] text-white/40">Скопируй текст выше — это и есть причина краша.</div>
          <button
            onClick={() => this.setState({ error: null })}
            className="rounded-md border border-white/15 bg-white/10 px-4 py-2 text-[11px] tracking-wider hover:bg-white/15"
          >
            Продолжить
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function Index() {
  return (
    <AppErrorBoundary>
      <IndexInner />
    </AppErrorBoundary>
  );
}

function IndexInner() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // PERF: one persistent RGBA buffer, reused every frame (reallocated only when canvas size changes)
  // instead of letting the canvas API do per-pixel work thousands of times a frame. Every brush still
  // paints into `data` exactly as before — the only thing that changed is how this buffer reaches the
  // screen (see pixiRef below): a GPU-uploaded PIXI.Sprite instead of ctx.putImageData.
  const pixelBufRef = useRef<{
    data: Uint8ClampedArray; w: number; h: number;
    buf32: Uint32Array; rainBudget: { left: number }; bufferTarget: PaintTarget;
  } | null>(null);
  // Owns the WebGL side of the main canvas: one Application bound to canvasRef's <canvas>, one
  // BufferResource-backed texture that wraps pixelBufRef's `data` array directly (no per-frame copy),
  // and one full-canvas Sprite showing it. The APPLICATION (and its one WebGL context) is created
  // ONCE — see pixiAppRef and the effects below — only the texture is rebuilt when canvasSize changes.
  const pixiAppRef = useRef<PIXI.Application | null>(null);
  const pixiRef = useRef<{
    app: PIXI.Application; baseTexture: PIXI.BaseTexture; sprite: PIXI.Sprite; w: number; h: number;
  } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // canvas size config
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({ w: 1280, h: 800 });

  // layers
  const [layers, setLayers] = useState<Layer[]>(() => [{
    id: ++layerIdCounter, name: "Слой 1", visible: true, strokes: [],
  }]);
  const [activeLayerId, setActiveLayerId] = useState<number>(() => layerIdCounter);
  const layersRef = useRef(layers);
  const activeLayerIdRef = useRef(activeLayerId);
  useEffect(() => { layersRef.current = layers; }, [layers]);
  useEffect(() => { activeLayerIdRef.current = activeLayerId; }, [activeLayerId]);

  // history
  const historyRef = useRef<string[]>([serializeLayers(layers)]);
  const historyIdxRef = useRef(0);
  const [historyVer, setHistoryVer] = useState(0);

  // PERF: running total of live pixelRain particles across the whole scene, updated incrementally
  // at every spawn/despawn point instead of re-scanned by summing every stroke's s.rain.length on
  // every single animation frame (that full scan used to run 60x/sec regardless of scene size).
  // Kept accurate by: (1) ++ on spawn and -- on despawn/erase — the normal per-frame paths — and
  // (2) an explicit recomputeRainCount() call at every place that removes strokes WITHOUT going
  // through those paths (undo, redo, clear layer/canvas, delete layer) — those are rare, one-off
  // events, so a full recount there is free, unlike doing it every frame.
  const rainCountRef = useRef(0);
  const recomputeRainCount = useCallback(() => {
    let total = 0;
    for (const layer of layersRef.current) {
      for (const s of layer.strokes) if (s.rain) total += s.rain.length;
    }
    rainCountRef.current = total;
  }, []);

  const pushHistory = useCallback(() => {
    const snap = serializeLayers(layersRef.current);
    const stack = historyRef.current;
    if (stack[historyIdxRef.current] === snap) return;
    stack.splice(historyIdxRef.current + 1);
    stack.push(snap);
    if (stack.length > HISTORY_LIMIT) stack.shift();
    historyIdxRef.current = stack.length - 1;
    setHistoryVer(v => v + 1);
  }, []);

  const undo = useCallback(() => {
    if (historyIdxRef.current <= 0) return;
    historyIdxRef.current -= 1;
    const restored = deserializeLayers(historyRef.current[historyIdxRef.current]);
    layersRef.current = restored;
    setLayers(restored);
    setHistoryVer(v => v + 1);
    recomputeRainCount();
  }, [recomputeRainCount]);
  const redo = useCallback(() => {
    if (historyIdxRef.current >= historyRef.current.length - 1) return;
    historyIdxRef.current += 1;
    const restored = deserializeLayers(historyRef.current[historyIdxRef.current]);
    layersRef.current = restored;
    setLayers(restored);
    setHistoryVer(v => v + 1);
    recomputeRainCount();
  }, [recomputeRainCount]);

  const canUndo = historyIdxRef.current > 0;
  const canRedo = historyIdxRef.current < historyRef.current.length - 1;
  void historyVer;

  const currentStrokeRef = useRef<Stroke | null>(null);
  const pointerRef = useRef({ x: 0, y: 0, down: false, px: 0, py: 0 });

  const [brush, setBrush] = useState<BrushKind>("ribbon");
  const [mode, setMode] = useState<ModeKind>("normal");
  // "Анимация" toggle: when off, every NEW stroke is born frozen (see Stroke.frozen) — it paints
  // once and stops, instead of animating every frame. Strokes drawn before the toggle was flipped
  // keep whatever behavior they were born with.
  const [animEnabled, setAnimEnabled] = useState(true);
  const [hue, setHue] = useState(200);
  const [size, setSize] = useState(28);
  const [speed, setSpeed] = useState(0.5);
  const [density, setDensity] = useState(0.5);
  const [noise, setNoise] = useState(0.4);
  const [intensity, setIntensity] = useState(0.7);
  const [dynamics, setDynamics] = useState(0.5);
  const [modeSpeed, setModeSpeed] = useState(0.5);
  const [rainbowFlow, setRainbowFlow] = useState(true);
  const [rainbowFlowSpeed, setRainbowFlowSpeed] = useState(0.5);
  const [rainbowBlinkSpeed, setRainbowBlinkSpeed] = useState(0.5);
  const [gradientSpeed, setGradientSpeed] = useState(0.3);
  // How many times the gradient's color cycle repeats across the stroke/canvas along its flow
  // direction — 1 stretches the picked colors once across the full span (auto-derived from the
  // stroke's own movement, or the canvas diagonal for a single-click fill), higher values repeat
  // the same cycle more times (a tighter, more compressed band pattern), lower values stretch a
  // single cycle out past the visible area.
  const [gradientScale, setGradientScale] = useState(1);
  const [gradientColors, setGradientColors] = useState<{ hue: number; weight: number }[]>([
    { hue: 200, weight: 1 }, { hue: 320, weight: 1 }, { hue: 60, weight: 1 },
  ]);
  const [gradientAngle, setGradientAngle] = useState(0);
  // Bucket fill ("Заливка") settings: contiguous selects only the region connected to the click
  // point; global selects every matching pixel on the canvas regardless of position. Tolerance is
  // the max per-channel color difference (0-255) still counted as "the same color".
  const [fillContiguous, setFillContiguous] = useState(true);
  const [fillTolerance, setFillTolerance] = useState(32);
  const [recording, setRecording] = useState<null | "gif" | "mp4">(null);
  const [recordProgress, setRecordProgress] = useState(0);
  const [gifQ, setGifQ] = useState<GifQ>("medium");
  const [mp4Q, setMp4Q] = useState<Mp4Q>("medium");
  const [exportScale, setExportScale] = useState<number>(2);
  const [exportSec, setExportSec] = useState<number>(4);
  const [exportFps, setExportFps] = useState<number>(24);
  // Loop-crossfade export: the animation isn't built from mathematically-synced oscillators (each
  // stroke's speed/noise/phase differs), so there's no single "natural period" to just cut the clip
  // at for a seamless repeat. Instead of a ping-pong (play forward then backward, which reads as an
  // obvious back-and-forth rather than a real loop), we render normally then blend the LAST stretch
  // of frames toward the FIRST stretch of frames (progressively increasing mix), so the tail eases
  // into matching the head — when the export repeats, the seam is smooth and the motion still reads
  // as continuous forward playback.
  const [exportLoop, setExportLoop] = useState(false);
  const [zoom, setZoom] = useState(1);
  // Free camera: pan is a CSS-pixel offset of the canvas from the viewport center. spaceHeld lets
  // a single mouse drag pan (desktop convention); two simultaneous touch pointers pinch-zoom/pan
  // (mobile convention) regardless of whether they land on the canvas or the surrounding space.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchStateRef = useRef<{ initialDist: number; initialZoom: number; initialMid: { x: number; y: number }; initialPan: { x: number; y: number } } | null>(null);
  const panDragRef = useRef<{ startX: number; startY: number; startPan: { x: number; y: number } } | null>(null);

  // === Selection / transform tool (#8) ===
  // Move (drag inside the box), scale (drag a corner handle), and rotate (drag the handle above the
  // box) — all against the active layer's selected strokes. Selection itself is a simple bounding-
  // box marquee (matches how fill/erase/etc. already only ever touch the active layer), not a full
  // spatial index — fine at the stroke counts this app deals with; only worth a real R/quad-tree if
  // selection itself gets slow, which nothing here suggests yet.
  const [selectTool, setSelectTool] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const selectedIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null);
  const moveDragRef = useRef<{ lastX: number; lastY: number } | null>(null);
  // Scale (corner handles) and rotate (handle above the box) — both apply against a SNAPSHOT of
  // each selected stroke's point positions taken at drag start, not against the live points frame
  // to frame. Scaling/rotating the already-scaled/rotated result every pointermove would compound
  // floating-point error and, worse, make the transform's origin drift away from the actual pivot
  // as the shape deforms — snapshotting once means every frame is "start position transformed by
  // the CURRENT total drag", which is exact regardless of how long the drag runs.
  const transformRef = useRef<{
    kind: "scale" | "rotate";
    cx: number; cy: number; // pivot: opposite corner for scale, bbox center for rotate
    startCorner: { x: number; y: number }; // scale only
    startAngle: number; // rotate only
    snapshot: { s: Stroke; pts: { x: number; y: number }[] }[];
  } | null>(null);
  // Mutating stroke points directly (same trick the existing move-drag above already uses) never
  // triggers a React re-render on its own — the CANVAS still updates every frame regardless since
  // the paint loop reads layersRef directly, but the bbox/handle overlay divs are plain React JSX
  // and would otherwise sit frozen at their drag-start position while the shape moves underneath
  // them. This tiny counter, bumped on every pointermove while any selection drag is active, is
  // just enough to make React recompute getSelectionBBox() and reposition the overlay each frame.
  const [, bumpOverlay] = useState(0);
  // Recomputed from live stroke data every render (cheap — only over the already-selected strokes'
  // points) rather than stored/cached, so it always matches wherever the strokes currently are,
  // including mid-drag.
  const getSelectionBBox = (): { x0: number; y0: number; x1: number; y1: number } | null => {
    if (selectedIds.size === 0) return null;
    const layer = layersRef.current.find(l => l.id === activeLayerId);
    if (!layer) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let any = false;
    for (const s of layer.strokes) {
      if (!selectedIds.has(s.id)) continue;
      for (const p of s.points) {
        any = true;
        if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
      }
    }
    if (!any) return null;
    const pad = 12;
    return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  };

  // Transform handles (corner = scale, top = rotate). Each handle owns its whole drag lifecycle —
  // pointer capture + down/move/up all live directly on the handle element via stopPropagation —
  // rather than routing through the big shared onDown/onMove/onUp used for drawing/marquee/move,
  // which keeps this from having to duplicate their brush-tool branches or risk a stray marquee
  // starting underneath a handle click.
  const startScaleDrag = (e: React.PointerEvent, corner: "nw" | "ne" | "sw" | "se") => {
    e.stopPropagation();
    const bbox = getSelectionBBox();
    const layer = layersRef.current.find(l => l.id === activeLayerId);
    if (!bbox || !layer) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const startCorner = { x: corner.includes("w") ? bbox.x0 : bbox.x1, y: corner.includes("n") ? bbox.y0 : bbox.y1 };
    // Pivot is the OPPOSITE corner — dragging a corner handle stretches from the far corner, the
    // same way every other image editor's resize handles behave, instead of scaling from the
    // shape's own center (which would move the shape's edges even on the side you're not touching).
    const pivot = { x: corner.includes("w") ? bbox.x1 : bbox.x0, y: corner.includes("n") ? bbox.y1 : bbox.y0 };
    const snapshot = layer.strokes.filter(s => selectedIdsRef.current.has(s.id)).map(s => ({ s, pts: s.points.map(p => ({ x: p.x, y: p.y })) }));
    transformRef.current = { kind: "scale", cx: pivot.x, cy: pivot.y, startCorner, startAngle: 0, snapshot };
  };
  const startRotateDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    const bbox = getSelectionBBox();
    const layer = layersRef.current.find(l => l.id === activeLayerId);
    if (!bbox || !layer) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const cx = (bbox.x0 + bbox.x1) / 2, cy = (bbox.y0 + bbox.y1) / 2;
    const { x, y } = getPoint(e);
    const snapshot = layer.strokes.filter(s => selectedIdsRef.current.has(s.id)).map(s => ({ s, pts: s.points.map(p => ({ x: p.x, y: p.y })) }));
    transformRef.current = { kind: "rotate", cx, cy, startCorner: { x: 0, y: 0 }, startAngle: Math.atan2(y - cy, x - cx), snapshot };
  };
  const onHandleMove = (e: React.PointerEvent) => {
    e.stopPropagation();
    const tr = transformRef.current;
    if (!tr) return;
    const { x, y } = getPoint(e);
    if (tr.kind === "scale") {
      // Guard against a near-zero-width/height starting box (e.g. a single-point selection) —
      // dividing by a near-zero span would blow the scale factor up to something absurd from a
      // tiny mouse movement.
      const denomX = tr.startCorner.x - tr.cx, denomY = tr.startCorner.y - tr.cy;
      const sx = Math.abs(denomX) < 1 ? 1 : (x - tr.cx) / denomX;
      const sy = Math.abs(denomY) < 1 ? 1 : (y - tr.cy) / denomY;
      for (const { s, pts } of tr.snapshot) {
        for (let i = 0; i < s.points.length; i++) {
          s.points[i].x = tr.cx + (pts[i].x - tr.cx) * sx;
          s.points[i].y = tr.cy + (pts[i].y - tr.cy) * sy;
        }
        s.segCache = undefined; s.bakedCache = null; strokeSerCache.delete(s);
      }
    } else {
      const ang = Math.atan2(y - tr.cy, x - tr.cx) - tr.startAngle;
      const cos = Math.cos(ang), sin = Math.sin(ang);
      for (const { s, pts } of tr.snapshot) {
        for (let i = 0; i < s.points.length; i++) {
          const dx = pts[i].x - tr.cx, dy = pts[i].y - tr.cy;
          s.points[i].x = tr.cx + dx * cos - dy * sin;
          s.points[i].y = tr.cy + dx * sin + dy * cos;
        }
        s.segCache = undefined; s.bakedCache = null; strokeSerCache.delete(s);
      }
    }
    bumpOverlay(v => v + 1);
  };
  const onHandleUp = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (!transformRef.current) return;
    transformRef.current = null;
    pushHistory();
  };

  useEffect(() => {
    const kd = (e: KeyboardEvent) => { if (e.code === "Space" && !e.repeat) setSpaceHeld(true); };
    const ku = (e: KeyboardEvent) => { if (e.code === "Space") setSpaceHeld(false); };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => { window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku); };
  }, []);

  const getPinchInfo = () => {
    const pts = Array.from(activePointersRef.current.values());
    if (pts.length < 2) return null;
    const [a, b] = pts;
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };

  const refs = {
    brush: useRef(brush), mode: useRef(mode), hue: useRef(hue), size: useRef(size),
    speed: useRef(speed), density: useRef(density), noise: useRef(noise),
    intensity: useRef(intensity), dynamics: useRef(dynamics),
    modeSpeed: useRef(modeSpeed),
    rainbowFlow: useRef(rainbowFlow),
    rainbowFlowSpeed: useRef(rainbowFlowSpeed),
    rainbowBlinkSpeed: useRef(rainbowBlinkSpeed),
    gradientSpeed: useRef(gradientSpeed), gradientScale: useRef(gradientScale), gradientColors: useRef(gradientColors),
    gradientAngle: useRef(gradientAngle),
    animEnabled: useRef(animEnabled),
    fillContiguous: useRef(fillContiguous),
    fillTolerance: useRef(fillTolerance),
  };
  useEffect(() => { refs.brush.current = brush; });
  useEffect(() => { refs.mode.current = mode; });
  useEffect(() => { refs.hue.current = hue; });
  useEffect(() => { refs.size.current = size; });
  useEffect(() => { refs.speed.current = speed; });
  useEffect(() => { refs.density.current = density; });
  useEffect(() => { refs.noise.current = noise; });
  useEffect(() => { refs.intensity.current = intensity; });
  useEffect(() => { refs.dynamics.current = dynamics; });
  useEffect(() => { refs.modeSpeed.current = modeSpeed; });
  useEffect(() => { refs.rainbowFlow.current = rainbowFlow; });
  useEffect(() => { refs.rainbowFlowSpeed.current = rainbowFlowSpeed; });
  useEffect(() => { refs.rainbowBlinkSpeed.current = rainbowBlinkSpeed; });
  useEffect(() => { refs.gradientSpeed.current = gradientSpeed; });
  useEffect(() => { refs.gradientScale.current = gradientScale; });
  useEffect(() => { refs.gradientColors.current = gradientColors; });
  useEffect(() => { refs.gradientAngle.current = gradientAngle; });
  useEffect(() => { refs.animEnabled.current = animEnabled; });
  useEffect(() => { refs.fillContiguous.current = fillContiguous; });
  useEffect(() => { refs.fillTolerance.current = fillTolerance; });

  // Create the Pixi Application — and with it, the ONE WebGL context it owns — exactly once for
  // this component's lifetime, NOT per canvasSize change. Recreating the whole Application (a brand
  // new WebGL context every time) on every resize/"Новый холст" click was quietly leaking contexts:
  // browsers cap how many live WebGL contexts a page may hold at once (commonly 8-16), destroy()
  // losing a context isn't guaranteed synchronous, and a rapid destroy-then-immediately-create in
  // the same tick could hand PIXI a context the browser hadn't actually finished tearing down yet.
  // PIXI's own capability probing then read garbage/zeroed GPU limits off that half-dead context and
  // threw deep inside its shader setup ("Invalid value of 0 passed to checkMaxIfStatementsInShader")
  // — which, with no error boundary in place at the time, took the whole page down to a blank
  // screen. One Application, one context, for the whole session now; only the much cheaper TEXTURE
  // gets rebuilt below when the canvas size actually changes.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const app = new PIXI.Application({
      view: c, width: canvasSize.w, height: canvasSize.h,
      antialias: false, backgroundAlpha: 0, clearBeforeRender: false,
    });
    pixiAppRef.current = app;
    return () => {
      app.destroy(false, { children: true, texture: true, baseTexture: true });
      pixiAppRef.current = null;
      pixiRef.current = null;
    };
    // Deliberately empty deps — this must run exactly once. Resizing is handled by the effect below
    // via app.renderer.resize(), not by recreating the Application.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuild just the CPU pixel buffer and its GPU texture whenever the logical canvas size changes
  // — resizing the EXISTING renderer/context (app.renderer.resize) instead of tearing down and
  // recreating the whole Application (see the effect above for why that distinction is the actual
  // fix, not just a tidy-up).
  useEffect(() => {
    const app = pixiAppRef.current;
    if (!app) return;
    const w = canvasSize.w, h = canvasSize.h;
    app.renderer.resize(w, h);

    // Same raw RGBA buffer every brush already painted into via `bufferTarget`/`buf` — untouched by
    // this swap. Only its destination changed (GPU sprite instead of ctx.putImageData).
    const data = new Uint8ClampedArray(w * h * 4);
    const bufObj = {
      data, w, h,
      buf32: new Uint32Array(data.buffer),
      rainBudget: { left: 0 },
      bufferTarget: { mode: "buffer" as const, buf: data, buf32: new Uint32Array(data.buffer), bw: w, bh: h },
    };
    pixelBufRef.current = bufObj;

    // `data` (Uint8ClampedArray) and PIXI's BufferResource typings want Uint8Array — same underlying
    // byte layout, safe to hand across; this is still literally the array every brush writes into.
    const baseTexture = PIXI.BaseTexture.fromBuffer(data as unknown as Uint8Array, w, h, {
      scaleMode: PIXI.SCALE_MODES.NEAREST,
    });
    const texture = new PIXI.Texture(baseTexture);

    const prev = pixiRef.current;
    if (prev) {
      // Reuse the same Sprite (and, more importantly, the same Application/context) — only swap
      // which texture it's showing, then free the OLD texture's GPU memory. This is a routine,
      // cheap GPU allocation/free, unlike destroying and recreating a whole WebGL context.
      prev.sprite.texture = texture;
      prev.baseTexture.destroy(true);
      pixiRef.current = { app, baseTexture, sprite: prev.sprite, w, h };
    } else {
      const sprite = new PIXI.Sprite(texture);
      app.stage.addChild(sprite);
      pixiRef.current = { app, baseTexture, sprite, w, h };
    }
  }, [canvasSize]);

  const eraseAt = useCallback((x: number, y: number, r: number) => {
    const r2 = r * r;
    const id = activeLayerIdRef.current;
    const layer = layersRef.current.find(l => l.id === id);
    if (!layer) return;
    for (const s of layer.strokes) {
      const before = s.points.length;
      s.points = s.points.filter(p => {
        const dx = p.x - x, dy = p.y - y;
        return dx * dx + dy * dy > r2;
      });
      // Erasing removes points from arbitrary positions, so cached segment indices no longer line
      // up with the (now shorter/reindexed) points array — drop the cache, it'll rebuild lazily.
      if (s.points.length !== before) { s.segCache = undefined; s.bakedCache = null; strokeSerCache.delete(s); }
      if (s.rain) {
        const rainBefore = s.rain.length;
        s.rain = s.rain.filter(i => (i.x - x) ** 2 + (i.y - y) ** 2 > r2);
        rainCountRef.current -= rainBefore - s.rain.length;
      }
    }
    layer.strokes = layer.strokes.filter(s => s.points.length > 0);
  }, []);

  // Render loop
  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dtRaw = Math.min(50, now - last);
      last = now;
      const c = canvasRef.current;
      if (!c) { raf = requestAnimationFrame(tick); return; }
      const w = canvasSize.w, h = canvasSize.h;

      // Both the CPU buffer and the Pixi app/texture wrapping it are (re)built together by the effect
      // above whenever canvasSize changes, so by the time this loop is running they already match the
      // current size — just bail for one frame on the rare tick that lands between resize and rebuild.
      const bufObj = pixelBufRef.current;
      const px = pixiRef.current;
      if (!bufObj || bufObj.w !== w || bufObj.h !== h || !px || px.w !== w || px.h !== h) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const buf = bufObj.data;
      // Seed the opaque background fast via a 32-bit view instead of a per-byte loop — .fill() on a
      // typed array is a native, heavily optimized operation.
      const BG_PACKED = (255 << 24) | (18 << 16) | (10 << 8) | 8; // little-endian bytes: R=8 G=10 B=18 A=255 (#080a12)
      bufObj.buf32.fill(BG_PACKED);

      const t = now / 1000;

      // Rain shares one global budget across the scene (caps total particle COUNT once truly
      // enormous — doesn't touch any individual particle's look). PERF: reads the incrementally
      // maintained rainCountRef instead of re-scanning every stroke on every layer every frame —
      // see rainCountRef/recomputeRainCount above for how it's kept accurate across spawn/despawn
      // AND the rare wholesale-removal paths (undo/redo/clear/delete-layer).
      bufObj.rainBudget.left = Math.max(0, GLOBAL_RAIN_CAP - rainCountRef.current);
      const liveOpts: RenderOpts = { step: 1, rainBudget: bufObj.rainBudget };
      const bufferTarget = bufObj.bufferTarget;

      for (const layer of layersRef.current) {
        if (!layer.visible) continue;
        if (layer.image) {
          const imgPixels = ensureLayerImagePixels(layer, w, h);
          if (imgPixels) blitLayerImage(buf, imgPixels);
        }
        for (const s of layer.strokes) {
          if (s.points.length === 0) continue;
          // Frozen strokes (born while "Анимация" was off) always render as if it's still the
          // instant they were created — same t/dt/now every frame — so their pattern is painted
          // once and stays put instead of flowing/wobbling/pulsing forever. Non-frozen strokes are
          // unaffected, whatever the toggle's CURRENT state is — only stroke creation reads it.
          // Bake once the stroke is actually finished, not on every point added while it's still
          // being drawn — see bakeFrozenStroke below for why re-baking mid-draw was expensive (full
          // canvas-sized allocations + a full pixel scan), and why that cost used to grow with every
          // single point, making a long frozen stroke get progressively laggier as you drew it.
          if (s.frozen && s !== currentStrokeRef.current) {
            if (!s.bakedCache || s.bakedCache.pointCount !== s.points.length) bakeFrozenStroke(s, w, h, s.born / 1000, 0, s.born, liveOpts);
            compositeBakedStroke(buf, s.bakedCache!);
          } else {
            renderStroke(bufferTarget, s, w, h, t, dtRaw, now, liveOpts);
          }
        }
      }

      // Final flush: push the CPU buffer to the GPU texture (baseTexture.update() re-uploads the
      // exact same `buf` array the loop above just painted into — no copy) and let Pixi composite it,
      // instead of the CPU-bound ctx.putImageData call this replaced.
      px.baseTexture.update();
      px.app.renderer.render(px.app.stage);

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [canvasSize]);

  // === Stroke renderer ===
  function renderStroke(target: PaintTarget, s: Stroke, w: number, h: number, t: number, dtRaw: number, now: number, opts: RenderOpts) {
    const step = Math.max(1, opts.step);
    const dt = dtRaw * (0.3 + s.speed * 2.4);
    // Every "breathing"/pulsing effect below (dither/mosaic sweep, pulse-mode brightness, ribbon
    // phase, rainbow flow) was driven purely by the shared GLOBAL clock `t`, with no per-stroke
    // offset — so two strokes drawn minutes apart still breathed in exact lockstep, since at any
    // given instant they both read the same `t`. Adding a phase offset derived from each stroke's
    // own birth time (stable forever after creation, since s.born never changes) staggers every
    // stroke onto its own point in the cycle — strokes drawn at different times now visibly
    // breathe/pulse out of sync with each other instead of all flashing on the same beat.
    const phaseOffset = (s.born % 6283) / 1000; // ~0..2π spread, so it covers a full cycle
    const tt = t * (0.3 + s.speed * 2.4) + phaseOffset;
    // FIX: every mode's color animation (pulse brightness, "Поток" hue flow, gradient travel,
    // glitch re-roll rate) used to run off `tt` above — which bakes in the BRUSH's own "Скорость"
    // slider (s.speed). That's what made mode speed and brush speed the same knob: dragging faster
    // sped up the glitch flicker too, dragging slower stalled the gradient flow, etc., with no way
    // to set them independently. `mt` is the same phase-staggered clock but WITHOUT s.speed mixed
    // in — modes read this instead, each scaled only by their own dedicated speed slider (gradient/
    // rainbow already had one each; pulse and glitch now share the new "Скорость режима" slider,
    // s.modeSpeed, defaulting to 0.5 so nothing jumps until it's actually moved).
    const mt = t + phaseOffset;
    const ms = s.modeSpeed ?? 0.5;
    const lifeMs = now - s.born;
    // Was a hardcoded 0.05 rate with no way to adjust it. "Поток" mode keeps that exact same 0.05
    // (unchanged, since it already has its own separate speed slider via legacyFlow below) — only
    // "Мигание целиком" gets the new adjustable rate, defaulting to 0.5*0.1=0.05 so nothing changes
    // until the slider is actually moved.
    const modeHueShift = s.mode === "rainbow" ? (lifeMs * (s.rainbowFlow ? 0.05 : s.rainbowBlinkSpeed * 0.1)) % 360 : 0;
    const modePulse = s.mode === "pulse" ? 0.6 + 0.5 * Math.sin(mt * (0.5 + ms * 3)) : 1;
    const alphaMul = (0.25 + s.intensity * 0.9) * modePulse;
    const pts = s.points;
    // "Радуга: Поток" keeps its original simple full-spectrum sweep, unchanged.
    // "Градиент" is now fully independent and spatial. Its base direction is auto-derived from
    // the way the brush was actually moved (start point -> end point of the stroke) — draw
    // left-to-right and the gradient flows left-to-right, draw diagonally and it follows that
    // diagonal. gradientAngle (the slider) is an ADDITIONAL offset rotated on top of that auto
    // direction — at 0 it does nothing. For strokes with no real movement (a single-click "Заливка")
    // the auto direction is 0, so the slider becomes the sole, absolute angle control there.
    const rainbowFlowActive = s.mode === "rainbow" && s.rainbowFlow;
    const legacySpread = rainbowFlowActive ? 360 : 0;
    const legacyFlow = rainbowFlowActive ? (mt * (10 + s.rainbowFlowSpeed * 150)) % 360 : 0;
    const nSeg = Math.max(1, pts.length - 1);
    const gradAutoAngle = s.mode === "gradient" ? strokeAutoAngleDeg(pts) : 0;
    const gradAngleRad = ((gradAutoAngle + s.gradientAngle) * Math.PI) / 180;
    const gradCos = Math.cos(gradAngleRad), gradSin = Math.sin(gradAngleRad);
    // Normalize the projection so the picked colors span roughly the visible canvas regardless of angle.
    const gradExtent = Math.abs(w * gradCos) + Math.abs(h * gradSin) || 1;
    const gradTravel = mt * (0.03 + s.gradientSpeed * 0.5);
    // PERF: precompute the gradient's color cycle ONCE per stroke per frame instead of calling
    // sampleGradient() (a loop over the stops) at every point/pixel that needs a gradient hue.
    // Deliberately built WITHOUT gradTravel baked in — travel is a pure phase shift, so it's added
    // at lookup time (see gradHueRampAt) by rotating which ramp index gets read, meaning this ramp
    // stays valid (and doesn't need rebuilding) for the whole frame regardless of animation speed.
    const GRAD_RAMP_N = 256;
    let gradHueRamp: Float32Array | null = null;
    const gradHueRampAt = (proj: number): number => {
      if (s.mode !== "gradient") return sampleGradient(s.gradientColors, proj);
      if (!gradHueRamp) {
        gradHueRamp = new Float32Array(GRAD_RAMP_N);
        for (let k = 0; k < GRAD_RAMP_N; k++) gradHueRamp[k] = sampleGradient(s.gradientColors, k / GRAD_RAMP_N);
      }
      const norm = ((proj % 1) + 1) % 1;
      return gradHueRamp[Math.min(GRAD_RAMP_N - 1, Math.floor(norm * GRAD_RAMP_N))];
    };
    const gradientHueAtXY = (x: number, y: number): number => {
      const proj = ((x * gradCos + y * gradSin) / gradExtent) * s.gradientScale;
      return gradHueRampAt(proj + gradTravel);
    };
    // "Глитч" mode: moved here from the brush per feedback — this used to be baked into the
    // pixelGlitch BRUSH's own coloring (three offset copies of the same paint() call, tinted
    // 0°/+120°/+240°, drawn a few pixels apart). That's exactly why it read as a real misaligned
    // print rather than a rainbow: the three colors sit at three different POSITIONS at the same
    // instant, not three colors cycling through time at the same spot (which is what the earlier
    // per-point time-based version did, and why it read as a flickering rainbow). See paint()
    // below and the `glitchSplitSet` block further down for where this now actually happens,
    // generically, for every brush — hueAt() itself no longer touches color for this mode at all.
    const glitchOn = s.mode === "glitch";
    const hueAt = (i: number, f = 0): number => {
      if (s.mode === "gradient") {
        const p0 = pts[Math.min(i, pts.length - 1)];
        const p1 = pts[Math.min(i + 1, pts.length - 1)];
        const px = p0.x + (p1.x - p0.x) * f;
        const py = p0.y + (p1.y - p0.y) * f;
        return gradientHueAtXY(px, py);
      }
      const posT = (i + f) / nSeg;
      return (s.hue + modeHueShift + legacyFlow + legacySpread * posT) % 360;
    };

    if (s.kind === "fill") {
      const bw = w, bh = h;
      if (s.fillW !== bw || s.fillH !== bh) return;
      if (!s.fillMaskCache || s.fillMaskCache.length !== bw * bh) {
        s.fillMaskCache = decodeMaskRLE(s.fillRuns!, bw * bh);
        let bx0 = bw, by0 = bh, bx1 = -1, by1 = -1;
        const m = s.fillMaskCache;
        for (let yy = 0; yy < bh; yy++) {
          for (let xx = 0; xx < bw; xx++) {
            if (!m[yy * bw + xx]) continue;
            if (xx < bx0) bx0 = xx;
            if (xx > bx1) bx1 = xx;
            if (yy < by0) by0 = yy;
            if (yy > by1) by1 = yy;
          }
        }
        s.fillBBox = bx1 < bx0 ? { x0: 0, y0: 0, x1: 0, y1: 0 } : { x0: bx0, y0: by0, x1: bx1 + 1, y1: by1 + 1 };
      }
      const mask = s.fillMaskCache;
      const { x0: bx0, y0: by0, x1: bx1, y1: by1 } = s.fillBBox!;
      if (bx1 <= bx0 || by1 <= by0) return;

      // Fill всегда полностью непрозрачный — перекрывает всё под ним
      const alpha = 1.0;

      if (s.mode === "gradient") {
        const RAMP = 96;
        const ramp: [number, number, number][] = new Array(RAMP);
        for (let k = 0; k < RAMP; k++) {
          const hueK = sampleGradient(s.gradientColors, k / RAMP + gradTravel);
          ramp[k] = getHslRgb(hueK, 85, 55);
        }
        if (target.mode === "buffer") {
          const buf = target.buf!;
          for (let yy = by0; yy < by1; yy++) {
            for (let xx = bx0; xx < bx1; xx++) {
              const mi = yy * bw + xx;
              if (!mask[mi]) continue;
              const proj = ((xx * gradCos + yy * gradSin) / gradExtent) * s.gradientScale + gradTravel;
              const norm = ((proj % 1) + 1) % 1;
              const [r, g, b] = ramp[Math.min(RAMP - 1, Math.floor(norm * RAMP))];
              const idx = mi * 4;
              buf[idx] = r;
              buf[idx + 1] = g;
              buf[idx + 2] = b;
              buf[idx + 3] = 255;
            }
          }
        } else if (target.mode === "iso") {
          const buf = target.buf!, alphaBuf = target.alphaBuf!;
          for (let yy = by0; yy < by1; yy++) {
            for (let xx = bx0; xx < bx1; xx++) {
              const mi = yy * bw + xx;
              if (!mask[mi]) continue;
              const proj = ((xx * gradCos + yy * gradSin) / gradExtent) * s.gradientScale + gradTravel;
              const norm = ((proj % 1) + 1) % 1;
              const [r, g, b] = ramp[Math.min(RAMP - 1, Math.floor(norm * RAMP))];
              blendIsoPixel(buf, alphaBuf, mi * 4, mi, r, g, b, alpha);
            }
          }
        } else {
          for (let yy = by0; yy < by1; yy++) {
            for (let xx = bx0; xx < bx1; xx++) {
              if (!mask[yy * bw + xx]) continue;
              paint(target, xx, yy, 1, 1, gradientHueAtXY(xx, yy), 85, 55, alpha);
            }
          }
        }
      } else {
        const hueF = hueAt(0, 0);
        if (target.mode === "buffer") {
          const [r, g, b] = getHslRgb(hueF, 85, 55);
          const buf = target.buf!;
          for (let yy = by0; yy < by1; yy++) {
            for (let xx = bx0; xx < bx1; xx++) {
              const mi = yy * bw + xx;
              if (!mask[mi]) continue;
              const idx = mi * 4;
              buf[idx] = r;
              buf[idx + 1] = g;
              buf[idx + 2] = b;
              buf[idx + 3] = 255;
            }
          }
        } else if (target.mode === "iso") {
          const [r, g, b] = getHslRgb(hueF, 85, 55);
          const buf = target.buf!, alphaBuf = target.alphaBuf!;
          for (let yy = by0; yy < by1; yy++) {
            for (let xx = bx0; xx < bx1; xx++) {
              const mi = yy * bw + xx;
              if (!mask[mi]) continue;
              blendIsoPixel(buf, alphaBuf, mi * 4, mi, r, g, b, alpha);
            }
          }
        } else {
          for (let yy = by0; yy < by1; yy++) {
            for (let xx = bx0; xx < bx1; xx++) {
              if (!mask[yy * bw + xx]) continue;
              paint(target, xx, yy, 1, 1, hueF, 85, 55, alpha);
            }
          }
        }
      }
      return;
    }

    // "Распыление" used to only ever do anything for the "ink" brush — every other brush kind just
    // silently ignored the mode entirely, which is what read as "spray doesn't work". Ink keeps its
    // own dedicated airbrush scatter (see isSpray below); every OTHER brush now gets the generic
    // paint()-level scatter turned on for its whole render pass instead.
    const spraySet = s.mode === "spray" && s.kind !== "ink";
    if (spraySet) {
      target.spray = Math.max(2, s.size * (0.3 + s.density * 0.6));
      // Was a hardcoded 0.55 no matter what — "Плотность" had zero effect on how sparse/dense the
      // scatter looked for every brush except ink. Now density genuinely thins it out or fills it in.
      target.sprayKeep = 0.25 + s.density * 0.6;
    }
    // "RGB сдвиг" mode — generic real channel-split, works with ANY brush (unlike the pixelGlitch
    // brush's own built-in split, which only fires for that one brush). Offset reach follows
    // "Динамика" (same knob the pixelGlitch brush uses for its own reach), and gently breathes over
    // time at the "Скорость режима" rate so it reads as a live flicker instead of a static fringe.
    const rgbShiftSet = s.mode === "rgbShift";
    if (rgbShiftSet) {
      const breathe = 0.5 + 0.5 * Math.sin(mt * (0.5 + ms * 3));
      target.rgbShift = Math.max(1, s.size * (0.05 + s.dynamics * 0.35) * (0.4 + breathe * 0.6));
    }
    // "Глитч" mode — generic spatial tri-hue split, works with ANY brush the same way it used to
    // work only for the pixelGlitch brush. FIX: this used to scale up with "Динамика" (up to
    // ~0.38x brush size), which for tile-based brushes (Дизеринг, Мозаика — cells sit edge to
    // edge with no overlap) pushed the offset past the tile's own size, tearing gaps BETWEEN the
    // three shifted copies that the near-black canvas showed straight through — reading as "the
    // brush went black". Kept small and fixed instead (not tied to brush size or Динамика at all)
    // so it stays comfortably smaller than any brush's own tile/grid step — visible fringing at
    // edges, never real gaps in solid coverage.
    const glitchSplitSet = glitchOn;
    if (glitchSplitSet) {
      const jitter = 0.6 + 0.4 * Math.sin(mt * (2 + ms * 10) + phaseOffset);
      target.glitchSplit = 1.5 * jitter;
    }
    // "Хром" mode — generic metallic sheen, works with ANY brush the same way rgbShift/glitch do.
    // Sweep direction follows the stroke's own drawn direction (same strokeAutoAngleDeg already
    // used by gradient mode) with NO extra rotation, so the repeating highlight/shadow bands are
    // spaced out ALONG the stroke's length — reading as a reflection traveling down the stroke,
    // like light sliding along a metal wire, rather than one static gradient across its width.
    // Band tightness scales with brush size (bigger brush = a few broad bands; thin brush = tighter
    // banding, same relative look at any scale).
    const chromeSet = s.mode === "chrome";
    if (chromeSet) {
      const angleRad = (strokeAutoAngleDeg(pts) * Math.PI) / 180;
      target.chromeCos = Math.cos(angleRad);
      target.chromeSin = Math.sin(angleRad);
      target.chromeFreq = (2 * Math.PI) / Math.max(20, s.size * 3);
      // Travels slowly over time so the highlight visibly sweeps across the shape — a living
      // reflection, not a static gradient — at the same adjustable "Скорость режима" rate every
      // other mode-speed-driven effect (pulse/glitch/rgbShift) already uses.
      target.chromePhase = mt * (0.4 + ms * 1.5);
      target.chromeColorAmt = s.noise;
    }

    // FIX (root cause of the intermittent "canvas goes black/negative regardless of mode" bug):
    // this whole per-brush dispatch below is wrapped in try/finally now because at least one
    // brush (pixelGlitch, see its own early `return` for <2 points) can exit BEFORE reaching the
    // spraySet/rgbShiftSet/glitchSplitSet reset at the end of this function. Since `target` is one
    // shared object reused across EVERY stroke drawn in a frame, a leaked flag (say, glitchSplit
    // left set from a single click that started a "Глитч" stroke but hadn't moved yet) then silently
    // applies to every OTHER stroke rendered afterward — any brush, any mode — until something else
    // happens to overwrite it. That's exactly why it looked random and mode-independent: it wasn't
    // the CURRENT stroke's mode causing it, it was a PAST stroke's flag never getting cleaned up.
    try {

    if (s.kind === "ink") {
      // Pixelated animated line — pixel dots along smooth path with breathing thickness
      if (!s.ink) s.ink = { phase: Math.random() * 100 };
      s.ink.phase += dt * 0.002;
      const grid = Math.max(2, Math.round(s.size / 8));
      // "Распыление" used to just multiply thickness by a flat 2.2x — a wider solid line, not an
      // actual spray. Real spray scatter is now handled below (isSpray branch): random speckled
      // dots with a soft falloff toward the edges, like paint from an airbrush, instead of a
      // uniform evenly-stepped fill. Base thickness no longer gets the flat multiplier since the
      // scatter radius below handles reach on its own.
      const isSpray = s.mode === "spray";
      const thickness = Math.max(grid, s.size * (0.45 + s.intensity * 0.55) * modePulse);
      const half = thickness / 2;
      const phaseI = s.ink.phase;
      // PERF: segment geometry (unit normal + step count) is cached per stroke — it's the same
      // for a given segment forever once drawn, so we stop recomputing Math.hypot + the normal for
      // every already-finished segment on every single frame. Only the wobble/color stay live.
      const segsInk = getSegCache(s, pts, grid);
      for (let i = 0; i < pts.length - 1; i += step) {
        const p = pts[i], nxt = pts[Math.min(i + 1, pts.length - 1)];
        const seg = segsInk[Math.min(i, segsInk.length - 1)];
        const dx = nxt.x - p.x, dy = nxt.y - p.y;
        const { nx, ny, num } = seg;
        // Pressure sensitivity: 0.5 (fallback/mouse) → unscaled; a light touch (low pressure) thins
        // and softens the line, a hard press (high pressure) widens and darkens it — the same knob
        // a real pen/tablet gives you, instead of every point along a stroke being the same weight.
        const pr = p.pressure ?? 0.5;
        const halfP = half * (0.5 + pr);
        const alphaPr = 0.6 + pr * 0.7;
        for (let k = 0; k <= num; k++) {
          const f = k / num;
          const cx = p.x + dx * f, cy = p.y + dy * f;
          const wob = Math.sin((i + f) * 0.3 + phaseI * 6) * s.size * 0.12 * s.dynamics
                    + hash(i + f + phaseI * 10) * s.noise * grid * 2;
          if (isSpray) {
            // Real airbrush-style scatter: a variable number of randomly placed dots (not an even
            // grid march), biased toward the centerline (two summed uniforms ≈ a soft triangular
            // falloff, cheaper than a true gaussian) and randomly dropped near the edges — the
            // grainy, uneven texture that actually reads as "spray" rather than a solid stripe.
            const sprayHalf = halfP * 1.6;
            const dotCount = Math.max(5, Math.floor(6 + s.density * 16));
            for (let d = 0; d < dotCount; d++) {
              const rnd = Math.random() + Math.random() - 1; // -1..1, peaked at 0
              const t2 = rnd * sprayHalf + wob;
              const distN = Math.abs(t2 - wob) / (sprayHalf + 1);
              if (Math.random() > 0.85 - distN * 0.5) continue; // sparser out toward the edges
              const gx = Math.round((cx + nx * t2) / grid) * grid;
              const gy = Math.round((cy + ny * t2) / grid) * grid;
              const edge = 1 - distN;
              const l = 50 + edge * 25;
              paint(target, gx, gy, grid, grid, hueAt(i, f), 85, l, alphaMul * edge * (0.5 + Math.random() * 0.5) * alphaPr);
            }
          } else {
            for (let t2 = -halfP; t2 <= halfP; t2 += grid) {
              const gx = Math.round((cx + nx * (t2 + wob)) / grid) * grid;
              const gy = Math.round((cy + ny * (t2 + wob)) / grid) * grid;
              const edge = 1 - Math.abs(t2) / (halfP + 1);
              const l = 55 + edge * 25;
              paint(target, gx, gy, grid, grid, hueAt(i, f), 85, l, alphaMul * edge * alphaPr);
            }
          }
        }
      }
    }

    else if (s.kind === "ribbon") {
      const grid = Math.max(2, Math.round(s.size / 8));
      const passes = Math.max(1, Math.floor(1 + s.density * 3));
      const segsRibbon = getSegCache(s, pts, grid);
      for (let pass = 0; pass < passes; pass++) {
        const phase = tt * 2 + pass * 0.7;
        const amp = s.size * 0.6 * (0.3 + s.dynamics) + Math.sin(tt + pass) * s.size * 0.2;
        // PERF: same cached geometry as ink — only the wave/color are recomputed each frame.
        for (let i = 0; i < pts.length - 1; i += step) {
          const p = pts[i], nxt = pts[Math.min(i + 1, pts.length - 1)];
          const seg = segsRibbon[Math.min(i, segsRibbon.length - 1)];
          const dx = nxt.x - p.x, dy = nxt.y - p.y;
          const { nx, ny, num } = seg;
          for (let k = 0; k <= num; k++) {
            const f = k / num;
            const wave = Math.sin(p.t * 3 + phase + (i + f) * 0.15) * amp
                       + hash(i + f + tt) * s.noise * s.size * 0.5;
            const gx = Math.round((p.x + dx * f + nx * wave) / grid) * grid;
            const gy = Math.round((p.y + dy * f + ny * wave) / grid) * grid;
            const pr = p.pressure ?? 0.5;
            paint(target, gx, gy, grid, grid, (hueAt(i, f) + pass * 20) % 360, 100, 65, alphaMul * 0.75 * (0.6 + pr * 0.7));
          }
        }
      }
    }

    else if (s.kind === "lightning") {
      const grid = Math.max(2, Math.round(s.size / 6));
      const arcs = Math.max(1, Math.floor(1 + s.density * 5));
      for (let a = 0; a < arcs; a++) {
        if (Math.random() > 0.3 + s.intensity * 0.6) continue;
        const i0 = Math.floor(Math.random() * pts.length);
        const i1 = Math.min(pts.length - 1, i0 + 1 + Math.floor(Math.random() * (5 + s.dynamics * 30)));
        const p0 = pts[i0], p1 = pts[i1];
        const hueL = hueAt(i0);
        const segs = 6 + Math.floor(s.dynamics * 10);
        let ppx = p0.x, ppy = p0.y;
        for (let i = 1; i <= segs; i++) {
          const f = i / segs;
          const nxx = p0.x + (p1.x - p0.x) * f + (Math.random() - 0.5) * s.size * (0.5 + s.noise * 1.5);
          const nyy = p0.y + (p1.y - p0.y) * f + (Math.random() - 0.5) * s.size * (0.5 + s.noise * 1.5);
          const ddx = nxx - ppx, ddy = nyy - ppy;
          const dlen = Math.hypot(ddx, ddy) || 1;
          const num = Math.max(1, Math.floor(dlen / grid));
          for (let k = 0; k <= num; k++) {
            const f2 = k / num;
            const gx = Math.round((ppx + ddx * f2) / grid) * grid;
            const gy = Math.round((ppy + ddy * f2) / grid) * grid;
            // PERF: was 4 separate fillRect calls for the glow (one per side) + 1 core = 5 draws
            // per point. Now it's 1 bigger glow rect + 1 core = 2 draws. Same visual read at this
            // grid size, far fewer canvas calls (which is where the real cost is).
            paint(target, gx - grid, gy - grid, grid * 3, grid * 3, hueL, 100, 60, alphaMul * 0.45);
            paint(target, gx, gy, grid, grid, hueL, 100, 82, alphaMul);
          }
          ppx = nxx; ppy = nyy;
        }
      }
    }

    else if (s.kind === "pixelRain") {
      const grid = Math.max(3, Math.round(s.size / 4));
      // PERF: target is now capped by the GLOBAL shared budget, not a flat 200-per-stroke pool.
      // (Fixed: previous version's target collapsed to whatever count currently existed, which
      // blocked new particles from ever spawning once old ones fell off-canvas.)
      const currentRainCount = s.rain?.length ?? 0;
      const wantRain = Math.floor(10 + s.density * 80);
      const rainTargetCount = Math.min(wantRain, currentRainCount + Math.max(0, opts.rainBudget.left));
      if (!s.rain) s.rain = [];
      while (s.rain.length < rainTargetCount && opts.rainBudget.left > 0) {
        const idx = Math.floor(Math.random() * pts.length);
        const p = pts[idx];
        s.rain.push({
          x: Math.round(p.x / grid) * grid + (Math.random() - 0.5) * s.size,
          y: p.y,
          vy: 0.5 + Math.random() * 2 * (0.3 + s.dynamics * 2),
          hue: s.mode === "gradient" ? gradientHueAtXY(p.x, p.y) : s.hue + (Math.random() - 0.5) * 40 + legacySpread * idx / nSeg,
          len: 3 + Math.floor(Math.random() * 8 * (0.3 + s.dynamics)),
          seed: Math.random() * 1000,
        });
        opts.rainBudget.left--;
        rainCountRef.current++;
      }
      for (let i = s.rain.length - 1; i >= 0; i--) {
        const r = s.rain[i];
        r.y += r.vy * dt * 0.1;
        r.x += hash(tt + r.seed) * s.noise * 0.8;
        if (r.y > h + 40) {
          // Swap-pop instead of splice: splice shifts every following element down by one (O(n) —
          // real cost with hundreds of particles). Swapping in the last element and shortening the
          // array is O(1) — array order doesn't matter for particles, so nothing is lost visually.
          const last = s.rain.length - 1;
          if (i !== last) s.rain[i] = s.rain[last];
          s.rain.pop();
          rainCountRef.current--;
          continue;
        }
        const hueP = (r.hue + modeHueShift) % 360;
        for (let k = 0; k < r.len; k++) {
          const a = alphaMul * (1 - k / r.len);
          paint(target, Math.round((r.x) / grid) * grid, Math.round((r.y - k * grid) / grid) * grid, grid, grid, hueP, 95, 55 + k * 3, a);
        }
      }
    }

    else if (s.kind === "pixelGlitch") {
      // With just one point (right after pointer-down, before any movement), the full slice
      // pattern was still drawn stacked around that single spot — there's no real direction yet,
      // and this is exactly what read as a stray dot sitting at the very start of every stroke,
      // separate from the actual glitch that appears once you start dragging. Wait for at least
      // one real segment before drawing anything.
      if (pts.length < 2) return;
      const grid = Math.max(2, Math.round(s.size / 6));
      const stepPts = Math.max(1, Math.floor(pts.length / 30));
      // dynamics now doubles as "how much this brush follows the stroke's own direction": 0 keeps
      // the slices in the original fixed horizontal pose (nx=0,ny=1 — same as before direction
      // tracking existed), and increasing values blend smoothly toward fully following the local
      // path direction. So dynamics no longer only controls radius — it's the one knob for both
      // reach and how "aware" the glitch is of the stroke's own movement.
      const segs = getSegCache(s, pts, grid);
      for (let pi = 0; pi < pts.length; pi += stepPts) {
        const p = pts[pi];
        const hueG = hueAt(pi);
        const radius = s.size * (0.8 + s.dynamics * 1.5);
        const slices = 3 + Math.floor(s.density * 8);
        const seg = segs[Math.min(pi, segs.length - 1)];
        const followT = Math.max(0, Math.min(1, s.dynamics));
        const nx0 = 0, ny0 = 1; // static pose: bars stack vertically, extend horizontally
        const nx1 = seg ? seg.nx : nx0, ny1 = seg ? seg.ny : ny0;
        let nx = nx0 * (1 - followT) + nx1 * followT;
        let ny = ny0 * (1 - followT) + ny1 * followT;
        const nlen = Math.hypot(nx, ny) || 1;
        nx /= nlen; ny /= nlen;
        const tx = ny, ty = -nx; // tangent = normal rotated 90°
        for (let i = 0; i < slices; i++) {
          const yOff = (i / slices - 0.5) * radius * 2;
          const shift = (hash(Math.floor(tt * 8) + i + p.t) * 2) * s.size * (0.3 + s.noise * 2);
          const widthLine = radius * 2 * (0.6 + Math.random() * 0.4);
          const baseX = p.x + nx * yOff, baseY = p.y + ny * yOff;
          const startX = baseX - tx * (widthLine / 2) + tx * shift;
          const startY = baseY - ty * (widthLine / 2) + ty * shift;
          // Per feedback: color moved OUT of this brush entirely and into the "Глитч" MODE (see
          // target.glitchSplit in paint()/renderStroke) — this brush only shapes the slices now
          // (position/width/count/density), exactly like every other brush. The triple pass at
          // [-grid,0,grid] is shape/density (three interleaved offset copies per slice — dropping
          // it read as too smooth, see earlier fix), NOT color. BUT: in "Глитч" mode specifically,
          // paint() ALREADY triples every single call into three offset+tinted copies on its own
          // (target.glitchSplit) — stacking that on top of this brush's own triple pass compounded
          // into 9 small scattered blocks per step instead of 3, which is exactly what read as
          // faded/washed out (same total ink spread over 3x the positions). So: skip this brush's
          // own tripling specifically when "Глитч" is active (paint()'s tripling already covers
          // it) and keep it for every other mode, where paint() does nothing extra on its own.
          if (glitchOn) {
            for (let xb = 0; xb < widthLine; xb += grid) {
              if (Math.random() > 0.4 + s.intensity * 0.5) continue;
              const px = startX + tx * xb, py = startY + ty * xb;
              paint(target, Math.round(px / grid) * grid, Math.round(py / grid) * grid, grid, grid, hueG, 100, 55, alphaMul * 0.55);
            }
          } else {
            const offs = [-grid, 0, grid];
            for (let c2 = 0; c2 < 3; c2++) {
              for (let xb = 0; xb < widthLine; xb += grid) {
                if (Math.random() > 0.4 + s.intensity * 0.5) continue;
                const off = xb + offs[c2];
                const px = startX + tx * off, py = startY + ty * off;
                paint(target, Math.round(px / grid) * grid, Math.round(py / grid) * grid, grid, grid, hueG, 100, 55, alphaMul * 0.55);
              }
            }
          }
        }
      }
    }



    else if (s.kind === "mosaic") {
      // Same "reveal by threshold" idea as Дизеринг, but the block size varies per sampled point
      // (1x/2x/3x the base grid, picked from the noise table so it stays the same tile size for
      // that point every frame instead of reshuffling) instead of one uniform cell size — reads as
      // an irregular mosaic of tile sizes rather than a single fine grid.
      const baseGrid = Math.max(3, Math.round(s.size / 4));
      const stepPts = Math.max(1, Math.floor(pts.length / 40));
      const radius = s.size * (1 + s.dynamics * 1.5);
      const coverage = 0.4 + s.density * 0.6;
      // Same fix as Дизеринг: narrower swing (was 0.22, synchronized across the whole area) so
      // fewer tiles flip at once, and a per-point phase jitter below so neighboring points' reveal
      // fronts don't line up into one big synchronized wash across the painted area. Also raised
      // the coverage floor above (was 0.2) for the same reason as Дизеринг — the whole canvas is
      // cleared and every stroke fully repainted every frame, so a threshold that can sweep down
      // near zero means the stroke itself intermittently vanishes to background for part of every
      // cycle, not just "looks dimmer."
      const sweep = 0.5 + 0.08 * Math.sin(tt * (0.35 + s.speed * 1.2) * Math.PI * 2);
      for (let pi = 0; pi < pts.length; pi += stepPts) {
        const p = pts[pi];
        const hueM = hueAt(pi);
        const pointJitter = (noiseAt(pi * 17 + 3) - 0.5) * 0.16;
        const sweepP = sweep + pointJitter;
        const sizeClass = noiseAt(pi * 131 + Math.floor(p.x) * 7 + Math.floor(p.y) * 13);
        const grid = baseGrid * (sizeClass > 0.5 ? 3 : sizeClass > 0 ? 2 : 1);
        const cx = Math.round(p.x / grid) * grid, cy = Math.round(p.y / grid) * grid;
        const cellsAcross = Math.max(1, Math.ceil(radius / grid));
        for (let gy = -cellsAcross; gy <= cellsAcross; gy++) {
          for (let gx = -cellsAcross; gx <= cellsAcross; gx++) {
            const wx = cx + gx * grid, wy = cy + gy * grid;
            const dist = Math.hypot(wx - p.x, wy - p.y) / radius;
            if (dist > 1) continue;
            const grain = noiseAt(Math.round(wx / grid) * 7 + Math.round(wy / grid) * 13);
            // Baseline grain weight (0.15) independent of the noise slider — same reasoning as
            // Дизеринг: without it, at noise=0 every tile shares nearly the same threshold and
            // pops in/out together across a wide area, reading as a sitewide haze.
            const threshold = (sweepP + grain * (0.15 + s.noise * 0.4)) * coverage;
            if (dist > threshold) continue;
            // FIX: lit/alpha used to both scale by (1-dist) from the sample point — every cluster of
            // tiles faded out radially toward its edge, which is exactly what read as "circles of
            // blurred pixels" instead of a flat mosaic. Tiles are flat now: brightness only varies by
            // the tile's own fixed per-cell grain (real mosaic texture), never by distance, so there's
            // no soft circular falloff anywhere — just solid squares of different sizes, on or off.
            const lit = 48 + grain * 14;
            paint(target, wx, wy, grid, grid, hueM, 90, lit, alphaMul);
          }
        }
      }
    }

    else if (s.kind === "embers") {
      // FIX: continuous ember TRAIL, not a small persistent pool. The previous version kept a
      // particle pool hard-capped at 8-68 embers total (by density) that spawned biased toward the
      // most recently drawn points and only refilled as old particles individually expired — drag
      // across a wide area and the older parts of the stroke would have no embers left at all, since
      // the pool never grew past its cap and particles weren't tied to any fixed position on the
      // path. That read as "an effect happening near the brush tip", not something you paint a trail
      // with. Every sampled point along the WHOLE path now always has its own coal(s), the same way
      // ink/ribbon/dither/mosaic cover their whole path every frame — density controls how many
      // coals cluster around each point (a scatter, not just one dot) instead of a global count cap.
      // Each coal still flares/dims on its own out-of-sync cycle (a per-seed phase offset, exactly
      // like before) so it still reads as smoldering, not static — it just no longer disappears.
      const grid = Math.max(3, Math.round(s.size / 4));
      const stepPts = Math.max(1, Math.floor(pts.length / 60));
      const perPoint = Math.max(1, Math.round(1 + s.density * 5));
      for (let pi = 0; pi < pts.length; pi += stepPts) {
        const p = pts[pi];
        for (let k = 0; k < perPoint; k++) {
          const seed = pi * 97 + k * 13;
          const ex = p.x + noiseAt(seed) * s.size * 0.6;
          const ey = p.y + noiseAt(seed + 5000) * s.size * 0.6;
          const period = 1.2 + ((noiseAt(seed + 1) + 1) / 2) * 2.5;
          const phase = ((noiseAt(seed + 2) + 1) / 2) * Math.PI * 2;
          const glow = 0.5 + 0.5 * Math.sin((tt * 2 * Math.PI) / period + phase);
          const lit = 20 + glow * (30 + s.intensity * 20);
          const hueE = s.mode === "gradient"
            ? gradientHueAtXY(ex, ey)
            : (s.hue + noiseAt(seed + 3) * 30 + modeHueShift) % 360;
          paint(target, Math.round(ex / grid) * grid, Math.round(ey / grid) * grid, grid, grid, hueE, 85, lit, alphaMul * (0.3 + glow * 0.7));
        }
      }
    }

    } finally {
      if (spraySet) { target.spray = undefined; target.sprayKeep = undefined; }
      if (rgbShiftSet) { target.rgbShift = undefined; }
      if (glitchSplitSet) { target.glitchSplit = undefined; }
      if (chromeSet) { target.chromeFreq = undefined; target.chromeCos = undefined; target.chromeSin = undefined; target.chromePhase = undefined; target.chromeColorAmt = undefined; }
    }
  }

  // PERF: build a frozen stroke's render ONCE and cache it, instead of re-running its full
  // animation math (trig, noise, per-particle physics, per-pixel gradient sampling for fills) every
  // single frame forever for a result that — because it's frozen — never changes. Safe specifically
  // because renderStroke(frozenStroke, ...) is called with the SAME fixed effT/effDt/effNow every
  // time (see tick()), making it a pure, idempotent function of the stroke's own data: baking once
  // and blitting thereafter is indistinguishable from recomputing every frame, pixel for pixel.
  function bakeFrozenStroke(s: Stroke, w: number, h: number, effT: number, effDt: number, effNow: number, opts: RenderOpts) {
    const data = new Uint8ClampedArray(w * h * 4);
    const alphaBuf = new Uint8ClampedArray(w * h);
    const isoTarget: PaintTarget = { mode: "iso", buf: data, alphaBuf, bw: w, bh: h };
    renderStroke(isoTarget, s, w, h, effT, effDt, effNow, opts);
    const touched: number[] = [];
    for (let i = 0; i < alphaBuf.length; i++) if (alphaBuf[i] > 0) touched.push(i);
    s.bakedCache = { data, alpha: alphaBuf, touched, pointCount: s.points.length };
  }
  // Composite a stroke's baked cache onto the live (always-opaque) frame buffer — only touches the
  // pixels the stroke actually painted, so cost tracks the stroke's footprint, not canvas size.
  function compositeBakedStroke(buf: Uint8ClampedArray, cache: NonNullable<Stroke["bakedCache"]>) {
    const { data, alpha, touched } = cache;
    for (let k = 0; k < touched.length; k++) {
      const mi = touched[k], idx = mi * 4;
      const a = alpha[mi] / 255, ia = 1 - a;
      buf[idx] = data[idx] * a + buf[idx] * ia;
      buf[idx + 1] = data[idx + 1] * a + buf[idx + 1] * ia;
      buf[idx + 2] = data[idx + 2] * a + buf[idx + 2] * ia;
      buf[idx + 3] = 255;
    }
  }
  // Same idea, but onto a still-transparent destination (the per-layer 3D preview buffers) — needs
  // real "over" compositing against whatever alpha is already there, not the opaque shortcut above.
  function compositeBakedStrokeIso(buf: Uint8ClampedArray, alphaBuf: Uint8ClampedArray, cache: NonNullable<Stroke["bakedCache"]>) {
    const { data, alpha, touched } = cache;
    for (let k = 0; k < touched.length; k++) {
      const mi = touched[k], idx = mi * 4;
      blendIsoPixel(buf, alphaBuf, idx, mi, data[idx], data[idx + 1], data[idx + 2], alpha[mi] / 255);
    }
  }

  // Renders ONE layer, alone, onto a transparent RGBA buffer — used to build each layer's own
  // texture for the 3D "layers in depth" view. The normal 2D editor never needs this (it composites
  // every layer straight into one shared opaque buffer, cheaper, but can't be pulled back apart into
  // separate planes). Frozen strokes still use their bake cache, just composited with real alpha via
  // compositeBakedStrokeIso instead of the opaque-destination shortcut the main loop uses.
  function renderLayerIso(layer: Layer, w: number, h: number, t: number, dtRaw: number, now: number, opts: RenderOpts): { buf: Uint8ClampedArray; alphaBuf: Uint8ClampedArray } {
    const buf = new Uint8ClampedArray(w * h * 4);
    const alphaBuf = new Uint8ClampedArray(w * h);
    const target: PaintTarget = { mode: "iso", buf, alphaBuf, bw: w, bh: h };
    if (layer.image) {
      const imgPixels = ensureLayerImagePixels(layer, w, h);
      if (imgPixels) blitLayerImageIso(buf, alphaBuf, imgPixels);
    }
    for (const s of layer.strokes) {
      if (s.points.length === 0) continue;
      if (s.frozen) {
        if (!s.bakedCache || s.bakedCache.pointCount !== s.points.length) bakeFrozenStroke(s, w, h, s.born / 1000, 0, s.born, opts);
        compositeBakedStrokeIso(buf, alphaBuf, s.bakedCache!);
      } else {
        renderStroke(target, s, w, h, t, dtRaw, now, opts);
      }
    }
    return { buf, alphaBuf };
  }

  function drawSmoothPath(ctx: CanvasRenderingContext2D, pts: StrokePoint[], phase: number, wobble: number, noiseAmt: number) {
    if (pts.length < 2) {
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fillStyle = ctx.strokeStyle as string;
        ctx.fill();
      }
      return;
    }
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const next = pts[i + 1] || p;
      const dx = next.x - p.x, dy = next.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const w = Math.sin(i * 0.3 + phase * 6) * wobble + hash(i + phase * 10) * noiseAmt * wobble * 0.5;
      const x = p.x + nx * w;
      const y = p.y + ny * w;
      if (i === 0) ctx.moveTo(x, y);
      else {
        const prev = pts[i - 1];
        const mx = (prev.x + p.x) / 2;
        const my = (prev.y + p.y) / 2;
        ctx.quadraticCurveTo(mx, my, x, y);
      }
    }
    ctx.stroke();
  }

  // === Pointer ===
  const getPoint = (e: React.PointerEvent) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    const sx = canvasSize.w / r.width;
    const sy = canvasSize.h / r.height;
    // Pointer Events report 0.5 for mouse/generic pointers while a button is held (and 0 for touch
    // on some browsers that don't report real pressure) — 0.5 is the sane "no real pressure data"
    // fallback so those devices draw at a normal, constant weight instead of at zero/invisible.
    const pressure = e.pressure > 0 ? e.pressure : 0.5;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy, pressure };
  };

  const addPoint = (x: number, y: number, pressure = 0.5) => {
    const s = currentStrokeRef.current;
    if (!s) return;
    const now = performance.now();
    s.points.push({ x, y, t: (now - s.born) / 1000, pressure });
    if (s.mode === "mirror") {
      s.points.push({ x: canvasSize.w - x, y, t: (now - s.born) / 1000, pressure });
    }
    if (s.points.length > MAX_POINTS_PER_STROKE) {
      // decimate: keep every other point from the older half
      const half = Math.floor(MAX_POINTS_PER_STROKE / 2);
      const old = s.points.slice(0, s.points.length - half);
      const recent = s.points.slice(s.points.length - half);
      const dec: StrokePoint[] = [];
      for (let i = 0; i < old.length; i += 2) dec.push(old[i]);
      s.points = dec.concat(recent);
      // Indices are completely reshuffled by decimation — drop the segment cache, it rebuilds
      // lazily from the new point layout on the next frame.
      s.segCache = undefined;
      strokeSerCache.delete(s);
    }
  };

  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointersRef.current.size >= 2) {
      // Second finger arrived — this is now a pinch/pan gesture, not a draw. Abandon any stroke a
      // single first finger might already have started.
      if (pointerRef.current.down) { pointerRef.current.down = false; currentStrokeRef.current = null; }
      panDragRef.current = null;
      const info = getPinchInfo()!;
      pinchStateRef.current = { initialDist: info.dist, initialZoom: zoom, initialMid: info.mid, initialPan: { ...pan } };
      return;
    }

    if (spaceHeld) {
      panDragRef.current = { startX: e.clientX, startY: e.clientY, startPan: { ...pan } };
      return;
    }

    const { x, y, pressure } = getPoint(e);
    pointerRef.current = { x, y, px: x, py: y, down: true };

    if (selectTool) {
      const bbox = getSelectionBBox();
      if (bbox && x >= bbox.x0 && x <= bbox.x1 && y >= bbox.y0 && y <= bbox.y1) {
        moveDragRef.current = { lastX: x, lastY: y };
      } else {
        marqueeStartRef.current = { x, y };
        setMarquee({ x0: x, y0: y, x1: x, y1: y });
        setSelectedIds(new Set());
      }
      return;
    }

    if (refs.brush.current === "eraser") { eraseAt(x, y, refs.size.current); return; }

    if (refs.brush.current === "eyedropper") {
      // One-shot sample, not a draggable stroke — reads whatever is actually composited on screen
      // right now (same buffer the fill tool already reads from), same as eraser/fill above.
      pointerRef.current.down = false;
      const bufObj = pixelBufRef.current;
      if (!bufObj) return;
      const w = canvasSize.w, h = canvasSize.h;
      const sx = Math.min(w - 1, Math.max(0, Math.round(x)));
      const sy = Math.min(h - 1, Math.max(0, Math.round(y)));
      const idx = (sy * w + sx) * 4;
      const r = bufObj.data[idx], g = bufObj.data[idx + 1], b = bufObj.data[idx + 2];
      setHue(Math.round(rgbToHue(r, g, b)));
      return;
    }

    if (refs.brush.current === "fill") {
      pointerRef.current.down = false;
      const layerF = layersRef.current.find(l => l.id === activeLayerIdRef.current);
      if (!layerF || !layerF.visible) return;

      const w = canvasSize.w, h = canvasSize.h;
      const sx = Math.min(w - 1, Math.max(0, Math.round(x)));
      const sy = Math.min(h - 1, Math.max(0, Math.round(y)));

      // === Рисуем только текущий слой отдельно, без других слоёв ===
      const tmpBuf = new Uint8ClampedArray(w * h * 4);
      tmpBuf.fill(0);
      const tmpTarget: PaintTarget = {
        mode: "buffer",
        buf: tmpBuf,
        buf32: new Uint32Array(tmpBuf.buffer),
        bw: w,
        bh: h
      };

      // Картинка слоя
      if (layerF.image) {
        const imgPixels = ensureLayerImagePixels(layerF, w, h);
        if (imgPixels) {
          for (let i = 0; i < imgPixels.length; i++) {
            tmpBuf[i] = imgPixels[i];
          }
        }
      }

      // Все мазки текущего слоя
      const nowF = performance.now();
      for (const s of layerF.strokes) {
        if (s.points.length === 0) continue;
        const effT = s.frozen ? s.born / 1000 : nowF / 1000;
        const effDt = s.frozen ? 0 : 16;
        const effNow = s.frozen ? s.born : nowF;
        renderStroke(tmpTarget, s, w, h, effT, effDt, effNow, FULL_QUALITY_OPTS);
      }
      // === Конец отдельного рендера ===

      // Заливка смотрит только на текущий слой, а не на весь экран
      const mask = computeFloodMask(tmpBuf, w, h, sx, sy, refs.fillTolerance.current, refs.fillContiguous.current);

      // Удаляем старые заливки в этой же точке
      for (let i = layerF.strokes.length - 1; i >= 0; i--) {
        const old = layerF.strokes[i];
        if (old.kind !== "fill" || old.fillW !== w || old.fillH !== h) continue;
        const oldMask = old.fillMaskCache ?? (old.fillRuns ? decodeMaskRLE(old.fillRuns, w * h) : null);
        if (oldMask && oldMask[sy * w + sx]) layerF.strokes.splice(i, 1);
      }

      const fillStroke: Stroke = {
        id: ++strokeIdCounter,
        kind: "fill",
        mode: refs.mode.current,
        size: refs.size.current,
        hue: refs.hue.current,
        speed: refs.speed.current,
        density: refs.density.current,
        noise: refs.noise.current,
        intensity: refs.intensity.current,
        dynamics: refs.dynamics.current,
        modeSpeed: refs.modeSpeed.current,
        rainbowFlow: refs.rainbowFlow.current,
        rainbowFlowSpeed: refs.rainbowFlowSpeed.current,
        rainbowBlinkSpeed: refs.rainbowBlinkSpeed.current,
        gradientSpeed: refs.gradientSpeed.current,
        gradientScale: refs.gradientScale.current,
        gradientColors: refs.gradientColors.current.map(c => ({ ...c })),
        gradientAngle: refs.gradientAngle.current,
        frozen: !refs.animEnabled.current,
        points: [{ x: sx, y: sy, t: 0 }],
        born: performance.now(),
        fillRuns: encodeMaskRLE(mask),
        fillW: w,
        fillH: h,
      };
      layerF.strokes.push(fillStroke);
      pushHistory();
      return;
    }

    const layer = layersRef.current.find(l => l.id === activeLayerIdRef.current);
    if (!layer || !layer.visible) return;
    const stroke: Stroke = {
      id: ++strokeIdCounter,
      kind: refs.brush.current,
      mode: refs.mode.current,
      size: refs.size.current,
      hue: refs.hue.current,
      speed: refs.speed.current,
      density: refs.density.current,
      noise: refs.noise.current,
      intensity: refs.intensity.current,
      dynamics: refs.dynamics.current,
      modeSpeed: refs.modeSpeed.current,
      rainbowFlow: refs.rainbowFlow.current,
      rainbowFlowSpeed: refs.rainbowFlowSpeed.current,
      rainbowBlinkSpeed: refs.rainbowBlinkSpeed.current,
      gradientSpeed: refs.gradientSpeed.current,
      gradientScale: refs.gradientScale.current,
      gradientColors: refs.gradientColors.current.map(c => ({ ...c })),
      gradientAngle: refs.gradientAngle.current,
      frozen: !refs.animEnabled.current,
      points: [],
      born: performance.now(),
    };
    currentStrokeRef.current = stroke;
    layer.strokes.push(stroke);
    addPoint(x, y, pressure);
  };
  const onMove = (e: React.PointerEvent) => {
    if (activePointersRef.current.has(e.pointerId)) activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointersRef.current.size >= 2 && pinchStateRef.current) {
      const info = getPinchInfo()!;
      const scaleFactor = info.dist / (pinchStateRef.current.initialDist || 1);
      const newZoom = Math.min(6, Math.max(0.1, pinchStateRef.current.initialZoom * scaleFactor));
      setZoom(newZoom);
      setPan({
        x: pinchStateRef.current.initialPan.x + (info.mid.x - pinchStateRef.current.initialMid.x),
        y: pinchStateRef.current.initialPan.y + (info.mid.y - pinchStateRef.current.initialMid.y),
      });
      return;
    }

    if (panDragRef.current) {
      const pd = panDragRef.current;
      setPan({ x: pd.startPan.x + (e.clientX - pd.startX), y: pd.startPan.y + (e.clientY - pd.startY) });
      return;
    }

    const { x, y, pressure } = getPoint(e);
    pointerRef.current.x = x; pointerRef.current.y = y;
    if (!pointerRef.current.down) return;

    if (selectTool) {
      if (moveDragRef.current) {
        const dx = x - moveDragRef.current.lastX, dy = y - moveDragRef.current.lastY;
        const layer = layersRef.current.find(l => l.id === activeLayerId);
        if (layer) {
          for (const s of layer.strokes) {
            if (!selectedIdsRef.current.has(s.id)) continue;
            for (const p of s.points) { p.x += dx; p.y += dy; }
            // Geometry moved — cached per-segment offsets/baked pixels no longer line up.
            s.segCache = undefined; s.bakedCache = null; strokeSerCache.delete(s);
          }
        }
        moveDragRef.current = { lastX: x, lastY: y };
        bumpOverlay(v => v + 1);
      } else if (marqueeStartRef.current) {
        setMarquee({ x0: marqueeStartRef.current.x, y0: marqueeStartRef.current.y, x1: x, y1: y });
      }
      return;
    }

    if (refs.brush.current === "eraser") { eraseAt(x, y, refs.size.current); pointerRef.current.px = x; pointerRef.current.py = y; return; }
    const px = pointerRef.current.px, py = pointerRef.current.py;
    const dx = x - px, dy = y - py;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.floor(dist / 5));
    for (let i = 1; i <= steps; i++) addPoint(px + dx * (i / steps), py + dy * (i / steps), pressure);
    pointerRef.current.px = x; pointerRef.current.py = y;
  };
  const onUp = (e: React.PointerEvent) => {
    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size < 2) pinchStateRef.current = null;
    panDragRef.current = null;
    if (!pointerRef.current.down) return;
    pointerRef.current.down = false;

    if (selectTool) {
      if (moveDragRef.current) {
        moveDragRef.current = null;
        pushHistory();
        return;
      }
      if (marqueeStartRef.current) {
        const m = marquee;
        marqueeStartRef.current = null;
        setMarquee(null);
        if (m) {
          const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
          const y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
          const layer = layersRef.current.find(l => l.id === activeLayerId);
          const ids = new Set<number>();
          if (layer) {
            for (const s of layer.strokes) {
              for (const p of s.points) {
                if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) { ids.add(s.id); break; }
              }
            }
          }
          setSelectedIds(ids);
        }
      }
      return;
    }

    currentStrokeRef.current = null;
    pushHistory();
  };

  // === Layer ops ===
  const addLayer = () => {
    const id = ++layerIdCounter;
    const next = [...layersRef.current, { id, name: `Слой ${layersRef.current.length + 1}`, visible: true, strokes: [] }];
    layersRef.current = next;
    setLayers(next);
    setActiveLayerId(id);
    pushHistory();
  };
  const removeLayer = (id: number) => {
    if (layersRef.current.length === 1) return;
    const next = layersRef.current.filter(l => l.id !== id);
    layersRef.current = next;
    setLayers(next);
    if (activeLayerIdRef.current === id) setActiveLayerId(next[0].id);
    recomputeRainCount();
    pushHistory();
  };
  const toggleLayer = (id: number) => {
    const next = layersRef.current.map(l => l.id === id ? { ...l, visible: !l.visible } : l);
    layersRef.current = next;
    setLayers(next);
  };
  const clearActive = () => {
    const next = layersRef.current.map(l => l.id === activeLayerIdRef.current ? { ...l, strokes: [] } : l);
    layersRef.current = next;
    setLayers(next);
    recomputeRainCount();
    pushHistory();
  };
  const clearAll = () => {
    const next = layersRef.current.map(l => ({ ...l, strokes: [] }));
    layersRef.current = next;
    setLayers(next);
    recomputeRainCount();
    pushHistory();
  };

  // Import a PNG/JPG/GIF as a static picture on the active layer (drawn underneath that layer's
  // brush strokes, "contain"-fit to the canvas). Animated GIFs only show their first frame — this
  // reads it the same way <img>/ctx.drawImage always do, not a real animated-GIF decoder.
  const importImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      const next = layersRef.current.map(l =>
        l.id === activeLayerIdRef.current
          ? { ...l, image: { url }, imageEl: undefined, imagePixels: null }
          : l
      );
      layersRef.current = next;
      setLayers(next);
      pushHistory();
    };
    reader.readAsDataURL(file);
  };
  const removeActiveLayerImage = () => {
    const next = layersRef.current.map(l =>
      l.id === activeLayerIdRef.current
        ? { ...l, image: null, imageEl: undefined, imagePixels: null }
        : l
    );
    layersRef.current = next;
    setLayers(next);
    pushHistory();
  };

  // === New canvas ===
  const [newW, setNewW] = useState(1280);
  const [newH, setNewH] = useState(800);
  // FIX: this is what was actually crashing the whole page on "new canvas". The inputs' min/max
  // attributes only affect the spinner arrows and :invalid styling — they do NOT stop the user
  // from typing 0, a negative number, leaving the field blank (→ NaN → 0 via the `|| 0` fallback),
  // or a huge value like 99999. Any of those went straight into setCanvasSize unclamped, then into
  // `new Uint8ClampedArray(w*h*4)` and `new PIXI.Application({ width: w, height: h })` — a
  // zero-size or absurdly large WebGL context throws there, and that throw was uncaught, taking
  // down the whole render effect (and with it the page). Clamping the actual values used here to
  // the same 64-4096 range the inputs only pretend to enforce is what actually prevents that.
  const clampCanvasDim = (v: number): number => {
    if (!Number.isFinite(v)) return 64;
    return Math.max(64, Math.min(4096, Math.round(v)));
  };
  const newCanvas = () => {
    setCanvasSize({ w: clampCanvasDim(newW), h: clampCanvasDim(newH) });
    setZoom(1);
    setPan({ x: 0, y: 0 });
    const layer: Layer = { id: ++layerIdCounter, name: "Слой 1", visible: true, strokes: [] };
    const next = [layer];
    layersRef.current = next;
    setLayers(next);
    setActiveLayerId(layer.id);
    historyRef.current = [serializeLayers(next)];
    historyIdxRef.current = 0;
    setHistoryVer(v => v + 1);
    recomputeRainCount();
    // The old layer's strokes are gone — any selection/marquee/in-progress transform pointing at
    // them needs clearing too, or the selection overlay and its handles keep trying to read strokes
    // that no longer exist in any layer.
    setSelectedIds(new Set());
    setMarquee(null);
    marqueeStartRef.current = null;
    moveDragRef.current = null;
    transformRef.current = null;
  };

  // === Export ===
  // Render the full scene into an arbitrary context (used by exports at full quality).
  // PERF: exports always use FULL_QUALITY_OPTS (step=1, unlimited rain) — the live-preview
  // decimation above never touches exported PNG/GIF/MP4 quality.
  const renderScene = useCallback((tctx: CanvasRenderingContext2D, w: number, h: number, now: number, dtRaw: number) => {
    tctx.fillStyle = "#080a12";
    tctx.fillRect(0, 0, w, h);
    const t = now / 1000;
    const target: PaintTarget = { mode: "ctx", ctx: tctx };
    for (const layer of layersRef.current) {
      if (!layer.visible) continue;
      // Draw the imported image straight via ctx.drawImage (not the pre-rasterized live-preview
      // pixel cache) so it's resampled natively at the export's actual resolution/scale, using
      // whatever transform is already active on tctx, instead of upscaling a lower-res copy.
      if (layer.image) {
        const el = ensureLayerImageEl(layer);
        if (el) {
          const fitScale = Math.min(w / el.naturalWidth, h / el.naturalHeight);
          const dw = el.naturalWidth * fitScale, dh = el.naturalHeight * fitScale;
          tctx.drawImage(el, (w - dw) / 2, (h - dh) / 2, dw, dh);
        }
      }
      for (const s of layer.strokes) {
        if (s.points.length === 0) continue;
        const effT = s.frozen ? s.born / 1000 : t;
        const effDt = s.frozen ? 0 : dtRaw;
        const effNow = s.frozen ? s.born : now;
        renderStroke(target, s, w, h, effT, effDt, effNow, FULL_QUALITY_OPTS);
      }
    }
  }, []);

  // How many frames at the tail get crossfaded toward the matching frame at the head, for the loop
  // export option. ~0.6s worth, but never more than a third of the clip (a short clip shouldn't have
  // its whole content eaten by the blend) and never less than 2 frames.
  const loopBlendFrameCount = (fps: number, total: number) =>
    Math.max(2, Math.min(Math.round(fps * 0.6), Math.floor(total / 3)));

  const savePng = () => {
    const scale = Math.max(1, Math.min(4, exportScale));
    const w = Math.round(canvasSize.w * scale);
    const h = Math.round(canvasSize.h * scale);
    const tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext("2d")!;
    tctx.setTransform(scale, 0, 0, scale, 0, 0);
    renderScene(tctx, canvasSize.w, canvasSize.h, performance.now(), 16.67);
    tmp.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `living-pixels-${Date.now()}@${scale}x.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  };

  const exportGif = async () => {
    if (recording) return;
    const preset = GIF_PRESETS[gifQ];
    setRecording("gif"); setRecordProgress(0);
    try {
      const fps = exportFps, seconds = exportSec, total = Math.max(1, Math.round(fps * seconds));
      const scale = Math.max(1, Math.min(4, exportScale));
      const gifW = Math.round(canvasSize.w * scale);
      const gifH = Math.round(canvasSize.h * scale);
      // OffscreenCanvas when the browser supports it: never touches the DOM/layout at all (a
      // detached <canvas> element still exists in the same document/compositor bookkeeping an
      // attached one does), and it's what a future Worker-based export would need anyway since a
      // regular HTMLCanvasElement can't be transferred to a worker. Falls back to a normal canvas
      // on anything older. renderScene itself only uses drawing calls both context types share
      // (fillRect/drawImage/etc.), so no other change is needed to use it here.
      const tmp: HTMLCanvasElement | OffscreenCanvas =
        typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(gifW, gifH) : document.createElement("canvas");
      if (tmp instanceof HTMLCanvasElement) { tmp.width = gifW; tmp.height = gifH; }
      const tctx = tmp.getContext("2d", { willReadFrequently: true }) as unknown as CanvasRenderingContext2D;
      tctx.setTransform(scale, 0, 0, scale, 0, 0);
      const gif = GIFEncoder();
      const delay = Math.round(1000 / fps);
      const dtRaw = 1000 / fps;
      const startNow = performance.now();
      // See loopBlendFrameCount / exportLoop comment above: store the first `loopBlend` frames'
      // pixels as we render them, then during the last `loopBlend` frames blend progressively
      // toward the matching stored start frame so the clip's end eases into its own beginning.
      const loopBlend = exportLoop ? loopBlendFrameCount(fps, total) : 0;
      const startFrames: Uint8ClampedArray[] = [];
      // Pooled scratch buffer for the loop-blend mix, reused across every blend frame in this
      // export instead of `new Uint8ClampedArray(data.length)` allocated fresh each time — on a 4K
      // export that's an ~33MB allocation per frame during the blend tail, right when GC pressure
      // is least welcome. `getImageData` itself still allocates (no way around that through the
      // standard Canvas2D API without dropping ctx-mode rendering entirely), but this removes the
      // other big one.
      let blendScratch: Uint8ClampedArray | null = null;
      for (let i = 0; i < total; i++) {
        renderScene(tctx, canvasSize.w, canvasSize.h, startNow + i * dtRaw, dtRaw);
        let data = tctx.getImageData(0, 0, gifW, gifH).data;
        if (loopBlend > 0) {
          if (i < loopBlend) {
            startFrames.push(new Uint8ClampedArray(data));
          } else if (i >= total - loopBlend) {
            const k = i - (total - loopBlend);
            const startData = startFrames[k];
            if (startData) {
              const mix = (k + 1) / loopBlend; // ramps up to a full blend at the very last frame
              if (!blendScratch || blendScratch.length !== data.length) blendScratch = new Uint8ClampedArray(data.length);
              const blended = blendScratch;
              for (let p = 0; p < data.length; p += 4) {
                blended[p] = data[p] * (1 - mix) + startData[p] * mix;
                blended[p + 1] = data[p + 1] * (1 - mix) + startData[p + 1] * mix;
                blended[p + 2] = data[p + 2] * (1 - mix) + startData[p + 2] * mix;
                blended[p + 3] = 255;
              }
              data = blended;
            }
          }
        }
        const palette = quantize(data, preset.colors);
        const index = applyPalette(data, palette);
        gif.writeFrame(index, gifW, gifH, { palette, delay });
        setRecordProgress((i + 1) / total);
        // FIX: was only yielding every 4th frame — meant up to 4 full 4K frames' worth of render +
        // getImageData + quantize + palette work ran back-to-back with no chance for the browser to
        // paint/respond in between, which is exactly what read as "the whole page freezes" during a
        // big export. Yielding every frame costs a little wall-clock time but keeps the tab alive
        // and responsive (progress bar actually animates, tab doesn't look hung) throughout.
        await new Promise(r => setTimeout(r, 0));
      }
      gif.finish();
      const bytes = gif.bytesView();
      const buf = new Uint8Array(bytes.byteLength); buf.set(bytes);
      const blob = new Blob([buf], { type: "image/gif" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `living-pixels-${Date.now()}.gif`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      (gif as unknown as { bytes?: () => Uint8Array }).bytes?.();
    } finally {
      setRecording(null); setRecordProgress(0);
    }
  };

  const exportMp4 = async () => {
    if (recording) return;
    const preset = MP4_PRESETS[mp4Q];
    const scale = Math.max(1, Math.min(4, exportScale));
    const seconds = exportSec;
    const fps = exportFps;
    const total = Math.max(1, Math.round(fps * seconds));
    const w = Math.round(canvasSize.w * scale);
    const h = Math.round(canvasSize.h * scale);

    const tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext("2d")!;
    tctx.setTransform(scale, 0, 0, scale, 0, 0);

    // frame-by-frame stream: captureStream(0) + requestFrame per rendered frame
    const stream = (tmp as HTMLCanvasElement).captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const mimes = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    const mime = mimes.find(m => (window as any).MediaRecorder?.isTypeSupported?.(m)) || "video/webm";
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: preset.bps });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    setRecording("mp4"); setRecordProgress(0);
    rec.start();
    try {
      const dtRaw = 1000 / fps;
      const startNow = performance.now();
      // prime first frame before start
      renderScene(tctx, canvasSize.w, canvasSize.h, startNow, dtRaw);
      const loopBlend = exportLoop ? loopBlendFrameCount(fps, total) : 0;
      const startFrames: Uint8ClampedArray[] = [];
      for (let i = 0; i < total; i++) {
        renderScene(tctx, canvasSize.w, canvasSize.h, startNow + i * dtRaw, dtRaw);
        if (loopBlend > 0) {
          if (i < loopBlend) {
            startFrames.push(new Uint8ClampedArray(tctx.getImageData(0, 0, w, h).data));
          } else if (i >= total - loopBlend) {
            const k = i - (total - loopBlend);
            const startData = startFrames[k];
            if (startData) {
              const imgData = tctx.getImageData(0, 0, w, h);
              const data = imgData.data;
              const mix = (k + 1) / loopBlend;
              for (let p = 0; p < data.length; p += 4) {
                data[p] = data[p] * (1 - mix) + startData[p] * mix;
                data[p + 1] = data[p + 1] * (1 - mix) + startData[p + 1] * mix;
                data[p + 2] = data[p + 2] * (1 - mix) + startData[p + 2] * mix;
              }
              tctx.putImageData(imgData, 0, 0);
            }
          }
        }
        track.requestFrame?.();
        setRecordProgress((i + 1) / total);
        // yield so the encoder can consume the frame
        await new Promise(r => setTimeout(r, 1000 / fps));
      }
    } finally {
      rec.stop();
      await new Promise<void>(r => { rec.onstop = () => r(); });
      track.stop();
      const blob = new Blob(chunks, { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `living-pixels-${Date.now()}.${mime.includes("mp4") ? "mp4" : "webm"}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      setRecording(null); setRecordProgress(0);
    }
  };

  // Keyboard: Ctrl+Z / Ctrl+Shift+Z
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      } else if (e.key.toLowerCase() === "y") {
        e.preventDefault(); redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const ParamSlider = ({ label, value, set }: { label: string; value: number; set: (n: number) => void }) => (
    <label className="flex flex-col gap-1 text-[10px] uppercase tracking-widest text-white/50">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="text-white/80">{Math.round(value * 100)}</span>
      </span>
      <input type="range" min={0} max={1} step={0.01} value={value} onChange={(e) => set(+e.target.value)} className="w-full accent-white" />
    </label>
  );

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#05060c] text-white flex">
      {/* Sidebar */}
      <aside className="z-20 flex h-full w-72 shrink-0 flex-col gap-3 overflow-y-auto border-r border-white/10 bg-black/70 p-3 backdrop-blur-xl">
        <div className="flex items-center justify-between">
          <h1 className="select-none text-[11px] font-medium tracking-[0.3em] text-white/70">LIVING PIXELS</h1>
        </div>

        {/* Undo / Redo */}
        <div className="flex gap-1.5">
          <button onClick={undo} disabled={!canUndo || !!recording} className="flex-1 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] tracking-wider transition hover:bg-white/10 disabled:opacity-30">↶ Отменить</button>
          <button onClick={redo} disabled={!canRedo || !!recording} className="flex-1 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] tracking-wider transition hover:bg-white/10 disabled:opacity-30">Вернуть ↷</button>
        </div>

        {/* Global animation toggle — only affects strokes drawn AFTER this is flipped; strokes
            already on the canvas keep animating (or stay static) exactly as they were born. */}
        <label className="flex cursor-pointer items-center gap-2 rounded-md border border-white/10 bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-white/70 select-none">
          <input
            type="checkbox"
            checked={animEnabled}
            onChange={(e) => setAnimEnabled(e.target.checked)}
            className="h-3.5 w-3.5 accent-white"
          />
          <span>Анимация</span>
          <span className="ml-auto text-[9px] uppercase tracking-widest text-white/35">
            {animEnabled ? "новые мазки живые" : "новые мазки статичны"}
          </span>
        </label>

        {/* New canvas */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
          <div className="mb-1.5 text-[9px] uppercase tracking-widest text-white/40">Холст</div>
          <div className="mb-2 flex items-center gap-1.5 text-[11px]">
            <input type="number" min={64} max={4096} value={newW} onChange={(e) => setNewW(+e.target.value || 0)} className="w-full rounded border border-white/10 bg-black/40 px-1.5 py-1 text-white" />
            <span className="text-white/40">×</span>
            <input type="number" min={64} max={4096} value={newH} onChange={(e) => setNewH(+e.target.value || 0)} className="w-full rounded border border-white/10 bg-black/40 px-1.5 py-1 text-white" />
          </div>
          <button onClick={newCanvas} disabled={!!recording} className="w-full rounded-md border border-white/15 bg-white/10 px-2 py-1.5 text-[11px] tracking-wider transition hover:bg-white/15 disabled:opacity-30">+ Новый холст</button>
          <div className="mt-1.5 text-[9px] text-white/40">Текущий: {canvasSize.w}×{canvasSize.h}</div>
        </section>

        {/* Layers */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[9px] uppercase tracking-widest text-white/40">Слои</div>
            <button onClick={addLayer} className="rounded border border-white/15 bg-white/10 px-2 py-0.5 text-[10px] hover:bg-white/20">+ Слой</button>
          </div>
          <ul className="flex flex-col gap-1">
            {[...layers].reverse().map((l) => (
              <li key={l.id} className={`flex items-center gap-1.5 rounded-md border px-1.5 py-1 ${activeLayerId === l.id ? "border-white/40 bg-white/10" : "border-white/5 bg-transparent hover:bg-white/[0.04]"}`}>
                <button onClick={() => toggleLayer(l.id)} className="text-[12px] leading-none text-white/70 hover:text-white" title="Видимость">{l.visible ? "👁" : "—"}</button>
                <button onClick={() => setActiveLayerId(l.id)} className="flex-1 truncate text-left text-[11px]">{l.name}</button>
                <span className="text-[9px] text-white/30">{l.strokes.length}</span>
                <button onClick={() => removeLayer(l.id)} disabled={layers.length === 1} className="text-[11px] text-white/40 hover:text-red-400 disabled:opacity-20" title="Удалить">✕</button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-1.5">
            <button onClick={clearActive} className="flex-1 rounded border border-white/10 px-1.5 py-1 text-[10px] uppercase tracking-widest text-white/60 hover:bg-white/5">Очистить слой</button>
            <button onClick={clearAll} className="flex-1 rounded border border-white/10 px-1.5 py-1 text-[10px] uppercase tracking-widest text-white/60 hover:bg-white/5">Всё</button>
          </div>
          <label className="mt-1.5 block cursor-pointer rounded border border-dashed border-white/20 px-1.5 py-1.5 text-center text-[10px] uppercase tracking-widest text-white/50 hover:border-white/50 hover:text-white" title="Вставить PNG/JPG/GIF как картинку на активный слой (под кистями этого слоя)">
            Импорт изображения (PNG/JPG/GIF)
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) importImage(file);
                e.target.value = "";
              }}
            />
          </label>
          {layers.find(l => l.id === activeLayerId)?.image && (
            <button
              onClick={removeActiveLayerImage}
              className="mt-1.5 w-full rounded border border-white/10 px-1.5 py-1 text-[10px] uppercase tracking-widest text-white/60 hover:bg-white/5 hover:text-red-400"
            >
              Убрать картинку слоя
            </button>
          )}
        </section>

        {/* Selection / move tool — a real, separate mode from painting so drags move strokes
            instead of drawing them. Only strokes on the active layer are selectable, same as fill
            and eraser already only ever touch it. Fill/eraser/eyedropper live here too — one-shot
            canvas actions rather than animated brushes, so grouped with draw/select instead of the
            brush grid below. */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
          <div className="mb-1.5 text-[9px] uppercase tracking-widest text-white/40">Инструмент</div>
          <div className="grid grid-cols-2 gap-1">
            <button
              onClick={() => { setSelectTool(false); setSelectedIds(new Set()); setMarquee(null); }}
              className={`rounded border px-2 py-1 text-[10px] tracking-wider transition ${!selectTool ? "border-white/60 bg-white/15" : "border-white/10 bg-white/[0.02] text-white/60 hover:bg-white/[0.06]"}`}
            >
              Рисование
            </button>
            <button
              onClick={() => setSelectTool(true)}
              className={`rounded border px-2 py-1 text-[10px] tracking-wider transition ${selectTool ? "border-white/60 bg-white/15" : "border-white/10 bg-white/[0.02] text-white/60 hover:bg-white/[0.06]"}`}
            >
              Выделение
            </button>
            {TOOLS.map(b => (
              <button key={b.id} onClick={() => { setSelectTool(false); setSelectedIds(new Set()); setMarquee(null); setBrush(b.id); }} className={`rounded border px-2 py-1 text-[10px] tracking-wider transition ${!selectTool && brush === b.id ? "border-white/60 bg-white/15" : "border-white/10 bg-white/[0.02] text-white/60 hover:bg-white/[0.06]"}`}>{b.label}</button>
            ))}
          </div>
          {selectTool && (
            <div className="mt-1.5 text-[9px] text-white/40">
              {selectedIds.size > 0 ? `Выбрано мазков: ${selectedIds.size} — тяните внутри рамки (перенос), за угол (размер) или за верхнюю точку (поворот)` : "Обведите рамкой мазки на активном слое"}
            </div>
          )}
        </section>

        {/* Brushes */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
          <div className="mb-1.5 text-[9px] uppercase tracking-widest text-white/40">Кисть</div>
          <div className="grid grid-cols-2 gap-1">
            {BRUSHES.map(b => (
              <button key={b.id} onClick={() => setBrush(b.id)} className={`rounded border px-2 py-1 text-[10px] tracking-wider transition ${brush === b.id ? "border-white/60 bg-white/15" : "border-white/10 bg-white/[0.02] text-white/60 hover:bg-white/[0.06]"}`}>{b.label}</button>
            ))}
          </div>
        </section>

        {/* Dedicated Fill (bucket) tool menu — only visible while "Заливка" is selected */}
        {brush === "fill" && (
          <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5 space-y-2">
            <div className="mb-1.5 text-[9px] uppercase tracking-widest text-white/40">Заливка — область</div>
            <div className="flex gap-1">
              <button
                onClick={() => setFillContiguous(true)}
                className={`flex-1 rounded border px-1.5 py-1 text-[10px] tracking-wider transition ${fillContiguous ? "border-white/60 bg-white/15" : "border-white/10 bg-white/[0.02] text-white/60 hover:bg-white/[0.06]"}`}
              >
                Связная
              </button>
              <button
                onClick={() => setFillContiguous(false)}
                className={`flex-1 rounded border px-1.5 py-1 text-[10px] tracking-wider transition ${!fillContiguous ? "border-white/60 bg-white/15" : "border-white/10 bg-white/[0.02] text-white/60 hover:bg-white/[0.06]"}`}
              >
                Всё выд.
              </button>
            </div>
            <label className="block text-[10px] uppercase tracking-widest text-white/50">
              <span className="mb-1 flex justify-between"><span>Допуск</span><span className="text-white/80">{fillTolerance}</span></span>
              <input type="range" min={0} max={255} value={fillTolerance} onChange={(e) => setFillTolerance(+e.target.value)} className="w-full accent-white" />
            </label>
            <div className="text-[8px] normal-case tracking-normal text-white/30">
              Использует текущий цвет и режим (обычный/радуга/пульс/градиент)
            </div>
          </section>
        )}

        {/* Modes */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
          <div className="mb-1.5 text-[9px] uppercase tracking-widest text-white/40">Режим</div>
          <div className="grid grid-cols-3 gap-1">
            {MODES.map(m => (
              <button key={m.id} onClick={() => setMode(m.id)} className={`rounded border px-1.5 py-1 text-[9px] uppercase tracking-widest transition ${mode === m.id ? "border-white/60 bg-white/10" : "border-white/5 text-white/40 hover:text-white/80"}`}>{m.label}</button>
            ))}
          </div>
          {mode === "rainbow" && (
            <button
              onClick={() => setRainbowFlow(v => !v)}
              className="mt-1.5 w-full rounded border border-white/10 bg-white/[0.02] px-1.5 py-1 text-[9px] uppercase tracking-widest text-white/60 transition hover:bg-white/5"
            >
              {rainbowFlow ? "Радуга: Поток вдоль мазка" : "Радуга: Мигание целиком"}
            </button>
          )}
          {mode === "rainbow" && rainbowFlow && (
            <div className="mt-2 border-t border-white/10 pt-2">
              <ParamSlider label="Скорость потока" value={rainbowFlowSpeed} set={setRainbowFlowSpeed} />
            </div>
          )}
          {mode === "rainbow" && !rainbowFlow && (
            <div className="mt-2 border-t border-white/10 pt-2">
              <ParamSlider label="Скорость мигания" value={rainbowBlinkSpeed} set={setRainbowBlinkSpeed} />
            </div>
          )}
          {(mode === "pulse" || mode === "glitch" || mode === "rgbShift") && (
            <div className="mt-2 border-t border-white/10 pt-2">
              <ParamSlider label="Скорость режима" value={modeSpeed} set={setModeSpeed} />
            </div>
          )}
        </section>

        {/* Dedicated Gradient tool menu — only visible while the Gradient mode is active */}
        {mode === "gradient" && (
          <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5 space-y-2">
            <div className="mb-1.5 text-[9px] uppercase tracking-widest text-white/40">Градиент — цвета</div>

            <div className="space-y-1.5">
              {gradientColors.map((c, i) => {
                const totalWeight = gradientColors.reduce((a, cc) => a + Math.max(0.05, cc.weight), 0);
                const sharePct = Math.round((Math.max(0.05, c.weight) / totalWeight) * 100);
                return (
                <div key={i} className="flex items-center gap-2 rounded border border-white/5 bg-black/20 px-1.5 py-1">
                  <input
                    type="color"
                    value={hueToHex(c.hue)}
                    onChange={(e) => {
                      const hue = hexToHue(e.target.value);
                      setGradientColors(cols => cols.map((cc, ci) => ci === i ? { ...cc, hue } : cc));
                    }}
                    className="h-6 w-6 shrink-0 cursor-pointer rounded border border-white/20 bg-transparent p-0"
                    title={`Цвет ${i + 1}`}
                  />
                  <input
                    type="range"
                    min={5}
                    max={300}
                    value={Math.round(c.weight * 100)}
                    onChange={(e) => {
                      const weight = +e.target.value / 100;
                      setGradientColors(cols => cols.map((cc, ci) => ci === i ? { ...cc, weight } : cc));
                    }}
                    className="w-full accent-white"
                    title="Тяжесть этого цвета в смеси"
                  />
                  <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-white/50">{sharePct}%</span>
                  {gradientColors.length > 2 && (
                    <button
                      onClick={() => setGradientColors(cols => cols.filter((_, ci) => ci !== i))}
                      className="shrink-0 text-[11px] text-white/40 hover:text-red-400"
                      title="Удалить цвет"
                    >
                      ✕
                    </button>
                  )}
                </div>
                );
              })}
              {gradientColors.length < 6 && (
                <button
                  onClick={() => setGradientColors(cols => [...cols, { hue: Math.round(Math.random() * 360), weight: 1 }])}
                  className="w-full rounded border border-dashed border-white/30 py-1 text-[10px] text-white/50 hover:border-white/60 hover:text-white"
                >
                  + Добавить цвет
                </button>
              )}
            </div>

            <label className="block text-[10px] uppercase tracking-widest text-white/50">
              <span className="mb-1 flex justify-between">
                <span>Поворот направления</span>
                <span className="text-white/80">{gradientAngle > 0 ? "+" : ""}{gradientAngle}°</span>
              </span>
              <input
                type="range"
                min={-180}
                max={180}
                value={gradientAngle}
                onChange={(e) => setGradientAngle(+e.target.value)}
                className="w-full accent-white"
              />
              <span className="mt-1 block text-[8px] normal-case tracking-normal text-white/30">
                0° — вдоль мазка (для заливки — угол вручную)
              </span>
            </label>

            <label className="block text-[10px] uppercase tracking-widest text-white/50">
              <span className="mb-1 flex justify-between">
                <span>Масштаб</span>
                <span className="text-white/80">×{gradientScale.toFixed(1)}</span>
              </span>
              <input
                type="range"
                min={0.2}
                max={4}
                step={0.1}
                value={gradientScale}
                onChange={(e) => setGradientScale(+e.target.value)}
                className="w-full accent-white"
              />
              <span className="mt-1 block text-[8px] normal-case tracking-normal text-white/30">
                Сколько раз цикл цветов повторяется вдоль направления мазка
              </span>
            </label>

            <ParamSlider label="Скорость потока" value={gradientSpeed} set={setGradientSpeed} />
          </section>
        )}

        {/* Size / Hue */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5 space-y-2">
          <label className="block text-[10px] uppercase tracking-widest text-white/50">
            <span className="mb-1 flex justify-between"><span>Размер</span><span className="text-white/80">{size}</span></span>
            <input type="range" min={4} max={120} value={size} onChange={(e) => setSize(+e.target.value)} className="w-full accent-white" />
          </label>
          <label className="block text-[10px] uppercase tracking-widest text-white/50">
            <span className="mb-1 flex items-center justify-between">
              <span>Цвет</span>
              <span className="h-4 w-4 rounded-full border border-white/30" style={{ backgroundColor: `hsl(${hue}, 90%, 60%)` }} />
            </span>
            <input type="range" min={0} max={360} value={hue} onChange={(e) => setHue(+e.target.value)} className="w-full" style={{ background: "linear-gradient(to right, hsl(0,90%,60%), hsl(60,90%,60%), hsl(120,90%,60%), hsl(180,90%,60%), hsl(240,90%,60%), hsl(300,90%,60%), hsl(360,90%,60%))", appearance: "none", height: 6, borderRadius: 999 }} />
          </label>
        </section>

        {/* Params */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5 space-y-2">
          <div className="mb-1 text-[9px] uppercase tracking-widest text-white/40">Параметры</div>
          <ParamSlider label="Скорость" value={speed} set={setSpeed} />
          <ParamSlider label="Плотность" value={density} set={setDensity} />
          <ParamSlider label="Шум" value={noise} set={setNoise} />
          <ParamSlider label="Интенсив." value={intensity} set={setIntensity} />
          <ParamSlider label="Динамика" value={dynamics} set={setDynamics} />
        </section>

        {/* Export */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5 space-y-2">
          <div className="text-[9px] uppercase tracking-widest text-white/40">Экспорт</div>

          {/* Scale + Duration selectors (shared) */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[9px] uppercase tracking-widest text-white/40">
              <span>Масштаб</span>
              <span className="text-white/70 normal-case tracking-normal">{Math.round(canvasSize.w * exportScale)}×{Math.round(canvasSize.h * exportScale)}</span>
            </div>
            <div className="flex gap-1">
              {SCALES.map(s => (
                <button key={s} onClick={() => setExportScale(s)} className={`flex-1 rounded border px-1 py-1 text-[10px] tracking-wider transition ${exportScale === s ? "border-white/60 bg-white/10" : "border-white/5 text-white/40 hover:text-white/80"}`}>{s}x</button>
              ))}
            </div>
          </div>
          <label className="block text-[10px] uppercase tracking-widest text-white/50">
            <span className="mb-1 flex justify-between"><span>Длительность</span><span className="text-white/80">{exportSec}s</span></span>
            <input type="range" min={1} max={30} step={1} value={exportSec} onChange={(e) => setExportSec(+e.target.value)} className="w-full accent-white" />
          </label>
          <label className="block text-[10px] uppercase tracking-widest text-white/50">
            <span className="mb-1 flex justify-between"><span>FPS</span><span className="text-white/80">{exportFps} fps</span></span>
            <input type="range" min={5} max={60} step={1} value={exportFps} onChange={(e) => setExportFps(+e.target.value)} className="w-full accent-white" />
          </label>

          <label className="flex cursor-pointer items-center gap-2 rounded border border-white/10 bg-white/[0.02] px-2 py-1.5 text-[10px] text-white/70 select-none" title="Плавно подмешивает конец ролика к его началу, чтобы GIF/MP4 зацикливался без рывка и без реверса (не пинг-понг)">
            <input
              type="checkbox"
              checked={exportLoop}
              onChange={(e) => setExportLoop(e.target.checked)}
              className="h-3.5 w-3.5 accent-white"
            />
            <span>Логичный луп</span>
            <span className="ml-auto text-[9px] uppercase tracking-widest text-white/35">без пинг-понга</span>
          </label>

          <button onClick={savePng} disabled={!!recording} className="w-full rounded border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] tracking-widest hover:bg-white/10 disabled:opacity-40">PNG · {exportScale}x</button>

          <div className="space-y-1">
            <div className="flex gap-1">
              {(Object.keys(GIF_PRESETS) as GifQ[]).map(q => (
                <button key={q} onClick={() => setGifQ(q)} className={`flex-1 rounded border px-1 py-1 text-[9px] uppercase tracking-widest transition ${gifQ === q ? "border-white/60 bg-white/10" : "border-white/5 text-white/40 hover:text-white/80"}`}>{GIF_PRESETS[q].label}</button>
              ))}
            </div>
            <button onClick={exportGif} disabled={!!recording} className="w-full rounded border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] tracking-widest hover:bg-white/10 disabled:opacity-40">
              {recording === "gif" ? `GIF ${Math.round(recordProgress * 100)}%` : `GIF · ${exportFps}fps ${exportSec}s`}
            </button>
          </div>

          <div className="space-y-1">
            <div className="flex gap-1">
              {(Object.keys(MP4_PRESETS) as Mp4Q[]).map(q => (
                <button key={q} onClick={() => setMp4Q(q)} className={`flex-1 rounded border px-1 py-1 text-[9px] uppercase tracking-widest transition ${mp4Q === q ? "border-white/60 bg-white/10" : "border-white/5 text-white/40 hover:text-white/80"}`}>{MP4_PRESETS[q].label}</button>
              ))}
            </div>
            <button onClick={exportMp4} disabled={!!recording} className="w-full rounded border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] tracking-widest hover:bg-white/10 disabled:opacity-40">
              {recording === "mp4" ? `MP4 ${Math.round(recordProgress * 100)}%` : `MP4 · ${exportFps}fps ${exportSec}s ${(MP4_PRESETS[mp4Q].bps/1_000_000).toFixed(1)}M`}
            </button>
          </div>
        </section>

        <div className="text-center text-[9px] text-white/30">Ctrl+Z / Ctrl+Shift+Z</div>
      </aside>

      {/* Canvas area — a free camera flying over a fixed-size canvas, not a scrolling page.
          Space+drag or two-finger touch pans; Ctrl/Cmd+wheel or pinch zooms. The dotted background
          extends past the canvas's own visible border so its edges are always apparent. */}
      <div
        ref={wrapRef}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setZoom((z) => Math.min(6, Math.max(0.1, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
          } else {
            e.preventDefault();
            setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
          }
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        className="relative flex-1 touch-none select-none overflow-hidden"
        style={{
          background: "#0a0b12",
          backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          cursor: spaceHeld ? (panDragRef.current ? "grabbing" : "grab") : (selectTool ? "default" : "crosshair"),
        }}
      >
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)`,
          }}
        >
          <canvas
            ref={canvasRef}
            style={{ width: canvasSize.w * zoom, height: canvasSize.h * zoom, imageRendering: "pixelated" }}
            className="block rounded-lg border border-white/10 bg-[#080a12] shadow-2xl"
          />
          {/* Selection overlay: live marquee while dragging a new box, or the bounding box of the
              current selection (draggable from inside via onDown's hit-test above) — same
              canvas-unit → screen-pixel scale (`* zoom`) the canvas element itself uses, positioned
              inside the same pan/zoom-transformed wrapper so it always lines up with the strokes. */}
          {selectTool && marquee && (
            <div
              className="pointer-events-none absolute border border-dashed border-cyan-300/80 bg-cyan-300/10"
              style={{
                left: Math.min(marquee.x0, marquee.x1) * zoom,
                top: Math.min(marquee.y0, marquee.y1) * zoom,
                width: Math.abs(marquee.x1 - marquee.x0) * zoom,
                height: Math.abs(marquee.y1 - marquee.y0) * zoom,
              }}
            />
          )}
          {selectTool && !marquee && selectedIds.size > 0 && (() => {
            const bbox = getSelectionBBox();
            if (!bbox) return null;
            const left = bbox.x0 * zoom, top = bbox.y0 * zoom;
            const width = (bbox.x1 - bbox.x0) * zoom, height = (bbox.y1 - bbox.y0) * zoom;
            const cx = left + width / 2;
            const HS = 10; // handle size in screen px — fixed regardless of zoom, like every other editor's handles
            const corners: { key: "nw" | "ne" | "sw" | "se"; x: number; y: number; cursor: string }[] = [
              { key: "nw", x: left, y: top, cursor: "nwse-resize" },
              { key: "ne", x: left + width, y: top, cursor: "nesw-resize" },
              { key: "sw", x: left, y: top + height, cursor: "nesw-resize" },
              { key: "se", x: left + width, y: top + height, cursor: "nwse-resize" },
            ];
            return (
              <>
                <div
                  className="pointer-events-none absolute border border-dashed border-cyan-300/80"
                  style={{ left, top, width, height }}
                />
                {/* Rotate handle — a short stalk above the box's top-center, ending in a circular
                    grip. Distance from the box is in fixed screen px (not scaled by zoom) so it
                    stays a comfortable, constant grab target at any zoom level. */}
                <div className="pointer-events-none absolute bg-cyan-300/80" style={{ left: cx - 0.5, top: top - 22, width: 1, height: 22 }} />
                <div
                  onPointerDown={startRotateDrag}
                  onPointerMove={onHandleMove}
                  onPointerUp={onHandleUp}
                  onPointerCancel={onHandleUp}
                  className="absolute touch-none rounded-full border border-cyan-300 bg-cyan-300/90"
                  style={{ left: cx - HS / 2, top: top - 22 - HS / 2, width: HS, height: HS, cursor: "grab" }}
                  title="Повернуть"
                />
                {corners.map(c => (
                  <div
                    key={c.key}
                    onPointerDown={(e) => startScaleDrag(e, c.key)}
                    onPointerMove={onHandleMove}
                    onPointerUp={onHandleUp}
                    onPointerCancel={onHandleUp}
                    className="absolute touch-none border border-cyan-300 bg-cyan-300/90"
                    style={{ left: c.x - HS / 2, top: c.y - HS / 2, width: HS, height: HS, cursor: c.cursor }}
                    title="Изменить размер"
                  />
                ))}
              </>
            );
          })()}
        </div>
        <div className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-1 rounded-md border border-white/10 bg-black/60 p-1 text-[11px] backdrop-blur">
          <button onClick={() => setZoom((z) => Math.max(0.1, z / 1.2))} className="pointer-events-auto rounded px-2 py-0.5 hover:bg-white/10">−</button>
          <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} className="pointer-events-auto rounded px-2 py-0.5 tabular-nums hover:bg-white/10">{Math.round(zoom * 100)}%</button>
          <button onClick={() => setZoom((z) => Math.min(6, z * 1.2))} className="pointer-events-auto rounded px-2 py-0.5 hover:bg-white/10">+</button>
        </div>
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-white/10 bg-black/60 px-2 py-1 text-[9px] uppercase tracking-widest text-white/40 backdrop-blur">
          Пробел+перетаскивание или два пальца — панорама
        </div>

      </div>
    </main>
  );
}

import { clamp, createRandom, deriveSeed, lerp } from "../math/random.js";
import type { Rgb } from "./lighting.js";

export interface ScenePalette {
  source: "artwork" | "random";
  /** Actual source swatches as normalized RGB; never invented complementary hues. */
  colors: readonly Rgb[];
  anchorHue: number;
}

interface Bucket { weight: number; r: number; g: number; b: number }
/** Squared RGB distance a medoid may sit from its k-means center (about 0.17 per channel). */
const MEDOID_BUDGET = 0.03;
const randomPalettes = new Map<string, ScenePalette>();
const finite = (value: number, fallback: number): number => Number.isFinite(value) ? value : fallback;

export function rgbHue(rgb: Rgb): number {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta < 1e-7) return 0;
  return (((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60) % 360 + 360) % 360;
}

/** Extract up to five visible RGB medoids; transparent pixels have no influence. */
export function extractPalette(pixels: Uint8ClampedArray | Uint8Array): ScenePalette {
  if (pixels.length % 4 !== 0) throw new Error("Palette extraction requires complete RGBA pixels");
  const histogram = new Map<number, Bucket>();
  let totalWeight = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3]! / 255;
    if (alpha === 0) continue;
    const r = pixels[index]! / 255;
    const g = pixels[index + 1]! / 255;
    const b = pixels[index + 2]! / 255;
    const id = ((pixels[index]! >> 4) << 8) | ((pixels[index + 1]! >> 4) << 4) | (pixels[index + 2]! >> 4);
    let bucket = histogram.get(id);
    if (!bucket) { bucket = { weight: 0, r: 0, g: 0, b: 0 }; histogram.set(id, bucket); }
    bucket.weight += alpha;
    bucket.r += r * alpha; bucket.g += g * alpha; bucket.b += b * alpha;
    totalWeight += alpha;
  }
  if (totalWeight === 0) return { source: "artwork", colors: [[0.5, 0.5, 0.5]], anchorHue: 0 };
  const buckets = Array.from(histogram.values(), (item) => ({
    weight: item.weight,
    r: item.r / item.weight, g: item.g / item.weight, b: item.b / item.weight,
  })).sort((a, b) => b.weight - a.weight);
  const first = buckets[0]!;
  const centers: Rgb[] = [[first.r, first.g, first.b]];
  const distance = (r: number, g: number, b: number, center: Rgb): number =>
    (r - center[0]) ** 2 + (g - center[1]) ** 2 + (b - center[2]) ** 2;
  while (centers.length < Math.min(5, buckets.length)) {
    let best: Bucket | undefined;
    let score = 0.0005;
    for (const item of buckets) {
      const nearest = Math.min(...centers.map((center) => distance(item.r, item.g, item.b, center)));
      const candidate = nearest * Math.pow(item.weight / totalWeight, 0.3);
      if (candidate > score) { best = item; score = candidate; }
    }
    if (!best) break;
    centers.push([best.r, best.g, best.b]);
  }
  const weights = new Float64Array(centers.length);
  for (let pass = 0; pass < 6; pass += 1) {
    const sums = centers.map((): Rgb => [0, 0, 0]);
    weights.fill(0);
    for (const item of buckets) {
      let closest = 0;
      let smallest = Infinity;
      for (let index = 0; index < centers.length; index += 1) {
        const candidate = distance(item.r, item.g, item.b, centers[index]!);
        if (candidate < smallest) { smallest = candidate; closest = index; }
      }
      weights[closest] = weights[closest]! + item.weight;
      sums[closest]![0] += item.r * item.weight;
      sums[closest]![1] += item.g * item.weight;
      sums[closest]![2] += item.b * item.weight;
    }
    for (let index = 0; index < centers.length; index += 1) {
      if (weights[index]! <= 0) continue;
      centers[index] = sums[index]!.map((value) => value / weights[index]!) as Rgb;
    }
  }
  // Select a real source pixel for each fitted center: the most chromatic one
  // within a small color budget, so a cluster of muted shades is represented
  // by its pigment rather than its grey. K-means centers average toward grey,
  // and every accent downstream can only reduce this chroma, never add to it.
  // Outside the budget the score degrades to nearest-pixel (every in-budget
  // score exceeds -0.087, every out-of-budget score is below -1), so uniform
  // and grey sources keep their exact swatches. Even unusual source colors are
  // retained as RGB, instead of synthesizing a contrast-hue palette.
  const medoids: (Rgb | undefined)[] = centers.map(() => undefined);
  const scores = new Float64Array(centers.length).fill(-Infinity);
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] === 0) continue;
    const rgb: Rgb = [pixels[index]! / 255, pixels[index + 1]! / 255, pixels[index + 2]! / 255];
    const chroma = Math.max(...rgb) - Math.min(...rgb);
    for (let center = 0; center < centers.length; center += 1) {
      const d2 = distance(...rgb, centers[center]!);
      const score = d2 <= MEDOID_BUDGET ? chroma - 0.5 * Math.sqrt(d2) : -1 - d2;
      if (score > scores[center]!) { scores[center] = score; medoids[center] = rgb; }
    }
  }
  const colors = centers.map((_, index) => ({ rgb: medoids[index]!, weight: weights[index]! }))
    .filter((item) => item.rgb && item.weight / totalWeight >= 0.018)
    .sort((a, b) => b.weight - a.weight)
    .map((item) => item.rgb);
  if (colors.length === 0) colors.push(medoids[0] ?? [0.5, 0.5, 0.5]);
  const anchor = colors.find((rgb) => Math.max(...rgb) - Math.min(...rgb) > 0.04) ?? colors[0]!;
  return { source: "artwork", colors, anchorHue: rgbHue(anchor) };
}

function hsl(h: number, s: number, l: number): Rgb {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const channel = (offset: number): number => {
    const k = (offset + h / 30) % 12;
    return l - chroma * 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

export interface AccentSwatches {
  /** Index of the most chromatic red-through-yellow swatch (bass, heat, hits). */
  warm: number;
  /** Index of the most chromatic green-through-violet swatch (treble, air, calm). */
  cool: number;
  darkest: number;
  lightest: number;
}

/**
 * Name the roles the swatches play so music can travel between two real
 * pigments of the source instead of walking the ring. A palette without a
 * warm or cool family falls back to its two most chromatic swatches, and a
 * grey palette points every role at swatch 0.
 */
export function accentSwatches(palette: ScenePalette): AccentSwatches {
  const colors = palette.colors;
  const chromaOf = (rgb: Rgb): number => Math.max(...rgb) - Math.min(...rgb);
  const lumaOf = (rgb: Rgb): number => rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  const mostChromatic = (candidates: number[]): number | undefined =>
    candidates.reduce<number | undefined>((best, index) =>
      best === undefined || chromaOf(colors[index]!) > chromaOf(colors[best]!) ? index : best, undefined);
  const indices = colors.map((_, index) => index);
  const byChroma = [...indices].sort((a, b) => chromaOf(colors[b]!) - chromaOf(colors[a]!));
  const isWarm = (hue: number): boolean => hue >= 300 || hue < 90;
  const isCool = (hue: number): boolean => hue >= 150 && hue < 300;
  const chromatic = indices.filter((index) => chromaOf(colors[index]!) >= 0.04);
  let warm = mostChromatic(chromatic.filter((index) => isWarm(rgbHue(colors[index]!))));
  let cool = mostChromatic(chromatic.filter((index) => isCool(rgbHue(colors[index]!))));
  if (chromatic.length === 0) {
    warm = 0;
    cool = 0;
  } else if (warm === undefined || cool === undefined) {
    warm = byChroma[0]!;
    cool = byChroma[1] ?? byChroma[0]!;
  }
  const darkest = indices.reduce((best, index) => lumaOf(colors[index]!) < lumaOf(colors[best]!) ? index : best, 0);
  const lightest = indices.reduce((best, index) => lumaOf(colors[index]!) > lumaOf(colors[best]!) ? index : best, 0);
  return { warm, cool, darkest, lightest };
}

/**
 * Ring direction (+1 or -1) from a swatch toward the neighbour of the closer
 * hue. The ring is ordered by weight, not by hue, so a phase offset from an
 * accent may cross into the other family through a grey midpoint; spreading
 * a gradient this way keeps it inside the accent's own pigment family.
 */
export function swatchFamilyDirection(palette: ScenePalette, index: number): 1 | -1 {
  const colors = palette.colors;
  const count = colors.length;
  if (count < 3 || !Number.isInteger(index) || index < 0 || index >= count) return 1;
  const hue = rgbHue(colors[index]!);
  const apart = (other: number): number => {
    const difference = Math.abs(rgbHue(colors[other]!) - hue) % 360;
    return Math.min(difference, 360 - difference);
  };
  return apart((index + 1) % count) <= apart((index - 1 + count) % count) ? 1 : -1;
}

/**
 * No artwork: a repeatable two-family palette. Swatch 0 is the anchor; two
 * neighbours keep the family coherent and two near-complements give the
 * scene a real second color to travel to. The ring is ordered around the hue
 * wheel so phase offsets of about two steps reach the second family without
 * passing through a complementary (grey) midpoint. Bounded cache.
 */
export function randomPalette(seed: string): ScenePalette {
  const cached = randomPalettes.get(seed);
  if (cached) return cached;
  const random = createRandom(deriveSeed(seed, "scene-palette"));
  const anchorHue = random() * 360;
  const offsets = [
    22 + random() * 8,
    150 + (random() - 0.5) * 20,
    180 + (random() - 0.5) * 20,
    360 - (22 + random() * 8),
  ];
  const colors = [0, ...offsets].map((offset): Rgb => hsl(
    (anchorHue + offset) % 360,
    0.55 + random() * 0.3, 0.45 + random() * 0.15,
  ));
  const palette: ScenePalette = { source: "random", colors, anchorHue };
  if (randomPalettes.size >= 64) randomPalettes.delete(randomPalettes.keys().next().value!);
  randomPalettes.set(seed, palette);
  return palette;
}

/**
 * Phase cycles through existing RGB swatches; it never rotates their hue.
 * Saturation 100 preserves source chroma and 0 is neutral. Lightness 50 keeps
 * the source value; darker values shade it and lighter values mix in white.
 */
export function paletteRgb(
  palette: ScenePalette,
  phaseDegrees: number,
  saturation = 100,
  lightness = 50,
  out: Rgb = [0, 0, 0],
): Rgb {
  const colors = palette.colors;
  const position = ((finite(phaseDegrees, 0) % 360 + 360) % 360) / 360 * Math.max(1, colors.length);
  const first = Math.floor(position) % Math.max(1, colors.length);
  const amount = position - Math.floor(position);
  const left = colors[first] ?? [0.5, 0.5, 0.5];
  const right = colors[(first + 1) % Math.max(1, colors.length)] ?? left;
  let r = left[0]! + (right[0]! - left[0]!) * amount;
  let g = left[1]! + (right[1]! - left[1]!) * amount;
  let b = left[2]! + (right[2]! - left[2]!) * amount;
  const gray = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const chroma = clamp(finite(saturation, 100) / 100);
  r = gray + (r - gray) * chroma;
  g = gray + (g - gray) * chroma;
  b = gray + (b - gray) * chroma;
  const tone = clamp(finite(lightness, 50) / 100);
  const scale = tone <= 0.5 ? tone * 2 : 2 - tone * 2;
  const white = tone <= 0.5 ? 0 : tone * 2 - 1;
  out[0] = clamp(r * scale + white);
  out[1] = clamp(g * scale + white);
  out[2] = clamp(b * scale + white);
  return out;
}

/** Exposure a dark swatch may gain before white is mixed in instead. */
const MAX_LIFT_GAIN = 3;

/**
 * Brings a swatch up to `floor` luma by exposure first (the same pigment,
 * lit brighter: chroma ratios are kept), then white; `extra` white on top.
 * A cover's cool pigment is often its darkest (a teal shadow at luma 0.15
 * here) and would sink into the figure it is drawn over, while a light
 * peach needs no lift at all and would bleach at a fixed lightness.
 */
export function liftSwatch(rgb: Rgb, floor: number, extra: number): Rgb {
  const luma = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  const gain = Math.min(MAX_LIFT_GAIN, Math.max(1, floor / Math.max(1e-6, luma)));
  const lit = luma * gain;
  const white = clamp(Math.max(0, (floor - lit) / Math.max(1e-6, 1 - lit)) + extra);
  return [lerp(clamp(rgb[0] * gain), 1, white), lerp(clamp(rgb[1] * gain), 1, white), lerp(clamp(rgb[2] * gain), 1, white)];
}

/** Linear RGB mix from `from` (amount 0) to `to` (amount 1). */
export function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
  const t = clamp(amount);
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
}

export function rgbCss(rgb: ArrayLike<number>, alpha = 1): string {
  return `rgba(${Math.round(rgb[0]! * 255)},${Math.round(rgb[1]! * 255)},${Math.round(rgb[2]! * 255)},${clamp(finite(alpha, 1))})`;
}

export function paletteCss(palette: ScenePalette, phase: number, saturation: number, lightness: number, alpha = 1): string {
  return rgbCss(paletteRgb(palette, phase, saturation, lightness), alpha);
}

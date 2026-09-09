import { clamp, createRandom, deriveSeed } from "../math/random.js";
import type { Rgb } from "./lighting.js";

export interface ScenePalette {
  source: "artwork" | "random";
  /** Actual source swatches as normalized RGB; never invented complementary hues. */
  colors: readonly Rgb[];
  anchorHue: number;
}

interface Bucket { weight: number; r: number; g: number; b: number }
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
  // Select a real source pixel nearest each fitted center. Even unusual source
  // colors are retained as RGB, instead of synthesizing a contrast-hue palette.
  const medoids: (Rgb | undefined)[] = centers.map(() => undefined);
  const distances = new Float64Array(centers.length).fill(Infinity);
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] === 0) continue;
    const rgb: Rgb = [pixels[index]! / 255, pixels[index + 1]! / 255, pixels[index + 2]! / 255];
    for (let center = 0; center < centers.length; center += 1) {
      const candidate = distance(...rgb, centers[center]!);
      if (candidate < distances[center]!) { distances[center] = candidate; medoids[center] = rgb; }
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

/** No artwork: choose a repeatable palette from the full hue range. Bounded cache. */
export function randomPalette(seed: string): ScenePalette {
  const cached = randomPalettes.get(seed);
  if (cached) return cached;
  const random = createRandom(deriveSeed(seed, "scene-palette"));
  const anchorHue = random() * 360;
  const direction = random() > 0.5 ? 1 : -1;
  const spacing = 14 + random() * 14;
  const colors = Array.from({ length: 5 }, (_, index): Rgb => hsl(
    ((anchorHue + direction * (index - 2) * spacing + (random() - 0.5) * 12) % 360 + 360) % 360,
    0.48 + random() * 0.32, 0.42 + random() * 0.17,
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

export function paletteCss(palette: ScenePalette, phase: number, saturation: number, lightness: number, alpha = 1): string {
  const rgb = paletteRgb(palette, phase, saturation, lightness);
  return `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${clamp(finite(alpha, 1))})`;
}

// Objective frame metrics for before/after comparison of stills.
//   bun scripts/measure.ts renders/baseline/cover-12.png renders/baseline/cover-52.png ...
//   bun scripts/measure.ts --box 0.08,0.32,0.84,0.46 ...   (fractions of the frame: x,y,w,h)
//   bun scripts/measure.ts --hues ...                        (chroma-weighted hue histogram, 30 deg bins)
//   bun scripts/measure.ts --gate renders/after/S8           (assert the still targets of S2-S7)
// Prints per image: mean luma (0-255), mean HSV saturation (0-1), Hasler-Süsstrunk
// colorfulness, bright fraction (luma > 140), near-black fraction (luma < 0.08),
// white-fog fraction (saturation < 0.08 and luma > 0.6), vivid fraction
// (saturation > 0.3 and luma > 0.25), the 99th-percentile luma (0-255; the
// brightest structure, e.g. title letters in a title-band box), the mean
// R - B (0-255 levels; the frame's colour temperature, positive is warm) and
// the mean absolute pixel difference to the previous image in the list. --box restricts
// every statistic to that region; images of another size are compared in full.
// --gate <dir> reads the standard stills cover-12/52/75.png and loop-3.4.png from
// that directory and exits non-zero unless they meet the targets that S2-S7
// accepted (landscape layout: title band y 0.16-0.32, graph rect 0.08,0.32,0.84,0.46,
// strip band y 0.80-0.93).
import { parseArgs } from "node:util";
import { loadImage, createCanvas } from "@napi-rs/canvas";

interface Metrics {
  luma: number; saturation: number; colorfulness: number; bright: number;
  dark: number; fog: number; vivid: number; p99: number; rb: number; hues: Float64Array;
}
interface Box { x: number; y: number; w: number; h: number }

const { values, positionals } = parseArgs({
  options: { box: { type: "string" }, hues: { type: "boolean", default: false }, gate: { type: "string" } },
  allowPositionals: true,
});
const parseBox = (text: string): Box => {
  const [x, y, w, h] = text.split(",").map(Number);
  if (![x, y, w, h].every(Number.isFinite)) throw new Error("--box expects x,y,w,h fractions");
  return { x: x!, y: y!, w: w!, h: h! };
};
const box = values.box ? parseBox(values.box) : undefined;

async function measure(path: string, region?: Box, native = false): Promise<{ metrics: Metrics; data: Uint8ClampedArray }> {
  const image = await loadImage(path);
  // Statistics are taken on a 480 px wide view (the size at which the stills
  // are compared); the gate's title-band p99 reads native pixels because the
  // downscale softens letter cores by a level or two.
  const scale = native ? 1 : Math.min(1, 480 / image.width);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  const area = region
    ? { x: Math.round(region.x * width), y: Math.round(region.y * height), w: Math.max(1, Math.round(region.w * width)), h: Math.max(1, Math.round(region.h * height)) }
    : { x: 0, y: 0, w: width, h: height };
  const data = context.getImageData(area.x, area.y, area.w, area.h).data;
  let luma = 0, saturation = 0, bright = 0, dark = 0, fog = 0, vivid = 0, chromaWeight = 0, rb = 0;
  let rgSum = 0, rgSq = 0, ybSum = 0, ybSq = 0;
  const hues = new Float64Array(12);
  const count = area.w * area.h;
  const lumaHistogram = new Uint32Array(256);
  for (let index = 0; index < data.length; index += 4) {
    const r = data[index]!, g = data[index + 1]!, b = data[index + 2]!;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const sat = max === 0 ? 0 : (max - min) / max;
    luma += y;
    const level = Math.min(255, Math.max(0, Math.round(y)));
    lumaHistogram[level] = (lumaHistogram[level] ?? 0) + 1;
    saturation += sat;
    if (y > 140) bright += 1;
    if (y < 0.08 * 255) dark += 1;
    if (sat < 0.08 && y > 0.6 * 255) fog += 1;
    if (sat > 0.3 && y > 0.25 * 255) vivid += 1;
    const chroma = max - min;
    if (chroma >= 12 && max >= 16) {
      let hue = max === r ? (g - b) / chroma : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
      hue = ((hue * 60) % 360 + 360) % 360;
      const bin = Math.min(11, Math.floor(hue / 30));
      hues[bin] = (hues[bin] ?? 0) + chroma;
      chromaWeight += chroma;
    }
    rb += r - b;
    const rg = r - g, yb = 0.5 * (r + g) - b;
    rgSum += rg; rgSq += rg * rg; ybSum += yb; ybSq += yb * yb;
  }
  const rgMean = rgSum / count, ybMean = ybSum / count;
  const rgStd = Math.sqrt(Math.max(0, rgSq / count - rgMean * rgMean));
  const ybStd = Math.sqrt(Math.max(0, ybSq / count - ybMean * ybMean));
  const colorfulness = Math.sqrt(rgStd ** 2 + ybStd ** 2) + 0.3 * Math.sqrt(rgMean ** 2 + ybMean ** 2);
  let p99 = 255, seen = 0;
  for (let level = 255; level >= 0; level -= 1) {
    seen += lumaHistogram[level]!;
    if (seen >= count * 0.01) { p99 = level; break; }
  }
  return {
    metrics: {
      luma: luma / count, saturation: saturation / count, colorfulness, bright: bright / count,
      dark: dark / count, fog: fog / count, vivid: vivid / count, p99, rb: rb / count,
      hues: hues.map((value) => value / Math.max(1, chromaWeight)),
    },
    data,
  };
}

if (values.gate) {
  const dir = values.gate.replace(/\/$/, "");
  const TITLE_BAND: Box = { x: 0.2, y: 0.16, w: 0.6, h: 0.16 };
  const GRAPH_RECT: Box = { x: 0.08, y: 0.32, w: 0.84, h: 0.46 };
  const STRIP_BAND: Box = { x: 0.08, y: 0.80, w: 0.84, h: 0.13 };
  const frame = async (name: string, region?: Box, native = false) => (await measure(`${dir}/${name}.png`, region, native)).metrics;
  const quiet = await frame("cover-12");
  const peak = await frame("cover-52");
  const breakdown = await frame("cover-75");
  const loop = await frame("loop-3.4");
  const checks: Array<[string, number, string, number]> = [
    ["cover-12 mean luma >= 0.30 (S2)", quiet.luma / 255, ">=", 0.30],
    ["cover-12 mean saturation >= 0.18 (S2)", quiet.saturation, ">=", 0.18],
    ["cover-52 mean luma >= 0.34 (S2)", peak.luma / 255, ">=", 0.34],
    ["cover-52 mean saturation >= 0.20 (S2)", peak.saturation, ">=", 0.20],
    ["luma(52) - luma(12) >= 0.04 (S2)", (peak.luma - quiet.luma) / 255, ">=", 0.04],
    ["cover-12 near-black share <= 3% (S2)", quiet.dark, "<=", 0.03],
    ["cover-52 near-black share <= 3% (S2)", peak.dark, "<=", 0.03],
    ["cover-75 near-black share <= 3% (S2)", breakdown.dark, "<=", 0.03],
    // 0.95 of 255 is 242.25: the lockup's own lightness tops out at 242, the
    // value S2 and S7 accepted as 0.95 within 8-bit rounding.
    ["cover-12 title band p99 luma >= 242/255 (S2)", (await frame("cover-12", TITLE_BAND, true)).p99, ">=", 242],
    ["cover-52 title band p99 luma >= 242/255 (S2)", (await frame("cover-52", TITLE_BAND, true)).p99, ">=", 242],
    ["cover-52 graph-rect mean saturation >= 0.22 (S4)", (await frame("cover-52", GRAPH_RECT)).saturation, ">=", 0.22],
    ["cover-52 graph-rect white-fog share <= 3% (S4)", (await frame("cover-52", GRAPH_RECT)).fog, "<=", 0.03],
    ["cover-52 strip band vivid share >= 12% (S5)", (await frame("cover-52", STRIP_BAND)).vivid, ">=", 0.12],
    ["loop-3.4 near-black share <= 20% (S2)", loop.dark, "<=", 0.20],
  ];
  let failed = 0;
  for (const [label, actual, comparison, target] of checks) {
    const ok = comparison === ">=" ? actual >= target : actual <= target;
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(52)} ${actual.toFixed(3)}`);
  }
  console.log(failed === 0 ? "gate passed" : `gate failed: ${failed} check(s)`);
  process.exit(failed === 0 ? 0 : 1);
}

let previous: Uint8ClampedArray | undefined;
console.log("image".padEnd(40), "luma".padStart(6), "sat".padStart(6), "colorf".padStart(6), "bright".padStart(6),
  "dark".padStart(6), "fog".padStart(6), "vivid".padStart(6), "p99".padStart(5), "R-B".padStart(6), "delta".padStart(6));
for (const path of positionals) {
  const { metrics, data } = await measure(path, box);
  let delta = 0;
  if (previous && previous.length === data.length) {
    for (let index = 0; index < data.length; index += 4) {
      delta += Math.abs(data[index]! - previous[index]!) + Math.abs(data[index + 1]! - previous[index + 1]!) + Math.abs(data[index + 2]! - previous[index + 2]!);
    }
    delta /= (data.length / 4) * 3;
  }
  console.log(
    path.padEnd(40),
    metrics.luma.toFixed(1).padStart(6),
    metrics.saturation.toFixed(3).padStart(6),
    metrics.colorfulness.toFixed(1).padStart(6),
    metrics.bright.toFixed(3).padStart(6),
    metrics.dark.toFixed(3).padStart(6),
    metrics.fog.toFixed(3).padStart(6),
    metrics.vivid.toFixed(3).padStart(6),
    String(metrics.p99).padStart(5),
    metrics.rb.toFixed(1).padStart(6),
    (previous ? delta.toFixed(1) : "-").padStart(6),
  );
  if (values.hues) {
    console.log("  hue bins (30 deg, share of chroma):",
      Array.from(metrics.hues, (share, bin) => `${bin * 30}:${(share * 100).toFixed(0)}%`).join(" "));
  }
  previous = data;
}

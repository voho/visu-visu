// Render single PNG frames without encoding video. renders/ is gitignored.
//
//   bun scripts/stills.ts --analysis renders/not-looking-for-love.analysis.json \
//     --config renders/not-looking-for-love.config.json --times 12,28.8,32.5,60,107.97 \
//     --out renders/baseline/cover
//   bun scripts/stills.ts --analysis renders/loop.analysis.json --no-image \
//     --title RESONANCE --artist "VISU VISU" --seed loop-smoke --times 1.1,3.4 --out renders/baseline/loop
//
// Options: --width/--height (default 1920x1080), --scale (render scale, default 1),
// --image <path> overrides the config image, --no-image drops artwork.
// --yuv420p also saves <out>-<t>-yuv.png: the frame after the encoder's
// RGBA -> yuv420p (bt709, limited range) -> RGBA round trip through ffmpeg,
// i.e. what chroma subsampling leaves of thin coloured structure.
// --strip <seconds> renders that many seconds of consecutive frames from the
// first --times value (use --scale 0.25 for a 480x270 view), saves a contact
// sheet <out>-strip-<t>.png and prints each frame's mean absolute difference
// to the previous frame, marking the frames on which the hit plan starts a hit
// and the frames whose difference spikes to >= 2x the strip's median.
//
// Companion tools (all under renders/, which git ignores):
//   bun scripts/measure.ts renders/after/S9/cover-52.png ...      frame statistics, --box, --hues
//   bun scripts/measure.ts --gate renders/after/S9                 assert the accepted still targets
//   bun scripts/profile-stages.ts --analysis ... --config ... --time 52 [--budget 170]
//                                                                  flush-based ms per render stage
//   bun scripts/determinism.ts --analysis ... --config ... --time 52 --seeks 12,75
//                                                                  seek-order independence check
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { loadAnalysis } from "../src/audio/cache.js";
import { DEFAULT_CONFIG, parseProjectConfig } from "../src/config.js";
import { prepareArtwork } from "../src/render/artwork.js";
import { hitEventsAt } from "../src/render/hit-plan.js";
import { VisualizerRenderer } from "../src/render/renderer.js";
import { resolveRenderSeed } from "../src/render/render.js";

const { values } = parseArgs({
  options: {
    analysis: { type: "string" },
    config: { type: "string" },
    image: { type: "string" },
    "no-image": { type: "boolean", default: false },
    times: { type: "string", default: "30" },
    out: { type: "string", default: "renders/still" },
    width: { type: "string", default: "1920" },
    height: { type: "string", default: "1080" },
    scale: { type: "string", default: "1" },
    title: { type: "string" },
    artist: { type: "string" },
    seed: { type: "string" },
    yuv420p: { type: "boolean", default: false },
    strip: { type: "string" },
  },
});

if (!values.analysis) throw new Error("--analysis <file> is required");
const analysis = await loadAnalysis(values.analysis);
const base = values.config ? await Bun.file(values.config).json() : structuredClone(DEFAULT_CONFIG);
const width = Number(values.width);
const height = Number(values.height);
const config = parseProjectConfig({
  ...base,
  output: { ...base.output, width, height, fps: analysis.fps, renderScale: Number(values.scale) },
  text: {
    title: values.title ?? base.text?.title ?? "",
    artist: values.artist ?? base.text?.artist ?? "",
  },
  visual: {
    ...base.visual,
    ...(values.seed ? { seed: values.seed } : {}),
    imagePath: values["no-image"] ? "" : (values.image ?? base.visual?.imagePath ?? ""),
  },
});
const renderWidth = Math.round(width * config.output.renderScale);
const renderHeight = Math.round(height * config.output.renderScale);
const artwork = await prepareArtwork(config.visual.imagePath, renderWidth, renderHeight);
const renderer = new VisualizerRenderer(config, resolveRenderSeed(config, analysis), { width: renderWidth, height: renderHeight }, artwork);
await mkdir(dirname(values.out!), { recursive: true });

/** The encoder's colour path and its inverse, so the still shows what yuv420p keeps. */
function roundTripYuv420p(rgba: Buffer): Buffer {
  const size = `${renderWidth}x${renderHeight}`;
  const filters = [
    `scale=${size}:flags=lanczos+accurate_rnd+full_chroma_int:in_range=full:out_range=tv:out_color_matrix=bt709`,
    "format=yuv420p",
    `scale=${size}:flags=accurate_rnd+full_chroma_int:in_range=tv:out_range=full:in_color_matrix=bt709`,
    "format=rgba",
  ].join(",");
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", size, "-i", "pipe:0",
    "-vf", filters, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ], { input: rgba, maxBuffer: rgba.length * 4 });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr.toString()}`);
  if (result.stdout.length !== rgba.length) throw new Error(`ffmpeg returned ${result.stdout.length} bytes for ${rgba.length}`);
  return result.stdout;
}

function pngOf(rgba: Buffer): Buffer {
  const canvas = createCanvas(renderWidth, renderHeight);
  const context = canvas.getContext("2d");
  const image = context.createImageData(renderWidth, renderHeight);
  image.data.set(rgba);
  context.putImageData(image, 0, 0);
  return canvas.toBuffer("image/png");
}

function meanAbsDifference(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 4) {
    sum += Math.abs(a[index]! - b[index]!) + Math.abs(a[index + 1]! - b[index + 1]!) + Math.abs(a[index + 2]! - b[index + 2]!);
  }
  return sum / (a.length / 4 * 3);
}

const times = values.times!.split(",").map(Number);
for (const time of times) {
  const started = performance.now();
  const rgba = Buffer.from(renderer.render(analysis, time));
  const path = `${values.out}-${time}.png`;
  await Bun.write(path, renderer.canvas.toBuffer("image/png"));
  console.log(`${path}  (${((performance.now() - started) / 1000).toFixed(2)}s)`);
  if (values.yuv420p) {
    const yuvPath = `${values.out}-${time}-yuv.png`;
    await Bun.write(yuvPath, pngOf(roundTripYuv420p(rgba)));
    console.log(yuvPath);
  }
}

if (values.strip !== undefined) {
  const start = times[0]!;
  const fps = analysis.fps;
  const count = Math.max(2, Math.round(Number(values.strip) * fps));
  const columns = Math.min(count, 12);
  const rows = Math.ceil(count / columns);
  const sheet = createCanvas(columns * renderWidth, rows * renderHeight);
  const sheetContext = sheet.getContext("2d");
  const differences: number[] = [];
  const hitStarts: boolean[] = [];
  let previous: Buffer | undefined;
  for (let index = 0; index < count; index += 1) {
    const time = start + index / fps;
    const rgba = Buffer.from(renderer.render(analysis, time));
    sheetContext.drawImage(renderer.canvas, (index % columns) * renderWidth, Math.floor(index / columns) * renderHeight);
    differences.push(previous ? meanAbsDifference(previous, rgba) : 0);
    hitStarts.push(hitEventsAt(analysis, time).some((hit) => hit.age < 1 / fps));
    previous = rgba;
  }
  const stripPath = `${values.out}-strip-${start}.png`;
  await Bun.write(stripPath, sheet.toBuffer("image/png"));
  const sorted = differences.slice(1).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  console.log(`${stripPath}  ${count} frames from ${start}s, median frame difference ${median.toFixed(2)} levels`);
  for (let index = 1; index < count; index += 1) {
    const spike = differences[index]! >= median * 2;
    console.log(`${(start + index / fps).toFixed(3)}  ${differences[index]!.toFixed(2).padStart(6)}  ${hitStarts[index] ? "hit" : "   "}  ${spike ? "spike" : ""}`);
  }
}

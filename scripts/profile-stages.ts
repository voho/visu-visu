// Per-stage frame profile of the renderer. @napi-rs/canvas may defer raster
// work, so a naive timer around a draw call under-reports it; the renderer's
// profiler hook is called after each stage with the surface it drew to, and
// this script flushes that surface (a 1x1 getImageData) before taking the time.
//
//   bun scripts/profile-stages.ts --analysis renders/not-looking-for-love.analysis.json \
//     --config renders/not-looking-for-love.config.json --time 52 [--frames 30] [--budget 170]
//   bun scripts/profile-stages.ts --analysis renders/loop.analysis.json --no-image --seed loop-smoke --time 3.4
//
// Prints ms per stage (mean over --frames consecutive warm frames), the warm
// frame mean, and the cost of one cold seek to --time on a fresh renderer.
// --budget <ms> exits non-zero when the warm frame mean exceeds it.
// --src <dir> profiles another checkout's src/ (only the frame total, when
// that renderer has no profiler hook).
import { parseArgs } from "node:util";
import { resolve } from "node:path";

const { values } = parseArgs({
  options: {
    analysis: { type: "string" },
    config: { type: "string" },
    "no-image": { type: "boolean", default: false },
    seed: { type: "string" },
    time: { type: "string", default: "52" },
    frames: { type: "string", default: "30" },
    budget: { type: "string" },
    width: { type: "string", default: "1920" },
    height: { type: "string", default: "1080" },
    src: { type: "string", default: resolve(import.meta.dir, "../src") },
  },
});
if (!values.analysis) throw new Error("--analysis <file> is required");
const src = resolve(values.src!);
const { loadAnalysis } = await import(`${src}/audio/cache.ts`);
const { DEFAULT_CONFIG, parseProjectConfig } = await import(`${src}/config.ts`);
const { prepareArtwork } = await import(`${src}/render/artwork.ts`);
const { VisualizerRenderer } = await import(`${src}/render/renderer.ts`);
const { resolveRenderSeed } = await import("../src/render/render.js");

const analysis = await loadAnalysis(values.analysis);
const base = values.config ? await Bun.file(values.config).json() : structuredClone(DEFAULT_CONFIG);
const width = Number(values.width);
const height = Number(values.height);
const config = parseProjectConfig({
  ...base,
  output: { ...base.output, width, height, fps: analysis.fps, renderScale: 1 },
  visual: {
    ...base.visual,
    ...(values.seed ? { seed: values.seed } : {}),
    imagePath: values["no-image"] ? "" : (base.visual?.imagePath ?? ""),
  },
});
const artwork = await prepareArtwork(config.visual.imagePath, width, height);
const time = Number(values.time);
const frames = Math.max(1, Number(values.frames));
const fresh = () => new VisualizerRenderer(config, resolveRenderSeed(config, analysis), { width, height }, artwork);

type Surface = { getContext(kind: "2d"): { getImageData(x: number, y: number, w: number, h: number): unknown } };
const stages = new Map<string, number>();
const coldStages = new Map<string, number>();
let stageStart = 0;
const hookInto = (into: Map<string, number>) => (stage: string, surface: Surface) => {
  surface.getContext("2d").getImageData(0, 0, 1, 1);
  const now = performance.now();
  into.set(stage, (into.get(stage) ?? 0) + now - stageStart);
  stageStart = now;
};

// Cold seek: a fresh renderer's first frame at --time (captures, caches, sheets).
const cold = fresh();
const hasHook = "profiler" in cold;
if (hasHook) cold.profiler = hookInto(coldStages);
const coldStart = performance.now();
stageStart = coldStart;
cold.render(analysis, time);
const coldMs = performance.now() - coldStart;

// Warm frames: consecutive frames after the seek, with the hook installed.
const renderer = fresh();
renderer.render(analysis, time);
if (hasHook) renderer.profiler = hookInto(stages);
const totals: number[] = [];
for (let index = 1; index <= frames; index += 1) {
  const started = performance.now();
  stageStart = started;
  renderer.render(analysis, time + index / analysis.fps);
  totals.push(performance.now() - started);
}
const warmMean = totals.reduce((sum, value) => sum + value, 0) / totals.length;

if (hasHook) {
  console.log(`stage`.padEnd(12), `warm ms`.padStart(9), `cold ms`.padStart(9));
  for (const [stage, total] of stages) {
    console.log(stage.padEnd(12), (total / frames).toFixed(1).padStart(9), (coldStages.get(stage) ?? 0).toFixed(1).padStart(9));
  }
} else {
  console.log("(this renderer has no profiler hook; frame totals only)");
}
console.log(`warm frame mean over ${frames} frames at ${time}s: ${warmMean.toFixed(1)} ms  (min ${Math.min(...totals).toFixed(1)}, max ${Math.max(...totals).toFixed(1)})`);
console.log(`cold seek to ${time}s on a fresh renderer: ${coldMs.toFixed(1)} ms  (${(coldMs / warmMean).toFixed(2)}x warm)`);
if (values.budget !== undefined && warmMean > Number(values.budget)) {
  console.error(`over budget: ${warmMean.toFixed(1)} ms > ${values.budget} ms`);
  process.exit(1);
}

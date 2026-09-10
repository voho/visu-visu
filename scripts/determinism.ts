// Seek-order independence check (decisions.md item 8): the frame at --time must be
// byte-identical whether a fresh renderer draws it first or after other seeks.
//   bun scripts/determinism.ts --analysis renders/not-looking-for-love.analysis.json \
//     --config renders/not-looking-for-love.config.json --time 52 --seeks 12,75
import { parseArgs } from "node:util";
import { loadAnalysis } from "../src/audio/cache.js";
import { DEFAULT_CONFIG, parseProjectConfig } from "../src/config.js";
import { prepareArtwork } from "../src/render/artwork.js";
import { VisualizerRenderer } from "../src/render/renderer.js";
import { resolveRenderSeed } from "../src/render/render.js";

const { values } = parseArgs({
  options: {
    analysis: { type: "string" },
    config: { type: "string" },
    "no-image": { type: "boolean", default: false },
    time: { type: "string", default: "52" },
    seeks: { type: "string", default: "12,75" },
    width: { type: "string", default: "640" },
    height: { type: "string", default: "360" },
    seed: { type: "string" },
  },
});
if (!values.analysis) throw new Error("--analysis <file> is required");
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
const fresh = (): VisualizerRenderer =>
  new VisualizerRenderer(config, resolveRenderSeed(config, analysis), { width, height }, artwork);
const time = Number(values.time);
const direct = Buffer.from(fresh().render(analysis, time));
const wandering = fresh();
for (const seek of values.seeks!.split(",").map(Number)) wandering.render(analysis, seek);
const afterSeeks = Buffer.from(wandering.render(analysis, time));
const repeat = Buffer.from(wandering.render(analysis, time));
const identical = direct.equals(afterSeeks) && direct.equals(repeat);
console.log(`t=${time}: direct vs after seeks [${values.seeks}] vs repeat: ${identical ? "byte-identical" : "DIFFERENT"}`);
if (!identical) process.exit(1);

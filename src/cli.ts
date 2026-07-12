#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { basename, extname, resolve } from "node:path";
import { analyzeAudio } from "./audio/analyze.js";
import { loadAnalysis, saveAnalysis } from "./audio/cache.js";
import { assertFfmpegAvailable, decodeAudio } from "./audio/decode.js";
import {
  dimensionsFor,
  loadProjectConfig,
  parseProjectConfig,
  parseRatio,
  parseSize,
  renderDimensions,
} from "./config.js";
import { renderVideo } from "./render/render.js";
import type { ProjectConfig } from "./types.js";

const HELP = `
visu-visu — deterministic audio-reactive music videos

Usage:
  bun run render -- <song> [options]
  bun run analyze -- <song> [options]

Render options:
  -o, --output <file>       Output MP4 (default: <song>.visual.mp4)
  -c, --config <file>       JSON project config (default: built-in values)
      --analysis <file>     Reuse a previously saved analysis
      --save-analysis <f>   Save newly computed analysis for later renders
      --size <WxH>          Override output size (default: 1920x1080, 16:9)
      --ratio <W:H>         Aspect ratio shorthand, for example 16:9 or 3:2
      --resolution <name>   Long-edge preset: hd, fullhd, or 4k
      --fps <number>        Override frame rate (12–60, default: 30)
      --render-scale <n>    Internal resolution scale (0.25–1, final default: 1)
      --seed <value>        Reproducible visual seed (default: PCM-derived)
      --title <text>        On-screen and file metadata title
      --artist <text>       On-screen and file metadata artist
      --start <seconds>     Start within the song
      --duration <seconds>  Render only this many seconds
      --quality <mode>      final or preview
  -y, --overwrite           Replace an existing output

Analyze options:
  -o, --output <file>       Analysis JSON (default: <song>.analysis.json)
  -c, --config <file>       JSON project config
      --fps <number>        Analysis frame rate
      --bands <number>      Spectrum band count (16–128)

Examples:
  bun run render -- ./song.wav --title "Night Signal" --artist "Vojta"
  bun run preview -- ./song.mp3 --overwrite
  bun run analyze -- ./song.flac -o ./song.analysis.json
`;

const sharedOptions = {
  output: { type: "string", short: "o" },
  config: { type: "string", short: "c" },
  fps: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

function numericOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
  return parsed;
}

function inputPath(positionals: string[]): string {
  const input = positionals[0];
  if (!input) throw new Error("An input audio file is required. Run with --help for examples.");
  return resolve(input);
}

function defaultOutput(audioPath: string, suffix: string): string {
  const extension = extname(audioPath);
  const stem = extension ? audioPath.slice(0, -extension.length) : audioPath;
  return resolve(`${stem}${suffix}`);
}

function overrideConfig(
  config: ProjectConfig,
  options: {
    size?: string;
    ratio?: string;
    resolution?: string;
    fps?: string;
    renderScale?: string;
    seed?: string;
    title?: string;
    artist?: string;
    quality?: string;
    bands?: string;
  },
): ProjectConfig {
  const mutable = structuredClone(config);
  if (options.size !== undefined && (options.ratio !== undefined || options.resolution !== undefined)) {
    throw new Error("Use either --size or --ratio/--resolution, not both");
  }
  if (options.size !== undefined) {
    const size = parseSize(options.size);
    mutable.output.width = size.width;
    mutable.output.height = size.height;
  }
  if (options.ratio !== undefined || options.resolution !== undefined) {
    const ratio =
      options.ratio === undefined
        ? mutable.output.width / mutable.output.height
        : parseRatio(options.ratio);
    const currentLongEdge = Math.max(mutable.output.width, mutable.output.height);
    const inferredResolution = currentLongEdge >= 3000 ? "4k" : currentLongEdge <= 1400 ? "hd" : "fullhd";
    const dimensions = dimensionsFor(options.resolution ?? inferredResolution, ratio);
    mutable.output.width = dimensions.width;
    mutable.output.height = dimensions.height;
  }
  const fps = numericOption(options.fps, "fps");
  if (fps !== undefined) mutable.output.fps = fps;
  const renderScale = numericOption(options.renderScale, "render-scale");
  const bands = numericOption(options.bands, "bands");
  if (bands !== undefined) mutable.visual.spectrumBands = bands;
  if (options.seed !== undefined) mutable.visual.seed = options.seed;
  if (options.title !== undefined) mutable.text.title = options.title;
  if (options.artist !== undefined) mutable.text.artist = options.artist;
  if (options.quality !== undefined) {
    if (options.quality === "preview") {
      mutable.output.crf = 20;
      mutable.output.preset = "veryfast";
      if (renderScale === undefined) mutable.output.renderScale = 0.5;
    } else if (options.quality === "final") {
      mutable.output.crf = 8;
      mutable.output.preset = "slow";
      if (renderScale === undefined) mutable.output.renderScale = 1;
    } else {
      throw new Error('--quality must be either "preview" or "final"');
    }
  }
  if (renderScale !== undefined) mutable.output.renderScale = renderScale;
  return parseProjectConfig(mutable);
}

async function runAnalyze(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...sharedOptions,
      bands: { type: "string" },
    },
  });
  if (values.help) {
    console.log(HELP.trim());
    return;
  }
  const audioPath = inputPath(positionals);
  const config = overrideConfig(await loadProjectConfig(values.config), {
    ...(values.fps === undefined ? {} : { fps: values.fps }),
    ...(values.bands === undefined ? {} : { bands: values.bands }),
  });
  const outputPath = resolve(values.output ?? defaultOutput(audioPath, ".analysis.json"));

  await assertFfmpegAvailable();
  console.log(`Decode   ${basename(audioPath)}`);
  const pcm = await decodeAudio(audioPath);
  console.log(
    `Analyze  ${pcm.duration.toFixed(2)}s · ${config.output.fps} fps · ${config.visual.spectrumBands} bands`,
  );
  const analysis = analyzeAudio(pcm, config.output.fps, config.visual.spectrumBands);
  await saveAnalysis(outputPath, analysis);
  console.log(`Saved    ${outputPath}`);
}

async function runRender(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...sharedOptions,
      analysis: { type: "string" },
      "save-analysis": { type: "string" },
      size: { type: "string" },
      ratio: { type: "string" },
      resolution: { type: "string" },
      "render-scale": { type: "string" },
      seed: { type: "string" },
      title: { type: "string" },
      artist: { type: "string" },
      start: { type: "string" },
      duration: { type: "string" },
      quality: { type: "string" },
      overwrite: { type: "boolean", short: "y" },
    },
  });
  if (values.help) {
    console.log(HELP.trim());
    return;
  }
  const audioPath = inputPath(positionals);
  const config = overrideConfig(await loadProjectConfig(values.config), {
    ...(values.size === undefined ? {} : { size: values.size }),
    ...(values.ratio === undefined ? {} : { ratio: values.ratio }),
    ...(values.resolution === undefined ? {} : { resolution: values.resolution }),
    ...(values.fps === undefined ? {} : { fps: values.fps }),
    ...(values["render-scale"] === undefined
      ? {}
      : { renderScale: values["render-scale"] }),
    ...(values.seed === undefined ? {} : { seed: values.seed }),
    ...(values.title === undefined ? {} : { title: values.title }),
    ...(values.artist === undefined ? {} : { artist: values.artist }),
    ...(values.quality === undefined ? {} : { quality: values.quality }),
  });
  if (!config.text.title) {
    config.text.title = basename(audioPath, extname(audioPath));
  }
  const outputPath = resolve(values.output ?? defaultOutput(audioPath, ".visual.mp4"));
  const start = numericOption(values.start, "start") ?? 0;
  const duration = numericOption(values.duration, "duration");
  await assertFfmpegAvailable();

  let analysis;
  if (values.analysis) {
    console.log(`Analysis ${resolve(values.analysis)}`);
    analysis = await loadAnalysis(values.analysis);
  } else {
    console.log(`Decode   ${basename(audioPath)}`);
    const pcm = await decodeAudio(audioPath);
    console.log(
      `Analyze  ${pcm.duration.toFixed(2)}s · ${config.output.fps} fps · ${config.visual.spectrumBands} bands`,
    );
    analysis = analyzeAudio(pcm, config.output.fps, config.visual.spectrumBands);
    if (values["save-analysis"]) {
      await saveAnalysis(values["save-analysis"], analysis);
      console.log(`Saved    ${resolve(values["save-analysis"])}`);
    }
  }

  const internalSize = renderDimensions(config);
  const scaling =
    internalSize.width === config.output.width && internalSize.height === config.output.height
      ? "native"
      : `${internalSize.width}x${internalSize.height} internal`;
  console.log(
    `Render   ${config.output.width}x${config.output.height} ← ${scaling} · ${config.output.fps} fps · prismatic conductor`,
  );
  let lastPercent = -1;
  const result = await renderVideo(
    {
      audioPath,
      outputPath,
      config,
      start,
      ...(duration === undefined ? {} : { duration }),
      overwrite: values.overwrite ?? false,
    },
    analysis,
    ({ frame, totalFrames, elapsedSeconds }) => {
      const percent = Math.floor((frame / totalFrames) * 100);
      if (percent === 100 || percent >= lastPercent + 5) {
        lastPercent = percent;
        const rate = elapsedSeconds > 0 ? frame / elapsedSeconds : 0;
        process.stdout.write(`\rFrames   ${String(percent).padStart(3)}% · ${rate.toFixed(1)} frames/s`);
      }
    },
  );
  process.stdout.write("\n");
  console.log(`Seed     ${result.seed}`);
  console.log(`Saved    ${outputPath} (${result.duration.toFixed(2)}s, ${result.frames} frames)`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP.trim());
    return;
  }
  if (command === "analyze") {
    await runAnalyze(args);
    return;
  }
  if (command === "render") {
    await runRender(args);
    return;
  }
  throw new Error(`Unknown command "${command}". Run with --help for usage.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  process.exitCode = 1;
});

#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { basename, extname, resolve } from "node:path";
import { analyzeAudio } from "./audio/analyze.js";
import { loadAnalysis, saveAnalysis } from "./audio/cache.js";
import { selectClip } from "./audio/clip.js";
import { readAudioMetadata } from "./audio/metadata.js";
import { assertFfmpegAvailable, decodeAudio } from "./audio/decode.js";
import {
  dimensionsFor,
  loadProjectConfig,
  parseProjectConfig,
  parseRatio,
  parseSize,
  renderDimensions,
  resolveArtworkPath,
} from "./config.js";
import { renderVideo, validateRenderAnalysis } from "./render/render.js";
import { resolveFadeDurations } from "./render/encoder.js";
import { prepareArtwork } from "./render/artwork.js";
import type { ProjectConfig } from "./types.js";

const HELP = `
visu-visu — deterministic audio-reactive music videos

Usage:
  bun run render -- <song> [options]
  bun run analyze -- <song> [options]
  bun run clip -- <song> [options]

Render options:
  -o, --output <file>       Output MP4 (default: <song>.visual.mp4)
  -c, --config <file>       JSON project config (default: built-in values)
      --analysis <file>     Reuse a previously saved analysis
      --save-analysis <f>   Save newly computed analysis for later renders
      --size <WxH>          Override output size (default: 1920x1080, 16:9)
      --ratio <W:H>         Aspect ratio shorthand, for example 16:9 or 3:2
      --resolution <name>   Long-edge preset: hd, fullhd, or 4k
      --fps <number>        Override frame rate (12–60, default: 60)
      --render-scale <n>    Internal resolution scale (0.25–1, final default: 1)
      --seed <value>        Reproducible visual seed (default: PCM-derived)
      --engine <name>       resonance (default) or milkdrop (requires Chrome)
      --title <text>        On-screen and file metadata title
      --artist <text>       On-screen and file metadata artist
      --image <file>        Local artwork; softened, masked, and used for colors
      --lighting <0–1>      Reactive material lighting (default: 0.65; 0 disables)
      --start <seconds>     Start within the song
      --duration <seconds>  Render only this many seconds
      --fade <seconds>      Fade picture/audio at both ends (default: 3)
      --quality <mode>      final (upload), preview (draft), or master (archive)
  -y, --overwrite           Replace an existing output

Clip options (portrait Full HD60, up to 30 seconds):
      --drop <seconds>      Use a known drop timestamp instead of auto-selection
      --lead-in <seconds>   Time before the drop (default: min(3, duration/2))
      --duration <seconds>  Maximum clip length (default: 30; range: >0–30)
      --fade-in <seconds>   Brief picture/audio entrance (default: 0.35)
      --fade-out <seconds>  Picture/audio end fade (default: 3)
      --dry-run            Print the selection as JSON without encoding
  -o, --output <file>       Output MP4 (default: <song>.clip.mp4)
      --title / --artist    Override audio tags; artist is required if untagged
  Also accepts --config, --analysis, --save-analysis, --resolution, --fps,
  --render-scale, --seed, --engine, --image, --lighting, --quality, and --overwrite. Aspect ratio is always 9:16.
  Short sources use their available length. No clear drop: use sustained energy.

Analyze options:
  -o, --output <file>       Analysis JSON (default: <song>.analysis.json)
  -c, --config <file>       JSON project config
      --fps <number>        Analysis frame rate
      --bands <number>      Spectrum band count (16–128)

Examples:
  bun run render -- ./song.wav --title "Night Signal" --artist "Vojta"
  bun run preview -- ./song.mp3 --overwrite
  bun run clip -- ./song.mp3 --title "Night Signal" --artist "Vojta"
  bun run clip -- ./song.mp3 --artist "Vojta" --drop 92.5 --dry-run
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
  if (!value.trim() || !Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
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

export function overrideConfig(
  config: ProjectConfig,
  options: {
    size?: string;
    ratio?: string;
    resolution?: string;
    fps?: string;
    renderScale?: string;
    seed?: string;
    engine?: string;
    title?: string;
    artist?: string;
    image?: string;
    lighting?: string;
    quality?: string;
    bands?: string;
    fade?: string;
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
  const fade = numericOption(options.fade, "fade");
  if (fade !== undefined) mutable.output.fadeSeconds = fade;
  const bands = numericOption(options.bands, "bands");
  if (bands !== undefined) mutable.visual.spectrumBands = bands;
  if (options.seed !== undefined) mutable.visual.seed = options.seed;
  if (options.engine !== undefined) {
    if (options.engine !== "resonance" && options.engine !== "milkdrop") {
      throw new Error('--engine must be "resonance" or "milkdrop"');
    }
    mutable.visual.engine = options.engine;
  }
  if (options.title !== undefined) mutable.text.title = options.title;
  if (options.artist !== undefined) mutable.text.artist = options.artist;
  if (options.image !== undefined) mutable.visual.imagePath = resolveArtworkPath(options.image);
  const lighting = numericOption(options.lighting, "lighting");
  if (lighting !== undefined) mutable.visual.lighting = lighting;
  if (options.quality !== undefined) {
    if (options.quality === "preview") {
      mutable.output.crf = 22;
      mutable.output.preset = "veryfast";
      mutable.output.maxBitrateMbps = 8;
      if (renderScale === undefined) mutable.output.renderScale = 0.5;
    } else if (options.quality === "final") {
      mutable.output.crf = 18;
      mutable.output.preset = "fast";
      mutable.output.maxBitrateMbps = 16;
      if (renderScale === undefined) mutable.output.renderScale = 1;
    } else if (options.quality === "master") {
      mutable.output.crf = 8;
      mutable.output.preset = "slow";
      mutable.output.maxBitrateMbps = 0;
      if (renderScale === undefined) mutable.output.renderScale = 1;
    } else {
      throw new Error('--quality must be "preview", "final", or "master"');
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

async function runRender(args: string[], clip = false): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...sharedOptions,
      analysis: { type: "string" },
      "save-analysis": { type: "string" },
      drop: { type: "string" },
      "lead-in": { type: "string" },
      "fade-in": { type: "string" },
      "fade-out": { type: "string" },
      "dry-run": { type: "boolean" },
      size: { type: "string" },
      ratio: { type: "string" },
      start: { type: "string" },
      fade: { type: "string" },
      resolution: { type: "string" },
      "render-scale": { type: "string" },
      seed: { type: "string" },
      engine: { type: "string" },
      title: { type: "string" },
      artist: { type: "string" },
      image: { type: "string" },
      lighting: { type: "string" },
      duration: { type: "string" },
      quality: { type: "string" },
      overwrite: { type: "boolean", short: "y" },
    },
  });
  if (values.help) {
    console.log(HELP.trim());
    return;
  }
  const incompatible = clip
    ? ["size", "ratio", "start", "fade"] as const
    : ["drop", "lead-in", "fade-in", "fade-out", "dry-run"] as const;
  for (const option of incompatible) {
    if (values[option] !== undefined) {
      throw new Error(clip
        ? `--${option} is not a clip option. Clips use 9:16; choose --drop, --lead-in, --fade-in or --fade-out.`
        : `--${option} is only available with the clip command.`);
    }
  }
  const audioPath = inputPath(positionals);
  const dryRun = clip && (values["dry-run"] ?? false);
  const log = (message: string): void => { if (!dryRun) console.log(message); };
  const config = overrideConfig(await loadProjectConfig(values.config), {
    ...(clip ? { ratio: "9:16", resolution: "fullhd", fps: "60", quality: "final" } : {}),
    ...(values.size === undefined ? {} : { size: values.size }),
    ...(values.ratio === undefined ? {} : { ratio: values.ratio }),
    ...(values.resolution === undefined ? {} : { resolution: values.resolution }),
    ...(values.fps === undefined ? {} : { fps: values.fps }),
    ...(values["render-scale"] === undefined
      ? {}
      : { renderScale: values["render-scale"] }),
    ...(values.seed === undefined ? {} : { seed: values.seed }),
    ...(values.engine === undefined ? {} : { engine: values.engine }),
    ...(values.title === undefined ? {} : { title: values.title }),
    ...(values.artist === undefined ? {} : { artist: values.artist }),
    ...(values.image === undefined ? {} : { image: values.image }),
    ...(values.lighting === undefined ? {} : { lighting: values.lighting }),
    ...(values.fade === undefined ? {} : { fade: values.fade }),
    ...(values.quality === undefined ? {} : { quality: values.quality }),
  });
  const outputPath = resolve(values.output ?? defaultOutput(audioPath, clip ? ".clip.mp4" : ".visual.mp4"));
  let start = numericOption(values.start, "start") ?? 0;
  let duration = numericOption(values.duration, "duration");
  const leadIn = numericOption(values["lead-in"], "lead-in");
  const drop = numericOption(values.drop, "drop");
  let fadeInSeconds = numericOption(values["fade-in"], "fade-in") ?? 0.35;
  let fadeOutSeconds = numericOption(values["fade-out"], "fade-out") ?? 3;
  if (clip) {
    duration ??= 30;
    if (!(duration > 0 && duration <= 30)) throw new Error("--duration must be greater than 0 and at most 30 seconds for clips");
    if (leadIn !== undefined && !(leadIn >= 0 && leadIn < duration)) {
      throw new Error("--lead-in must be nonnegative and shorter than --duration");
    }
    for (const [label, value] of [["fade-in", fadeInSeconds], ["fade-out", fadeOutSeconds]] as const) {
      if (value < 0 || value > 30) throw new Error(`--${label} must be between 0 and 30 seconds`);
    }
  }
  await assertFfmpegAvailable();
  if (clip && (!config.text.title || !config.text.artist)) {
    const metadata = await readAudioMetadata(audioPath);
    if (!config.text.title) config.text.title = metadata.title ?? "";
    if (!config.text.artist) config.text.artist = metadata.artist ?? "";
  }
  if (!config.text.title) config.text.title = basename(audioPath, extname(audioPath));
  if (clip && !config.text.artist) {
    throw new Error('No artist tag found. Add --artist "Artist Name" (or set text.artist in your config) so the clip includes a readable artist credit.');
  }

  let analysis;
  if (values.analysis) {
    log(`Analysis ${resolve(values.analysis)}`);
    analysis = await loadAnalysis(values.analysis);
  } else {
    log(`Decode   ${basename(audioPath)}`);
    const pcm = await decodeAudio(audioPath);
    log(
      `Analyze  ${pcm.duration.toFixed(2)}s · ${config.output.fps} fps · ${config.visual.spectrumBands} bands`,
    );
    analysis = analyzeAudio(pcm, config.output.fps, config.visual.spectrumBands);
    if (values["save-analysis"]) {
      await saveAnalysis(values["save-analysis"], analysis);
      log(`Saved    ${resolve(values["save-analysis"])}`);
    }
  }

  if (clip) {
    const selection = selectClip(analysis, {
      ...(duration === undefined ? {} : { duration }),
      ...(leadIn === undefined ? {} : { leadIn }),
      ...(drop === undefined ? {} : { drop }),
    });
    start = selection.start;
    duration = selection.duration;
    const renderedDuration = Math.max(1, Math.ceil(duration * config.output.fps - 1e-9)) / config.output.fps;
    // Keep the selected impact at full volume, including near source boundaries.
    // Fades are upper limits; a short tail gives the drop a brief hold first.
    if (selection.dropOffset !== null) {
      fadeInSeconds = Math.min(fadeInSeconds, selection.dropOffset);
      const tail = Math.max(0, renderedDuration - selection.dropOffset);
      const hold = Math.min(0.75, tail * 0.35);
      fadeOutSeconds = Math.min(fadeOutSeconds, tail - hold);
    }
    const fades = resolveFadeDurations(renderedDuration, config.output.fadeSeconds, fadeInSeconds, fadeOutSeconds);
    fadeInSeconds = fades.fadeIn;
    fadeOutSeconds = fades.fadeOut;
    if (dryRun) {
      await validateRenderAnalysis(audioPath, config, analysis);
      const renderSize = renderDimensions(config);
      await prepareArtwork(config.visual.imagePath, renderSize.width, renderSize.height);
      console.log(JSON.stringify({
        input: audioPath, output: outputPath,
        ...selection,
        width: config.output.width, height: config.output.height, fps: config.output.fps,
        renderedDuration, fadeInSeconds, fadeOutSeconds,
        title: config.text.title, artist: config.text.artist,
        imagePath: config.visual.imagePath ?? "",
        engine: config.visual.engine ?? "resonance",
      }, null, 2));
      return;
    }
    log(`Clip     ${selection.start.toFixed(2)}s → ${selection.end.toFixed(2)}s · ${selection.duration.toFixed(2)}s · ${selection.reason}`);
    log(selection.drop === null
      ? selection.reason === "short-track" ? "Select   Full available source; shorter than the requested clip" : "Select   Strongest sustained energy; no distinct drop detected"
      : `Drop     ${selection.drop.toFixed(2)}s in song · ${selection.dropOffset!.toFixed(2)}s into clip`);
    if (selection.duration < 30) log("Length   Using available audio or the requested shorter duration");
  }

  const internalSize = renderDimensions(config);
  const scaling =
    internalSize.width === config.output.width && internalSize.height === config.output.height
      ? "native"
      : `${internalSize.width}x${internalSize.height} internal`;
  log(
    `Render   ${config.output.width}x${config.output.height} ← ${scaling} · ${config.output.fps} fps · ${config.visual.engine === "milkdrop" ? "MilkDrop / Butterchurn" : "resonance conductor"}`,
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
      ...(clip ? { fadeInSeconds, fadeOutSeconds } : {}),
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
  log(`Seed     ${result.seed}`);
  log(`Saved    ${outputPath} (${result.duration.toFixed(2)}s, ${result.frames} frames)`);
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
  if (command === "render" || command === "clip") {
    await runRender(args, command === "clip");
    return;
  }
  throw new Error(`Unknown command "${command}". Run with --help for usage.`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nError: ${message}`);
    process.exitCode = 1;
  });
}

import { sha256 } from "../math/random.js";
import { hashFile } from "../audio/decode.js";
import { renderDimensions } from "../config.js";
import {
  ANALYSIS_VERSION,
  RENDERER_VERSION,
  type AudioAnalysis,
  type ProjectConfig,
  type RenderRequest,
} from "../types.js";
import { FfmpegEncoder, resolveFadeDurations } from "./encoder.js";
import { VisualizerRenderer } from "./renderer.js";
import { prepareArtwork } from "./artwork.js";

export interface RenderProgress {
  frame: number;
  totalFrames: number;
  elapsedSeconds: number;
}

export interface RenderResult {
  duration: number;
  frames: number;
  seed: string;
  renderWidth: number;
  renderHeight: number;
}

export async function validateRenderAnalysis(
  audioPath: string,
  config: ProjectConfig,
  analysis: AudioAnalysis,
): Promise<void> {
  if (analysis.version !== ANALYSIS_VERSION) {
    throw new Error(
      `Analysis version ${analysis.version} is not supported by this renderer (expected ${ANALYSIS_VERSION})`,
    );
  }
  const sourceFileHash = await hashFile(audioPath);
  if (analysis.sourceFileHash !== sourceFileHash) {
    throw new Error("The analysis was created from a different audio file");
  }
  if (analysis.spectrumBands !== config.visual.spectrumBands) {
    throw new Error(
      `Analysis has ${analysis.spectrumBands} spectrum bands but the project requests ${config.visual.spectrumBands}`,
    );
  }
  if (analysis.fps !== config.output.fps) {
    throw new Error(
      `Analysis uses ${analysis.fps} fps but the project requests ${config.output.fps} fps`,
    );
  }
}

/** The automatic seed binds the visual plan to the decoded audio, the output profile and the renderer version. */
export function resolveRenderSeed(config: ProjectConfig, analysis: AudioAnalysis): string {
  if (config.visual.seed !== "auto") return config.visual.seed;
  return sha256(
    [
      analysis.sourceHash,
      config.output.width,
      config.output.height,
      config.output.fps,
      config.visual.spectrumBands,
      RENDERER_VERSION,
      ...(config.visual.engine === "milkdrop" ? ["milkdrop-2"] : []),
    ].join(":"),
  ).slice(0, 16);
}

export async function renderVideo(
  request: RenderRequest,
  analysis: AudioAnalysis,
  onProgress?: (progress: RenderProgress) => void,
): Promise<RenderResult> {
  await validateRenderAnalysis(request.audioPath, request.config, analysis);
  if (!Number.isFinite(request.start) || request.start < 0 || request.start >= analysis.duration) {
    throw new Error(`Start time must be a finite number between 0 and ${analysis.duration.toFixed(3)} seconds`);
  }
  if (request.duration !== undefined && (!Number.isFinite(request.duration) || request.duration <= 0)) {
    throw new Error("Render duration must be a finite number greater than zero");
  }
  const availableDuration = analysis.duration - request.start;
  const requestedDuration = Math.min(request.duration ?? availableDuration, availableDuration);
  if (!(requestedDuration > 0)) throw new Error("Render duration must be greater than zero");
  const fps = request.config.output.fps;
  const totalFrames = Math.max(1, Math.ceil(requestedDuration * fps - 1e-9));
  const duration = totalFrames / fps;
  resolveFadeDurations(duration, request.config.output.fadeSeconds, request.fadeInSeconds, request.fadeOutSeconds);
  const seed = resolveRenderSeed(request.config, analysis);
  const renderSize = renderDimensions(request.config);
  // Decode before opening the output: a bad image must not truncate an existing MP4.
  const artwork = await prepareArtwork(request.config.visual.imagePath, renderSize.width, renderSize.height);
  if (request.config.visual.engine === "milkdrop") {
    const { renderMilkdrop } = await import("../milkdrop/export.js");
    return await renderMilkdrop(request, analysis, { duration, totalFrames, seed, renderSize, artwork }, onProgress);
  }
  const renderer = new VisualizerRenderer(request.config, seed, renderSize, artwork);
  const encoder = await FfmpegEncoder.create({
    audioPath: request.audioPath,
    outputPath: request.outputPath,
    config: request.config,
    start: request.start,
    duration,
    ...(request.fadeInSeconds === undefined ? {} : { fadeInSeconds: request.fadeInSeconds }),
    ...(request.fadeOutSeconds === undefined ? {} : { fadeOutSeconds: request.fadeOutSeconds }),
    frameCount: totalFrames,
    inputWidth: renderSize.width,
    inputHeight: renderSize.height,
    overwrite: request.overwrite,
  });
  const startedAt = performance.now();

  try {
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
      const time = request.start + frameIndex / fps;
      const frame = renderer.render(analysis, time);
      await encoder.write(frame);
      onProgress?.({
        frame: frameIndex + 1,
        totalFrames,
        elapsedSeconds: (performance.now() - startedAt) / 1000,
      });
    }
    await encoder.finish();
  } catch (error) {
    encoder.abort();
    throw error;
  }

  return {
    duration,
    frames: totalFrames,
    seed,
    renderWidth: renderSize.width,
    renderHeight: renderSize.height,
  };
}

import { sha256 } from "../math/random.js";
import { hashFile } from "../audio/decode.js";
import { renderDimensions } from "../config.js";
import {
  ANALYSIS_VERSION,
  RENDERER_VERSION,
  type AudioAnalysis,
  type RenderRequest,
} from "../types.js";
import { FfmpegEncoder } from "./encoder.js";
import { VisualizerRenderer } from "./renderer.js";

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

export async function renderVideo(
  request: RenderRequest,
  analysis: AudioAnalysis,
  onProgress?: (progress: RenderProgress) => void,
): Promise<RenderResult> {
  if (analysis.version !== ANALYSIS_VERSION) {
    throw new Error(
      `Analysis version ${analysis.version} is not supported by this renderer (expected ${ANALYSIS_VERSION})`,
    );
  }
  const sourceFileHash = await hashFile(request.audioPath);
  if (analysis.sourceFileHash !== sourceFileHash) {
    throw new Error("The analysis was created from a different audio file");
  }
  if (analysis.spectrumBands !== request.config.visual.spectrumBands) {
    throw new Error(
      `Analysis has ${analysis.spectrumBands} spectrum bands but the project requests ${request.config.visual.spectrumBands}`,
    );
  }
  if (analysis.fps !== request.config.output.fps) {
    throw new Error(
      `Analysis uses ${analysis.fps} fps but the project requests ${request.config.output.fps} fps`,
    );
  }
  if (request.start < 0 || request.start >= analysis.duration) {
    throw new Error(`Start time must be between 0 and ${analysis.duration.toFixed(3)} seconds`);
  }

  const availableDuration = analysis.duration - request.start;
  const requestedDuration = Math.min(request.duration ?? availableDuration, availableDuration);
  if (!(requestedDuration > 0)) throw new Error("Render duration must be greater than zero");
  const fps = request.config.output.fps;
  const totalFrames = Math.max(1, Math.ceil(requestedDuration * fps - 1e-9));
  const duration = totalFrames / fps;
  const automaticSeed = sha256(
    [
      analysis.sourceHash,
      request.config.output.width,
      request.config.output.height,
      fps,
      request.config.visual.spectrumBands,
      RENDERER_VERSION,
    ].join(":"),
  ).slice(0, 16);
  const seed = request.config.visual.seed === "auto" ? automaticSeed : request.config.visual.seed;
  const renderSize = renderDimensions(request.config);
  const renderer = new VisualizerRenderer(request.config, seed, renderSize);
  const encoder = await FfmpegEncoder.create({
    audioPath: request.audioPath,
    outputPath: request.outputPath,
    config: request.config,
    start: request.start,
    duration,
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

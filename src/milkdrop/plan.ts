import { createRandom, deriveSeed } from "../math/random.js";
import type { AudioAnalysis } from "../types.js";

export interface MilkdropPresetLoad {
  /** Load once before preroll; the preset stays active for the whole song. */
  frame: 0;
  preset: string;
  blendSeconds: 0;
}

export interface MilkdropPlan {
  simulationStart: number;
  simulationFrames: number;
  outputStartFrame: number;
  schedule: [MilkdropPresetLoad];
}

const PREROLL_SECONDS = 4;

/**
 * Pick one preset per source song and configured visual seed, independent of
 * excerpt timing, analysis features, output size and frame rate. Pass the raw
 * visual.seed setting, not the resolved render seed (which includes dimensions).
 * Preroll warms up an excerpt; it does not reconstruct full-track feedback.
 */
export function planMilkdrop(
  analysis: AudioAnalysis,
  visualSeed: string,
  start: number,
  totalFrames: number,
  fps: number,
  presetNames: readonly string[],
): MilkdropPlan {
  if (!Number.isFinite(start) || start < 0) throw new Error("MilkDrop start must be finite and nonnegative.");
  if (!Number.isSafeInteger(totalFrames) || totalFrames < 1) throw new Error("MilkDrop output requires a positive whole frame count.");
  if (!Number.isFinite(fps) || fps < 1 || fps > 240) throw new Error("MilkDrop frame rate must be between 1 and 240.");
  if (!Number.isFinite(analysis.fps) || analysis.fps <= 0) throw new Error("MilkDrop analysis frame rate must be positive.");
  if (!Array.isArray(presetNames) || presetNames.some(name => typeof name !== "string" || !name.trim())) {
    throw new Error("MilkDrop preset IDs must be nonempty strings.");
  }
  // Multiple IDs are a candidate pool, so their order must not affect selection.
  const presets = [...new Set(presetNames)].sort();
  if (!presets.length) throw new Error("MilkDrop needs at least one preset.");
  const outputStartFrame = Math.floor(Math.min(start, PREROLL_SECONDS) * fps);
  const simulationStart = Math.max(0, start - outputStartFrame / fps);
  const simulationFrames = outputStartFrame + totalFrames;
  if (!Number.isSafeInteger(simulationFrames)) throw new Error("MilkDrop simulation frame count is too large.");
  const random = createRandom(deriveSeed(JSON.stringify([analysis.sourceHash, visualSeed]), "milkdrop:song-preset-1"));
  const preset = presets[Math.floor(random() * presets.length)]!;
  return { simulationStart, simulationFrames, outputStartFrame,
    schedule: [{ frame: 0, preset, blendSeconds: 0 }] };
}

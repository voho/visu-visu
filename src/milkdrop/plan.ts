import { createRandom, deriveSeed } from "../math/random.js";
import type { AnalysisFrame, AudioAnalysis } from "../types.js";

export interface MilkdropTransition {
  /** Frame on the simulation timeline, including preroll. */
  frame: number;
  preset: string;
  blendSeconds: number;
}

export interface MilkdropPlan {
  simulationStart: number;
  simulationFrames: number;
  outputStartFrame: number;
  schedule: MilkdropTransition[];
}

const PREROLL_SECONDS = 4;
const MIN_DWELL_SECONDS = 8;
const MAX_DWELL_SECONDS = 13;
const unit = (value: number | undefined): number => Number.isFinite(value)
  ? Math.max(0, Math.min(1, value!)) : 0;

function energyOf(frame: AnalysisFrame | undefined): number {
  return unit(frame?.bass) * 0.50 + unit(frame?.rms) * 0.25
    + unit(frame?.mid) * 0.18 + unit(frame?.treble) * 0.07;
}

/** Only known curated IDs have musical affinities; arbitrary names remain valid. */
function affinity(name: string, frame: AnalysisFrame | undefined, energy: number): number {
  const bass = unit(frame?.bass), mid = unit(frame?.mid), treble = unit(frame?.treble);
  const total = Math.max(0.01, bass + mid + treble);
  switch (name) {
    case "vortex": case "folded-tunnel": return 0.20 + bass / total * 0.65 + energy * 0.20;
    case "ribbons": case "moebius": return 0.20 + mid / total * 0.55 + (1 - Math.abs(energy - 0.45)) * 0.20;
    case "cosmic-dust": case "julia-fractal": return 0.15 + treble / total * 0.60 + energy * 0.15;
    case "fog-tunnel": return 0.25 + (1 - energy) * 0.75;
    case "plasma": return 0.15 + energy * 0.65 + bass / total * 0.20;
    default: return 0.35;
  }
}

/**
 * A causal, seeded preset plan for a sequential MilkDrop simulation. Its short
 * preroll is an explicit excerpt warmup, not a reconstruction of full-track
 * framebuffer history. Geometry and feedback are rendered by the engine.
 */
export function planMilkdrop(
  analysis: AudioAnalysis,
  seed: string,
  start: number,
  totalFrames: number,
  fps: number,
  presetNames: string[],
  ordered = false,
): MilkdropPlan {
  if (!Number.isFinite(start) || start < 0) throw new Error("MilkDrop start must be finite and nonnegative.");
  if (!Number.isSafeInteger(totalFrames) || totalFrames < 1) throw new Error("MilkDrop output requires a positive whole frame count.");
  if (!Number.isFinite(fps) || fps < 1 || fps > 240) throw new Error("MilkDrop frame rate must be between 1 and 240.");
  if (!Number.isFinite(analysis.fps) || analysis.fps <= 0) throw new Error("MilkDrop analysis frame rate must be positive.");
  if (!Array.isArray(presetNames) || presetNames.some(name => typeof name !== "string" || !name.trim())) {
    throw new Error("MilkDrop preset IDs must be nonempty strings.");
  }
  const presets = [...new Set(presetNames)];
  if (!presets.length) throw new Error("MilkDrop needs at least one preset.");
  const outputStartFrame = Math.floor(Math.min(start, PREROLL_SECONDS) * fps);
  const simulationStart = Math.max(0, start - outputStartFrame / fps);
  const simulationFrames = outputStartFrame + totalFrames;
  if (!Number.isSafeInteger(simulationFrames)) throw new Error("MilkDrop simulation frame count is too large.");
  const random = createRandom(deriveSeed(seed, "milkdrop:preset-plan"));
  let remaining = presets.slice();
  let previous: string | undefined;
  const choosePreset = (frame: AnalysisFrame | undefined, energy: number): string => {
    if (!remaining.length) remaining = presets.slice();
    if (ordered) return remaining.shift()!;
    let winner = 0, best = -Infinity;
    for (let index = 0; index < remaining.length; index++) {
      const name = remaining[index]!;
      if (remaining.length > 1 && name === previous) continue;
      const score = affinity(name, frame, energy) + random() * 0.75;
      if (score > best) { winner = index; best = score; }
    }
    previous = remaining.splice(winner, 1)[0]!;
    return previous;
  };
  const sourceIndexAt = (time: number): number => Math.floor(time * analysis.fps);
  const sourceAt = (time: number): AnalysisFrame | undefined => analysis.frames[sourceIndexAt(time)];
  let sourceIndex = sourceIndexAt(simulationStart);
  const initial = sourceAt(simulationStart);
  let section = energyOf(initial);
  let dwellJitter = random() * 0.3;
  const schedule: MilkdropTransition[] = [{ frame: 0, preset: choosePreset(initial, section), blendSeconds: 0 }];
  let previousChange = 0;
  // A single preset still receives its initial load, with no pointless reloads.
  if (presets.length === 1) return { simulationStart, simulationFrames, outputStartFrame, schedule };
  for (let frame = 1; frame < simulationFrames; frame++) {
    const time = simulationStart + frame / fps;
    const sample = sourceAt(time);
    const energy = energyOf(sample);
    section += (energy - section) * -Math.expm1(-1 / fps / (energy > section ? 0.8 : 2.4));
    const nextSourceIndex = sourceIndexAt(time);
    let onset = 0;
    // Scan each intervening feature once, even when export fps is lower than
    // analysis fps. An onset cannot affect a frame before its source timestamp.
    for (let index = Math.max(1, sourceIndex + 1); index <= Math.min(nextSourceIndex, analysis.frames.length - 1); index++) {
      const level = unit(analysis.frames[index]?.onset);
      const prior = unit(analysis.frames[index - 1]?.onset);
      if (level > prior + 0.08) onset = Math.max(onset, level);
    }
    sourceIndex = nextSourceIndex;
    const elapsed = (frame - previousChange) / fps;
    if (elapsed < MIN_DWELL_SECONDS) continue;
    const preferred = Math.min(MAX_DWELL_SECONDS, 12.6 - section * 3.8 + dwellJitter);
    const musicalChange = onset >= 0.16 && elapsed >= Math.max(MIN_DWELL_SECONDS, preferred - 1.7);
    if (!musicalChange && elapsed < MAX_DWELL_SECONDS) continue;
    schedule.push({ frame, preset: choosePreset(sample, section),
      blendSeconds: 4 - 1.5 * Math.min(1, section * 0.8 + onset * 0.2) });
    previousChange = frame;
    dwellJitter = random() * 0.3;
  }
  return { simulationStart, simulationFrames, outputStartFrame, schedule };
}

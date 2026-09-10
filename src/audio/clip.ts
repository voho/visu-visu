import type { AudioAnalysis } from "../types.js";

/** Seconds of build-up before the drop: a short clip must reach its drop within three seconds. */
export const DEFAULT_LEAD_IN = 3;

export interface ClipOptions {
  /** Maximum clip length in seconds, up to 30. */
  duration?: number;
  /** Build-up before a drop; defaults to 3, or half the length for clips under 6 s, so the drop lands within the first three seconds. */
  leadIn?: number;
  /** Optional absolute song time of a known drop. */
  drop?: number;
}

export interface ClipSelection {
  start: number;
  duration: number;
  end: number;
  drop: number | null;
  dropOffset: number | null;
  reason: "drop" | "energy" | "short-track" | "manual";
  score: number;
}

function unit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** Piecewise-constant integration keeps all scoring windows measured in seconds. */
function energyProfile(analysis: AudioAnalysis): (start: number, end: number) => number {
  const count = Math.ceil(analysis.duration * analysis.fps);
  const prefix = new Float64Array(count + 1);
  for (let index = 0; index < count; index += 1) {
    const frame = analysis.frames[index];
    // Bass carries the most musical weight; isolated spectral flux/peaks do not.
    const energy = frame
      ? unit(frame.bass) * 0.58 + unit(frame.rms) * 0.24 + unit(frame.mid) * 0.14 + unit(frame.treble) * 0.04
      : 0;
    prefix[index + 1] = (prefix[index] ?? 0) + energy / analysis.fps;
  }
  const integral = (time: number): number => {
    const position = Math.max(0, Math.min(analysis.duration, time)) * analysis.fps;
    const index = Math.min(count, Math.floor(position));
    const fraction = position - index;
    return (prefix[index] ?? 0) + ((prefix[index + 1] ?? prefix[index] ?? 0) - (prefix[index] ?? 0)) * fraction;
  };
  return (start, end) => {
    const left = Math.max(0, Math.min(analysis.duration, start));
    const right = Math.max(left, Math.min(analysis.duration, end));
    return right > left ? (integral(right) - integral(left)) / (right - left) : 0;
  };
}

/**
 * Selects a portrait-short excerpt without editing the analysis or needing PCM.
 * A drop must have both a sharp lift and sustained energy after the hit. Otherwise
 * the strongest full-length energy window wins. Equal scores choose the earliest.
 */
export function selectClip(analysis: AudioAnalysis, options: ClipOptions = {}): ClipSelection {
  const duration = options.duration ?? 30;
  const leadIn = options.leadIn ?? Math.min(DEFAULT_LEAD_IN, duration / 2);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 30) {
    throw new Error("Clip duration must be greater than 0 and at most 30 seconds.");
  }
  if (!Number.isFinite(leadIn) || leadIn < 0 || leadIn >= duration) {
    throw new Error("Clip lead-in must be at least 0 and shorter than the clip duration.");
  }
  if (!Number.isFinite(analysis.duration) || analysis.duration <= 0
    || !Number.isFinite(analysis.fps) || analysis.fps <= 0 || analysis.frames.length === 0) {
    throw new Error("Clip selection requires a nonempty analysis with a positive duration and frame rate.");
  }
  if (options.drop !== undefined && (!Number.isFinite(options.drop) || options.drop < 0 || options.drop >= analysis.duration)) {
    throw new Error("Drop time must be at least 0 and before the end of the song.");
  }
  const { fps } = analysis;
  const frameDuration = Math.floor(duration * fps + 1e-9) / fps;
  if (frameDuration === 0) throw new Error("Clip duration must include at least one video frame.");
  const mean = energyProfile(analysis);
  const makeSelection = (start: number, drop: number | null, reason: ClipSelection["reason"], score: number): ClipSelection => {
    let startFrame = Math.max(0, Math.floor(start * fps + 1e-9));
    // Extremely short clips / long custom lead-ins can otherwise put a manual
    // drop beyond the excerpt after rounding to complete video frames.
    if (drop !== null) startFrame = Math.max(startFrame, Math.floor(drop * fps + 1e-9) - Math.round(frameDuration * fps) + 1);
    const alignedStart = startFrame / fps;
    const length = Math.min(frameDuration, analysis.duration - alignedStart);
    return {
      start: alignedStart,
      duration: length,
      end: alignedStart + length,
      drop,
      dropOffset: drop === null ? null : drop - alignedStart,
      reason,
      score,
    };
  };
  if (options.drop !== undefined) {
    // Preserve the requested build-up even at the end of the song, shortening the
    // excerpt there instead of silently moving the supplied drop to another place.
    return makeSelection(Math.max(0, options.drop - leadIn), options.drop, "manual", 1);
  }
  if (analysis.duration <= frameDuration) {
    return makeSelection(0, null, "short-track", mean(0, analysis.duration));
  }

  const lastStart = Math.max(0, Math.floor((analysis.duration - frameDuration) * fps + 1e-9) / fps);
  const minimumTail = Math.min(2, frameDuration / 3);
  const attackWindow = Math.min(0.5, frameDuration / 6);
  const sustainWindow = Math.min(6, Math.max(minimumTail, frameDuration - leadIn));
  let bestDrop: ClipSelection | undefined;
  let bestEnergy: ClipSelection | undefined;
  const lastFrame = Math.floor(analysis.duration * fps);
  for (let index = 0; index <= lastFrame; index += 1) {
    const time = index / fps;
    if (time <= lastStart + 1e-9) {
      const score = mean(time, time + frameDuration);
      if (!bestEnergy || score > bestEnergy.score + 1e-9) {
        bestEnergy = makeSelection(time, null, "energy", score);
      }
    }
    if (index === 0 || analysis.duration - time < minimumTail) continue;
    const before = mean(time - attackWindow, time);
    const after = mean(time, time + attackWindow);
    const baselineEnd = Math.max(0, time - attackWindow);
    const baseline = baselineEnd > 0 ? mean(time - 5, baselineEnd) : before;
    const sustained = mean(time + attackWindow, time + sustainWindow);
    const sharpLift = after - before;
    const sustainedLift = sustained - baseline;
    // These two requirements exclude one-frame hits and gradual intro crescendos.
    if (sharpLift < Math.max(0.035, after * 0.13)
      || sustainedLift < Math.max(0.05, sustained * 0.18)
      || sharpLift < sustainedLift * 0.35
      || sustained < after * 0.55) continue;
    const start = Math.max(0, time - leadIn);
    const availableBuild = leadIn > 0 ? Math.min(1, time / leadIn) : 1;
    const availableTail = Math.min(1, (analysis.duration - time) / Math.max(minimumTail, frameDuration - leadIn));
    const context = 0.7 + availableBuild * 0.1 + availableTail * 0.2;
    const clipEnergy = mean(start + Math.min(leadIn, time - start), start + frameDuration);
    const score = (sharpLift * 0.35 + sustainedLift * 0.25 + sustained * 0.3 + clipEnergy * 0.1) * context;
    if (!bestDrop || score > bestDrop.score + 1e-9) {
      bestDrop = makeSelection(start, time, "drop", score);
    }
  }
  // Index zero is always a valid fallback, including a completely silent song.
  return bestDrop ?? bestEnergy ?? makeSelection(0, null, "energy", 0);
}

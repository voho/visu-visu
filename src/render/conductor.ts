import { clamp, smoothstep } from "../math/random.js";
import type { AnalysisFrame, AudioAnalysis } from "../types.js";

export interface VisualState {
  ambient: number;
  drive: number;
  peak: number;
  beat: number;
  trend: number;
  motion: number;
  chapter: number;
  form: number;
}

function frameEnergy(frame: AnalysisFrame): number {
  return clamp(
    frame.rms * 0.44 +
      frame.bass * 0.23 +
      frame.mid * 0.2 +
      frame.treble * 0.13,
  );
}

function rangeMean(
  analysis: AudioAnalysis,
  startIndex: number,
  endIndex: number,
  value: (frame: AnalysisFrame) => number,
): number {
  const start = Math.max(0, Math.min(analysis.frames.length - 1, startIndex));
  const end = Math.max(start, Math.min(analysis.frames.length - 1, endIndex));
  let sum = 0;
  for (let index = start; index <= end; index += 1) {
    const frame = analysis.frames[index];
    if (frame) sum += value(frame);
  }
  return sum / Math.max(1, end - start + 1);
}

/**
 * A direct-seek-safe visual conductor. Every value depends only on cached
 * analysis and absolute time, so renders remain identical regardless of frame
 * order while longer builds and drops can still reshape the composition.
 */
export function deriveVisualState(analysis: AudioAnalysis, time: number): VisualState {
  const fps = analysis.fps;
  const currentIndex = Math.max(
    0,
    Math.min(analysis.frames.length - 1, Math.round(time * fps)),
  );
  const current = analysis.frames[currentIndex] ?? analysis.frames[0];
  if (!current) {
    return {
      ambient: 1,
      drive: 0,
      peak: 0,
      beat: 0,
      trend: 0,
      motion: 0.35,
      chapter: 0,
      form: 0,
    };
  }

  const sectionRadius = Math.max(1, Math.round(fps * 0.72));
  const sectionEnergy = rangeMean(
    analysis,
    currentIndex - sectionRadius,
    currentIndex + sectionRadius,
    frameEnergy,
  );
  const pastEnergy = rangeMean(
    analysis,
    currentIndex - Math.round(fps * 1.8),
    currentIndex - Math.round(fps * 0.3),
    frameEnergy,
  );
  const futureEnergy = rangeMean(
    analysis,
    currentIndex + Math.round(fps * 0.3),
    currentIndex + Math.round(fps * 1.45),
    frameEnergy,
  );
  const onsetActivity = rangeMean(
    analysis,
    currentIndex - Math.round(fps * 1.4),
    currentIndex,
    (frame) => Math.sqrt(frame.onset),
  );
  const trend = clamp((futureEnergy - pastEnergy) * 2.4, -1, 1);

  let beat = 0;
  const beatStart = Math.max(1, currentIndex - Math.ceil(fps * 0.5));
  for (let index = beatStart; index <= currentIndex; index += 1) {
    const strength = analysis.frames[index]?.onset ?? 0;
    const previous = analysis.frames[index - 1]?.onset ?? 0;
    const next = analysis.frames[index + 1]?.onset ?? 0;
    if (strength < 0.08 || strength < previous || strength <= next) continue;
    const age = Math.max(0, time - index / fps);
    beat = Math.max(beat, strength ** 1.35 * Math.exp(-age / 0.15));
  }
  beat = clamp(beat);

  const driveSignal =
    sectionEnergy * 0.84 + onsetActivity * 0.46 + Math.max(0, trend) * 0.16;
  const peakSignal =
    sectionEnergy * 0.78 + onsetActivity * 0.32 + Math.max(0, trend) * 0.12;
  const rawDrive = smoothstep(0.2, 0.78, driveSignal);
  const peak = smoothstep(0.54, 0.9, peakSignal);
  const drive = rawDrive * (1 - peak);
  const ambient = clamp(1 - drive - peak);
  const structuralChapter = smoothstep(
    0.28,
    0.78,
    sectionEnergy * 0.82 + onsetActivity * 0.18 + Math.max(0, trend) * 0.28,
  );
  const slowVariation = 0.5 - Math.cos(time * 0.21) * 0.5;
  const chapter = clamp(structuralChapter * 0.9 + slowVariation * 0.1);
  const form = smoothstep(0.04, 0.7, peak * 0.72 + drive * 0.52 + chapter * 0.24);
  const motion = clamp(
    0.35 + drive * 0.42 + peak * 0.18 + Math.abs(trend) * 0.2 + chapter * 0.08,
  );

  return { ambient, drive, peak, beat, trend, motion, chapter, form };
}

import { onsetEventsBetween } from "../audio/onsets.js";
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

export interface ChoreographyModes {
  ambient: number;
  build: number;
  peak: number;
  release: number;
}

export interface ChoreographyLayers {
  stars: number;
  aurora: number;
  halo: number;
  tunnel: number;
  waveform: number;
  spiral: number;
  grade: number;
  camera: number;
}

export interface Choreography {
  modes: ChoreographyModes;
  layers: ChoreographyLayers;
  impact: number;
  onset: number;
}

interface ConductorProfile {
  sectionEnergy: Float64Array;
  floor: number;
  ceiling: number;
  spread: number;
}

export const LOW_FLASH_TRANSIENT_CAP = 0.3;

const profiles = new WeakMap<AudioAnalysis, ConductorProfile>();

function frameEnergy(frame: AnalysisFrame): number {
  return clamp(
    frame.rms * 0.44 +
      frame.bass * 0.23 +
      frame.mid * 0.2 +
      frame.treble * 0.13,
  );
}

function percentile(values: ArrayLike<number>, position: number): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(position * (sorted.length - 1))),
  );
  return sorted[index] ?? 0;
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

function buildProfile(analysis: AudioAnalysis): ConductorProfile {
  const sectionRadius = Math.max(1, Math.round(analysis.fps * 0.28));
  const sectionEnergy = Float64Array.from(
    analysis.frames,
    (_, index) =>
      rangeMean(
        analysis,
        index - sectionRadius,
        index + sectionRadius,
        frameEnergy,
      ),
  );
  const floor = percentile(sectionEnergy, 0.18);
  const rawCeiling = percentile(sectionEnergy, 0.84);
  const ceiling = Math.max(rawCeiling, floor + 0.035);
  return {
    sectionEnergy,
    floor,
    ceiling,
    spread: ceiling - floor,
  };
}

function profileFor(analysis: AudioAnalysis): ConductorProfile {
  const cached = profiles.get(analysis);
  if (cached) return cached;
  const profile = buildProfile(analysis);
  profiles.set(analysis, profile);
  return profile;
}

function recentOnsetActivity(analysis: AudioAnalysis, time: number): number {
  const decaySeconds = 0.45;
  let sum = 0;
  for (const event of onsetEventsBetween(analysis, time - decaySeconds * 4, time)) {
    sum += Math.sqrt(event.strength) * Math.exp(-(time - event.time) / decaySeconds);
  }
  // One event contributes a fixed area, roughly one frame of activity at 24 fps.
  return sum / (24 * decaySeconds);
}

function deriveBeat(analysis: AudioAnalysis, time: number): number {
  let beat = 0;
  for (const event of onsetEventsBetween(analysis, time - 0.5, time)) {
    const age = time - event.time;
    beat = Math.max(beat, event.strength ** 1.35 * Math.exp(-age / 0.15));
  }
  return clamp(beat);
}

/**
 * A direct-seek-safe visual conductor. It compares a short musical section to
 * robust, track-relative energy bounds and a longer surrounding bed. Every
 * value depends only on cached analysis and absolute time; the WeakMap only
 * avoids rebuilding identical profile data for every rendered frame.
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
      motion: 0.22,
      chapter: 0,
      form: 0,
    };
  }

  const profile = profileFor(analysis);
  const sectionEnergy = profile.sectionEnergy[currentIndex] ?? frameEnergy(current);
  const bedRadius = Math.max(1, Math.round(fps * 1.4));
  const bedEnergy = rangeMean(
    analysis,
    currentIndex - bedRadius,
    currentIndex + bedRadius,
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
  const trend = clamp(
    (futureEnergy - pastEnergy) / (profile.spread * 1.6),
    -1,
    1,
  );
  const contrast = clamp(
    (sectionEnergy - bedEnergy) / (profile.spread * 1.15),
    -1,
    1,
  );
  const relativeEnergy = Math.max(
    smoothstep(profile.floor, profile.ceiling, sectionEnergy),
    smoothstep(0.18, 0.68, sectionEnergy) * 0.5,
  );
  const rhythm = smoothstep(
    0.05,
    0.17,
    recentOnsetActivity(analysis, time),
  );
  const beat = deriveBeat(analysis, time);

  const peakSignal =
    relativeEnergy * 0.7 + Math.max(0, contrast) * 0.24 + rhythm * 0.18;
  const peak = smoothstep(0.58, 0.84, peakSignal);
  const driveSignal =
    relativeEnergy * 0.55 + rhythm * 0.2 + Math.max(0, trend) * 0.25;
  const rawDrive = smoothstep(0.18, 0.74, driveSignal);
  const drive = rawDrive * (1 - peak);
  const ambient = clamp(1 - drive - peak);
  const chapter = smoothstep(
    0.15,
    0.82,
    relativeEnergy * 0.72 + Math.max(0, trend) * 0.2 + rhythm * 0.08,
  );
  const form = smoothstep(
    0.1,
    0.82,
    peak * 0.82 + drive * 0.34 + chapter * 0.12,
  );
  const motion = clamp(
    0.22 +
      drive * 0.42 +
      peak * 0.34 +
      Math.abs(trend) * 0.2 +
      chapter * 0.07,
  );

  return { ambient, drive, peak, beat, trend, motion, chapter, form };
}

function transient(value: number, lowFlash: boolean): number {
  const normalized = clamp(value);
  return lowFlash ? Math.min(normalized, LOW_FLASH_TRANSIENT_CAP) : normalized;
}

/**
 * Maps conductor modes to an intentional layer handoff. Sustained mode and
 * layer values do not depend on low-flash mode; only fast impact/onset accents
 * are capped, so safety does not flatten the musical section structure.
 */
export function deriveChoreography(
  visual: VisualState,
  onset: number,
  lowFlash: boolean,
): Choreography {
  const positiveTrend = smoothstep(0.06, 0.65, Math.max(0, visual.trend));
  const negativeTrend = smoothstep(0.06, 0.65, Math.max(0, -visual.trend));
  const ambientRaw = clamp(visual.ambient);
  const buildRaw = clamp(visual.drive) + positiveTrend * 0.28 * (1 - clamp(visual.peak));
  const peakRaw = clamp(visual.peak);
  const releaseRaw = negativeTrend * 1.1 * (1 - clamp(visual.peak));
  const total = ambientRaw + buildRaw + peakRaw + releaseRaw;
  const modes: ChoreographyModes =
    total <= 1e-9
      ? { ambient: 1, build: 0, peak: 0, release: 0 }
      : {
          ambient: ambientRaw / total,
          build: buildRaw / total,
          peak: peakRaw / total,
          release: releaseRaw / total,
        };
  const { ambient, build, peak, release } = modes;
  const layers: ChoreographyLayers = {
    stars: clamp(ambient * 0.78 + build * 0.5 + peak * 0.56 + release * 0.82),
    aurora: clamp(ambient * 0.74 + build * 0.66 + peak * 0.42 + release * 0.74),
    halo: clamp(ambient * 0.52 + build * 0.44 + peak * 0.22 + release * 0.82),
    tunnel: clamp(ambient * 0.15 + build * 0.9 + peak * 0.38 + release * 0.26),
    waveform: clamp(ambient * 0.3 + build * 0.44 + peak * 0.16 + release * 0.4),
    spiral: clamp(ambient * 0.26 + build * 0.6 + peak + release * 0.34),
    grade: clamp(ambient * 0.32 + build * 0.62 + peak * 0.92 + release * 0.38),
    camera: clamp(ambient * 0.16 + build * 0.66 + peak * 0.82 + release * 0.24),
  };

  return {
    modes,
    layers,
    impact: transient(visual.beat, lowFlash),
    onset: transient(onset, lowFlash),
  };
}

import { clamp } from "../math/random.js";
import type { AnalysisFrame, AudioAnalysis } from "../types.js";

export interface MusicMotion {
  /** Integrated musical time for sustained, slowly moving forms (0.2–1×). */
  slowTime: number;
  /** Integrated musical time for foreground particles and rapid detail (1–5×). */
  fastTime: number;
  bassPulse: number;
  treblePulse: number;
  bassEnergy: number;
  midEnergy: number;
  trebleEnergy: number;
  attack: number;
  sustain: number;
}

interface MotionProfile {
  fps: number;
  targets: Float64Array;
  sustain: Float64Array;
  bassPulse: Float64Array;
  treblePulse: Float64Array;
  slowTime: Float64Array;
  fastTime: Float64Array;
  bass: BandEnvelope;
  mid: BandEnvelope;
  treble: BandEnvelope;
}

interface BandEnvelope {
  targets: Float64Array;
  starts: Float64Array;
  attack: number;
  release: number;
}

const BASS_DECAY = 0.16;
const TREBLE_DECAY = 0.08;
const SUSTAIN_ATTACK = 0.26;
const SUSTAIN_RELEASE = 0.9;
const FLUX_FLOOR = 0.0015;
const profiles = new WeakMap<AudioAnalysis, MotionProfile>();

function positive(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function percentile(values: number[], fraction: number): number {
  values.sort((left, right) => left - right);
  return values[Math.floor((values.length - 1) * fraction)] ?? 0;
}

function broadEnergy(frame: AnalysisFrame, bass: number): number {
  let waveformSquares = 0;
  for (const value of frame.waveform) {
    if (Number.isFinite(value)) waveformSquares += value * value;
  }
  const waveformRms = Math.sqrt(waveformSquares / Math.max(1, frame.waveform.length));
  return clamp(positive(frame.rms) * 0.45 + waveformRms * 0.15 + bass * 0.4);
}

function bandEnvelope(
  analysis: AudioAnalysis,
  band: "bass" | "mid" | "treble",
  step: number,
  attack: number,
  release: number,
): BandEnvelope {
  const targets = Float64Array.from(analysis.frames, (frame) => positive(frame[band]));
  const gain = Math.min(24, 1 / Math.max(0.0001, percentile(Array.from(targets), 0.9)));
  const starts = new Float64Array(targets.length);
  for (let index = 0; index < targets.length; index += 1) {
    targets[index] = clamp((targets[index]! - FLUX_FLOOR) * gain);
    if (index === 0) {
      starts[index] = targets[index]!;
    } else {
      const target = targets[index - 1]!;
      const start = starts[index - 1]!;
      const tau = target > start ? attack : release;
      starts[index] = target + (start - target) * Math.exp(-step / tau);
    }
  }
  return { targets, starts, attack, release };
}

function bandAt(band: BandEnvelope, index: number, elapsed: number): number {
  const start = band.starts[index]!;
  const target = band.targets[index]!;
  const tau = target > start ? band.attack : band.release;
  return clamp(target + (start - target) * Math.exp(-elapsed / tau));
}

function highBandFlux(frame: AnalysisFrame, previous: AnalysisFrame): number {
  const start = Math.floor(frame.spectrum.length * 0.68);
  let flux = 0;
  for (let index = start; index < frame.spectrum.length; index += 1) {
    flux += Math.max(
      0,
      positive(frame.spectrum[index] ?? 0) - positive(previous.spectrum[index] ?? 0),
    );
  }
  return Math.max(
    positive(frame.treble - previous.treble),
    flux / Math.max(1, frame.spectrum.length - start),
  );
}

function pulseGain(flux: Float64Array): number {
  const audibleChanges = Array.from(flux).filter((value) => value > FLUX_FLOOR * 2);
  // Relative normalization reveals quiet high-frequency detail, while the gain
  // ceiling and absolute floor keep almost-silent numerical noise inconspicuous.
  return Math.min(36, 0.95 / Math.max(1e-9, percentile(audibleChanges, 0.85)));
}

function sustainTau(start: number, target: number): number {
  return target > start ? SUSTAIN_ATTACK : SUSTAIN_RELEASE;
}

function envelopeArea(start: number, target: number, duration: number): number {
  const tau = sustainTau(start, target);
  return target * duration + (start - target) * tau * -Math.expm1(-duration / tau);
}

function pulseArea(start: number, duration: number, tau: number): number {
  return start * tau * -Math.expm1(-duration / tau);
}

function buildProfile(analysis: AudioAnalysis): MotionProfile {
  const count = analysis.frames.length;
  const fps = Number.isFinite(analysis.fps) && analysis.fps > 0 ? analysis.fps : 30;
  const step = 1 / fps;
  const bass = bandEnvelope(analysis, "bass", step, 0.035, 0.22);
  const mid = bandEnvelope(analysis, "mid", step, 0.065, 0.32);
  const treble = bandEnvelope(analysis, "treble", step, 0.015, 0.1);
  const targets = Float64Array.from(analysis.frames, (frame, index) => broadEnergy(frame, bass.targets[index]!));
  const sustain = new Float64Array(count);
  const bassPulse = new Float64Array(count);
  const treblePulse = new Float64Array(count);
  const slowTime = new Float64Array(count);
  const fastTime = new Float64Array(count);

  // Normalize changes to a common sampling period before computing gains, so
  // slow ramps and the noise floor retain the same meaning at different fps.
  for (let index = 1; index < count; index += 1) {
    const current = analysis.frames[index]!;
    const previous = analysis.frames[index - 1]!;
    bassPulse[index] = positive(current.bass - previous.bass) * fps / 30;
    treblePulse[index] = highBandFlux(current, previous) * fps / 30;
  }
  const bassGain = pulseGain(bassPulse);
  const trebleGain = pulseGain(treblePulse);
  const energyGain = Math.min(4, 1 / Math.max(0.0001, percentile(Array.from(targets), 0.9)));

  for (let index = 0; index < count; index += 1) {
    targets[index] = clamp((targets[index]! - 0.003) * energyGain);
    if (index === 0) {
      // A track can start in a sustained note; its first FFT is not a drum hit.
      sustain[index] = targets[index]!;
      continue;
    }
    const previous = index - 1;
    const start = sustain[previous]!;
    const target = targets[previous]!;
    const sustainedArea = envelopeArea(start, target, step);
    const bassArea = pulseArea(bassPulse[previous]!, step, BASS_DECAY);
    const trebleArea = pulseArea(treblePulse[previous]!, step, TREBLE_DECAY);
    sustain[index] = target + (start - target) * Math.exp(-step / sustainTau(start, target));
    slowTime[index] = slowTime[previous]! + step * 0.2 + sustainedArea * 0.8;
    fastTime[index] = fastTime[previous]! + step + sustainedArea * 1.7 + bassArea * 1.8 + trebleArea * 0.5;
    bassPulse[index] = Math.max(
      bassPulse[previous]! * Math.exp(-step / BASS_DECAY),
      clamp((bassPulse[index]! - FLUX_FLOOR) * bassGain),
    );
    treblePulse[index] = Math.max(
      treblePulse[previous]! * Math.exp(-step / TREBLE_DECAY),
      clamp((treblePulse[index]! - FLUX_FLOOR) * trebleGain),
    );
  }
  return { fps, targets, sustain, bassPulse, treblePulse, slowTime, fastTime, bass, mid, treble };
}

/**
 * Causal musical transport and envelopes, evaluated at absolute time. Cached
 * scalar prefix integrals avoid accumulating render state or copying audio
 * frames. Exponentials are integrated analytically inside each sample interval,
 * so direct seeks and 60 fps rendering follow exactly the same continuous path.
 * Track-wide percentiles set sensitivity; events never precede their timestamps.
 */
export function deriveMusicMotion(analysis: AudioAnalysis, time: number): MusicMotion {
  const safeTime = Number.isFinite(time) ? Math.max(0, time) : 0;
  let profile = profiles.get(analysis);
  if (!profile) {
    profile = buildProfile(analysis);
    profiles.set(analysis, profile);
  }
  if (profile.targets.length === 0) {
    return {
      slowTime: safeTime * 0.2,
      fastTime: safeTime,
      bassPulse: 0,
      treblePulse: 0,
      bassEnergy: 0,
      midEnergy: 0,
      trebleEnergy: 0,
      attack: 0,
      sustain: 0,
    };
  }
  let index = Math.min(profile.targets.length - 1, Math.floor(safeTime * profile.fps));
  // Correct multiplication roundoff using actual event timestamps, without an
  // epsilon that could admit a future hit just before a frame boundary.
  if (index > 0 && index / profile.fps > safeTime) index -= 1;
  if (index + 1 < profile.targets.length && (index + 1) / profile.fps <= safeTime) index += 1;
  const elapsed = safeTime - index / profile.fps;
  const start = profile.sustain[index]!;
  const target = profile.targets[index]!;
  const sustain = clamp(target + (start - target) * Math.exp(-elapsed / sustainTau(start, target)));
  const bassPulse = profile.bassPulse[index]! * Math.exp(-elapsed / BASS_DECAY);
  const treblePulse = profile.treblePulse[index]! * Math.exp(-elapsed / TREBLE_DECAY);
  const sustainedArea = envelopeArea(start, target, elapsed);

  return {
    slowTime: profile.slowTime[index]! + elapsed * 0.2 + sustainedArea * 0.8,
    fastTime:
      profile.fastTime[index]! + elapsed + sustainedArea * 1.7 +
      pulseArea(profile.bassPulse[index]!, elapsed, BASS_DECAY) * 1.8 +
      pulseArea(profile.treblePulse[index]!, elapsed, TREBLE_DECAY) * 0.5,
    bassPulse,
    treblePulse,
    bassEnergy: bandAt(profile.bass, index, elapsed),
    midEnergy: bandAt(profile.mid, index, elapsed),
    trebleEnergy: bandAt(profile.treble, index, elapsed),
    attack: Math.max(bassPulse, treblePulse * 0.85),
    sustain,
  };
}

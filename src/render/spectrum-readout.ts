import type { AudioAnalysis } from "../types.js";

/** The readout keeps all 64 FFT bands; the sculpture retains its 32 material bands. */
export const SPECTRUM_STRIP_BANDS = 64;
export const SPECTRUM_PEAK_HOLD_SECONDS = 0.2;
export const SPECTRUM_PEAK_FALL_PER_SECOND = 0.38;
/** Near the track maximum preserves dynamics; p90 made busy drops a flat wall. */
const CEILING_PERCENTILE = 0.98;
/** Keep quiet bands visible without amplifying silence and numerical noise. */
const CEILING_FLOOR = 0.12;
const unit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

interface ReadoutProfile {
  fps: number;
  count: number;
  targets: Float64Array;
  starts: Float64Array;
  smoothed: Float64Array;
  ceilings: Float64Array;
  peaks: Float64Array;
  heldUntil: Float64Array;
}
const profiles = new WeakMap<AudioAnalysis, ReadoutProfile>();

/** Area sampling retains independent source bins and supports older, lower-resolution analyses. */
function sourceBands(source: Float32Array): Float64Array {
  const result = new Float64Array(SPECTRUM_STRIP_BANDS);
  for (let band = 0; band < SPECTRUM_STRIP_BANDS; band++) {
    const start = band / SPECTRUM_STRIP_BANDS * source.length;
    const end = (band + 1) / SPECTRUM_STRIP_BANDS * source.length;
    let sum = 0;
    for (let point = Math.floor(start); point < Math.ceil(end); point++) {
      sum += unit(source[point] ?? 0) * Math.max(0, Math.min(end, point + 1) - Math.max(start, point));
    }
    result[band] = sum / Math.max(1e-9, end - start);
  }
  return result;
}

/** Exact two-pole integration keeps movement smooth between analysis frames. */
function advance(start: number, smoothed: number, target: number, elapsed: number, band: number): { envelope: number; value: number } {
  const response = target > start ? 0.032 : 0.40 - band / (SPECTRUM_STRIP_BANDS - 1) * 0.28;
  const decay = Math.exp(-elapsed / response);
  const inertia = 0.022;
  const inertiaDecay = Math.exp(-elapsed / inertia);
  return {
    envelope: target + (start - target) * decay,
    value: unit(target + (smoothed - target) * inertiaDecay
      + (start - target) * response / (response - inertia) * (decay - inertiaDecay)),
  };
}

function fallenPeak(peak: number, heldUntil: number, time: number): number {
  return Math.max(0, peak - Math.max(0, time - heldUntil) * SPECTRUM_PEAK_FALL_PER_SECOND);
}

function build(analysis: AudioAnalysis): ReadoutProfile {
  const fps = Number.isFinite(analysis.fps) && analysis.fps > 0 ? analysis.fps : 30;
  const count = analysis.frames.length;
  const targets = new Float64Array(count * SPECTRUM_STRIP_BANDS);
  const starts = new Float64Array(targets.length);
  const smoothed = new Float64Array(targets.length);
  const peaks = new Float64Array(targets.length);
  const heldUntil = new Float64Array(targets.length);
  const ceilings = new Float64Array(SPECTRUM_STRIP_BANDS).fill(CEILING_FLOOR);
  for (let index = 0; index < count; index++) targets.set(sourceBands(analysis.frames[index]!.spectrum), index * SPECTRUM_STRIP_BANDS);
  if (count > 0) {
    const column = new Float64Array(count);
    for (let band = 0; band < SPECTRUM_STRIP_BANDS; band++) {
      for (let index = 0; index < count; index++) column[index] = targets[index * SPECTRUM_STRIP_BANDS + band]!;
      column.sort();
      ceilings[band] = Math.max(CEILING_FLOOR, column[Math.min(count - 1, Math.floor(count * CEILING_PERCENTILE))]!);
    }
  }
  for (let index = 0; index < count; index++) {
    const time = index / fps;
    for (let band = 0; band < SPECTRUM_STRIP_BANDS; band++) {
      const offset = index * SPECTRUM_STRIP_BANDS + band;
      let peak = 0, hold = 0;
      if (index > 0) {
        const previous = offset - SPECTRUM_STRIP_BANDS;
        const next = advance(starts[previous]!, smoothed[previous]!, targets[previous]!, 1 / fps, band);
        starts[offset] = next.envelope;
        smoothed[offset] = next.value;
        hold = heldUntil[previous]!;
        peak = fallenPeak(peaks[previous]!, Math.max((index - 1) / fps, hold), time);
      }
      // Capture raw peaks immediately, even when the bar is still easing into a hit.
      const target = unit(targets[offset]! / ceilings[band]!) ** 0.8;
      if (target > 0 && target >= peak) {
        peak = target;
        hold = time + SPECTRUM_PEAK_HOLD_SECONDS;
      }
      peaks[offset] = peak;
      heldUntil[offset] = hold;
    }
  }
  return { fps, count, targets, starts, smoothed, ceilings, peaks, heldUntil };
}

/** Causal envelopes and peak hold, indexed by absolute time rather than render history. */
export function spectrumReadoutAt(analysis: AudioAnalysis, time: number): { levels: Float32Array; peaks: Float32Array } {
  let profile = profiles.get(analysis);
  if (!profile) { profile = build(analysis); profiles.set(analysis, profile); }
  const levels = new Float32Array(SPECTRUM_STRIP_BANDS);
  const peaks = new Float32Array(SPECTRUM_STRIP_BANDS);
  if (!profile.count) return { levels, peaks };
  const safeTime = Number.isFinite(time) ? Math.max(0, Math.min(1e9, time)) : 0;
  let index = Math.min(profile.count - 1, Math.floor(safeTime * profile.fps));
  if (index > 0 && index / profile.fps > safeTime) index--;
  if (index + 1 < profile.count && (index + 1) / profile.fps <= safeTime) index++;
  const frameTime = index / profile.fps;
  const elapsed = safeTime - frameTime;
  for (let band = 0; band < SPECTRUM_STRIP_BANDS; band++) {
    const offset = index * SPECTRUM_STRIP_BANDS + band;
    const value = advance(profile.starts[offset]!, profile.smoothed[offset]!, profile.targets[offset]!, elapsed, band).value;
    levels[band] = unit(value / profile.ceilings[band]!) ** 0.8;
    // A sustained final frame still holds its own level; no invented post-track silence.
    const target = unit(profile.targets[offset]! / profile.ceilings[band]!) ** 0.8;
    peaks[band] = Math.max(target, levels[band]!, fallenPeak(profile.peaks[offset]!, Math.max(frameTime, profile.heldUntil[offset]!), safeTime));
  }
  return { levels, peaks };
}

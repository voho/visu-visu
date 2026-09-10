import { frameAt } from "../audio/analyze.js";
import type { AnalysisFrame, AudioAnalysis } from "../types.js";
import { audioFieldGeometry } from "./audio-field-geometry.js";
import { surfaceFeatureSamples } from "./surface-signal.js";

export const AUDIO_FIELD_BANDS = 32;
export interface AudioFieldState {
  /** Fast loudness outline and slower amplitude breathing, independently filtered. */
  fast: number;
  slow: number;
  /** Separate causal frequency envelopes for the spectrum readout. */
  spectrum: Float32Array;
}
interface Profile { fps: number; count: number; targets: Float64Array; starts: Float64Array; smoothed: Float64Array }
const profiles = new WeakMap<AudioAnalysis, Profile>();
const STRIDE = AUDIO_FIELD_BANDS + 2;
const unit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
function advance(start: number, smoothed: number, target: number, elapsed: number, channel: number): { envelope: number; value: number } {
  const attack = channel === 0 ? 0.020 : channel === 1 ? 0.28 : 0.032;
  const release = channel === 0 ? 0.20 : channel === 1 ? 1.2 : 0.40 - (channel - 2) / 31 * 0.28;
  const response = target > start ? attack : release;
  const decay = Math.exp(-elapsed / response);
  const envelope = target + (start - target) * decay;
  if (channel < 2) return { envelope, value: envelope };
  // A second short pole eases velocity at every FFT boundary while keeping
  // hits crisp. Exact integration preserves the same curve at any frame rate.
  const inertia = 0.022;
  const inertiaDecay = Math.exp(-elapsed / inertia);
  const value = target + (smoothed - target) * inertiaDecay
    + (start - target) * response / (response - inertia) * (decay - inertiaDecay);
  return { envelope, value: unit(value) };
}
function build(analysis: AudioAnalysis): Profile {
  const fps = Number.isFinite(analysis.fps) && analysis.fps > 0 ? analysis.fps : 30;
  const count = analysis.frames.length;
  const targets = new Float64Array(count * STRIDE);
  const starts = new Float64Array(targets.length);
  const smoothed = new Float64Array(targets.length);
  for (let index = 0; index < count; index++) {
    const frame = analysis.frames[index]!;
    const offset = index * STRIDE;
    targets[offset] = targets[offset + 1] = unit(frame.rms);
    const features = surfaceFeatureSamples(frame);
    for (let band = 0; band < AUDIO_FIELD_BANDS; band++) targets[offset + 2 + band] = unit(features[band]!);
    if (index > 0) for (let channel = 0; channel < STRIDE; channel++) {
      const previous = offset - STRIDE + channel;
      const next = advance(starts[previous]!, smoothed[previous]!, targets[previous]!, 1 / fps, channel);
      starts[offset + channel] = next.envelope;
      smoothed[offset + channel] = next.value;
    }
  }
  return { fps, count, starts, smoothed, targets };
}

/** Mean of a band range, as analyze.ts derives bass, mid and treble from the spectrum. */
function rangeMean(spectrum: Float32Array, startRatio: number, endRatio: number): number {
  const start = Math.floor(startRatio * spectrum.length);
  const end = Math.max(start + 1, Math.ceil(endRatio * spectrum.length));
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += spectrum[index] ?? 0;
  return sum / (end - start);
}

/**
 * The analysis frame at `time` with its spectrum replaced by the strip's
 * causal band envelopes (32 ms attack, 22 ms inertia, 120-400 ms release)
 * resampled to the frame's own band count, and bass, mid and treble re-derived
 * from that spectrum over the analysis' own ranges. The sculpture, its skin,
 * the core glow and the reflected strip light read this frame: a hit builds
 * over a few frames and settles with momentum, and FFT noise never crawls
 * across the mesh. Onset, loudness, centroid and the waveform are the frame's own.
 */
export function smoothedFrameAt(analysis: AudioAnalysis, time: number): AnalysisFrame {
  const frame = frameAt(analysis, time);
  const bands = frame.spectrum.length;
  if (bands === 0) return frame;
  const envelopes = audioFieldAt(analysis, time).spectrum;
  const spectrum = new Float32Array(bands);
  for (let band = 0; band < bands; band += 1) {
    // Bilinear across band centres, clamped at the ends (the same lookup the surface uses).
    const coordinate = Math.max(0, Math.min(AUDIO_FIELD_BANDS - 1, ((band + 0.5) / bands) * AUDIO_FIELD_BANDS - 0.5));
    const left = Math.floor(coordinate);
    const right = Math.min(AUDIO_FIELD_BANDS - 1, left + 1);
    const a = envelopes[left] ?? 0;
    const b = envelopes[right] ?? 0;
    spectrum[band] = a + (b - a) * (coordinate - left);
  }
  return {
    ...frame,
    spectrum,
    bass: rangeMean(spectrum, 0, 0.24),
    mid: rangeMean(spectrum, 0.24, 0.68),
    treble: rangeMean(spectrum, 0.68, 1),
  };
}

/** Absolute-time envelopes: seeking cannot borrow future audio or previous rendered frames. */
export function audioFieldAt(analysis: AudioAnalysis, time: number): AudioFieldState {
  let profile = profiles.get(analysis);
  if (!profile) { profile = build(analysis); profiles.set(analysis, profile); }
  const spectrum = new Float32Array(AUDIO_FIELD_BANDS);
  if (!profile.count) return { fast: 0, slow: 0, spectrum };
  const safeTime = Number.isFinite(time) ? Math.max(0, Math.min(1e9, time)) : 0;
  let index = Math.min(profile.count - 1, Math.floor(safeTime * profile.fps));
  if (index > 0 && index / profile.fps > safeTime) index--;
  if (index + 1 < profile.count && (index + 1) / profile.fps <= safeTime) index++;
  const elapsed = safeTime - index / profile.fps;
  const at = (channel: number): number => {
    const offset = index * STRIDE + channel;
    return advance(profile!.starts[offset]!, profile!.smoothed[offset]!, profile!.targets[offset]!, elapsed, channel).value;
  };
  for (let band = 0; band < AUDIO_FIELD_BANDS; band++) spectrum[band] = at(band + 2);
  return { fast: at(0), slow: at(1), spectrum };
}

export { audioFieldGeometry };

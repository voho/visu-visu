import type { SKRSContext2D } from "@napi-rs/canvas";
import type { AudioAnalysis } from "../types.js";
import { audioFieldGeometry, type AudioFieldGeometry, type AudioFieldPoint } from "./audio-field-geometry.js";
import { paletteCss, type ScenePalette } from "./palette.js";
import { safeGraphRadius, type SafeLayout } from "./layout.js";
import { surfaceFeatureSamples } from "./surface-signal.js";

export const AUDIO_FIELD_BANDS = 32;
export interface AudioFieldState {
  /** Fast loudness outline and slower amplitude breathing, independently filtered. */
  fast: number;
  slow: number;
  /** Separate causal frequency envelopes for the visible spectrum crown. */
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

/** Rounded spectral stems and a smooth signed waveform frame the textured sculpture. */
export function drawAudioField(
  context: SKRSContext2D,
  layout: SafeLayout,
  field: AudioFieldGeometry,
  palette: ScenePalette,
  front: boolean,
  lowFlash: boolean,
): void {
  const radius = safeGraphRadius(layout);
  const rx = Math.min(layout.width * 0.40, radius * 1.55);
  const ry = radius * 0.78;
  const width = Math.max(1.2, radius * 0.0076);
  context.save();
  context.globalCompositeOperation = "screen";
  context.lineCap = "round";
  context.lineJoin = "round";
  const path = (points: AudioFieldPoint[]): void => {
    context.beginPath();
    let joined = false;
    for (const point of points) {
      if (point.front !== front) { joined = false; continue; }
      const x = layout.centerX + point.x * rx, y = layout.horizon + point.y * ry;
      if (joined) context.lineTo(x, y); else context.moveTo(x, y);
      joined = true;
    }
    context.stroke();
  };
  for (const halo of field.halos) {
    context.lineWidth = width * halo.width;
    context.strokeStyle = paletteCss(palette, halo.phase, 88, 76, halo.alpha * (front ? 1 : 0.7));
    path(halo.points);
  }
  for (const spoke of field.spokes) {
    if (spoke.front !== front) continue;
    context.lineWidth = width * (0.85 + spoke.energy * 0.7);
    const alpha = (0.12 + spoke.energy * (lowFlash ? 0.30 : 0.46)) * (front ? 1 : 0.72);
    context.strokeStyle = paletteCss(palette, spoke.phase, 100, 79, alpha);
    context.beginPath();
    context.moveTo(layout.centerX + spoke.x1 * rx, layout.horizon + spoke.y1 * ry);
    context.lineTo(layout.centerX + spoke.x2 * rx, layout.horizon + spoke.y2 * ry);
    context.stroke();
  }
  if (front) {
    context.lineWidth = width * 1.2;
    context.strokeStyle = paletteCss(palette, 65, 80, 84, field.waveAlpha * (lowFlash ? 0.78 : 1));
    path(field.wave);
  }
  context.restore();
}

export { audioFieldGeometry };

import { clamp, smoothstep } from "../math/random.js";
import type { AudioAnalysis } from "../types.js";

export interface FrozenCloudEvent {
  id: number;
  /** Absolute song time used once for all captured geometry, color, and camera state. */
  captureTime: number;
  age: number;
  strength: number;
  /** Expansion of the frozen snapshot, never a new sample of the live shape. */
  scale: number;
  /** Final compositing opacity, including strength and the complete fade envelope. */
  opacity: number;
  /** Blur radius in units of the hero's radius. */
  blur: number;
  /** Continuous 0..1 erosion of a fixed spatial mask; do not resample its noise. */
  dissolve: number;
}

export interface FrozenCloudCapture {
  id: number;
  captureTime: number;
  strength: number;
}

export const FROZEN_CLOUD_LIFETIME = 7.5;
const REFRACTORY = 3;
const FLUX_FLOOR = 0.006;
const REFERENCE_FLOOR = 0.018;
const plans = new WeakMap<AudioAnalysis, readonly FrozenCloudCapture[]>();

function positive(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function frozenCloudPlan(analysis: AudioAnalysis): readonly FrozenCloudCapture[] {
  const cached = plans.get(analysis);
  if (cached) return cached;
  const events: FrozenCloudCapture[] = [];
  const fps = Number.isFinite(analysis.fps) && analysis.fps > 0 ? analysis.fps : 30;
  const refractoryFrames = Math.ceil(REFRACTORY * fps);
  const referenceDecay = Math.exp(-1 / (fps * 8));
  let lastCapture = -Infinity;
  let referenceFlux = REFERENCE_FLOOR;

  // A trailing reference adapts to quieter passages without allowing a later
  // loud drop to change any earlier capture. The first FFT is not an onset.
  for (let index = 1; index < analysis.frames.length; index += 1) {
    const bass = positive(analysis.frames[index]!.bass);
    const previousBass = positive(analysis.frames[index - 1]!.bass);
    const flux = positive(bass - previousBass) * fps / 30;
    referenceFlux = Math.max(REFERENCE_FLOOR, referenceFlux * referenceDecay);
    const isImpulse = bass >= 0.012 && flux >= Math.max(FLUX_FLOOR, referenceFlux * 0.3);
    if (isImpulse && index - lastCapture >= refractoryFrames) {
      events.push({
        id: index,
        captureTime: index / fps,
        strength: clamp(0.45 + 0.55 * flux / referenceFlux),
      });
      lastCapture = index;
    }
    referenceFlux = Math.max(referenceFlux, flux);
  }
  plans.set(analysis, events);
  return events;
}

/**
 * Sparse bass-triggered snapshots, evaluated from absolute song time. Captures
 * are at least 3 seconds apart and live for 7.5 seconds, naturally limiting the
 * renderer to three clouds without abruptly evicting a fading snapshot. Only
 * expansion, blur, opacity, and fixed-mask dissolution evolve after capture.
 */
export function cloudEventsAt(analysis: AudioAnalysis, time: number): FrozenCloudEvent[] {
  if (!Number.isFinite(time) || time < 0) return [];
  const events = frozenCloudPlan(analysis);
  let left = 0;
  let right = events.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (events[middle]!.captureTime + FROZEN_CLOUD_LIFETIME <= time) left = middle + 1;
    else right = middle;
  }
  const result: FrozenCloudEvent[] = [];
  for (let index = left; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.captureTime > time) break;
    const pose = frozenCloudAt(event, time);
    if (pose) result.push(pose);
  }
  return result;
}

/** Optical history only: the captured object never resamples live music. */
export function frozenCloudAt(event: FrozenCloudCapture, time: number): FrozenCloudEvent | undefined {
  const age = time - event.captureTime;
  if (!Number.isFinite(age) || age < 0 || time >= event.captureTime + FROZEN_CLOUD_LIFETIME) return undefined;
  const progress = clamp(age / FROZEN_CLOUD_LIFETIME);
  const endFade = 1 - smoothstep(FROZEN_CLOUD_LIFETIME * 0.72, FROZEN_CLOUD_LIFETIME, age);
  return {
    ...event, age,
    // Constant motion in depth gives a gentle perspective approach. The
    // snapshot passes from its original plane toward the viewer without
    // rotating, changing shape, or reaching the camera's near plane.
    scale: 1 / (1 - progress * 0.54),
    opacity: 0.14 * event.strength * smoothstep(0, 0.6, age)
      * Math.exp(-Math.max(0, age - 0.6) / 4.2) * endFade,
    // A recognizable ghost remains for the first second before turning to fog.
    blur: 0.006 + 0.114 * smoothstep(1.1, FROZEN_CLOUD_LIFETIME, age),
    dissolve: smoothstep(1.1, FROZEN_CLOUD_LIFETIME, age),
  };
}

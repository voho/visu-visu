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

interface PlannedCloud {
  id: number;
  captureTime: number;
  strength: number;
}

const LIFETIME = 6;
const REFRACTORY = 2.8;
const FLUX_FLOOR = 0.006;
const REFERENCE_FLOOR = 0.018;
const plans = new WeakMap<AudioAnalysis, readonly PlannedCloud[]>();

function positive(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function planFor(analysis: AudioAnalysis): readonly PlannedCloud[] {
  const cached = plans.get(analysis);
  if (cached) return cached;
  const events: PlannedCloud[] = [];
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
 * are at least 2.8 seconds apart and live for 6 seconds, naturally limiting the
 * renderer to three clouds without abruptly evicting a fading snapshot. Only
 * expansion, blur, opacity, and fixed-mask dissolution evolve after capture.
 */
export function cloudEventsAt(analysis: AudioAnalysis, time: number): FrozenCloudEvent[] {
  if (!Number.isFinite(time) || time < 0) return [];
  const events = planFor(analysis);
  let left = 0;
  let right = events.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (events[middle]!.captureTime <= time - LIFETIME) left = middle + 1;
    else right = middle;
  }
  const result: FrozenCloudEvent[] = [];
  for (let index = left; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.captureTime > time) break;
    const age = time - event.captureTime;
    if (age >= LIFETIME) continue;
    const progress = clamp(age / LIFETIME);
    const endFade = 1 - smoothstep(LIFETIME * 0.7, LIFETIME, age);
    result.push({
      ...event,
      age,
      scale: 1 + progress * 0.7,
      opacity: 0.095 * event.strength * smoothstep(0, 0.42, age) *
        Math.exp(-Math.max(0, age - 0.42) / 3.8) * endFade,
      blur: 0.014 + 0.116 * smoothstep(0, 1, progress),
      dissolve: smoothstep(0.3, LIFETIME, age),
    });
  }
  return result;
}

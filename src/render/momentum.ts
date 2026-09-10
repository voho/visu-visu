import { clamp, smoothstep } from "../math/random.js";
import { HIT_LIFETIME, hitEventsAt, type HitEvent } from "./hit-plan.js";
import type { AudioAnalysis } from "../types.js";

/**
 * One smoothed push per moving thing, heaviest first. Each is the response of
 * a different mass to the same kept hits: the room barely leans, the camera
 * follows, the sculpture folds, light flickers. All are pure functions of the
 * cached hit plan and absolute time, so seeking reproduces every push.
 */
export interface Momentum {
  /** The cover room: heaviest, peaks 140 ms after a hit and is gone by 0.7 s. */
  push: number;
  /** The graph camera's zoom. */
  camera: number;
  /** The full-frame warm lift and the core burst: light, but the whole frame, so heavier than a flick. */
  glow: number;
  /** The sculpture's fold, the key light, the skin and the embers' swell. */
  body: number;
  /** Light has no mass: the bloom smear and the bloom's glow and saturation accents. */
  flick: number;
}

/** Seconds from a hit to each response's peak. */
export const MOMENTUM_TAU = { push: 0.14, camera: 0.11, glow: 0.10, body: 0.08, flick: 0.045 } as const;

/** Hits fade out of the kernels over this long before their lifetime ends, so nothing steps when one leaves. */
const TAPER = 0.12;

/**
 * Response of a mass to a hit at `age` seconds: zero at the hit with zero
 * velocity, one at `tau`, below 0.01 by five `tau`. Two poles, so the rise is
 * S-shaped instead of the one-frame step of the raw bass pulse.
 */
export function momentumKernel(age: number, tau: number): number {
  if (!(age > 0) || !(tau > 0)) return 0;
  const x = age / tau;
  return x * x * Math.exp(2 * (1 - x));
}

/** A kick pushes with its whole size; a hat with about a third of it. */
function hitPush(hit: HitEvent): number {
  return clamp(hit.strength) * (0.35 + 0.65 * clamp(hit.kick));
}

/** Identity up to one full push, then eases toward 1.25: overlapping hits add a little, never a flat top. */
function softClamp(value: number): number {
  if (!(value > 0)) return 0;
  return value <= 1 ? value : 1 + 0.25 * (1 - Math.exp(-(value - 1) / 0.25));
}

/** The pushes of every live hit through one kernel, summed and softly bounded. */
export function punchAt(hits: readonly HitEvent[], tau: number): number {
  let total = 0;
  for (const hit of hits) {
    const taper = 1 - smoothstep(HIT_LIFETIME - TAPER, HIT_LIFETIME, hit.age);
    total += hitPush(hit) * momentumKernel(hit.age, tau) * taper;
  }
  return softClamp(total);
}

export function momentumFromHits(hits: readonly HitEvent[]): Momentum {
  return {
    push: punchAt(hits, MOMENTUM_TAU.push),
    camera: punchAt(hits, MOMENTUM_TAU.camera),
    glow: punchAt(hits, MOMENTUM_TAU.glow),
    body: punchAt(hits, MOMENTUM_TAU.body),
    flick: punchAt(hits, MOMENTUM_TAU.flick),
  };
}

export function momentumAt(analysis: AudioAnalysis, time: number): Momentum {
  return momentumFromHits(hitEventsAt(analysis, time));
}

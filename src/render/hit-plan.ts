import { onsetEventsBetween } from "../audio/onsets.js";
import { clamp, createRandom, deriveSeed, randomBetween, smoothstep } from "../math/random.js";
import type { AudioAnalysis } from "../types.js";

export interface HitEvent {
  time: number;
  /** Seconds since the onset, 0 .. HIT_LIFETIME. */
  age: number;
  /** 0.5 * onset strength + 0.5 * rank among the onsets of the surrounding 8 s. */
  strength: number;
  /** Bass share of the onset frame's band energy: kicks near 1, hats near 0. */
  bassShare: number;
  /**
   * 1 for a kick, 0 for a hat: bassShare split at the median of this
   * track's kept hits (clamped to 0.25..0.6 so a kicks-only or hats-only
   * track lands whole on one side) with a narrow crossover, so almost no hit
   * sits in the grey between the two ring pigments.
   */
  kick: number;
}

/** Minimum spacing between kept hits; every luminance transient obeys it. */
export const HIT_REFRACTORY = 0.34;
/** Kept hits per second at most, the flash budget's rate term. */
export const FLASH_MAX_RATE = 1 / HIT_REFRACTORY;
/** A hit's ring and lift are over after this long. */
export const HIT_LIFETIME = 0.7;
/** Ring light under lowFlash never exceeds this (a luminance transient, see LOW_FLASH_TRANSIENT_CAP). */
export const LOW_FLASH_RING_ALPHA = 0.45;
/** Ring radius at a hit's start, as a multiple of the graph reserve. */
const RING_START = 0.5;
/** Half-width of the window a hit is ranked against. */
const RANK_WINDOW = 4;
/** Live hits per frame: with the refractory at most three fit in one lifetime. */
const MAX_LIVE = 3;
/** Half-width of the kick/hat crossover in bass share. */
const KICK_CROSSOVER = 0.03;

type PlannedHit = Omit<HitEvent, "age">;

const plans = new WeakMap<AudioAnalysis, readonly PlannedHit[]>();

/**
 * One global, cached plan per analysis. Onsets are sized by 0.5 * strength
 * + 0.5 * rank within +/-4 s, so among a run of clipped 1.0 onsets the hits
 * that are loud for their neighbourhood still stand out and an intro tap
 * scores lower than a drop kick. Non-maximum suppression by that size with
 * the refractory as radius keeps the strongest hit of every cluster (a walk
 * in time order would let a ghost note 0.1 s early block the kick). The plan
 * depends only on the analysis, so seeking never moves a hit.
 */
function planFor(analysis: AudioAnalysis): readonly PlannedHit[] {
  const cached = plans.get(analysis);
  if (cached) return cached;
  const onsets = onsetEventsBetween(analysis, 0, Number.POSITIVE_INFINITY);
  const sized = onsets.map((event, index): Omit<PlannedHit, "kick"> => {
    let below = 0;
    let count = 0;
    for (let other = 0; other < onsets.length; other += 1) {
      if (other === index) continue;
      const candidate = onsets[other]!;
      if (Math.abs(candidate.time - event.time) > RANK_WINDOW) continue;
      count += 1;
      if (candidate.strength < event.strength) below += 1;
      else if (candidate.strength === event.strength) below += 0.5;
    }
    // An onset with no neighbours is neither loud nor quiet for its neighbourhood.
    const rank = count === 0 ? 0.5 : below / count;
    const frame = analysis.frames[event.index];
    const bass = Math.max(0, frame?.bass ?? 0);
    const total = bass + Math.max(0, frame?.mid ?? 0) + Math.max(0, frame?.treble ?? 0) + 1e-6;
    return {
      time: event.time,
      strength: clamp(0.5 * clamp(event.strength) + 0.5 * rank),
      bassShare: clamp(bass / total),
    };
  });
  const byStrength = [...sized].sort((left, right) =>
    right.strength - left.strength || left.time - right.time);
  const kept: Omit<PlannedHit, "kick">[] = [];
  for (const hit of byStrength) {
    if (kept.every((other) => Math.abs(other.time - hit.time) >= HIT_REFRACTORY)) kept.push(hit);
  }
  kept.sort((left, right) => left.time - right.time);
  const shares = kept.map((hit) => hit.bassShare).sort((left, right) => left - right);
  const median = shares.length === 0 ? 0.45 : shares[Math.floor(shares.length / 2)]!;
  const split = clamp(median, 0.25, 0.6);
  const plan = kept.map((hit): PlannedHit => ({
    ...hit,
    kick: smoothstep(split - KICK_CROSSOVER, split + KICK_CROSSOVER, hit.bassShare),
  }));
  plans.set(analysis, plan);
  return plan;
}

/** Hits alive at `time`, newest first; a pure function of the cached plan and absolute time. */
export function hitEventsAt(analysis: AudioAnalysis, time: number): HitEvent[] {
  if (!Number.isFinite(time)) return [];
  const plan = planFor(analysis);
  let left = 0;
  let right = plan.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (plan[middle]!.time < time - HIT_LIFETIME) left = middle + 1;
    else right = middle;
  }
  const live: HitEvent[] = [];
  for (let index = left; index < plan.length; index += 1) {
    const hit = plan[index]!;
    if (hit.time > time) break;
    const age = time - hit.time;
    if (age > HIT_LIFETIME) continue;
    live.push({ ...hit, age });
  }
  return live.reverse().slice(0, MAX_LIVE);
}

/**
 * Light of a hit ring at `age` for a hit of visual `size` (0..1): ramps in
 * over 50 ms so no frame jumps to full, fades over the lifetime, and under
 * lowFlash is capped. Geometry is never capped, only this alpha.
 */
export function hitRingAlpha(age: number, size: number, lowFlash: boolean, intensity = 1): number {
  const progress = clamp(age / HIT_LIFETIME);
  // The 50 ms ramp is motion, so both modes share it; only the cap is lowFlash's.
  const alpha = clamp(size) * (1 - progress) ** 1.3 * 0.7 * Math.max(0, intensity) * smoothstep(0, 0.05, age);
  return lowFlash ? Math.min(LOW_FLASH_RING_ALPHA, alpha) : alpha;
}

/** How one hit's ring differs from the next: no two ripples are the same ellipse. */
export interface HitVariation {
  /** Scale of the whole ring, start and ceiling alike. */
  diameter: number;
  /** Vertical radius relative to the horizontal one. */
  ratio: number;
  /** Stroke width scale. */
  thickness: number;
  /** Rotation of the ellipse in graph space (radians). */
  tilt: number;
  /** Direction the ring drifts in as it spreads, and how far (as a share of its radii). */
  driftAngle: number;
  drift: number;
}

/** A hit's variation depends only on the render seed and the hit's time, so seeking never changes a ring. */
export function hitVariation(seed: string, hit: { time: number }): HitVariation {
  const random = createRandom(deriveSeed(seed, `hit-ring:${hit.time.toFixed(4)}`));
  return {
    diameter: randomBetween(random, 0.82, 1.18),
    ratio: randomBetween(random, 0.78, 1.22),
    thickness: randomBetween(random, 0.7, 1.4),
    tilt: randomBetween(random, -0.3, 0.3),
    driftAngle: randomBetween(random, 0, Math.PI * 2),
    drift: randomBetween(random, 0.05, 0.14),
  };
}

/**
 * Ring radius at `age` as a multiple of the graph reserve: eases out from
 * RING_START toward a ceiling that grows with the hit's size (intro taps stay
 * small ripples, drop kicks reach wide) but never past `fit`, the largest
 * multiple that still lies inside the graph clip under the frame's camera.
 * The ring therefore fades out inside the reserve instead of growing into the
 * clip and ending as flat chords at its edges.
 */
export function hitRingReach(age: number, size: number, fit: number): number {
  const progress = clamp(age / HIT_LIFETIME);
  const eased = 1 - (1 - progress) ** 2.4;
  const ceiling = Math.min(0.55 + 0.75 * clamp(size), Math.max(0, fit));
  const start = Math.min(RING_START, ceiling);
  return start + eased * (ceiling - start);
}

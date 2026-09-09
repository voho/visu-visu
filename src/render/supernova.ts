import { clamp, deriveSeed, smoothstep } from "../math/random.js";
import type { AnalysisFrame, AudioAnalysis } from "../types.js";
import { deriveMusicMotion } from "./music-motion.js";

export interface SupernovaEvent {
  id: number;
  age: number;
  /** Bass bursts have more strength and a larger radius than high-band flares. */
  strength: number;
  /** Seeded accent hue in degrees, and flare rotation in radians. */
  hue: number;
  angle: number;
  /** Origin offsets expressed in units of the hero's radius. */
  originX: number;
  originY: number;
  /** Expanding radius expressed in units of the hero's radius. */
  expansion: number;
  /** Local light envelopes in 0..1; renderers multiply them by strength. */
  flash: number;
  flare: number;
  afterglow: number;
  kind: "nova" | "flare";
}

interface PlannedEvent {
  id: number;
  time: number;
  strength: number;
  kind: SupernovaEvent["kind"];
}

const NOVA_LIFETIME = 2.4;
const FLARE_LIFETIME = 1.1;
const NOVA_REFRACTORY = 0.75;
const FLARE_REFRACTORY = 0.3;
const plans = new WeakMap<AudioAnalysis, readonly PlannedEvent[]>();

function positive(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function highFlux(frame: AnalysisFrame, previous: AnalysisFrame): number {
  const start = Math.floor(frame.spectrum.length * 0.68);
  let flux = 0;
  for (let index = start; index < frame.spectrum.length; index += 1) {
    flux += positive(positive(frame.spectrum[index] ?? 0) - positive(previous.spectrum[index] ?? 0));
  }
  return Math.max(
    positive(frame.treble - previous.treble),
    flux / Math.max(1, frame.spectrum.length - start),
  );
}

function lifetime(event: PlannedEvent): number {
  return event.kind === "nova" ? NOVA_LIFETIME : FLARE_LIFETIME;
}

function planFor(analysis: AudioAnalysis): readonly PlannedEvent[] {
  const cached = plans.get(analysis);
  if (cached) return cached;
  const events: PlannedEvent[] = [];
  const fps = Number.isFinite(analysis.fps) && analysis.fps > 0 ? analysis.fps : 30;
  let lastNova = -Infinity;
  let lastFlare = -Infinity;
  let active: PlannedEvent[] = [];
  // Compare only against the preceding sample. A future FFT must never move an
  // event earlier, and a sustained first sample is not an onset.
  for (let index = 1; index < analysis.frames.length; index += 1) {
    const frame = analysis.frames[index]!;
    const previous = analysis.frames[index - 1]!;
    const bassFlux = positive(frame.bass - previous.bass) * fps / 30;
    const trebleFlux = highFlux(frame, previous) * fps / 30;
    if (Math.max(bassFlux, trebleFlux) < 0.004) continue;
    const time = index / fps;
    const motion = deriveMusicMotion(analysis, time);
    const bassShare = bassFlux * 3.5 / Math.max(0.0001, bassFlux * 3.5 + trebleFlux * 0.4);
    const kick = bassFlux >= 0.004 && motion.bassPulse >= 0.2 && bassShare >= 0.3;
    let kind: PlannedEvent["kind"];
    let strength: number;
    if (kick && time - lastNova >= NOVA_REFRACTORY) {
      kind = "nova";
      strength = clamp(0.62 + motion.bassPulse * 0.34 + motion.bassEnergy * 0.04);
    } else if (time - lastFlare >= FLARE_REFRACTORY && (kick || motion.treblePulse >= 0.2)) {
      kind = "flare";
      strength = kick ? 0.45 + motion.bassPulse * 0.14 : 0.18 + motion.treblePulse * 0.28;
    } else {
      continue;
    }
    active = active.filter((event) => time - event.time < lifetime(event));
    // Reserve a fourth voice for the low end. Budget at scheduling time instead
    // of truncating live arrays: an existing afterglow never suddenly vanishes.
    if (active.length >= (kind === "nova" ? 4 : 3)) continue;
    const event = { id: index, time, strength, kind };
    events.push(event);
    active.push(event);
    if (kind === "nova") lastNova = time;
    else lastFlare = time;
  }
  plans.set(analysis, events);
  return events;
}

function namedRandom(seed: string, id: number, name: string): number {
  return deriveSeed(seed, `supernova:${id}:${name}`) / 4_294_967_296;
}

function lightEnvelope(age: number, attack: number, decay: number): number {
  return smoothstep(0, attack, age) * Math.exp(-Math.max(0, age - attack) / decay);
}

/**
 * Absolute-time, continuous burst geometry and local light envelopes. The audio
 * event plan is built once per analysis; arbitrary seek/render order is safe.
 * lowFlash reduces and softens light only, preserving every event and its motion.
 */
export function novaEventsAt(
  analysis: AudioAnalysis,
  time: number,
  seed: string,
  lowFlash: boolean,
): SupernovaEvent[] {
  if (!Number.isFinite(time) || time < 0) return [];
  const events = planFor(analysis);
  // Only a few seconds of events are live, even for a multi-hour song.
  let left = 0;
  let right = events.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (events[middle]!.time <= time - NOVA_LIFETIME) left = middle + 1;
    else right = middle;
  }
  const result: SupernovaEvent[] = [];
  for (let index = left; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.time > time) break;
    const age = time - event.time;
    const duration = lifetime(event);
    if (age >= duration) continue;
    const nova = event.kind === "nova";
    const endFade = 1 - smoothstep(duration * 0.7, duration, age);
    const flashAttack = lowFlash ? 0.075 : nova ? 0.045 : 0.03;
    const flashDecay = lowFlash ? 0.22 : nova ? 0.16 : 0.12;
    const flareAttack = lowFlash ? 0.09 : nova ? 0.055 : 0.035;
    const flareDecay = lowFlash ? 0.65 : nova ? 0.52 : 0.4;
    const glowAttack = nova ? 0.13 : 0.08;
    result.push({
      id: event.id,
      age,
      strength: event.strength,
      kind: event.kind,
      hue: namedRandom(seed, event.id, "hue") * 360,
      angle: namedRandom(seed, event.id, "angle") * Math.PI * 2,
      originX: (namedRandom(seed, event.id, "origin-x") - 0.5) * 0.4,
      originY: (namedRandom(seed, event.id, "origin-y") - 0.5) * 0.4,
      expansion: (nova ? 2.55 : 1.05) * (0.72 + event.strength * 0.28) * (age / duration) ** 0.65,
      flash: lightEnvelope(age, flashAttack, flashDecay) * endFade * (lowFlash ? 0.28 : 1),
      flare: lightEnvelope(age, flareAttack, flareDecay) * endFade * (lowFlash ? 0.48 : 1),
      afterglow: lightEnvelope(age, glowAttack, nova ? 1.4 : 0.55) * endFade * (lowFlash ? 0.62 : 1),
    });
  }
  return result;
}

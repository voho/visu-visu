import type { SKRSContext2D } from "@napi-rs/canvas";
import { clamp, createRandom, deriveSeed, randomBetween } from "../math/random.js";
import { AUDIO_FIELD_BANDS } from "./audio-field.js";
import { creditLockupEllipse, type SafeLayout } from "./layout.js";
import type { Rgb } from "./lighting.js";
import { rgbCss } from "./palette.js";
import type { SceneDynamics } from "./scene-dynamics.js";

/**
 * A soft disc of the cover's own light floating in the room. Two parallax
 * planes: the far one sits under the sculpture's bloom, the near one in front
 * of everything but the credits.
 */
export interface Ember {
  /** Rest position as fractions of the frame. */
  x: number;
  y: number;
  /** 0 far .. 1 near; sets size, rise speed and parallax. */
  depth: number;
  near: boolean;
  /** Fraction of the frame's short side. */
  radius: number;
  /** 0..1 position in the ember colour list. */
  tint: number;
  /** Spectrum band whose track-relative level pulses this ember. */
  band: number;
  phase: number;
  /** The smallest embers also flash with the raw treble pulse. */
  sparkle: boolean;
}

export interface EmberDrive {
  time: number;
  dynamics: SceneDynamics;
  section: number;
  kick: number;
  treblePulse: number;
  /** Per-band levels on the track's own scale (normalizedBandsAt). */
  bands: ArrayLike<number>;
  /** Graph-camera pan and cover Ken Burns offset as fractions of the frame; the planes follow them at different rates. */
  pan: { x: number; y: number };
  cover: { x: number; y: number };
  layout: SafeLayout;
  width: number;
  height: number;
  /** Overall light: intensity x presence. */
  gain: number;
}

export interface EmberPose {
  x: number;
  y: number;
  radius: number;
  alpha: number;
}

/** Alpha ceiling of one disc; above it near embers over a bright cover blow out to white. */
export const EMBER_MAX_ALPHA = 0.6;
/** Near embers are larger than their depth alone says: they are the ones close to the lens. */
const NEAR_SCALE = 1.3;
/** The far plane keeps 12 of the plan's 28 embers; the rest float in front. */
const FAR_SHARE = 12 / 28;
const SPARKLE_SHARE = 8 / 28;
/** Vertical wrap span (fractions of the frame): a disc leaves the top before it re-enters at the bottom. */
const WRAP_SPAN = 1.3;
const WRAP_OFFSET = 0.15;

const unit = (value: number): number => Number.isFinite(value) ? clamp(value) : 0;
const wrap = (value: number): number => value - Math.floor(value);

/** Seeded plan; `count` embers with a fixed far/near split so both planes exist at any count >= 2. */
export function createEmberPlan(seed: string, count: number): Ember[] {
  const total = Math.max(0, Math.round(Number.isFinite(count) ? count : 0));
  const random = createRandom(deriveSeed(seed, "ember-bokeh"));
  const far = Math.round(total * FAR_SHARE);
  const embers = Array.from({ length: total }, (_, index): Ember => {
    const near = index >= far;
    const depth = near ? randomBetween(random, 0.55, 1) : randomBetween(random, 0, 0.55);
    return {
      x: randomBetween(random, -0.05, 1.05),
      y: random(),
      depth,
      near,
      radius: 0.005 + depth * 0.022,
      tint: random(),
      band: Math.floor(random() * AUDIO_FIELD_BANDS),
      phase: randomBetween(random, 0, Math.PI * 2),
      sparkle: false,
    };
  });
  const smallest = [...embers].sort((left, right) => left.radius - right.radius).slice(0, Math.round(total * SPARKLE_SHARE));
  for (const ember of smallest) ember.sparkle = true;
  return embers;
}

/**
 * Where and how bright one ember is at absolute time. The rise integrates the
 * body clock, so a loud passage speeds every ember up without a jump when the
 * energy steps; the wrap is analytic, so seeking never changes a position.
 */
export function emberPoseAt(ember: Ember, drive: EmberDrive): EmberPose {
  const time = Number.isFinite(drive.time) ? drive.time : 0;
  const bodyClock = Number.isFinite(drive.dynamics.body.clock) ? drive.dynamics.body.clock : 0;
  const driftClock = Number.isFinite(drive.dynamics.drift.clock) ? drive.dynamics.drift.clock : 0;
  const depth = unit(ember.depth);
  const rise = (0.010 * time + 0.020 * bodyClock) * (0.5 + depth);
  const panRate = ember.near ? 1.7 : 0.5;
  const coverRate = ember.near ? 1.4 : 0.6;
  const nx = ember.x + Math.sin(driftClock * 0.5 + ember.phase) * 0.03
    + drive.pan.x * panRate + drive.cover.x * coverRate;
  const ny = wrap((ember.y - rise) / WRAP_SPAN) * WRAP_SPAN - WRAP_OFFSET
    + drive.pan.y * panRate + drive.cover.y * coverRate;
  // Ember assignments span the complete spectrum even when the readout has
  // more bins than the material field. Average the assigned frequency slice.
  const start = ember.band / AUDIO_FIELD_BANDS * drive.bands.length;
  const end = (ember.band + 1) / AUDIO_FIELD_BANDS * drive.bands.length;
  let energy = 0;
  for (let band = Math.floor(start); band < Math.ceil(end); band++) {
    const overlap = Math.max(0, Math.min(end, band + 1) - Math.max(start, band));
    energy += unit(drive.bands[band] ?? 0) * overlap;
  }
  const level = energy / Math.max(1e-9, end - start);
  let alpha = (0.10 + 0.55 * level) * (0.6 + 0.4 * unit(drive.section))
    * (0.7 + 0.3 * Math.sin(time * 0.9 + ember.phase));
  if (ember.sparkle) alpha += 0.2 * unit(drive.treblePulse);
  // The lockup must stay the brightest, cleanest thing in the frame: embers
  // dim inside the same ellipse the cover is shaded under (frame space, unpanned).
  const credit = creditLockupEllipse(drive.layout, drive.width, drive.height);
  const creditDistance = ((nx - credit.x) / credit.rx) ** 2 + ((ny - credit.y) / credit.ry) ** 2;
  alpha *= 1 - 0.85 * Math.exp(-Math.pow(creditDistance, 1.5));
  const kickSwell = ember.near ? NEAR_SCALE * (1 + unit(drive.kick) * 0.25) : 1;
  return {
    x: nx * drive.width,
    y: ny * drive.height,
    radius: ember.radius * Math.min(drive.width, drive.height) * kickSwell,
    alpha: Math.min(EMBER_MAX_ALPHA, alpha) * Math.max(0, Number.isFinite(drive.gain) ? drive.gain : 0),
  };
}

/**
 * Paints one plane as radial-gradient discs: solid colour to 55% of the
 * radius, then a soft falloff. Both planes screen: over a mid-tone cover an
 * additive disc overshoots to white and loses the spark's colour.
 */
export function drawEmbers(
  context: SKRSContext2D,
  plan: readonly Ember[],
  colors: readonly Rgb[],
  drive: EmberDrive,
  plane: "far" | "near",
): void {
  if (colors.length === 0) return;
  context.save();
  context.globalCompositeOperation = "screen";
  for (const ember of plan) {
    if (ember.near !== (plane === "near")) continue;
    const pose = emberPoseAt(ember, drive);
    if (pose.alpha < 0.004 || pose.radius <= 0) continue;
    if (pose.x < -pose.radius || pose.x > drive.width + pose.radius
      || pose.y < -pose.radius || pose.y > drive.height + pose.radius) continue;
    const color = colors[Math.min(colors.length - 1, Math.floor(unit(ember.tint) * colors.length))]!;
    const disc = context.createRadialGradient(pose.x, pose.y, 0, pose.x, pose.y, pose.radius);
    disc.addColorStop(0, rgbCss(color, pose.alpha));
    disc.addColorStop(0.55, rgbCss(color, pose.alpha));
    disc.addColorStop(1, rgbCss(color, 0));
    context.fillStyle = disc;
    context.fillRect(pose.x - pose.radius, pose.y - pose.radius, pose.radius * 2, pose.radius * 2);
  }
  context.restore();
}

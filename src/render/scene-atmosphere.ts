import type { SKRSContext2D } from "@napi-rs/canvas";
import { clamp, createRandom, deriveSeed, smoothstep } from "../math/random.js";
import { safeGraphRadius, type SafeLayout } from "./layout.js";
import type { LightingState, Rgb } from "./lighting.js";
import type { SceneDynamics } from "./scene-dynamics.js";

const TAU = Math.PI * 2;
type ParticleTier = "drift" | "body" | "detail" | "spark";

interface Cloud {
  x: number;
  y: number;
  phase: number;
  radius: number;
  stretch: number;
  hue: number;
}

export interface AtmosphereParticle {
  tier: ParticleTier;
  x: number;
  y: number;
  phase: number;
  speed: number;
  depth: number;
  radius: number;
}

export interface AtmosphereParticlePose {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  /** Near particles grow and defocus; the invisible end of each flight resets. */
  depth: number;
  softness: number;
}

const positive = (value: number): number => Number.isFinite(value) ? Math.max(0, value) : 0;
const unit = (value: number): number => Number.isFinite(value) ? clamp(value) : 0;
const wrap = (value: number): number => value - Math.floor(value);

/** Analytic particle motion: every depth tier follows its own integrated clock. */
export function atmosphereParticleAt(
  particle: AtmosphereParticle,
  dynamics: SceneDynamics,
  width: number,
  height: number,
  creditBottom: number,
  clockOffset = 0,
): AtmosphereParticlePose {
  const tier = dynamics[particle.tier];
  const energy = unit(tier.energy);
  const clock = positive(tier.clock) + clockOffset;
  const slow = particle.tier === "drift";
  const body = particle.tier === "body";
  const detail = particle.tier === "detail";
  const travel = slow ? 0.17 : body ? 0.105 : detail ? 0.054 : 0.03;
  const phase = particle.phase + clock * particle.speed * 0.72;
  // Frequency tiers have very different clock speeds. These rates keep their
  // approach slow while letting upper bands trace finer, faster lateral swirls.
  const depthRate = slow ? 0.035 : body ? 0.016 : detail ? 0.0055 : 0.0016;
  const depth = wrap(particle.phase / TAU + clock * particle.speed * depthRate);
  const perspective = 0.42 + depth ** 1.75 * 1.3;
  const flightFade = smoothstep(0, 0.12, depth) * (1 - smoothstep(0.8, 1, depth));
  const areaHeight = Math.max(0, height - creditBottom);
  const sway = travel * (0.72 + energy * 0.55) * particle.depth;
  const x = width * (0.5 + (particle.x - 0.5) * perspective
    + (Math.sin(phase) + Math.sin(phase * 0.37 + particle.phase) * 0.23) * sway);
  const y = creditBottom + areaHeight * (0.52 + (particle.y - 0.52) * perspective
    + Math.sin(phase * 0.71 + particle.phase) * sway * 0.72);
  const brightness = slow ? 0.13 : body ? 0.19 : detail ? 0.23 : 0.27;
  const edge = smoothstep(creditBottom, creditBottom + areaHeight * 0.1, y)
    * (1 - smoothstep(height * 0.9, height, y))
    * smoothstep(-width * 0.05, width * 0.05, x)
    * (1 - smoothstep(width * 0.95, width * 1.05, x));
  return {
    x, y, depth,
    softness: smoothstep(0.5, 0.94, depth) * (slow ? 1 : body ? 0.8 : 0.45),
    radius: Math.max(0.32, Math.min(width, height) * particle.radius * particle.depth
      * (0.5 + perspective * 0.8) * (1 + energy * (slow ? 0.7 : body ? 0.4 : 0.18))),
    alpha: edge * flightFade * brightness * (0.45 + energy * 0.55) * (0.58 + particle.depth * 0.25),
  };
}

function color(rgb: Rgb, alpha: number): string {
  return `rgba(${Math.round(unit(rgb[0]) * 255)},${Math.round(unit(rgb[1]) * 255)},${Math.round(unit(rgb[2]) * 255)},${unit(alpha)})`;
}

/**
 * A layered atmosphere between the cover and the live sculpture. The plans are
 * fixed at construction; music only changes absolute clock poses and bounded
 * envelopes. No particles, light trails or cloud opacity accumulate per frame.
 */
export class SceneAtmosphere {
  private readonly clouds: readonly Cloud[];
  private readonly particles: readonly AtmosphereParticle[];
  private readonly flarePhase: number;
  private readonly radius: number;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly layout: SafeLayout,
    seed: string,
    private readonly lowFlash = false,
  ) {
    if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error("Atmosphere dimensions must be finite and positive");
    }
    const random = createRandom(deriveSeed(seed, "scene-atmosphere"));
    this.radius = Math.max(1, safeGraphRadius(layout));
    this.flarePhase = random() * TAU;
    this.clouds = Array.from({ length: 10 }, () => ({
      x: 0.12 + random() * 0.76,
      y: 0.18 + random() * 0.65,
      phase: random() * TAU,
      radius: 0.10 + random() * 0.12,
      stretch: 0.43 + random() * 0.3,
      hue: random(),
    }));
    const particles: AtmosphereParticle[] = [];
    for (const [tier, count, size, speed] of [
      ["drift", 28, 0.0025, 0.55],
      ["body", 36, 0.0017, 0.8],
      ["detail", 44, 0.00105, 1.4],
      ["spark", 52, 0.00065, 2.2],
    ] as const) {
      for (let index = 0; index < count; index += 1) {
        particles.push({
          tier, x: random(), y: 0.05 + random() * 0.9,
          phase: random() * TAU, speed: speed * (0.65 + random() * 0.7),
          depth: 0.55 + random() * 0.95, radius: size * (0.7 + random() * 0.65),
        });
      }
    }
    this.particles = particles;
  }

  draw(context: SKRSContext2D, dynamics: SceneDynamics, lights: LightingState): void {
    const cloud = unit(dynamics.cloud.energy);
    const drift = unit(dynamics.drift.energy);
    const body = unit(dynamics.body.energy);
    const impact = unit(dynamics.impact.energy);
    const cloudClock = positive(dynamics.cloud.clock);
    const driftClock = positive(dynamics.drift.clock);
    const bodyClock = positive(dynamics.body.clock);
    const impactClock = positive(dynamics.impact.clock);
    const key = lights.lights[0].color;
    const fill = lights.lights[1].color;
    const rim = lights.lights[2].color;
    context.save();
    // Protection is in final canvas space even if the caller has a camera pose.
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.beginPath();
    context.rect(0, this.layout.graphTop, this.width, this.height - this.layout.graphTop);
    context.clip();
    context.filter = "none";
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";

    // A soft contact shadow grounds the floating folds without an opaque disc.
    context.save();
    context.translate(this.layout.centerX + Math.sin(bodyClock * 0.13) * this.radius * 0.06,
      this.layout.horizon + this.radius * (0.64 + body * 0.06));
    context.scale(1, 0.17);
    const shadowRadius = this.radius * (0.8 + body * 0.17);
    const shadow = context.createRadialGradient(0, 0, 0, 0, 0, shadowRadius);
    const shadowTint: Rgb = [key[0] * 0.012, key[1] * 0.012, key[2] * 0.012];
    shadow.addColorStop(0, color(shadowTint, 0.07 + body * 0.075));
    shadow.addColorStop(0.4, color(shadowTint, 0.038 + body * 0.03));
    shadow.addColorStop(1, color(shadowTint, 0));
    context.fillStyle = shadow;
    context.fillRect(-shadowRadius, -shadowRadius, shadowRadius * 2, shadowRadius * 2);
    context.restore();

    context.globalCompositeOperation = "screen";
    for (const plan of this.clouds) {
      const phase = plan.phase + cloudClock * 0.32;
      const curl = driftClock * 0.5 + plan.phase;
      const x = this.width * (plan.x + Math.sin(phase) * (0.052 + drift * 0.028)
        + Math.sin(curl) * 0.018);
      const y = this.layout.graphTop + (this.height - this.layout.graphTop)
        * (plan.y + Math.cos(phase * 0.71) * 0.065);
      const radius = Math.min(this.width, this.height) * plan.radius * (0.9 + cloud * 0.3);
      const alpha = 0.014 + cloud * 0.034 + drift * 0.012;
      const tintPhase = 0.5 + Math.sin(curl * 0.38 + plan.hue * TAU) * 0.5;
      const tint: Rgb = [
        key[0] * (1 - tintPhase) + fill[0] * tintPhase,
        key[1] * (1 - tintPhase) + fill[1] * tintPhase,
        key[2] * (1 - tintPhase) + fill[2] * tintPhase,
      ];
      context.save();
      context.translate(x, y);
      context.rotate(phase * 0.19 + Math.sin(curl * 0.43) * 0.65);
      context.scale(1.85, plan.stretch * (0.85 + Math.sin(phase * 0.63) * 0.15));
      const fog = context.createRadialGradient(0, 0, 0, 0, 0, radius);
      fog.addColorStop(0, color(tint, alpha));
      fog.addColorStop(0.37, color(tint, alpha * 0.52));
      fog.addColorStop(1, color(tint, 0));
      context.fillStyle = fog;
      context.fillRect(-radius, -radius, radius * 2, radius * 2);
      // Offset wisps shear past the broad lobe instead of rotating a round disc.
      context.translate(radius * Math.sin(curl) * 0.48, radius * 0.36);
      context.rotate(Math.sin(phase) * 0.5);
      context.scale(0.82, 0.55);
      context.globalAlpha = 0.48;
      context.fillRect(-radius, -radius, radius * 2, radius * 2);
      context.restore();
    }

    // The clouds keep their long envelope; fast light accents alone are softened.
    const flashScale = this.lowFlash ? 0.3 : 1;
    if (impact > 0.004) {
      for (let index = 0; index < 3; index += 1) {
        const phase = wrap(impactClock * 0.2 + index / 3);
        const ringRadius = this.radius * (0.23 + phase * 1.55);
        const ringAlpha = impact * Math.sin(phase * Math.PI) ** 2 * 0.10 * flashScale;
        context.save();
        context.translate(this.layout.centerX, this.layout.horizon);
        context.rotate(bodyClock * 0.095 + this.flarePhase + index * 0.3);
        context.scale(1.22, 0.62 + Math.sin(cloudClock * 0.2) * 0.08);
        const ringTint = index === 0 ? key : index === 1 ? fill : rim;
        context.strokeStyle = color(ringTint, ringAlpha * 0.14);
        context.lineWidth = Math.max(2, this.radius * (0.026 + phase * 0.03));
        context.beginPath();
        context.arc(0, 0, ringRadius, 0, TAU);
        context.stroke();
        context.strokeStyle = color(ringTint, ringAlpha);
        context.lineWidth = Math.max(0.5, this.radius * 0.0032);
        context.beginPath();
        context.arc(0, 0, ringRadius, 0, TAU);
        context.stroke();
        context.restore();
      }
      const position = lights.lights[0].position;
      const x = this.layout.centerX + position[0] * this.radius * 0.85;
      const y = this.layout.horizon - position[1] * this.radius * 0.65;
      const flareRadius = this.radius * (0.14 + impact * 0.20);
      const flare = context.createRadialGradient(x, y, 0, x, y, flareRadius);
      flare.addColorStop(0, color(key, impact * 0.14 * flashScale));
      flare.addColorStop(0.14, color(key, impact * 0.061 * flashScale));
      flare.addColorStop(1, color(key, 0));
      context.fillStyle = flare;
      context.fillRect(x - flareRadius, y - flareRadius, flareRadius * 2, flareRadius * 2);
      context.save();
      context.translate(x, y);
      context.rotate(this.flarePhase + bodyClock * 0.16 + Math.sin(cloudClock * 0.3) * 0.25);
      for (let axis = 0; axis < 3; axis += 1) {
        const length = this.radius * (axis === 0 ? 0.7 : axis === 1 ? 0.25 : 0.42) * (0.65 + impact * 0.35);
        const streak = context.createLinearGradient(-length, 0, length, 0);
        streak.addColorStop(0, color(key, 0));
        streak.addColorStop(0.5, color(key, impact * 0.12 * flashScale));
        streak.addColorStop(1, color(key, 0));
        context.strokeStyle = streak;
        context.globalAlpha = 0.28;
        context.lineWidth = Math.max(2, this.radius * 0.019);
        context.beginPath();
        context.moveTo(-length, 0); context.lineTo(length, 0); context.stroke();
        context.globalAlpha = 1;
        context.lineWidth = Math.max(0.55, this.radius * 0.0028);
        context.beginPath();
        context.moveTo(-length, 0); context.lineTo(length, 0); context.stroke();
        context.rotate(axis === 0 ? Math.PI / 2 : Math.PI / 4);
      }
      context.restore();
    }

    this.drawParticles(context, dynamics, lights, false);
    context.restore();
  }

  /** Near dust and soft bokeh pass in front of the sculpture, below the credits. */
  drawForeground(context: SKRSContext2D, dynamics: SceneDynamics, lights: LightingState): void {
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.beginPath();
    context.rect(0, this.layout.graphTop, this.width, this.height - this.layout.graphTop);
    context.clip();
    context.filter = "none";
    context.globalAlpha = 1;
    context.globalCompositeOperation = "screen";
    this.drawParticles(context, dynamics, lights, true);
    context.restore();
  }

  private drawParticles(context: SKRSContext2D, dynamics: SceneDynamics, lights: LightingState, foreground: boolean): void {
    const key = lights.lights[0].color;
    const fill = lights.lights[1].color;
    const rim = lights.lights[2].color;
    for (const particle of this.particles) {
      const pose = atmosphereParticleAt(particle, dynamics, this.width, this.height, this.layout.graphTop);
      // Complementary depth weights make dust gently cross the surface plane.
      // The close flight is already defocused and fading, so it remains subtle.
      const frontWeight = smoothstep(0.58, 0.78, pose.depth);
      pose.alpha *= foreground ? frontWeight : 1 - frontWeight;
      if (pose.alpha <= 0.00001 || pose.x < -20 || pose.x > this.width + 20) continue;
      const tint = particle.tier === "drift" ? fill : particle.tier === "body" ? key : rim;
      const soft = particle.tier === "drift" || particle.tier === "body" || pose.softness > 0.12;
      if (soft) {
        const haloRadius = pose.radius * (2.6 + pose.softness * 2.8);
        const halo = context.createRadialGradient(pose.x, pose.y, 0, pose.x, pose.y, haloRadius);
        halo.addColorStop(0, color(tint, pose.alpha * (0.52 + pose.softness * 0.2)));
        halo.addColorStop(0.3, color(tint, pose.alpha * 0.23));
        halo.addColorStop(1, color(tint, 0));
        context.fillStyle = halo;
        context.fillRect(pose.x - haloRadius, pose.y - haloRadius, haloRadius * 2, haloRadius * 2);
      }
      if (particle.tier !== "drift") {
        const trailClock = particle.tier === "body" ? 0.22 : particle.tier === "detail" ? 0.32 : 0.42;
        const previous = atmosphereParticleAt(particle, dynamics, this.width, this.height, this.layout.graphTop, -trailClock);
        const middle = atmosphereParticleAt(particle, dynamics, this.width, this.height, this.layout.graphTop, -trailClock * 0.5);
        // A trail must never bridge the invisible reset from foreground to far.
        if (previous.depth <= pose.depth && previous.alpha > 0.001) {
          context.strokeStyle = color(tint, Math.min(previous.alpha, pose.alpha) * 0.52);
          context.lineWidth = Math.max(0.4, pose.radius * (0.6 + pose.softness));
          context.beginPath(); context.moveTo(previous.x, previous.y);
          context.quadraticCurveTo(middle.x, middle.y, pose.x, pose.y); context.stroke();
        }
      }
      context.fillStyle = color(tint, pose.alpha * (1 - pose.softness * 0.76));
      context.beginPath(); context.arc(pose.x, pose.y, pose.radius, 0, TAU); context.fill();
    }
  }
}

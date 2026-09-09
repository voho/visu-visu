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
  const travel = slow ? 0.13 : body ? 0.082 : detail ? 0.044 : 0.025;
  const phase = particle.phase + clock * particle.speed;
  const areaHeight = Math.max(0, height - creditBottom);
  const x = width * (particle.x + Math.sin(phase) * travel * (0.72 + energy * 0.55) * particle.depth);
  const y = creditBottom + areaHeight * (particle.y
    + Math.sin(phase * 0.71 + particle.phase) * travel * 0.8 * particle.depth);
  const brightness = slow ? 0.095 : body ? 0.16 : detail ? 0.19 : 0.23;
  const edge = smoothstep(creditBottom, creditBottom + areaHeight * 0.1, y)
    * (1 - smoothstep(height * 0.9, height, y));
  return {
    x, y,
    radius: Math.max(0.32, Math.min(width, height) * particle.radius * particle.depth * (1 + energy * (slow ? 0.7 : body ? 0.4 : 0.18))),
    alpha: edge * brightness * (0.45 + energy * 0.55) * (0.58 + particle.depth * 0.25),
  };
}

function color(rgb: Rgb, alpha: number): string {
  return `rgba(${Math.round(unit(rgb[0]) * 255)},${Math.round(unit(rgb[1]) * 255)},${Math.round(unit(rgb[2]) * 255)},${unit(alpha)})`;
}

/**
 * A sparse atmosphere between the cover and the live sculpture. The plans are
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
    this.clouds = Array.from({ length: 8 }, () => ({
      x: 0.12 + random() * 0.76,
      y: 0.18 + random() * 0.65,
      phase: random() * TAU,
      radius: 0.10 + random() * 0.12,
      stretch: 0.43 + random() * 0.3,
      hue: random(),
    }));
    const particles: AtmosphereParticle[] = [];
    for (const [tier, count, size, speed] of [
      ["drift", 24, 0.0022, 0.55],
      ["body", 28, 0.0015, 0.8],
      ["detail", 32, 0.00095, 1.4],
      ["spark", 40, 0.0006, 2.2],
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
      const phase = plan.phase + cloudClock * 0.18;
      const x = this.width * (plan.x + Math.sin(phase) * (0.024 + drift * 0.016));
      const y = this.layout.graphTop + (this.height - this.layout.graphTop)
        * (plan.y + Math.cos(phase * 0.71) * 0.038);
      const radius = Math.min(this.width, this.height) * plan.radius * (0.86 + cloud * 0.24);
      const alpha = 0.012 + cloud * 0.025 + drift * 0.008;
      const tint: Rgb = [
        key[0] * (1 - plan.hue) + fill[0] * plan.hue,
        key[1] * (1 - plan.hue) + fill[1] * plan.hue,
        key[2] * (1 - plan.hue) + fill[2] * plan.hue,
      ];
      context.save();
      context.translate(x, y);
      context.rotate(Math.sin(phase * 0.43) * 0.55 + plan.phase);
      context.scale(1.7, plan.stretch);
      const fog = context.createRadialGradient(0, 0, 0, 0, 0, radius);
      fog.addColorStop(0, color(tint, alpha));
      fog.addColorStop(0.37, color(tint, alpha * 0.52));
      fog.addColorStop(1, color(tint, 0));
      context.fillStyle = fog;
      context.fillRect(-radius, -radius, radius * 2, radius * 2);
      context.restore();
    }

    // The clouds keep their long envelope; fast light accents alone are softened.
    const flashScale = this.lowFlash ? 0.3 : 1;
    if (impact > 0.004) {
      for (let index = 0; index < 2; index += 1) {
        const phase = wrap(impactClock * 0.24 + index * 0.5);
        const ringRadius = this.radius * (0.28 + phase * 1.13);
        const ringAlpha = impact * Math.sin(phase * Math.PI) ** 2 * 0.075 * flashScale;
        context.save();
        context.translate(this.layout.centerX, this.layout.horizon);
        context.rotate(Math.sin(bodyClock * 0.12 + this.flarePhase) * 0.3);
        context.scale(1.2, 0.69);
        context.strokeStyle = color(index ? fill : key, ringAlpha);
        context.lineWidth = Math.max(0.5, this.radius * 0.0032);
        context.beginPath();
        context.arc(0, 0, ringRadius, 0, TAU);
        context.stroke();
        context.restore();
      }
      const position = lights.lights[0].position;
      const x = this.layout.centerX + position[0] * this.radius * 0.85;
      const y = this.layout.horizon - position[1] * this.radius * 0.65;
      const flareRadius = this.radius * (0.10 + impact * 0.12);
      const flare = context.createRadialGradient(x, y, 0, x, y, flareRadius);
      flare.addColorStop(0, color(key, impact * 0.095 * flashScale));
      flare.addColorStop(0.14, color(key, impact * 0.043 * flashScale));
      flare.addColorStop(1, color(key, 0));
      context.fillStyle = flare;
      context.fillRect(x - flareRadius, y - flareRadius, flareRadius * 2, flareRadius * 2);
      context.save();
      context.translate(x, y);
      context.rotate(this.flarePhase + bodyClock * 0.06);
      for (let axis = 0; axis < 2; axis += 1) {
        const length = this.radius * (axis ? 0.12 : 0.46) * (0.6 + impact * 0.4);
        const streak = context.createLinearGradient(-length, 0, length, 0);
        streak.addColorStop(0, color(key, 0));
        streak.addColorStop(0.5, color(key, impact * 0.095 * flashScale));
        streak.addColorStop(1, color(key, 0));
        context.strokeStyle = streak;
        context.lineWidth = Math.max(0.55, this.radius * 0.0028);
        context.beginPath();
        context.moveTo(-length, 0); context.lineTo(length, 0); context.stroke();
        context.rotate(Math.PI / 2);
      }
      context.restore();
    }

    for (const particle of this.particles) {
      const pose = atmosphereParticleAt(particle, dynamics, this.width, this.height, this.layout.graphTop);
      if (pose.alpha <= 0 || pose.x < -20 || pose.x > this.width + 20) continue;
      const tint = particle.tier === "drift" ? fill : particle.tier === "body" ? key : rim;
      if (particle.tier === "drift") {
        const halo = context.createRadialGradient(pose.x, pose.y, 0, pose.x, pose.y, pose.radius * 3.5);
        halo.addColorStop(0, color(tint, pose.alpha * 0.52));
        halo.addColorStop(1, color(tint, 0));
        context.fillStyle = halo;
        context.fillRect(pose.x - pose.radius * 3.5, pose.y - pose.radius * 3.5, pose.radius * 7, pose.radius * 7);
      } else if (particle.tier === "detail" || particle.tier === "spark") {
        const previous = atmosphereParticleAt(particle, dynamics, this.width, this.height, this.layout.graphTop, -0.055);
        context.strokeStyle = color(tint, pose.alpha * 0.45);
        context.lineWidth = Math.max(0.4, pose.radius * 0.65);
        context.beginPath(); context.moveTo(previous.x, previous.y); context.lineTo(pose.x, pose.y); context.stroke();
      }
      context.fillStyle = color(tint, pose.alpha);
      context.beginPath(); context.arc(pose.x, pose.y, pose.radius, 0, TAU); context.fill();
    }
    context.restore();
  }
}

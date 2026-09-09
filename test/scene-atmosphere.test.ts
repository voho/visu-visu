import { describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { SceneAtmosphere, atmosphereParticleAt, type AtmosphereParticle } from "../src/render/scene-atmosphere.js";
import { createSafeLayout } from "../src/render/layout.js";
import { lightingAt } from "../src/render/lighting.js";
import type { SceneDynamics } from "../src/render/scene-dynamics.js";

function dynamics(energy = 0.4, clock = 10): SceneDynamics {
  return {
    drift: { energy, clock: clock * 0.1 },
    cloud: { energy, clock: clock * 0.23 },
    body: { energy, clock: clock * 0.5 },
    detail: { energy, clock: clock * 1.1 },
    spark: { energy, clock: clock * 2.3 },
    impact: { energy, clock: clock * 0.7 },
  };
}
const lights = lightingAt({
  slowTime: 5, fastTime: 20, bassPulse: 0.6, treblePulse: 0.2,
  bassEnergy: 0.75, midEnergy: 0.5, trebleEnergy: 0.4, attack: 0.6, sustain: 0.6,
}, 20, "atmosphere", 220);

function render(layer: SceneAtmosphere, width: number, height: number, state: SceneDynamics): Uint8ClampedArray {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "rgb(35,45,55)";
  context.fillRect(0, 0, width, height);
  layer.draw(context, state, lights);
  return context.getImageData(0, 0, width, height).data;
}

function difference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let total = 0;
  for (let index = 0; index < a.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) total += Math.abs(a[index + channel]! - b[index + channel]!);
  }
  return total / (a.length / 4 * 3);
}

describe("tiered music atmosphere", () => {
  test("protects credits, preserves cover detail, and restores the caller's canvas state", () => {
    for (const [width, height] of [[640, 360], [360, 640]] as const) {
      const layout = createSafeLayout(width, height);
      const layer = new SceneAtmosphere(width, height, layout, "layer");
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      context.fillStyle = "rgb(35,45,55)";
      context.fillRect(0, 0, width, height);
      context.globalAlpha = 0.42;
      context.filter = "blur(2px)";
      context.globalCompositeOperation = "source-over";
      context.translate(20, -50);
      const transform = context.getTransform();
      const alpha = context.globalAlpha;
      layer.draw(context, dynamics(1, 16), lights);
      expect(context.globalAlpha).toBe(alpha);
      expect(context.filter).toBe("blur(2px)");
      expect(context.globalCompositeOperation).toBe("source-over");
      expect(context.getTransform().e).toBe(transform.e);
      expect(context.getTransform().f).toBe(transform.f);
      const pixels = context.getImageData(0, 0, width, height).data;
      let creditChanges = 0;
      let totalChange = 0;
      let maxChange = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          for (let channel = 0; channel < 3; channel += 1) {
            const delta = Math.abs(pixels[(y * width + x) * 4 + channel]! - [35, 45, 55][channel]!);
            if (y + 1 <= layout.graphTop && delta > 0) creditChanges += 1;
            totalChange += delta;
            maxChange = Math.max(maxChange, delta);
          }
        }
      }
      expect(creditChanges).toBe(0);
      expect(maxChange).toBeGreaterThan(10);
      expect(maxChange).toBeLessThan(70);
      expect(totalChange / (width * height * 3)).toBeLessThan(3);
    }
  });

  test("repeated and reverse seeks reproduce the same clouds, pulses and particle positions", () => {
    const width = 320;
    const height = 180;
    const layout = createSafeLayout(width, height);
    const layer = new SceneAtmosphere(width, height, layout, "repeatable");
    const first = render(layer, width, height, dynamics(0.7, 18));
    render(layer, width, height, dynamics(1, 210));
    render(layer, width, height, dynamics(0.1, 3));
    expect(render(layer, width, height, dynamics(0.7, 18))).toEqual(first);
    expect(render(new SceneAtmosphere(width, height, layout, "repeatable"), width, height, dynamics(0.7, 18))).toEqual(first);
    expect(difference(first, render(new SceneAtmosphere(width, height, layout, "different"), width, height, dynamics(0.7, 18)))).toBeGreaterThan(0.08);
  });

  test("low-flash mode softens local impact accents while retaining slow atmosphere", () => {
    const width = 640;
    const height = 360;
    const layout = createSafeLayout(width, height);
    const normal = new SceneAtmosphere(width, height, layout, "flash");
    const reduced = new SceneAtmosphere(width, height, layout, "flash", true);
    const quiet = dynamics(0.5, 14);
    quiet.impact.energy = 0;
    const pulse = { ...quiet, impact: { energy: 1, clock: quiet.impact.clock } };
    const baseline = render(normal, width, height, quiet);
    expect(render(reduced, width, height, quiet)).toEqual(baseline);
    const strong = difference(baseline, render(normal, width, height, pulse));
    const soft = difference(baseline, render(reduced, width, height, pulse));
    expect(strong).toBeGreaterThan(0.003);
    expect(soft).toBeGreaterThan(0);
    expect(soft).toBeLessThan(strong * 0.45);
  });

  test("low-frequency particle response is broader and each tier follows its own clock", () => {
    const particle: AtmosphereParticle = { tier: "drift", x: 0.5, y: 0.5, phase: 0.8, speed: 1, depth: 1, radius: 0.001 };
    const quiet = dynamics(0, 0);
    const loud = dynamics(1, 0);
    const displacement = (tier: AtmosphereParticle["tier"]): number => {
      const a = atmosphereParticleAt({ ...particle, tier }, quiet, 1920, 1080, 345);
      const b = atmosphereParticleAt({ ...particle, tier }, loud, 1920, 1080, 345);
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    expect(displacement("drift")).toBeGreaterThan(displacement("spark") * 4);
    expect(displacement("body")).toBeGreaterThan(displacement("detail") * 1.5);
    const advanced = { ...loud, spark: { energy: 1, clock: 0.02 } };
    expect(atmosphereParticleAt(particle, advanced, 1920, 1080, 345)).toEqual(atmosphereParticleAt(particle, loud, 1920, 1080, 345));
    const fast = { ...particle, tier: "spark" as const };
    const before = atmosphereParticleAt(fast, loud, 1920, 1080, 345);
    const after = atmosphereParticleAt(fast, advanced, 1920, 1080, 345);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(0.1);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(2);
    expect(atmosphereParticleAt(particle, loud, 1920, 1080, 345).radius)
      .toBeGreaterThan(atmosphereParticleAt(fast, loud, 1920, 1080, 345).radius);
  });
});

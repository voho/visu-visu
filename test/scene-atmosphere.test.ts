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
  layer.drawForeground(context, state, lights);
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
      layer.drawForeground(context, dynamics(1, 16), lights);
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

  test("particles approach the viewer slowly, expand and soften before an invisible reset", () => {
    const particle: AtmosphereParticle = {
      tier: "spark", x: 0.85, y: 0.64, phase: 0, speed: 1, depth: 1, radius: 0.002,
    };
    const far = dynamics(0.5, 0);
    far.spark.clock = 0.2 / 0.0016;
    const near = { ...far, spark: { energy: 0.5, clock: 0.75 / 0.0016 } };
    const a = atmosphereParticleAt(particle, far, 1920, 1080, 345);
    const b = atmosphereParticleAt(particle, near, 1920, 1080, 345);
    expect(b.depth).toBeGreaterThan(a.depth);
    expect(b.radius).toBeGreaterThan(a.radius * 1.5);
    expect(b.softness).toBeGreaterThan(a.softness);
    expect(b.x - 960).toBeGreaterThan(a.x - 960);
    expect(b.alpha).toBeGreaterThan(0.02);

    const resetParticle = { ...particle, tier: "drift" as const };
    const before = dynamics(1, 0);
    before.drift.clock = (1 - 0.00001) / 0.035;
    const after = { ...before, drift: { energy: 1, clock: (1 + 0.00001) / 0.035 } };
    const outgoing = atmosphereParticleAt(resetParticle, before, 1920, 1080, 345);
    const incoming = atmosphereParticleAt(resetParticle, after, 1920, 1080, 345);
    expect(outgoing.depth).toBeGreaterThan(0.999);
    expect(incoming.depth).toBeLessThan(0.001);
    expect(outgoing.alpha).toBeLessThan(0.000001);
    expect(incoming.alpha).toBeLessThan(0.000001);
    // Fast spark clocks still produce slow depth travel between adjacent poses.
    const next = { ...far, spark: { energy: 0.5, clock: far.spark.clock + 1 / 60 } };
    expect(atmosphereParticleAt(particle, next, 1920, 1080, 345).depth - a.depth).toBeLessThan(0.0001);
  });

  test("every layer clock changes the visible atmosphere without accumulating history", () => {
    const width = 640;
    const height = 360;
    const layer = new SceneAtmosphere(width, height, createSafeLayout(width, height), "layer-clocks");
    const baseline = dynamics(0.8, 24);
    const original = render(layer, width, height, baseline);
    for (const tier of ["drift", "cloud", "body", "detail", "spark", "impact"] as const) {
      const advanced = { ...baseline, [tier]: { ...baseline[tier], clock: baseline[tier].clock + 4 } };
      expect(difference(original, render(layer, width, height, advanced))).toBeGreaterThan(0.004);
      expect(render(layer, width, height, baseline)).toEqual(original);
    }
  });

  test("cloud blends, bokeh and diffraction keep a grayscale artwork palette neutral", () => {
    const width = 480;
    const height = 270;
    const layer = new SceneAtmosphere(width, height, createSafeLayout(width, height), "neutral-fx");
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "rgb(40,40,40)";
    context.fillRect(0, 0, width, height);
    const neutral = { ...lights, lights: lights.lights.map((light) => ({ ...light, color: [0.6, 0.6, 0.6] })) } as typeof lights;
    layer.draw(context, dynamics(1, 18), neutral);
    layer.drawForeground(context, dynamics(1, 18), neutral);
    const pixels = context.getImageData(0, 0, width, height).data;
    let spread = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      spread = Math.max(spread, Math.abs(pixels[index]! - pixels[index + 1]!), Math.abs(pixels[index]! - pixels[index + 2]!));
    }
    expect(spread).toBeLessThanOrEqual(1);
  });

  test("near bokeh remains visible over an opaque sculpture and the foreground pass is seek safe", () => {
    const width = 640;
    const height = 360;
    const layout = createSafeLayout(width, height);
    const layer = new SceneAtmosphere(width, height, layout, "front-depth");
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    const state = dynamics(0.9, 30);
    layer.draw(context, state, lights);
    // Stand-in for an opaque photo surface between the two atmosphere passes.
    context.fillStyle = "rgb(35,45,55)";
    context.fillRect(0, 0, width, height);
    const covered = context.getImageData(0, 0, width, height).data;
    layer.drawForeground(context, state, lights);
    const foreground = context.getImageData(0, 0, width, height).data;
    expect(difference(covered, foreground)).toBeGreaterThan(0.004);
    let creditChanges = 0;
    for (let y = 0; y + 1 <= layout.graphTop; y += 1) {
      for (let x = 0; x < width * 4; x += 1) {
        if (covered[y * width * 4 + x] !== foreground[y * width * 4 + x]) creditChanges += 1;
      }
    }
    expect(creditChanges).toBe(0);
    layer.drawForeground(context, dynamics(1, 240), lights);
    context.fillStyle = "rgb(35,45,55)";
    context.fillRect(0, 0, width, height);
    layer.drawForeground(context, state, lights);
    expect(context.getImageData(0, 0, width, height).data).toEqual(foreground);
  });
});

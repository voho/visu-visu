import { describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { createMaterialFromHeight } from "../src/render/material.js";
import { MaterialLightLayer } from "../src/render/material-layer.js";
import { createSafeLayout } from "../src/render/layout.js";
import { lightingAt, type LightingState } from "../src/render/lighting.js";
import type { MusicMotion } from "../src/render/music-motion.js";

const quiet: MusicMotion = {
  slowTime: 1, fastTime: 3, bassPulse: 0, treblePulse: 0,
  bassEnergy: 0, midEnergy: 0, trebleEnergy: 0, attack: 0, sustain: 0,
};
const map = createMaterialFromHeight(Float32Array.from({ length: 16 * 16 }, (_, index) =>
  0.5 + Math.sin(index % 16 * Math.PI / 8) * 0.2), 16, 16);

function render(layer: MaterialLightLayer, width: number, height: number, lights: LightingState, strength = 0.65, zoom = 1): Uint8ClampedArray {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "rgb(8,12,16)";
  context.fillRect(0, 0, width, height);
  layer.draw(context, lights, strength, zoom);
  return context.getImageData(0, 0, width, height).data;
}

function difference(left: Uint8ClampedArray, right: Uint8ClampedArray): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (index % 4 !== 3) total += Math.abs(left[index]! - right[index]!);
  }
  return total / (left.length / 4 * 3);
}

describe("subtle material light layer", () => {
  test("adds bounded texture light below the credits, including at the strongest artwork zoom", () => {
    const lights = lightingAt({ ...quiet, bassEnergy: 1, bassPulse: 1, midEnergy: 1, trebleEnergy: 1, sustain: 1 }, 1, "layer", 210);
    for (const [width, height] of [[640, 360], [360, 640]] as const) {
      const layout = createSafeLayout(width, height);
      const layer = new MaterialLightLayer(width, height, map, layout, true);
      const pixels = render(layer, width, height, lights, 1, 1.039);
      let maximumAdded = 0;
      let totalAdded = 0;
      let creditChanged = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          for (let channel = 0; channel < 3; channel += 1) {
            const added = pixels[(y * width + x) * 4 + channel]! - [8, 12, 16][channel]!;
            maximumAdded = Math.max(maximumAdded, added);
            totalAdded += added;
            if (y + 1 <= layout.graphTop && added !== 0) creditChanged += 1;
          }
        }
      }
      expect(creditChanged).toBe(0);
      expect(maximumAdded).toBeGreaterThan(8);
      expect(maximumAdded).toBeLessThan(40);
      // Even an opaque synthetic cover at maximum strength adds under 6.5%
      // average brightness; real cover masks and the default 0.65 reduce it.
      expect(totalAdded / (width * height * 3)).toBeLessThan(255 * 0.065);
    }
  });

  test("lighting zero is a no-op, transparent material stays invisible, and invalid controls are safe", () => {
    const width = 192;
    const height = 108;
    const layout = createSafeLayout(width, height);
    const layer = new MaterialLightLayer(width, height, map, layout);
    const lights = lightingAt(quiet, 1, "layer", 210);
    const off = render(layer, width, height, lights, 0);
    for (const strength of [-1, NaN, Infinity]) expect(render(layer, width, height, lights, strength)).toEqual(off);
    expect(render(layer, width, height, lights, 20)).toEqual(render(layer, width, height, lights, 1));
    expect(render(layer, width, height, lights, 1, NaN)).toEqual(render(layer, width, height, lights, 1));
    const transparent = { ...map, albedo: map.albedo.slice() };
    for (let index = 3; index < transparent.albedo.length; index += 4) transparent.albedo[index] = 0;
    const hidden = new MaterialLightLayer(width, height, transparent, layout);
    expect(render(hidden, width, height, lights, 1)).toEqual(off);
  });

  test("seeking is deterministic and bass changes the actual shaded pixels more than treble", () => {
    const width = 192;
    const height = 108;
    const layer = new MaterialLightLayer(width, height, map, createSafeLayout(width, height));
    const resting = lightingAt(quiet, 1, "layer", 210);
    const bass = lightingAt({ ...quiet, bassEnergy: 1, bassPulse: 1 }, 1, "layer", 210);
    const treble = lightingAt({ ...quiet, trebleEnergy: 1, treblePulse: 1 }, 1, "layer", 210);
    const baseline = render(layer, width, height, resting);
    const bassPixels = render(layer, width, height, bass);
    const treblePixels = render(layer, width, height, treble);
    expect(render(layer, width, height, resting)).toEqual(baseline);
    expect(difference(baseline, bassPixels)).toBeGreaterThan(0.5);
    expect(difference(baseline, bassPixels)).toBeGreaterThan(difference(baseline, treblePixels) * 1.5);
  });
});

import { describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { createSafeLayout } from "../src/render/layout.js";
import { lightingAt } from "../src/render/lighting.js";
import { createMaterial, createMaterialFromRgba, type MaterialMap } from "../src/render/material.js";
import { createResonanceFilaments, createResonancePlan } from "../src/render/resonance.js";
import { drawMaterialSurface } from "../src/render/surface-mesh.js";
import type { AnalysisFrame } from "../src/types.js";
import type { MusicMotion } from "../src/render/music-motion.js";
import type { VisualState } from "../src/render/conductor.js";

const width = 480;
const height = 270;
const layout = createSafeLayout(width, height);
const motion: MusicMotion = {
  slowTime: 3.5, fastTime: 12, bassPulse: 0.6, treblePulse: 0.2,
  bassEnergy: 0.8, midEnergy: 0.6, trebleEnergy: 0.4, attack: 0.6, sustain: 0.7,
};
const frame: AnalysisFrame = {
  rms: 0.5, peak: 0.7, bass: 0.8, mid: 0.6, treble: 0.4,
  centroid: 0.3, flux: 0.3, onset: 0.6,
  spectrum: new Float32Array(64).fill(0.25),
  waveform: new Float32Array(192),
};
const visual: VisualState = { ambient: 0.7, drive: 0.6, peak: 0.5, beat: 0.6, trend: 0.2, motion: 0.6, chapter: 0.4, form: 0.4, warmth: 0.5 };
const filaments = createResonanceFilaments(createResonancePlan("mesh-test"), frame, visual, layout, 5, false, motion);
const material = createMaterial("mesh-test", 32);
const lights = lightingAt(motion, 5, "mesh-test", 210);

function render(audio: AnalysisFrame, strength = 0.65, surface: MaterialMap = material): Uint8ClampedArray {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "rgb(8,12,16)";
  context.fillRect(0, 0, width, height);
  // This is the same final-space protection applied by the production renderer.
  context.beginPath();
  context.rect(layout.left, layout.graphTop, layout.width, layout.graphBottom - layout.graphTop);
  context.clip();
  drawMaterialSurface(context, filaments, audio, motion, surface, lights, strength, false);
  return context.getImageData(0, 0, width, height).data;
}

function pixelDifference(left: Uint8ClampedArray, right: Uint8ClampedArray): { mean: number; changedPixels: number } {
  let difference = 0;
  let changedPixels = 0;
  for (let index = 0; index < left.length; index += 4) {
    const delta = Math.abs(left[index]! - right[index]!) + Math.abs(left[index + 1]! - right[index + 1]!)
      + Math.abs(left[index + 2]! - right[index + 2]!);
    difference += delta;
    if (delta > 2) changedPixels += 1;
  }
  return { mean: difference / (width * height * 3), changedPixels };
}

describe("audio-reflecting material mesh", () => {
  test("waveform and spectrum each alter actual surface pixels with fixed geometry and lighting", () => {
    const baseline = render(frame);
    const waveform = render({ ...frame, waveform: Float32Array.from({ length: 192 }, (_, index) =>
      Math.sin(index / 192 * Math.PI * 4) * 0.95) });
    const spectrum = render({ ...frame, spectrum: Float32Array.from({ length: 64 }, (_, index) => index < 32 ? 0.95 : 0.05) });
    for (const changed of [waveform, spectrum]) {
      const response = pixelDifference(baseline, changed);
      expect(response.mean).toBeGreaterThan(0.025);
      expect(response.changedPixels).toBeGreaterThan(400);
    }
    // The material, geometry and lights are reused above. Only the arrays in
    // AnalysisFrame changed, so a global beat/color effect cannot satisfy this.
    expect(render(frame)).toEqual(baseline);
  });

  test("photographic alpha controls the actual skin, including light and waveform accents", () => {
    const pixels = new Uint8ClampedArray(32 * 32 * 4);
    for (let index = 0; index < pixels.length; index += 4) pixels.set([160, 70, 190, 255], index);
    const opaque = createMaterialFromRgba(pixels, 32, 32);
    for (let index = 3; index < pixels.length; index += 4) pixels[index] = 0;
    const transparent = createMaterialFromRgba(pixels, 32, 32);
    const active = { ...frame, spectrum: new Float32Array(64).fill(1),
      waveform: Float32Array.from({ length: 192 }, (_, index) => Math.sin(index * 0.15)) };
    const hidden = render(active, 1, transparent);
    expect(hidden).toEqual(render(active, 0, opaque));
    expect(pixelDifference(hidden, render(active, 1, opaque)).changedPixels).toBeGreaterThan(1000);
  });

  test("disabled lighting leaves output untouched and the filled material stays below credits", () => {
    const off = render(frame, 0);
    const on = render(frame, 1);
    const response = pixelDifference(off, on);
    expect(response.changedPixels).toBeGreaterThan(1000);
    let disabledChanges = 0;
    let outsideChanges = 0;
    let opaquePixels = 0;
    let brightestMean = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        if (off[at] !== 8 || off[at + 1] !== 12 || off[at + 2] !== 16) disabledChanges += 1;
        if (on[at + 3] === 255) opaquePixels += 1;
        brightestMean = Math.max(brightestMean, (on[at]! + on[at + 1]! + on[at + 2]!) / 3);
        const outside = x + 1 <= layout.left || x >= layout.right || y + 1 <= layout.graphTop || y >= layout.graphBottom;
        if (outside && (on[at] !== 8 || on[at + 1] !== 12 || on[at + 2] !== 16)) outsideChanges += 1;
      }
    }
    expect(disabledChanges).toBe(0);
    expect(outsideChanges).toBe(0);
    expect(opaquePixels).toBe(width * height);
    expect(brightestMean).toBeLessThan(225);
    expect(render(frame, -1)).toEqual(off);
  });
});

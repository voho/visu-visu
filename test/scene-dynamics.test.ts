import { describe, expect, test } from "bun:test";
import { deriveSceneDynamics, SCENE_LAYER_NAMES } from "../src/render/scene-dynamics.js";
import { ANALYSIS_VERSION, type AnalysisFrame, type AudioAnalysis } from "../src/types.js";

const base = { drift: 0.04, cloud: 0.1, body: 0.24, detail: 0.6, spark: 1.2, impact: 0.08 };
const speed = { drift: 0.12, cloud: 0.28, body: 0.8, detail: 1.8, spark: 3.6, impact: 1.6 };

function frame(spectrum = new Float32Array(64), onset = 0): AnalysisFrame {
  return { rms: 0, peak: 0, bass: 0, mid: 0, treble: 0, centroid: 0, flux: 0, onset,
    spectrum, waveform: new Float32Array(32) };
}

function source(sample: (time: number) => AnalysisFrame, fps = 60, duration = 8): AudioAnalysis {
  return {
    version: ANALYSIS_VERSION, sampleRate: 48_000, fps, duration,
    spectrumBands: 64, waveformPoints: 32, sourceHash: "scene-dynamics", sourceFileHash: "scene-dynamics",
    frames: Array.from({ length: Math.ceil(fps * duration) }, (_, index) => sample(index / fps)),
  };
}

const burst = (time: number) => frame(new Float32Array(64).fill(time >= 1 && time < 2 ? 0.8 : 0), time === 1 ? 1 : 0);

describe("independent scene momentum tiers", () => {
  test("each tier releases at its own physical timescale after the same burst", () => {
    const analysis = source(burst);
    const before = deriveSceneDynamics(analysis, 1 - 1e-9);
    for (const layer of SCENE_LAYER_NAMES) expect(before[layer].energy).toBe(0);
    const start = deriveSceneDynamics(analysis, 2);
    const tail = deriveSceneDynamics(analysis, 3);
    const releases = { drift: 8, cloud: 3, body: 0.7, detail: 0.3, spark: 0.12, impact: 1.2 };
    for (const layer of SCENE_LAYER_NAMES) {
      expect(start[layer].energy).toBeGreaterThan(0.05);
      expect(tail[layer].energy / start[layer].energy).toBeCloseTo(Math.exp(-1 / releases[layer]), 10);
    }
    expect(tail.drift.energy).toBeGreaterThan(tail.spark.energy * 1000);
    expect(tail.impact.energy).toBeGreaterThan(tail.detail.energy * 5);
  });

  test("fractional FFT ranges separate bass, mids and treble while retaining larger bass response", () => {
    const band = (low: number, high: number) => source(() => frame(Float32Array.from({ length: 64 }, (_, index) =>
      index / 64 >= low && index / 64 < high ? 0.8 : 0)));
    const bass = deriveSceneDynamics(band(0, 0.3), 6);
    const mids = deriveSceneDynamics(band(0.42, 0.66), 6);
    const treble = deriveSceneDynamics(band(0.75, 1), 6);
    expect(bass.body.energy).toBeGreaterThan(0.8);
    expect(bass.drift.energy).toBeGreaterThan(0.7);
    expect(bass.detail.energy).toBe(0);
    expect(bass.spark.energy).toBe(0);
    expect(mids.detail.energy).toBeGreaterThan(0.5);
    expect(mids.body.energy).toBe(0);
    expect(mids.spark.energy).toBe(0);
    expect(treble.spark.energy).toBeGreaterThan(0.35);
    expect(treble.body.energy).toBe(0);
    expect(treble.drift.energy).toBe(0);
    expect(bass.body.energy).toBeGreaterThan(treble.spark.energy * 2);
    // A sustained initial bass note does not manufacture an impact event.
    expect(bass.impact.energy).toBe(0);
  });

  test("momentum delays acceleration independently and keeps clock velocity continuous at attacks", () => {
    const analysis = source(burst);
    const velocity = (time: number) => {
      const dt = 1e-5;
      const left = deriveSceneDynamics(analysis, time - dt);
      const right = deriveSceneDynamics(analysis, time + dt);
      return Object.fromEntries(SCENE_LAYER_NAMES.map((layer) => [layer,
        ((right[layer].clock - left[layer].clock) / (2 * dt) - base[layer]) / speed[layer],
      ])) as Record<typeof SCENE_LAYER_NAMES[number], number>;
    };
    for (const momentum of Object.values(velocity(1))) expect(Math.abs(momentum)).toBeLessThan(1e-6);
    const accelerating = velocity(1.1);
    expect(accelerating.spark).toBeGreaterThan(accelerating.body);
    expect(accelerating.body).toBeGreaterThan(accelerating.cloud * 10);
    expect(accelerating.cloud).toBeGreaterThan(accelerating.drift * 5);
    const previous = deriveSceneDynamics(analysis, 2 - 1e-8);
    const next = deriveSceneDynamics(analysis, 2 + 1e-8);
    for (const layer of SCENE_LAYER_NAMES) {
      expect(next[layer].clock - previous[layer].clock).toBeGreaterThanOrEqual(0);
      expect(next[layer].clock - previous[layer].clock).toBeLessThan((base[layer] + speed[layer]) * 2.1e-8);
    }
  });

  test("absolute seeks and rendering cadence reproduce the same six clocks", () => {
    const analysis = source(burst, 24);
    const expected = deriveSceneDynamics(analysis, 2.617);
    for (const time of [7.8, 0, 1.2, 4.6, 0.1]) deriveSceneDynamics(analysis, time);
    expect(deriveSceneDynamics(analysis, 2.617)).toEqual(expected);
    expect(deriveSceneDynamics(source(burst, 24), 2.617)).toEqual(expected);
    const frames = Array.from({ length: 60 }, (_, index) => deriveSceneDynamics(analysis, 1 + index / 60));
    for (const layer of SCENE_LAYER_NAMES) {
      expect(new Set(frames.map((value) => value[layer].clock)).size).toBe(60);
      for (let index = 1; index < frames.length; index += 1) {
        const delta = frames[index]![layer].clock - frames[index - 1]![layer].clock;
        expect(delta).toBeGreaterThanOrEqual(base[layer] / 60 - 1e-12);
        expect(delta).toBeLessThanOrEqual((base[layer] + speed[layer]) / 60 + 1e-12);
      }
    }
    // The continuous spectral envelopes and integrated momentum have the same
    // result when a piecewise-constant signal is analyzed at a different fps.
    const highRate = source(burst, 60);
    for (const layer of ["drift", "cloud", "body", "detail", "spark"] as const) {
      expect(deriveSceneDynamics(highRate, 2.617)[layer].energy).toBeCloseTo(expected[layer].energy, 10);
      expect(deriveSceneDynamics(highRate, 2.617)[layer].clock).toBeCloseTo(expected[layer].clock, 10);
    }
  });

  test("silence retains gentle separate drift, and empty or malformed analysis stays finite", () => {
    const silence = source(() => frame());
    const empty = { ...silence, frames: [] };
    for (const analysis of [silence, empty]) {
      const state = deriveSceneDynamics(analysis, 7.5);
      for (const layer of SCENE_LAYER_NAMES) {
        expect(state[layer].energy).toBe(0);
        expect(state[layer].clock).toBeCloseTo(7.5 * base[layer], 10);
      }
    }
    const malformed = { ...source(() => frame(Float32Array.from([NaN, Infinity, -1, 4]), NaN)), fps: NaN };
    for (const time of [-1, NaN, Infinity, 3, Number.MAX_VALUE]) {
      for (const layer of Object.values(deriveSceneDynamics(malformed, time))) {
        expect(Number.isFinite(layer.clock)).toBe(true);
        expect(layer.clock).toBeGreaterThanOrEqual(0);
        expect(layer.energy).toBeWithin(0, 1);
      }
    }
  });
});

import { describe, expect, test } from "bun:test";
import { createMaterialFromHeight, createMaterialFromRgba, sampleMaterial, type MaterialMap } from "../src/render/material.js";
import { sampleResonanceMaterial, mirroredArtworkUv } from "../src/render/surface-material.js";
import { createResonanceFilaments, createResonancePlan, type ResonanceFilament } from "../src/render/resonance.js";
import { createSafeLayout } from "../src/render/layout.js";
import type { AnalysisFrame } from "../src/types.js";
import type { VisualState } from "../src/render/conductor.js";

function flatMaterial(normal: [number, number, number] = [0, 0, 1]): MaterialMap {
  const map = createMaterialFromHeight(new Float32Array(16 * 16).fill(0.5), 16, 16);
  for (let index = 0; index < map.normals.length; index += 3) map.normals.set(normal, index);
  return map;
}

function plane(rotate = false): ResonanceFilament[] {
  return Array.from({ length: 5 }, (_, row) => ({
    alpha: 1, hueOffset: 0, depth: 0.5,
    points: [-1, -0.5, 0, 0.5, -1].map((x) => ({
      x, y: row, depth: 0.5, energy: 0.5, band: 0.5,
      surfaceX: x,
      surfaceY: rotate ? 0 : 2 - row,
      surfaceZ: rotate ? 2 - row : 0,
    })),
  }));
}

describe("filament material basis", () => {
  test("keeps texture X right and green up, then rotates both with the actual surface", () => {
    const map = flatMaterial([0.3, 0.4, Math.sqrt(0.75)]);
    const flat = sampleResonanceMaterial(map, plane(), 2, 2);
    expect(flat.nx).toBeCloseTo(0.3, 6);
    expect(flat.ny).toBeCloseTo(0.4, 6);
    expect(flat.nz).toBeCloseTo(Math.sqrt(0.75), 6);
    const rotated = sampleResonanceMaterial(map, plane(true), 2, 2);
    expect(rotated.nx).toBeCloseTo(flat.nx, 6);
    expect(rotated.ny).toBeCloseTo(-flat.nz, 6);
    expect(rotated.nz).toBeCloseTo(flat.ny, 6);
  });

  test("uses a unit orthogonal basis even when neighboring strands are skewed", () => {
    const skewed = plane();
    for (const strand of skewed) {
      for (const point of strand.points) point.surfaceX += point.surfaceY * 0.75;
    }
    const sample = sampleResonanceMaterial(flatMaterial([0, 1, 0]), skewed, 2, 2);
    expect(sample.nx).toBeCloseTo(0, 6);
    expect(sample.ny).toBeCloseTo(1, 6);
    expect(sample.nz).toBeCloseTo(0, 6);
  });

  test("wraps closed indices, reuses storage, and safely handles missing or degenerate geometry", () => {
    const map = flatMaterial();
    const filaments = plane();
    const result = sampleResonanceMaterial(map, filaments, 2, 2);
    const out = sampleMaterial(map, 0, 0);
    expect(sampleResonanceMaterial(map, filaments, -3, -2, out)).toBe(out);
    expect(out).toEqual(result);
    expect(sampleResonanceMaterial(map, filaments, 12, 10)).toEqual(result);
    expect(sampleResonanceMaterial(map, filaments, 2, 4)).toEqual(sampleResonanceMaterial(map, filaments, 2, 0));
    const cases = [[], [{ ...filaments[0]!, points: [] }], [{ ...filaments[0]!, points: filaments[0]!.points.slice(0, 1) }]];
    for (const geometry of cases) {
      expect(sampleResonanceMaterial(map, geometry, Infinity, NaN)).toEqual(sampleMaterial(map, 0, 0));
    }
    for (const strand of filaments) {
      for (const point of strand.points) point.surfaceX = point.surfaceY = point.surfaceZ = 0;
    }
    expect(sampleResonanceMaterial(map, filaments, 2, 2)).toEqual(sampleMaterial(map, 0, 0));
    filaments[2]!.points[3]!.surfaceX = NaN;
    expect(Object.values(sampleResonanceMaterial(map, filaments, 2, 2)).every(Number.isFinite)).toBe(true);
  });

  test("maps the full photo around both closed axes without a clamped half or moving UVs", () => {
    for (const [phase, expected] of [[0, 0], [0.125, 0.25], [0.5, 1], [0.75, 0.5], [0.875, 0.25], [1, 0]] as const) {
      expect(mirroredArtworkUv(phase).coordinate).toBeCloseTo(expected, 9);
    }
    expect(mirroredArtworkUv(0.25).normalSign).toBe(1);
    expect(mirroredArtworkUv(0.75).normalSign).toBe(-1);
    expect(mirroredArtworkUv(0).normalSign).toBe(0);
    expect(mirroredArtworkUv(1 - 1e-8).coordinate).toBeCloseTo(mirroredArtworkUv(1e-8).coordinate, 6);
    expect(Math.abs(mirroredArtworkUv(1 - 1e-8).normalSign)).toBeLessThan(1e-8);
    const rgba = new Uint8ClampedArray(16 * 16 * 4);
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) rgba.set([x * 17, y * 17, 50, 255], (y * 16 + x) * 4);
    }
    const photo = createMaterialFromRgba(rgba, 16, 16);
    const flat = plane();
    const rotated = plane(true);
    const a = sampleResonanceMaterial(photo, flat, 1.3, 2.5);
    const b = sampleResonanceMaterial(photo, rotated, 1.3, 2.5);
    expect([a.r, a.g, a.b, a.a, a.height]).toEqual([b.r, b.g, b.b, b.a, b.height]);
    expect(Math.hypot(a.nx - b.nx, a.ny - b.ny, a.nz - b.nz)).toBeGreaterThan(0.1);
    expect(sampleResonanceMaterial(photo, flat, 1.3, 2.5).r)
      .toBeGreaterThan(sampleResonanceMaterial(photo, flat, 1.3, 3.5).r + 0.4);
    for (const position of [0, 0.001, 1.99, 2, 2.01, 3.999]) {
      const sample = sampleResonanceMaterial(photo, flat, 1.3, position);
      expect(Math.hypot(sample.nx, sample.ny, sample.nz)).toBeCloseTo(1, 6);
    }
  });

  test("real morphing geometry has finite unit normals independent of viewport and seek order", () => {
    const map = flatMaterial([0.3, 0.4, Math.sqrt(0.75)]);
    const plan = createResonancePlan("material-geometry");
    const audio: AnalysisFrame = {
      rms: 0.8, peak: 0.95, bass: 1, mid: 0.75, treble: 0.9,
      centroid: 0.5, flux: 0.7, onset: 0.8,
      spectrum: Float32Array.from({ length: 64 }, (_, index) => 0.6 + 0.3 * Math.sin(index)),
      waveform: Float32Array.from({ length: 192 }, (_, index) => Math.sin(index / 192 * Math.PI * 2)),
    };
    const visual: VisualState = { ambient: 0.7, drive: 0.8, peak: 0.9, beat: 1, trend: 0.3, motion: 0.8, chapter: 0.4, form: 0.5, warmth: 0.5 };
    const sample = (time: number, portrait = false) => createResonanceFilaments(plan, audio, visual,
      createSafeLayout(portrait ? 1080 : 1920, portrait ? 1920 : 1080), time, false);
    const out = sampleMaterial(map, 0, 0);
    for (const time of [0, 19, 136]) {
      const geometry = sample(time);
      let largestUnitError = 0;
      let alteredNormals = 0;
      for (let strand = 0; strand < geometry.length; strand += 1) {
        for (let index = 0; index < geometry[strand]!.points.length; index += 1) {
          sampleResonanceMaterial(map, geometry, strand, index, out);
          largestUnitError = Math.max(largestUnitError, Math.abs(1 - Math.hypot(out.nx, out.ny, out.nz)));
          if (Math.abs(out.nx - 0.3) + Math.abs(out.ny - 0.4) > 0.05) alteredNormals += 1;
        }
      }
      expect(Number.isFinite(largestUnitError)).toBe(true);
      expect(largestUnitError).toBeLessThan(1e-6);
      expect(alteredNormals).toBeGreaterThan(geometry.length * 230);
      const expected = sampleResonanceMaterial(map, geometry, 18, 73);
      sample(290);
      expect(sampleResonanceMaterial(map, sample(time), 18, 73)).toEqual(expected);
      expect(sampleResonanceMaterial(map, sample(time, true), 18, 73)).toEqual(expected);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadImage } from "@napi-rs/canvas";
import {
  createMaterial, createMaterialFromRgba, createProceduralHeight,
  normalsFromHeight, sampleMaterial,
} from "../src/render/material.js";

describe("coherent silk material", () => {
  test("converts flat and sloped heights to normalized +Y-up surface normals", () => {
    const size = 16;
    const flat = normalsFromHeight(new Float32Array(size * size).fill(0.4), size, size);
    for (let index = 0; index < flat.length; index += 3) {
      expect(flat[index]).toBeCloseTo(0, 7);
      expect(flat[index + 1]).toBeCloseTo(0, 7);
      expect(flat[index + 2]).toBe(1);
    }
    const horizontal = Float32Array.from({ length: size * size }, (_, index) => index % size / size);
    const vertical = Float32Array.from({ length: size * size }, (_, index) => Math.floor(index / size) / size);
    const xNormal = normalsFromHeight(horizontal, size, size, 0.5, false);
    const yNormal = normalsFromHeight(vertical, size, size, 0.5, false);
    const center = (8 * size + 8) * 3;
    expect(xNormal[center]).toBeCloseTo(-1 / Math.sqrt(5), 6);
    expect(xNormal[center + 1]).toBeCloseTo(0, 7);
    expect(yNormal[center]).toBeCloseTo(0, 7);
    expect(yNormal[center + 1]).toBeCloseTo(1 / Math.sqrt(5), 6);
    expect(Math.hypot(...xNormal.slice(center, center + 3))).toBeCloseTo(1, 6);
  });

  test("uses wrapped central gradients across both texture seams", () => {
    const size = 64;
    const heights = Float32Array.from({ length: size * size }, (_, index) => 0.5
      + Math.sin(index % size / size * Math.PI * 2) * 0.2
      + Math.sin(Math.floor(index / size) / size * Math.PI * 2) * 0.15);
    const normals = normalsFromHeight(heights, size, size, 0.1);
    // The seam has the same analytic derivative as the other sampled phases.
    const dx = Math.sin(2 * Math.PI / size) * size * 0.2;
    const dy = Math.sin(2 * Math.PI / size) * size * 0.15;
    const length = Math.hypot(dx * 0.1, dy * 0.1, 1);
    expect(normals[0]).toBeCloseTo(-dx * 0.1 / length, 5);
    expect(normals[1]).toBeCloseTo(dy * 0.1 / length, 5);
    const map = createMaterial("seam", size, heights);
    expect(sampleMaterial(map, 0, 0.35)).toEqual(sampleMaterial(map, 1, 0.35));
    expect(sampleMaterial(map, -0.125, 1.25)).toEqual(sampleMaterial(map, 0.875, 0.25));
    const before = sampleMaterial(map, 1 - 1e-5, 0.35);
    const after = sampleMaterial(map, 1e-5, 0.35);
    expect(Math.abs(before.height - after.height)).toBeLessThan(0.0001);
    expect(Math.abs(before.nx - after.nx)).toBeLessThan(0.0001);
  });

  test("is reproducible, varies with seed, and supplies bounded roughness and color", () => {
    const first = createMaterial("silk-a", 64);
    const repeated = createMaterial("silk-a", 64);
    expect(first.heightMap).toEqual(repeated.heightMap);
    expect(first.normals).toEqual(repeated.normals);
    expect(first.heightMap).not.toEqual(createMaterial("silk-b", 64).heightMap);
    expect(createProceduralHeight("fallback-a", 32)).toEqual(createProceduralHeight("fallback-a", 32));
    expect(createProceduralHeight("fallback-a", 32)).not.toEqual(createProceduralHeight("fallback-b", 32));
    expect(first.albedo.length).toBe(64 * 64 * 4);
    let minRoughness = 1;
    let maxRoughness = 0;
    for (let index = 0; index < first.heightMap.length; index += 1) {
      const normal = first.normals.subarray(index * 3, index * 3 + 3);
      expect(Math.hypot(...normal)).toBeCloseTo(1, 5);
      expect(normal[2]).toBeGreaterThan(0);
      expect(first.albedo[index * 4 + 3]).toBe(255);
      minRoughness = Math.min(minRoughness, first.roughness[index]!);
      maxRoughness = Math.max(maxRoughness, first.roughness[index]!);
    }
    expect(minRoughness).toBeGreaterThanOrEqual(0.3);
    expect(maxRoughness).toBeLessThanOrEqual(0.76);
    expect(maxRoughness - minRoughness).toBeGreaterThan(0.05);
    const reusable = sampleMaterial(first, 0.2, 0.7);
    expect(sampleMaterial(first, 0.3, 0.9, reusable)).toBe(reusable);
    expect(Math.hypot(reusable.nx, reusable.ny, reusable.nz)).toBeCloseTo(1, 6);
    expect(sampleMaterial(first, NaN, Infinity)).toEqual(sampleMaterial(first, 0, 0));
  });

  test("rejects invalid dimensions, malformed data, and nonfinite geometry", () => {
    for (const size of [0, 1, 1.5, 257, NaN]) expect(() => createMaterial("bad", size)).toThrow("dimensions");
    expect(() => createMaterial("bad", 16, new Float32Array(5))).toThrow("match");
    expect(() => createMaterial("bad", 2, [0, NaN, 0, 0])).toThrow("finite");
    expect(() => normalsFromHeight([0, Infinity, 0, 0], 2, 2)).toThrow("finite");
    expect(() => normalsFromHeight([0, 0, 0, 0], 2, 2, -1)).toThrow("strength");
  });
});

describe("cover relief", () => {
  test("preserves artwork colors and transparency, excludes hidden RGB, and clamps edges", () => {
    const width = 16;
    const height = 8;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      pixels[index * 4] = 180;
      pixels[index * 4 + 1] = 90;
      pixels[index * 4 + 2] = 40;
      pixels[index * 4 + 3] = index % width < 8 ? 255 : 0;
    }
    const map = createMaterialFromRgba(pixels, width, height, { blurRadius: 2 });
    expect(map.albedo).toEqual(pixels);
    expect(map.albedo).not.toBe(pixels);
    expect(map.wrap).toBe(false);
    const other = pixels.slice();
    for (let index = 0; index < width * height; index += 1) {
      if (other[index * 4 + 3] !== 0) continue;
      other[index * 4] = 0;
      other[index * 4 + 1] = 255;
      other[index * 4 + 2] = 255;
    }
    const hiddenColor = createMaterialFromRgba(other, width, height, { blurRadius: 2 });
    expect(hiddenColor.heightMap).toEqual(map.heightMap);
    expect(hiddenColor.normals).toEqual(map.normals);
    expect(sampleMaterial(map, -0.2, 0.4)).toEqual(sampleMaterial(map, 0, 0.4));
    expect(sampleMaterial(map, 1.2, 0.4)).toEqual(sampleMaterial(map, 1, 0.4));
    expect(sampleMaterial(map, 0, 0.4).a).toBe(1);
    expect(sampleMaterial(map, 1, 0.4).a).toBe(0);
  });

  test("softens high-frequency cover details before deriving relief", () => {
    const pixels = new Uint8ClampedArray(32 * 32 * 4);
    for (let index = 0; index < 32 * 32; index += 1) {
      const value = index % 2 ? 255 : 0;
      pixels.set([value, value, value, 255], index * 4);
    }
    const unblurred = createMaterialFromRgba(pixels, 32, 32, { blurRadius: 0 });
    const softened = createMaterialFromRgba(pixels, 32, 32, { blurRadius: 3 });
    const contrast = (map: typeof unblurred): number => Math.abs(map.heightMap[16 * 32 + 16]! - map.heightMap[16 * 32 + 17]!);
    expect(contrast(softened)).toBeLessThan(contrast(unblurred) * 0.2);
    expect(() => createMaterialFromRgba(pixels, 32, 32, { blurRadius: -1 })).toThrow("blur radius");
  });
});

test("material regeneration produces identical exported maps from the same source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "visu-visu-material-"));
  try {
    for (const name of ["first", "second"]) {
      const result = Bun.spawn([process.execPath, "scripts/generate-materials.ts", "--out-dir", join(directory, name)], {
        stdout: "pipe", stderr: "pipe",
      });
      const error = await new Response(result.stderr).text();
      expect(await result.exited, error).toBe(0);
    }
    for (const filename of ["silk-albedo.png", "silk-height.png", "silk-normal.png", "silk-roughness.png", "silk-height.ts", "material.json"]) {
      const first = await readFile(join(directory, "first", filename));
      expect(first.equals(await readFile(join(directory, "second", filename)))).toBe(true);
      expect(first.equals(await readFile(join("assets/materials", filename)))).toBe(true);
      if (!filename.endsWith(".png")) continue;
      const map = await loadImage(join(directory, "first", filename));
      expect(map.width).toBe(512);
      expect(map.height).toBe(512);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

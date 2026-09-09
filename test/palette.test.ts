import { describe, expect, test } from "bun:test";
import { extractPalette, paletteCss, paletteRgb, randomPalette, rgbHue } from "../src/render/palette.js";
import { createMaterial, recolorMaterial } from "../src/render/material.js";
import type { Rgb } from "../src/render/lighting.js";

const sourcePixels = (colors: readonly (readonly [number, number, number, number])[]): Uint8ClampedArray =>
  new Uint8ClampedArray(colors.flat());
const degreesApart = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe("artwork-derived RGB palette", () => {
  test("retains actual source swatches and ignores invisible colors", () => {
    const pixels = sourcePixels([
      ...Array.from({ length: 80 }, () => [220, 55, 25, 255] as const),
      ...Array.from({ length: 30 }, () => [25, 110, 185, 255] as const),
      ...Array.from({ length: 20 }, () => [235, 205, 130, 255] as const),
      ...Array.from({ length: 1000 }, () => [0, 255, 0, 0] as const),
    ]);
    const palette = extractPalette(pixels);
    expect(palette.source).toBe("artwork");
    expect(palette.colors.map((rgb) => rgb.map((value) => Math.round(value * 255))))
      .toEqual([[220, 55, 25], [25, 110, 185], [235, 205, 130]]);
    expect(palette).toEqual(extractPalette(pixels));
    expect(palette.anchorHue).toBeCloseTo(rgbHue([220 / 255, 55 / 255, 25 / 255]), 6);
  });

  test("grayscale stays neutral through palette cycling, saturation and brightness changes", () => {
    const palette = extractPalette(sourcePixels([
      ...Array.from({ length: 60 }, () => [40, 40, 40, 255] as const),
      ...Array.from({ length: 30 }, () => [140, 140, 140, 255] as const),
      ...Array.from({ length: 10 }, () => [225, 225, 225, 255] as const),
      [255, 0, 255, 0],
    ]));
    for (const phase of [-150, 0, 50, 180, 290, 360, 780]) {
      for (const saturation of [0, 40, 100]) {
        for (const brightness of [15, 50, 90]) {
          const rgb = paletteRgb(palette, phase, saturation, brightness);
          expect(rgb[0]).toBeCloseTo(rgb[1], 10);
          expect(rgb[1]).toBeCloseTo(rgb[2], 10);
        }
      }
    }
  });

  test("a single artwork hue never gains a synthetic complementary color", () => {
    const palette = extractPalette(sourcePixels([[230, 110, 35, 255]]));
    const sourceHue = rgbHue(palette.colors[0]!);
    for (let phase = -360; phase < 720; phase += 13) {
      for (const saturation of [20, 70, 100]) {
        for (const lightness of [15, 40, 60, 95]) {
          expect(degreesApart(rgbHue(paletteRgb(palette, phase, saturation, lightness)), sourceHue)).toBeLessThan(1e-6);
        }
      }
    }
  });

  test("interpolates only between swatches, wraps smoothly, and reuses output storage", () => {
    const palette = extractPalette(sourcePixels([[255, 0, 0, 255], [0, 0, 255, 255]]));
    expect(paletteRgb(palette, 0)).toEqual([1, 0, 0]);
    expect(paletteRgb(palette, 90)).toEqual([0.5, 0, 0.5]);
    expect(paletteRgb(palette, 180)).toEqual([0, 0, 1]);
    expect(paletteRgb(palette, 360)).toEqual(paletteRgb(palette, 0));
    expect(paletteRgb(palette, -90)).toEqual(paletteRgb(palette, 270));
    const output: Rgb = [0, 0, 0];
    expect(paletteRgb(palette, 90, 100, 50, output)).toBe(output);
    expect(output).toEqual([0.5, 0, 0.5]);
    expect(paletteCss(palette, 0, 100, 50, 0.3)).toBe("rgba(255,0,0,0.3)");
  });

  test("fully transparent artwork supplies neutral light and malformed controls stay bounded", () => {
    const palette = extractPalette(sourcePixels([[255, 0, 255, 0], [0, 255, 0, 0]]));
    expect(palette.colors).toEqual([[0.5, 0.5, 0.5]]);
    expect(extractPalette(new Uint8ClampedArray())).toEqual(palette);
    expect(() => extractPalette(new Uint8ClampedArray(3))).toThrow("RGBA");
    for (const rgb of [paletteRgb(palette, NaN, Infinity, NaN), paletteRgb(palette, Infinity, -20, 150)]) {
      for (const channel of rgb) expect(Number.isFinite(channel) && channel >= 0 && channel <= 1).toBe(true);
    }
  });
});

describe("seeded fallback and material recoloring", () => {
  test("seed chooses distinct color families from the full hue range and survives cache eviction", () => {
    const first = randomPalette("fallback-palette-amber");
    expect(first.source).toBe("random");
    expect(randomPalette("fallback-palette-amber")).toBe(first);
    const other = randomPalette("fallback-palette-violet");
    expect(other.colors).not.toEqual(first.colors);
    expect(degreesApart(other.anchorHue, first.anchorHue)).toBeGreaterThan(30);
    const hueSectors = new Set<number>();
    for (let index = 0; index < 96; index += 1) hueSectors.add(Math.floor(randomPalette(`coverage-${index}`).anchorHue / 60));
    expect(hueSectors.size).toBe(6);
    expect(randomPalette("fallback-palette-amber")).toEqual(first);
  });

  test("removes baked pigment without changing normals, height, roughness or transparency", () => {
    const map = createMaterial("recolor", 32);
    for (let index = 3; index < map.albedo.length; index += 4) map.albedo[index] = index % 255;
    const original = map.albedo.slice();
    const neutral = extractPalette(sourcePixels([[90, 90, 90, 255], [170, 170, 170, 255]]));
    const colored = recolorMaterial(map, neutral);
    expect(colored.normals).toBe(map.normals);
    expect(colored.heightMap).toBe(map.heightMap);
    expect(colored.roughness).toBe(map.roughness);
    expect(map.albedo).toEqual(original);
    expect(colored.albedo).not.toBe(map.albedo);
    for (let index = 0; index < colored.albedo.length; index += 4) {
      expect(colored.albedo[index]).toBe(colored.albedo[index + 1]);
      expect(colored.albedo[index + 1]).toBe(colored.albedo[index + 2]);
      expect(colored.albedo[index + 3]).toBe(original[index + 3]);
    }
  });
});

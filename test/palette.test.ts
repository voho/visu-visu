import { describe, expect, test } from "bun:test";
import { accentSwatches, extractPalette, paletteCss, paletteRgb, randomPalette, rgbHue, swatchFamilyDirection } from "../src/render/palette.js";
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

  test("represents a muted cluster by its most chromatic pixel, repeatably", () => {
    // Four vivid far colors take the remaining center slots, so the small
    // vivid teal patch shares the grey-teal field's cluster instead of its own.
    const field = [100, 128, 130, 255] as const;
    const vivid = [84, 146, 142, 255] as const;
    const pixels = sourcePixels([
      ...Array.from({ length: 300 }, () => field),
      ...Array.from({ length: 8 }, () => vivid),
      ...Array.from({ length: 40 }, () => [220, 40, 30, 255] as const),
      ...Array.from({ length: 40 }, () => [30, 60, 210, 255] as const),
      ...Array.from({ length: 40 }, () => [240, 210, 60, 255] as const),
      ...Array.from({ length: 40 }, () => [200, 40, 200, 255] as const),
    ]);
    const palette = extractPalette(pixels);
    const bytes = palette.colors.map((rgb) => rgb.map((value) => Math.round(value * 255)));
    expect(bytes).toHaveLength(5);
    expect(bytes[0]).toEqual([84, 146, 142]);
    expect(bytes).not.toContainEqual([100, 128, 130]);
    expect(palette).toEqual(extractPalette(pixels));
  });

  test("names warm, cool, darkest and lightest swatches from real pigments", () => {
    const sample = extractPalette(sourcePixels([
      ...Array.from({ length: 50 }, () => [0x0e, 0x2e, 0x39, 255] as const),
      ...Array.from({ length: 40 }, () => [0xab, 0x7e, 0x6e, 255] as const),
      ...Array.from({ length: 30 }, () => [0xf6, 0xa7, 0x83, 255] as const),
      ...Array.from({ length: 20 }, () => [0xfd, 0xcb, 0xb4, 255] as const),
      ...Array.from({ length: 10 }, () => [0x33, 0x54, 0x5c, 255] as const),
    ]));
    const bytes = sample.colors.map((rgb) => rgb.map((value) => Math.round(value * 255)));
    const accents = accentSwatches(sample);
    expect(bytes[accents.warm]).toEqual([0xf6, 0xa7, 0x83]);
    expect(bytes[accents.cool]).toEqual([0x0e, 0x2e, 0x39]);
    expect(bytes[accents.darkest]).toEqual([0x0e, 0x2e, 0x39]);
    expect(bytes[accents.lightest]).toEqual([0xfd, 0xcb, 0xb4]);
    expect(accentSwatches(sample)).toEqual(accents);
    const grey = extractPalette(sourcePixels([
      ...Array.from({ length: 60 }, () => [40, 40, 40, 255] as const),
      ...Array.from({ length: 30 }, () => [140, 140, 140, 255] as const),
    ]));
    expect(accentSwatches(grey)).toMatchObject({ warm: 0, cool: 0 });
    // One warm family only: the two most chromatic swatches take both roles.
    const orange = extractPalette(sourcePixels([
      ...Array.from({ length: 60 }, () => [230, 110, 35, 255] as const),
      ...Array.from({ length: 30 }, () => [120, 70, 40, 255] as const),
    ]));
    const single = accentSwatches(orange);
    expect(single.warm).not.toBe(single.cool);
    expect(orange.colors[single.warm]!.map((value) => Math.round(value * 255))).toEqual([230, 110, 35]);
  });

  test("spreads each accent toward the ring neighbour of its own hue family", () => {
    // Ring by weight: dark teal, peach-brown, peach, light peach, teal. The
    // cool accent (index 0) must walk backwards to the teal at index 4, never
    // forward into the peach-brown; the warm peach walks to the light peach.
    const sample = extractPalette(sourcePixels([
      ...Array.from({ length: 50 }, () => [0x0e, 0x2e, 0x39, 255] as const),
      ...Array.from({ length: 40 }, () => [0xab, 0x7e, 0x6e, 255] as const),
      ...Array.from({ length: 30 }, () => [0xf6, 0xa7, 0x83, 255] as const),
      ...Array.from({ length: 20 }, () => [0xfd, 0xcb, 0xb4, 255] as const),
      ...Array.from({ length: 10 }, () => [0x33, 0x54, 0x5c, 255] as const),
    ]));
    const accents = accentSwatches(sample);
    expect(swatchFamilyDirection(sample, accents.cool)).toBe(-1);
    expect(swatchFamilyDirection(sample, accents.warm)).toBe(1);
    const coolStep = swatchFamilyDirection(sample, accents.cool) * 360 / sample.colors.length * 0.6;
    expect(degreesApart(rgbHue(paletteRgb(sample, accents.cool * 360 / sample.colors.length + coolStep)), 195)).toBeLessThan(6);
    // Too few swatches to have two neighbours, or a bad index: forward.
    expect(swatchFamilyDirection({ source: "random", colors: [[1, 0, 0], [0, 0, 1]], anchorHue: 0 }, 0)).toBe(1);
    expect(swatchFamilyDirection(sample, 9)).toBe(1);
    expect(swatchFamilyDirection(sample, Number.NaN)).toBe(1);
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

  test("every seeded palette anchors swatch 0 and holds two real color families", () => {
    for (let index = 0; index < 48; index += 1) {
      const palette = randomPalette(`families-${index}`);
      expect(palette.colors).toHaveLength(5);
      expect(degreesApart(rgbHue(palette.colors[0]!), palette.anchorHue)).toBeLessThan(1);
      const hues = palette.colors.map(rgbHue);
      let widest = 0;
      for (const a of hues) for (const b of hues) widest = Math.max(widest, degreesApart(a, b));
      expect(widest).toBeGreaterThanOrEqual(120);
      for (const rgb of palette.colors) expect(Math.max(...rgb) - Math.min(...rgb)).toBeGreaterThan(0.2);
    }
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

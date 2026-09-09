import { describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import {
  ArtworkWarp, artworkDisplacementAt, blendArtworkWarpFields,
  createArtworkWarpField, warpArtworkPixels,
} from "../src/render/artwork-warp.js";
import { createSafeLayout } from "../src/render/layout.js";
import { createResonanceFilaments, createResonancePlan } from "../src/render/resonance.js";
import { drawArtwork, type PreparedArtwork } from "../src/render/artwork.js";
import { randomPalette } from "../src/render/palette.js";

const width = 1920;
const height = 1080;
const layout = createSafeLayout(width, height);
const plan = createResonancePlan("cover-warp");
function geometry(time: number) {
  return createResonanceFilaments(plan, {
    rms: 0.4, peak: 0.5, bass: 0.6, mid: 0.4, treble: 0.2,
    centroid: 0.4, flux: 0.1, onset: 0.2,
    spectrum: new Float32Array(32).fill(0.5),
    waveform: Float32Array.from({ length: 64 }, (_, index) => Math.sin(index * Math.PI / 32) * 0.4),
  }, { ambient: 0.5, drive: 0.4, peak: 0.3, beat: 0.2, trend: 0.1, motion: 0.6, chapter: 0.3, form: 0.4 },
  layout, time, false);
}

function pattern(w: number, h: number): Uint8ClampedArray {
  return Uint8ClampedArray.from({ length: w * h * 4 }, (_, index) => {
    const pixel = Math.floor(index / 4);
    if (index % 4 === 3) return 255;
    return (pixel % w * 13 + Math.floor(pixel / w) * 7) % 256;
  });
}

describe("geometry-coupled background artwork warp", () => {
  test("samples actual projected geometry with the same camera transform", () => {
    const filaments = geometry(12);
    const camera = { a: 1.02, b: 0.03, c: -0.03, d: 1.02, e: 4, f: -2 };
    const field = createArtworkWarpField(filaments, width, height, layout, camera);
    expect(field.anchors).toHaveLength(24);
    const source = filaments[0]!.points[0]!;
    expect(field.anchors[0]!.x).toBeCloseTo(camera.a * source.x + camera.c * source.y + camera.e, 8);
    expect(field.anchors[0]!.y).toBeCloseTo(camera.b * source.x + camera.d * source.y + camera.f, 8);
    expect(field.maximum).toBeCloseTo(6.48, 8);
    expect(createArtworkWarpField([], width, height, layout).anchors).toHaveLength(0);
  });

  test("changes with the sculpture while staying within a few pixels and freezing credits and edges", () => {
    const first = createArtworkWarpField(geometry(12), width, height, layout);
    const later = createArtworkWarpField(geometry(22), width, height, layout);
    let maximum = 0;
    let geometryChange = 0;
    let creditMotion = 0;
    for (let y = 0; y <= height; y += 15) {
      for (let x = 0; x <= width; x += 15) {
        const a = artworkDisplacementAt(first, x, y);
        const b = artworkDisplacementAt(later, x, y);
        maximum = Math.max(maximum, Math.hypot(a.x, a.y));
        geometryChange = Math.max(geometryChange, Math.hypot(a.x - b.x, a.y - b.y));
        if (y <= layout.graphTop || x === 0 || x === width || y === height) creditMotion += Math.abs(a.x) + Math.abs(a.y);
      }
    }
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(6.48);
    expect(geometryChange).toBeGreaterThan(0.3);
    expect(creditMotion).toBe(0);
  });

  test("blends corresponding geometry landmarks with deterministic normalized history weights", () => {
    const first = createArtworkWarpField(geometry(4), width, height, layout);
    const second = createArtworkWarpField(geometry(9), width, height, layout);
    const blended = blendArtworkWarpFields([first, second], [3, 1]);
    expect(blended.anchors[0]!.x).toBeCloseTo(first.anchors[0]!.x * 0.75 + second.anchors[0]!.x * 0.25, 8);
    expect(blended.anchors[0]!.radius).toBeCloseTo(first.anchors[0]!.radius * 0.75 + second.anchors[0]!.radius * 0.25, 8);
    expect(blendArtworkWarpFields([first, second], [0.75, 0.25])).toEqual(blended);
    expect(() => blendArtworkWarpFields([first], [0])).toThrow("positive sum");
    expect(() => blendArtworkWarpFields([first, { ...second, width: 1 }], [1, 1])).toThrow("dimensions");
  });

  test("inverse resampling preserves source pixels, alpha and neutral hues without hidden RGB bleed", () => {
    const w = 128;
    const h = 72;
    const source = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const at = (y * w + x) * 4;
        const visible = x % 6 < 3;
        source[at] = visible ? 0 : 255;
        source[at + 1] = visible ? 180 : 0;
        source[at + 3] = visible ? 255 : 0;
      }
    }
    const before = source.slice();
    const field = createArtworkWarpField(geometry(12), width, height, layout);
    const output = warpArtworkPixels(source, w, h, field);
    let fractionalAlpha = 0;
    let contamination = 0;
    for (let index = 0; index < output.length; index += 4) {
      if (output[index + 3]! > 0 && output[index + 3]! < 255) fractionalAlpha += 1;
      if (output[index + 3]! > 0) contamination += output[index]! + Math.abs(output[index + 1]! - 180) + output[index + 2]!;
    }
    expect(source).toEqual(before);
    expect(fractionalAlpha).toBeGreaterThan(30);
    expect(contamination).toBe(0);
    const gray = pattern(w, h);
    const grayWarp = warpArtworkPixels(gray, w, h, field);
    expect(grayWarp).not.toEqual(gray);
    let graySpread = 0;
    for (let index = 0; index < grayWarp.length; index += 4) {
      graySpread = Math.max(graySpread, Math.abs(grayWarp[index]! - grayWarp[index + 1]!), Math.abs(grayWarp[index]! - grayWarp[index + 2]!));
    }
    expect(graySpread).toBe(0);
    expect(() => warpArtworkPixels(source, w, h, field, source)).toThrow("separate");
  });

  test("freezes final credit coordinates even when the artwork has a separate breathing zoom", () => {
    const w = 192;
    const h = 108;
    const source = pattern(w, h);
    const field = createArtworkWarpField(geometry(12), width, height, layout);
    const zoom = 1.035;
    const output = warpArtworkPixels(source, w, h, field, undefined, zoom);
    let protectedChanges = 0;
    for (let y = 0; y < h; y += 1) {
      const screenY = ((y + 0.5) / h * zoom + (1 - zoom) / 2) * height;
      if (screenY > layout.graphTop) continue;
      for (let x = 0; x < w * 4; x += 1) {
        if (output[y * w * 4 + x] !== source[y * w * 4 + x]) protectedChanges += 1;
      }
    }
    expect(protectedChanges).toBe(0);
    expect(warpArtworkPixels(source, w, h, { ...field, maximum: 0 })).toEqual(source);
  });

  test("cached canvas output reconstructs identically after arbitrary seeks without changing the source", () => {
    const source = createCanvas(192, 108);
    const context = source.getContext("2d");
    const image = context.createImageData(192, 108);
    image.data.set(pattern(192, 108));
    context.putImageData(image, 0, 0);
    const first = createArtworkWarpField(geometry(12), width, height, layout);
    const last = createArtworkWarpField(geometry(60), width, height, layout);
    const warp = new ArtworkWarp(source);
    const read = () => warp.render(first, 1.024).getContext("2d").getImageData(0, 0, 192, 108).data;
    const reference = read();
    warp.render(last, 1.04);
    warp.render(createArtworkWarpField(geometry(1), width, height, layout));
    expect(read()).toEqual(reference);
    expect(source.getContext("2d").getImageData(0, 0, 192, 108).data).toEqual(image.data);
  });

  test("replacing the background canvas cannot reuse the previous image's cached warp", () => {
    const source = createCanvas(128, 72);
    source.getContext("2d").fillStyle = "white";
    source.getContext("2d").fillRect(0, 0, 128, 72);
    const artwork: PreparedArtwork = {
      canvas: source, width, height, accentHue: 0, secondaryHue: 0, palette: randomPalette("warp-cache"),
    };
    const output = createCanvas(192, 108);
    const context = output.getContext("2d");
    context.scale(0.1, 0.1);
    const field = createArtworkWarpField(geometry(12), width, height, layout);
    drawArtwork(context, artwork, 12, undefined, field);
    expect(context.getImageData(0, 0, 192, 108).data.some((value) => value > 0)).toBe(true);
    context.clearRect(0, 0, width, height);
    drawArtwork(context, { ...artwork, canvas: createCanvas(128, 72) }, 12, undefined, field);
    expect(context.getImageData(0, 0, 192, 108).data.some((value) => value > 0)).toBe(false);
  });
});

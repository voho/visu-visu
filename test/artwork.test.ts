import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drawArtwork, prepareArtwork, deriveArtworkMotion } from "../src/render/artwork.js";
import type { MusicMotion } from "../src/render/music-motion.js";
import { sampleMaterial } from "../src/render/material.js";

let directory: string;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "visu-visu-artwork-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe("artwork preparation", () => {
  test("is optional and reports missing, invalid, or remote artwork clearly", async () => {
    expect(await prepareArtwork(undefined, 1920, 1080)).toBeUndefined();
    expect(await prepareArtwork("", 1920, 1080)).toBeUndefined();
    await expect(prepareArtwork(join(directory, "missing.png"), 320, 180)).rejects.toThrow("Could not read artwork");
    const invalid = join(directory, "invalid.png");
    await writeFile(invalid, "not an image");
    await expect(prepareArtwork(invalid, 320, 180)).rejects.toThrow("Could not decode artwork");
    for (const path of ["https://example.com/image.png", "data:image/png;base64,AAAA", "file:///tmp/image.png"]) {
      await expect(prepareArtwork(path, 320, 180)).rejects.toThrow("local file path");
    }
    await writeFile(invalid, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    await expect(prepareArtwork(invalid, 320, 180)).rejects.toThrow("raster image instead of SVG");
  });

  test("derives the dominant cover hue and decodes only during preparation", async () => {
    const source = createCanvas(120, 120);
    const context = source.getContext("2d");
    context.fillStyle = "#f04020";
    context.fillRect(0, 0, 120, 120);
    context.fillStyle = "#0066cc";
    context.fillRect(0, 0, 30, 120);
    const path = join(directory, "colors.png");
    await writeFile(path, source.toBuffer("image/png"));
    const prepared = await prepareArtwork(path, 1920, 1080);
    expect(prepared).toBeDefined();
    expect(prepared!.accentHue).toBeGreaterThanOrEqual(0);
    expect(prepared!.accentHue).toBeLessThanOrEqual(30);
    expect(prepared!.secondaryHue).toBeGreaterThanOrEqual(195);
    expect(prepared!.secondaryHue).toBeLessThanOrEqual(225);
    expect(Math.max(prepared!.canvas.width, prepared!.canvas.height)).toBeLessThanOrEqual(512);
    await rm(path);
    const output = createCanvas(1920, 1080);
    const outputContext = output.getContext("2d");
    const draw = (): Buffer => {
      outputContext.clearRect(0, 0, 1920, 1080);
      drawArtwork(outputContext, prepared!, 14);
      return Buffer.from(outputContext.getImageData(0, 0, 1920, 1080).data);
    };
    const first = draw();
    expect(draw().equals(first)).toBe(true);
    expect(first.some((value) => value > 0)).toBe(true);
  });

  for (const { name, width, height, heroY } of [
    { name: "landscape", width: 640, height: 360, heroY: 0.56 },
    { name: "portrait", width: 360, height: 640, heroY: 0.45 },
  ]) {
    test(`keeps bright, busy ${name} artwork behind readable credits and the hero`, async () => {
      const source = createCanvas(width, height);
      const context = source.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, width, height);
      for (let x = 0; x < width; x += 4) {
        context.fillStyle = x % 8 ? "#ff00ff" : "#00ffff";
        context.fillRect(x, 0, 2, height);
      }
      const path = join(directory, `${name}-busy.png`);
      await writeFile(path, source.toBuffer("image/png"));
      const prepared = (await prepareArtwork(path, width, height))!;
      const output = createCanvas(width, height);
      const outputContext = output.getContext("2d");
      outputContext.fillStyle = "black";
      outputContext.fillRect(0, 0, width, height);
      drawArtwork(outputContext, prepared, 25);
      const pixel = (x: number, y: number): number => {
        const [r = 0, g = 0, b = 0] = outputContext.getImageData(Math.round(x * width), Math.round(y * height), 1, 1).data;
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const peripheralLuminance = pixel(0.08, 0.85);
      expect(peripheralLuminance).toBeGreaterThan(20);
      expect(peripheralLuminance).toBeLessThan(80);
      expect(pixel(0.5, 0.23)).toBeLessThan(peripheralLuminance * 0.12);
      // Cover imagery now remains visible through the translucent material,
      // while white credits retain very strong contrast against their band.
      expect(pixel(0.5, heroY)).toBeGreaterThan(8);
      expect(pixel(0.5, heroY)).toBeLessThan(45);
      expect(pixel(0.5, 0.23)).toBeLessThan(5);
      // Fine source stripes are blurred into soft color rather than retaining
      // alternating high-contrast lines around the visualization.
      expect(Math.abs(pixel(0.08, 0.85) - pixel(0.08 + 2 / width, 0.85))).toBeLessThan(3);
    });
  }

  test("extracts the same full-image palette before portrait or landscape cropping", async () => {
    const source = createCanvas(800, 160);
    const context = source.getContext("2d");
    context.fillStyle = "#d8328f";
    context.fillRect(0, 0, 400, 160);
    context.fillStyle = "#1faf60";
    context.fillRect(400, 0, 400, 160);
    // A portrait crop sees primarily this pale center; extraction must still
    // retain the saturated edge colors from the artist's complete cover.
    context.fillStyle = "#dddddd";
    context.fillRect(325, 0, 150, 160);
    const path = join(directory, "full-source-palette.png");
    await writeFile(path, source.toBuffer("image/png"));
    const portrait = (await prepareArtwork(path, 360, 640))!;
    const landscape = (await prepareArtwork(path, 640, 360))!;
    expect(portrait.palette).toEqual(landscape.palette);
    const swatches = portrait.palette.colors.map((rgb) => rgb.map((value) => Math.round(value * 255)));
    expect(swatches).toContainEqual([216, 50, 143]);
    expect(swatches).toContainEqual([31, 175, 96]);
    expect(swatches).toContainEqual([221, 221, 221]);
  });

  test("keeps the complete image pigment and alpha on the object, separate from background masks", async () => {
    const source = createCanvas(64, 64);
    const context = source.getContext("2d");
    context.fillStyle = "#f05331";
    context.fillRect(0, 0, 32, 64);
    context.fillStyle = "#3c87b9";
    context.fillRect(32, 0, 32, 64);
    context.fillStyle = "white";
    context.fillRect(16, 8, 32, 12);
    context.clearRect(24, 42, 16, 12);
    const sourcePixels = context.getImageData(0, 0, 64, 64).data;
    const path = join(directory, "object-photo.png");
    await writeFile(path, source.toBuffer("image/png"));
    const landscape = (await prepareArtwork(path, 640, 360))!;
    const portrait = (await prepareArtwork(path, 360, 640))!;
    const object = landscape.objectMaterial!;
    expect(object.pigment).toBe("artwork");
    expect(object.width).toBe(64);
    expect(object.height).toBe(64);
    expect(object.albedo).toEqual(sourcePixels);
    expect(portrait.objectMaterial!.albedo).toEqual(object.albedo);
    expect(portrait.objectMaterial!.normals).toEqual(object.normals);
    const objectCreditPosition = sampleMaterial(object, 0.5, 0.22);
    const backgroundCreditPosition = sampleMaterial(landscape.material!, 0.5, 0.22);
    expect(objectCreditPosition.a).toBe(1);
    expect(objectCreditPosition.r).toBe(1);
    expect(backgroundCreditPosition.a).toBeLessThan(0.05);
    expect(sampleMaterial(object, 0.5, 0.75).a).toBe(0);
    for (let index = 0; index < object.normals.length; index += 3) {
      expect(Math.hypot(object.normals[index]!, object.normals[index + 1]!, object.normals[index + 2]!)).toBeCloseTo(1, 6);
    }
    expect(Math.min(...object.roughness)).toBeGreaterThanOrEqual(0.5);
    expect(Math.max(...object.roughness)).toBeLessThanOrEqual(0.74);
  });

  test("adds a feathered artwork vignette independently of the scene", async () => {
    const source = createCanvas(640, 360);
    const context = source.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, 640, 360);
    const path = join(directory, "white-vignette.png");
    await writeFile(path, source.toBuffer("image/png"));
    const artwork = (await prepareArtwork(path, 640, 360))!;
    const texture = artwork.canvas.getContext("2d");
    const alpha = (x: number, y: number): number => texture.getImageData(
      Math.floor(x * artwork.canvas.width), Math.floor(y * artwork.canvas.height), 1, 1,
    ).data[3]!;
    expect(alpha(0.05, 0.95)).toBeLessThan(alpha(0.16, 0.91) * 0.85);
    expect(alpha(0.16, 0.91)).toBeGreaterThan(70);
  });

  test("gently zooms on bass impulses without flashing or accumulating state", async () => {
    const source = createCanvas(360, 640);
    const sourceContext = source.getContext("2d");
    const gradient = sourceContext.createLinearGradient(0, 0, 360, 640);
    gradient.addColorStop(0, "#fd742a");
    gradient.addColorStop(0.5, "#173a5c");
    gradient.addColorStop(1, "#18d3ab");
    sourceContext.fillStyle = gradient;
    sourceContext.fillRect(0, 0, 360, 640);
    const path = join(directory, "beat-zoom.png");
    await writeFile(path, source.toBuffer("image/png"));
    const artwork = (await prepareArtwork(path, 360, 640))!;
    const output = createCanvas(360, 640);
    const context = output.getContext("2d");
    const music: MusicMotion = {
      slowTime: 10, fastTime: 20, bassPulse: 0, treblePulse: 0,
      bassEnergy: 0.4, midEnergy: 0.3, trebleEnergy: 0.1, attack: 0, sustain: 0.5,
    };
    const draw = (bassPulse: number): Buffer => {
      context.clearRect(0, 0, 360, 640);
      context.fillStyle = "black";
      context.fillRect(0, 0, 360, 640);
      context.globalAlpha = 0.75;
      const savedAlpha = context.globalAlpha;
      context.globalCompositeOperation = "source-over";
      context.filter = "none";
      drawArtwork(context, artwork, 12, { ...music, bassPulse });
      expect(context.globalAlpha).toBe(savedAlpha);
      expect(context.globalCompositeOperation).toBe("source-over");
      expect(context.filter).toBe("none");
      context.globalAlpha = 1;
      return Buffer.from(context.getImageData(0, 0, 360, 640).data);
    };
    const quiet = draw(0);
    const beat = draw(1);
    expect(beat.equals(quiet)).toBe(false);
    expect(draw(0).equals(quiet)).toBe(true);
    let brightnessDifference = 0;
    for (let index = 0; index < beat.length; index += 4) {
      for (let channel = 0; channel < 3; channel += 1) brightnessDifference += Math.abs(beat[index + channel]! - quiet[index + channel]!);
    }
    expect(brightnessDifference / (360 * 640 * 3)).toBeLessThan(0.5);
  });

  test("preserves source hues while bass has stronger saturation and beat response", () => {
    const silent: MusicMotion = {
      slowTime: 10, fastTime: 20, bassPulse: 0, treblePulse: 0,
      bassEnergy: 0, midEnergy: 0, trebleEnergy: 0, attack: 0, sustain: 0,
    };
    const neutral = deriveArtworkMotion(20);
    expect(neutral.hueShift).toBe(0);
    expect(neutral.saturation).toBe(1);
    const bass = deriveArtworkMotion(20, { ...silent, bassEnergy: 1 });
    const treble = deriveArtworkMotion(20, { ...silent, trebleEnergy: 1 });
    expect(bass.hueShift).toBe(0);
    expect(treble.hueShift).toBe(0);
    expect(bass.saturation - 1).toBeGreaterThan((treble.saturation - 1) * 2.5);
    const loud = deriveArtworkMotion(20, {
      ...silent, bassPulse: 100, bassEnergy: 100, midEnergy: 100, trebleEnergy: 100, sustain: 100,
    });
    expect(loud.saturation).toBeLessThanOrEqual(1.1);
    expect(loud.hueShift).toBe(0);
    expect(loud.zoom).toBeLessThan(1.04);
    expect(loud.opacity).toBeLessThanOrEqual(0.81);
    expect(deriveArtworkMotion(20, { ...silent, bassPulse: 1 }).opacity).toBe(deriveArtworkMotion(20, silent).opacity);
    expect(deriveArtworkMotion(20, { ...silent, bassEnergy: NaN }).hueShift).toBe(0);
  });
});

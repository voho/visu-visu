import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSafeLayout } from "../src/render/layout.js";
import { coverCameraAt, drawArtwork, prepareArtwork, deriveArtworkMotion } from "../src/render/artwork.js";
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
    expect(Math.max(prepared!.canvas.width, prepared!.canvas.height)).toBeLessThanOrEqual(768);
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
      expect(peripheralLuminance).toBeGreaterThan(30);
      expect(peripheralLuminance).toBeLessThan(150);
      // The original cover must flow through the credits without a full-width
      // dark stripe; the shade under the lockup only softens it for the letters.
      expect(pixel(0.5, 0.23)).toBeGreaterThan(peripheralLuminance * 0.45);
      expect(pixel(0.5, 0.23)).toBeLessThan(150);
      // The hero hole keeps the sculpture's ground darker than the periphery.
      expect(pixel(0.5, heroY)).toBeGreaterThan(8);
      expect(pixel(0.5, heroY)).toBeLessThan(peripheralLuminance * 0.85);
      // Fine source stripes (183 levels of contrast) are softened to a fraction
      // of that rather than retaining alternating high-contrast lines.
      expect(Math.abs(pixel(0.08, 0.85) - pixel(0.08 + 2 / width, 0.85))).toBeLessThan(24);
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
    expect(backgroundCreditPosition.a).toBeGreaterThan(0.4);
    expect(sampleMaterial(object, 0.5, 0.75).a).toBe(0);
    for (let index = 0; index < object.normals.length; index += 3) {
      expect(Math.hypot(object.normals[index]!, object.normals[index + 1]!, object.normals[index + 2]!)).toBeCloseTo(1, 6);
    }
    expect(Math.min(...object.roughness)).toBeGreaterThanOrEqual(0.5);
    expect(Math.max(...object.roughness)).toBeLessThanOrEqual(0.74);
  });

  test("samples the object pigment at up to 512 px on the long edge", async () => {
    const source = createCanvas(700, 400);
    const context = source.getContext("2d");
    context.fillStyle = "#3c87b9";
    context.fillRect(0, 0, 700, 400);
    context.fillStyle = "#f05331";
    context.fillRect(100, 60, 300, 200);
    const path = join(directory, "object-large.png");
    await writeFile(path, source.toBuffer("image/png"));
    const object = (await prepareArtwork(path, 640, 360))!.objectMaterial!;
    expect(object.width).toBe(512);
    expect(object.height).toBe(293);
    expect(sampleMaterial(object, 0.35, 0.4).r).toBeGreaterThan(0.9);
    expect(sampleMaterial(object, 0.9, 0.9).b).toBeGreaterThan(0.7);
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
    // The credit lockup sits on a baked shade; a flat image has no focal points.
    const layout = createSafeLayout(640, 360);
    const lockupY = (layout.titleY + 0.55 * (layout.graphTop - layout.titleY)) / 360;
    expect(alpha(0.5, lockupY)).toBeLessThanOrEqual(alpha(0.5, 0.85) * 0.65);
    expect(artwork.focal).toEqual({ a: [0.5, 0.5], b: [0.5, 0.5] });
  });

  test("finds the brightest and the most chromatic regions as focal points", async () => {
    const source = createCanvas(640, 360);
    const context = source.getContext("2d");
    // A mid-grey field: the white patch is the only bright region and the
    // orange patch (slightly darker than the field) the only chromatic one.
    context.fillStyle = "#808080";
    context.fillRect(0, 0, 640, 360);
    context.fillStyle = "#f8f8f8";
    context.fillRect(64, 36, 96, 72);
    context.fillStyle = "#e0602a";
    context.fillRect(448, 216, 96, 96);
    const path = join(directory, "focal.png");
    await writeFile(path, source.toBuffer("image/png"));
    const artwork = (await prepareArtwork(path, 640, 360))!;
    expect(artwork.focal!.a[0]).toBeCloseTo(112 / 640, 1);
    expect(artwork.focal!.a[1]).toBeCloseTo(72 / 360, 1);
    expect(artwork.focal!.b[0]).toBeCloseTo(496 / 640, 1);
    expect(artwork.focal!.b[1]).toBeCloseTo(264 / 360, 1);
  });

  test("samples the cover's bright saturated pixels as spaced ember colours, none from a grey cover", async () => {
    const source = createCanvas(640, 360);
    const context = source.getContext("2d");
    context.fillStyle = "#606060";
    context.fillRect(0, 0, 640, 360);
    // One bright orange spark, one bright teal patch and a dark red patch too dim to be light.
    context.fillStyle = "#ff8c40";
    context.fillRect(100, 100, 40, 40);
    context.fillStyle = "#40c8c0";
    context.fillRect(500, 240, 40, 40);
    context.fillStyle = "#300808";
    context.fillRect(300, 60, 40, 40);
    const path = join(directory, "embers.png");
    await writeFile(path, source.toBuffer("image/png"));
    const artwork = (await prepareArtwork(path, 640, 360))!;
    const colors = artwork.emberColors!;
    expect(colors.length).toBeGreaterThanOrEqual(4);
    expect(colors.length).toBeLessThanOrEqual(32);
    const hue = ([r, g, b]: readonly number[]): "orange" | "teal" | "other" =>
      r! > g! && g! > b! && r! - b! > 0.4 ? "orange" : g! > r! && b! > r! && g! - r! > 0.3 ? "teal" : "other";
    expect(colors.filter((rgb) => hue(rgb) === "orange").length).toBeGreaterThan(0);
    expect(colors.filter((rgb) => hue(rgb) === "teal").length).toBeGreaterThan(0);
    expect(colors.filter((rgb) => hue(rgb) === "other")).toEqual([]);
    // Spaced picks: a 40 px patch on a 640 px cover is 12 px on the 192 px crop, so at most a few picks per patch.
    expect(colors.filter((rgb) => hue(rgb) === "orange").length).toBeLessThanOrEqual(9);
    expect((await prepareArtwork(path, 640, 360))!.emberColors).toEqual(colors);

    const grey = createCanvas(64, 64);
    grey.getContext("2d").fillStyle = "#a0a0a0";
    grey.getContext("2d").fillRect(0, 0, 64, 64);
    const greyPath = join(directory, "grey-embers.png");
    await writeFile(greyPath, grey.toBuffer("image/png"));
    expect((await prepareArtwork(greyPath, 320, 180))!.emberColors).toEqual([]);
  });

  test("keeps the Ken Burns offset inside the zoom margin and moves with the section", () => {
    const focal = { a: [0.1, 0.9] as const, b: [0.95, 0.05] as const };
    for (const section of [0, 0.5, 1]) {
      for (const kick of [0, 1]) {
        for (const time of [0, 12, 75, 1000]) {
          const camera = coverCameraAt(time, section, kick, focal, 0.7, 1920, 1080, 40, -30);
          expect(Math.abs(camera.offsetX)).toBeLessThanOrEqual((camera.zoom - 1) * 960 + 1e-9);
          expect(Math.abs(camera.offsetY)).toBeLessThanOrEqual((camera.zoom - 1) * 540 + 1e-9);
          expect(camera.zoom).toBeGreaterThan(1);
        }
      }
    }
    const quiet = coverCameraAt(12, 0, 0, focal, 0.7, 1920, 1080);
    const loud = coverCameraAt(12, 1, 0, focal, 0.7, 1920, 1080);
    expect(loud.zoom).toBeGreaterThan(quiet.zoom);
    expect(loud.offsetX).not.toBe(quiet.offsetX);
    expect(coverCameraAt(12, 0, 0, focal, 0.7, 1920, 1080)).toEqual(quiet);
    // The kick alone adds 3% zoom, moving the texture corner by 28.8 px (1.5% of W); require at least 0.5%.
    const kicked = coverCameraAt(12, 0, 1, focal, 0.7, 1920, 1080);
    expect((kicked.zoom - quiet.zoom) * 960).toBeGreaterThanOrEqual(1920 * 0.005);
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
    const draw = (kick: number): Buffer => {
      context.clearRect(0, 0, 360, 640);
      context.fillStyle = "black";
      context.fillRect(0, 0, 360, 640);
      context.globalAlpha = 0.75;
      const savedAlpha = context.globalAlpha;
      context.globalCompositeOperation = "source-over";
      context.filter = "none";
      drawArtwork(context, artwork, 12, { kick, section: 0.4 });
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
    // The kick zooms the room without brightening it: the mean level of the
    // frame moves by less than 2% while the texture visibly shifts.
    let quietLevel = 0, beatLevel = 0;
    for (let index = 0; index < beat.length; index += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        quietLevel += quiet[index + channel]!;
        beatLevel += beat[index + channel]!;
      }
    }
    expect(Math.abs(beatLevel - quietLevel) / quietLevel).toBeLessThan(0.02);
  });

  test("pushes in and brightens with the section, never grades the colour", () => {
    const neutral = deriveArtworkMotion();
    expect(neutral.hueShift).toBe(0);
    expect(neutral.saturation).toBe(1);
    expect(neutral.zoom).toBeCloseTo(1.06, 10);
    expect(neutral.opacity).toBeCloseTo(0.8, 10);
    const loud = deriveArtworkMotion(100, 100);
    expect(loud.saturation).toBe(1);
    expect(loud.hueShift).toBe(0);
    expect(loud.zoom).toBeLessThan(1.25);
    expect(loud.opacity).toBeLessThanOrEqual(0.95);
    expect(loud.zoom).toBeGreaterThan(deriveArtworkMotion(1, 0).zoom);
    // The kick zooms but never lifts the opacity.
    expect(deriveArtworkMotion(0.3, 1).opacity).toBe(deriveArtworkMotion(0.3, 0).opacity);
    expect(deriveArtworkMotion(NaN, NaN)).toEqual(neutral);
  });
});

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { link, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isThumbnailRaster, renderThumbnail } from "../src/render/thumbnail.js";

let directory: string;
let imagePath: string;
let sourceBytes: Buffer<ArrayBuffer>;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "visu-thumbnail-render-"));
  imagePath = join(directory, "cover.png");
  const canvas = createCanvas(120, 120), context = canvas.getContext("2d");
  context.fillStyle = "#999999";
  context.fillRect(0, 0, 120, 120);
  context.fillStyle = "#dddddd";
  context.fillRect(20, 20, 20, 80);
  sourceBytes = Buffer.from(canvas.toBuffer("image/png"));
  await writeFile(imagePath, sourceBytes);
});

afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe("YouTube thumbnail rendering", () => {
  test("recognizes supported raster signatures and rejects disguised XML beyond a prefix scan", async () => {
    const canvas = createCanvas(8, 8);
    const images = await Promise.all([canvas.encode("png"), canvas.encode("jpeg"), canvas.encode("webp"), canvas.encode("avif")]);
    for (const bytes of images) expect(isThumbnailRaster(bytes)).toBe(true);
    expect(isThumbnailRaster(Buffer.from(`<!--${" ".repeat(8192)}--><svg></svg>`))).toBe(false);
    expect(isThumbnailRaster(Buffer.alloc(0))).toBe(false);
  });

  test("exports a sharp, grayscale-preserving 4K JPEG below 2 MB and writes no temporary debris", async () => {
    const outputPath = join(directory, "exports", "Night Blur.youtube.jpg");
    const result = await renderThumbnail({ imagePath, outputPath, title: "Night Blur", artist: "voho" });
    const bytes = await readFile(outputPath);
    expect(result).toMatchObject({ outputPath, width: 3840, height: 2160, bytes: bytes.length });
    expect(bytes.length).toBeLessThan(2_000_000);
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const image = await loadImage(bytes);
    expect([image.width, image.height]).toEqual([3840, 2160]);
    const canvas = createCanvas(3840, 2160), context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const cover = context.getImageData(960, 1080, 1, 1).data;
    const background = context.getImageData(3600, 200, 1, 1).data;
    expect(cover[0]!).toBeGreaterThan(140);
    expect(background[0]!).toBeLessThan(50);
    // A gray source must not acquire an unrelated accent hue in any layer.
    const pixels = context.getImageData(0, 0, 3840, 2160).data;
    let largestChroma = 0;
    for (let offset = 0; offset < pixels.length; offset += 4 * 607) {
      largestChroma = Math.max(largestChroma, Math.max(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!)
        - Math.min(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!));
    }
    expect(largestChroma).toBeLessThanOrEqual(2);
    expect(await readFile(imagePath)).toEqual(sourceBytes);
    expect(await readdir(join(directory, "exports"))).toEqual(["Night Blur.youtube.jpg"]);
    await expect(renderThumbnail({ imagePath, outputPath, title: "Other Song", artist: "voho" })).rejects.toThrow("already exists");
    expect(await readFile(outputPath)).toEqual(bytes);
    await renderThumbnail({ imagePath, outputPath, title: "Other Song", artist: "voho", overwrite: true });
    expect((await readFile(outputPath)).equals(bytes)).toBe(false);
  });

  test("never overwrites a cover, including aliases, even with overwrite enabled", async () => {
    const jpegCover = join(directory, "source.jpg");
    await writeFile(jpegCover, sourceBytes);
    const hardLink = join(directory, "hard-link.jpg"), symbolicLink = join(directory, "symbolic-link.jpg");
    await link(jpegCover, hardLink);
    await symlink(jpegCover, symbolicLink);
    for (const outputPath of [jpegCover, hardLink, symbolicLink]) {
      await expect(renderThumbnail({ imagePath: jpegCover, outputPath, title: "Song", artist: "voho", overwrite: true })).rejects.toThrow();
    }
    expect(await readFile(jpegCover)).toEqual(sourceBytes);
  });

  test("requires local raster art, credits and a JPEG destination", async () => {
    const base = { imagePath, outputPath: join(directory, "invalid.jpg"), title: "Song", artist: "voho" };
    await expect(renderThumbnail({ ...base, title: " \n " })).rejects.toThrow("title is required");
    await expect(renderThumbnail({ ...base, artist: " \t " })).rejects.toThrow("artist is required");
    await expect(renderThumbnail({ ...base, imagePath: "https://example.com/cover.png" })).rejects.toThrow("local file");
    await expect(renderThumbnail({ ...base, outputPath: join(directory, "invalid.png") })).rejects.toThrow(".jpg or .jpeg");
    const disguisedSvg = join(directory, "disguised.png");
    await writeFile(disguisedSvg, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    await expect(renderThumbnail({ ...base, imagePath: disguisedSvg })).rejects.toThrow("not SVG");
    expect((await readdir(directory)).includes("invalid.jpg")).toBe(false);
  });
});

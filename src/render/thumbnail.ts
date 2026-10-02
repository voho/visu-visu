import { createCanvas, GlobalFonts, loadImage, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { resolveArtworkPath } from "../config.js";
import { accentSwatches, extractPalette, rgbCss } from "./palette.js";

export interface ThumbnailOptions {
  imagePath: string;
  title: string;
  artist: string;
  outputPath: string;
  overwrite?: boolean;
}

export interface ThumbnailResult {
  outputPath: string;
  width: number;
  height: number;
  bytes: number;
  quality: number;
}

const WIDTH = 3840;
const HEIGHT = 2160;
const BYTE_LIMIT = 2_000_000;
let fontsReady = false;

function registerFonts(): void {
  if (fontsReady) return;
  for (const [file, family] of [["CormorantGaramond.ttf", "Thumbnail Serif"], ["Manrope.ttf", "Thumbnail Sans"]]) {
    if (!GlobalFonts.registerFromPath(resolve(import.meta.dir, "../../assets/fonts", file!), family!)) {
      throw new Error(`Could not load bundled thumbnail font: ${file}`);
    }
  }
  fontsReady = true;
}

function cleanCredit(value: string, label: string): string {
  const text = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!text) throw new Error(`Thumbnail ${label} is required.`);
  return text;
}

async function checkDestination(imagePath: string, outputPath: string, overwrite: boolean): Promise<void> {
  const source = await stat(imagePath);
  let destination;
  try { destination = await lstat(outputPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // Reject aliases before considering --overwrite. Replacing a cover is never
  // an intended thumbnail operation, including through a hard link or symlink.
  if (destination.isSymbolicLink()) throw new Error(`Thumbnail output must not be a symbolic link: ${outputPath}`);
  if (source.dev === destination.dev && source.ino === destination.ino) {
    throw new Error(`Thumbnail output would overwrite the source cover: ${outputPath}`);
  }
  if (!destination.isFile()) throw new Error(`Thumbnail output is not a regular file: ${outputPath}`);
  if (!overwrite) throw new Error(`Thumbnail already exists: ${outputPath}. Use --overwrite to replace it.`);
}

interface TextBlock {
  lines: string[];
  font: string;
  spacing: string;
  ascent: number;
  lineHeight: number;
  height: number;
}

function fitText(context: SKRSContext2D, text: string, width: number, initialSize: number, family: string, weight: number, tracking: number): TextBlock {
  let size = initialSize;
  for (;;) {
    const font = `${weight} ${size}px "${family}"`, spacing = `${size * tracking}px`;
    context.font = font;
    context.letterSpacing = spacing;
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > width) { lines.push(line); line = word; }
      else line = candidate;
    }
    if (line) lines.push(line);
    if (lines.length <= 2 && lines.every(value => context.measureText(value).width <= width)) {
      const measures = lines.map(value => context.measureText(value));
      const ascent = Math.max(...measures.map(value => value.actualBoundingBoxAscent));
      const descent = Math.max(...measures.map(value => value.actualBoundingBoxDescent));
      const lineHeight = size * 1.04;
      return { lines, font, spacing, ascent, lineHeight, height: ascent + descent + (lines.length - 1) * lineHeight };
    }
    if (size < 16) throw new Error("Thumbnail credit is too long to fit legibly. Use a shorter title or artist name.");
    size *= 0.94;
  }
}

function paintText(context: SKRSContext2D, block: TextBlock, x: number, top: number, color: string): void {
  context.font = block.font;
  context.letterSpacing = block.spacing;
  context.fillStyle = color;
  context.textBaseline = "alphabetic";
  context.shadowColor = "rgba(0,0,0,0.85)";
  context.shadowBlur = 50;
  context.shadowOffsetY = 8;
  for (let line = 0; line < block.lines.length; line += 1) {
    context.fillText(block.lines[line]!, x, top + block.ascent + line * block.lineHeight);
  }
}

/** Shared with batch preflight so every job accepts the same raster formats. */
export function isThumbnailRaster(bytes: Buffer): boolean {
  // Check signatures instead of extensions or an SVG substring scan: XML
  // comments can hide a renamed SVG's root element arbitrarily far into it.
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  let avif = false;
  if (bytes.length >= 16 && bytes.toString("ascii", 4, 8) === "ftyp") {
    const boxEnd = Math.min(bytes.readUInt32BE(0), bytes.length);
    for (let offset = 8; offset + 4 <= boxEnd; offset += 4) {
      if (offset === 12) continue; // minor version, not a format brand
      const brand = bytes.toString("ascii", offset, offset + 4);
      if (brand === "avif" || brand === "avis") avif = true;
    }
  }
  return png || jpeg || webp || avif;
}

async function composeThumbnail(imagePath: string, title: string, artist: string): Promise<Canvas> {
  const bytes = await readFile(imagePath);
  if (!isThumbnailRaster(bytes)) {
    throw new Error("Thumbnail cover must be a raster PNG, JPEG, WebP, or AVIF image, not SVG.");
  }
  let source;
  try {
    source = await loadImage(bytes);
    if (!(source.width > 0 && source.height > 0)) throw new Error("Image has no pixels");
  } catch (error) {
    throw new Error(`Could not decode thumbnail cover ${imagePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  registerFonts();
  const sampleScale = Math.min(1, 256 / Math.max(source.width, source.height));
  const sample = createCanvas(Math.max(1, Math.round(source.width * sampleScale)), Math.max(1, Math.round(source.height * sampleScale)));
  const sampleContext = sample.getContext("2d");
  sampleContext.drawImage(source, 0, 0, sample.width, sample.height);
  const palette = extractPalette(sampleContext.getImageData(0, 0, sample.width, sample.height).data);
  const roles = accentSwatches(palette);

  // A soft enlargement of the artwork provides continuity with the video.
  // Blur at quarter resolution keeps 4K export inexpensive and avoids detail
  // behind the credits; the foreground cover retains its original pigments.
  const backdrop = createCanvas(WIDTH / 4, HEIGHT / 4), back = backdrop.getContext("2d");
  back.fillStyle = rgbCss(palette.colors[roles.darkest]!);
  back.fillRect(0, 0, backdrop.width, backdrop.height);
  const fillScale = Math.max(backdrop.width / source.width, backdrop.height / source.height) * 1.12;
  const fillWidth = source.width * fillScale, fillHeight = source.height * fillScale;
  back.filter = "blur(24px)";
  back.drawImage(source, (backdrop.width - fillWidth) / 2, (backdrop.height - fillHeight) / 2, fillWidth, fillHeight);
  back.filter = "none";
  back.fillStyle = "rgba(0,0,0,0.74)";
  back.fillRect(0, 0, backdrop.width, backdrop.height);

  const canvas = createCanvas(WIDTH, HEIGHT), context = canvas.getContext("2d");
  context.drawImage(backdrop, 0, 0, WIDTH, HEIGHT);
  const glow = context.createRadialGradient(920, 1080, 80, 920, 1080, 1660);
  glow.addColorStop(0, rgbCss(palette.colors[roles.warm]!, 0.27));
  glow.addColorStop(1, rgbCss(palette.colors[roles.warm]!, 0));
  context.fillStyle = glow;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  const shade = context.createLinearGradient(0, 0, WIDTH, 0);
  shade.addColorStop(0, "rgba(0,0,0,0.04)");
  shade.addColorStop(0.55, "rgba(0,0,0,0.14)");
  shade.addColorStop(1, "rgba(0,0,0,0.46)");
  context.fillStyle = shade;
  context.fillRect(0, 0, WIDTH, HEIGHT);

  const cover = { x: 256, y: 368, size: 1424, radius: 32 };
  context.save();
  context.shadowColor = "rgba(0,0,0,0.80)";
  context.shadowBlur = 140;
  context.shadowOffsetY = 34;
  context.fillStyle = rgbCss(palette.colors[roles.darkest]!);
  context.beginPath();
  context.roundRect(cover.x, cover.y, cover.size, cover.size, cover.radius);
  context.fill();
  context.shadowBlur = 0;
  context.shadowOffsetY = 0;
  context.clip();
  // Contain non-square artwork instead of cutting off its content.
  const coverScale = Math.min(cover.size / source.width, cover.size / source.height);
  const artWidth = source.width * coverScale, artHeight = source.height * coverScale;
  context.drawImage(source, cover.x + (cover.size - artWidth) / 2, cover.y + (cover.size - artHeight) / 2, artWidth, artHeight);
  context.restore();
  context.strokeStyle = "rgba(255,255,255,0.12)";
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(cover.x + 1, cover.y + 1, cover.size - 2, cover.size - 2, cover.radius);
  context.stroke();

  const textX = 1920, textWidth = WIDTH - textX - 256;
  const heading = fitText(context, title, textWidth, 282, "Thumbnail Serif", 600, -0.012);
  const byline = fitText(context, artist, textWidth, 176, "Thumbnail Sans", 500, 0.035);
  const gap = 102;
  const top = (HEIGHT - heading.height - gap - byline.height) / 2;
  context.save();
  paintText(context, heading, textX, top, "#fafafa");
  paintText(context, byline, textX + 6, top + heading.height + gap, "#e8e8e8");
  context.restore();
  return canvas;
}

/** Native 4K artwork composition, compressed below the mobile upload limit. */
export async function renderThumbnail(options: ThumbnailOptions): Promise<ThumbnailResult> {
  const title = cleanCredit(options.title, "title"), artist = cleanCredit(options.artist, "artist");
  const imagePath = resolveArtworkPath(options.imagePath);
  if (!imagePath) throw new Error("Thumbnail cover image is required.");
  if (![".png", ".jpg", ".jpeg", ".webp", ".avif"].includes(extname(imagePath).toLowerCase())) {
    throw new Error("Thumbnail cover must be a local PNG, JPEG, WebP, or AVIF image.");
  }
  const outputPath = resolve(options.outputPath);
  if (![".jpg", ".jpeg"].includes(extname(outputPath).toLowerCase())) throw new Error("Thumbnail output must use a .jpg or .jpeg extension.");
  await checkDestination(imagePath, outputPath, options.overwrite ?? false);
  const canvas = await composeThumbnail(imagePath, title, artist);
  let quality = 95, encoded = await canvas.encode("jpeg", quality);
  while (encoded.length >= BYTE_LIMIT && quality > 5) {
    quality -= 5;
    encoded = await canvas.encode("jpeg", quality);
  }
  if (encoded.length >= BYTE_LIMIT) throw new Error("Could not encode a 4K thumbnail below 2 MB.");
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = resolve(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, encoded, { flag: "wx" });
    await checkDestination(imagePath, outputPath, options.overwrite ?? false);
    // A hard-link publication is atomic and exclusive. Rename is atomic when
    // explicitly replacing an existing thumbnail, and never follows symlinks.
    if (options.overwrite) await rename(temporary, outputPath);
    else await link(temporary, outputPath);
  } finally { await rm(temporary, { force: true }); }
  return { outputPath, width: WIDTH, height: HEIGHT, bytes: encoded.length, quality };
}

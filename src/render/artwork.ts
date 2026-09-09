import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createCanvas, loadImage, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { resolveArtworkPath } from "../config.js";
import { clamp, smoothstep } from "../math/random.js";
import { createSafeLayout } from "./layout.js";
import type { MusicMotion } from "./music-motion.js";
import { createMaterialFromRgba, type MaterialMap } from "./material.js";

export interface PreparedArtwork {
  /** Low-resolution, softened and masked texture; no per-frame image decoding. */
  canvas: Canvas;
  /** Target render dimensions (the texture itself is deliberately smaller). */
  width: number;
  height: number;
  accentHue: number;
  secondaryHue: number;
  /** Luminance-derived shallow relief, with the same quiet-area masks. */
  material?: MaterialMap;
}

export interface ArtworkMotion {
  zoom: number;
  hueShift: number;
  saturation: number;
  opacity: number;
}

/** A restrained frequency grade: bass carries the largest color and size response. */
export function deriveArtworkMotion(time: number, music?: MusicMotion): ArtworkMotion {
  const energy = (value: number | undefined): number => Number.isFinite(value) ? clamp(value!) : 0;
  const musicalTime = Number.isFinite(music?.slowTime)
    ? music!.slowTime
    : (Number.isFinite(time) ? Math.max(0, time) * 0.2 : 0);
  const bass = energy(music?.bassEnergy);
  const mid = energy(music?.midEnergy);
  const treble = energy(music?.trebleEnergy);
  return {
    zoom: 1.018 + Math.sin(musicalTime * 0.075) * 0.009 + energy(music?.bassPulse) * 0.012,
    hueShift: bass * -14 + mid * 5 + treble * 2.6,
    saturation: 1 + bass * 0.045 + mid * 0.03 + treble * 0.015,
    opacity: 0.72 + energy(music?.sustain) * 0.09,
  };
}

function paletteFromPixels(pixels: Uint8ClampedArray): { accentHue: number; secondaryHue: number } {
  const histogram = new Float64Array(24);
  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index]! / 255;
    const g = pixels[index + 1]! / 255;
    const b = pixels[index + 2]! / 255;
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    const chroma = maximum - minimum;
    if (chroma < 0.08 || maximum < 0.1) continue;
    let hue = maximum === r
      ? ((g - b) / chroma) % 6
      : maximum === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
    hue = ((hue * 60) + 360) % 360;
    const bin = Math.round(hue / 15) % histogram.length;
    // Ignore transparent padding, near-black colors, and white highlight noise.
    histogram[bin] = histogram[bin]! + chroma * maximum * pixels[index + 3]! / 255;
  }
  let dominant = -1;
  for (let index = 0; index < histogram.length; index += 1) {
    if (histogram[index]! > (dominant < 0 ? 0 : histogram[dominant]!)) dominant = index;
  }
  const accentHue = dominant < 0 ? 206 : dominant * 15;
  let secondary = -1;
  for (let index = 0; index < histogram.length; index += 1) {
    const distance = Math.abs(index * 15 - accentHue);
    if (Math.min(distance, 360 - distance) < 60) continue;
    if (histogram[index]! > (secondary < 0 ? 0 : histogram[secondary]!)) secondary = index;
  }
  return { accentHue, secondaryHue: secondary < 0 ? (accentHue + 60) % 360 : secondary * 15 };
}

/**
 * Prepare local raster artwork once. A cover crop preserves its peripheral
 * texture; blur, compressed luminance, and a fixed quiet region prevent bright
 * cover art or baked-in lettering from competing with the actual song credits.
 */
export async function prepareArtwork(
  imagePath: string | undefined,
  width: number,
  height: number,
): Promise<PreparedArtwork | undefined> {
  if (!imagePath?.trim()) return undefined;
  const path = resolveArtworkPath(imagePath);
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Artwork render dimensions must be finite and greater than zero");
  }
  if (![".png", ".jpg", ".jpeg", ".webp", ".avif"].includes(extname(path).toLowerCase())) {
    throw new Error(`Unsupported artwork format: ${path}. Use a local PNG, JPEG, WebP, or AVIF image.`);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new Error(`Could not read artwork ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Pass bytes, never a URL, to the loader. SVG is excluded even if renamed.
  if (bytes.subarray(0, 1024).toString("utf8").match(/<svg[\s>]/i)) {
    throw new Error(`Could not decode artwork ${path}: use a raster image instead of SVG.`);
  }
  let source;
  try {
    source = await loadImage(bytes);
    if (!(source.width > 0 && source.height > 0)) throw new Error("Image has no pixels");
  } catch (error) {
    throw new Error(`Could not decode artwork ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const scale = Math.min(1, 512 / Math.max(width, height));
  const textureWidth = Math.max(16, Math.round(width * scale));
  const textureHeight = Math.max(16, Math.round(height * scale));
  const raw = createCanvas(textureWidth, textureHeight);
  const rawContext = raw.getContext("2d");
  const cover = Math.max(textureWidth / source.width, textureHeight / source.height);
  const drawWidth = source.width * cover;
  const drawHeight = source.height * cover;
  rawContext.drawImage(source, (textureWidth - drawWidth) / 2, (textureHeight - drawHeight) / 2, drawWidth, drawHeight);
  const colors = paletteFromPixels(rawContext.getImageData(0, 0, textureWidth, textureHeight).data);

  const canvas = createCanvas(textureWidth, textureHeight);
  const context = canvas.getContext("2d");
  context.filter = `blur(${Math.max(0.65, Math.min(textureWidth, textureHeight) * 0.006)}px)`;
  context.drawImage(raw, 0, 0);
  context.filter = "none";
  const image = context.getImageData(0, 0, textureWidth, textureHeight);
  const layout = createSafeLayout(width, height);
  const textCenterY = (layout.titleY + layout.graphTop) / (2 * height);
  const textHalfHeight = (layout.graphTop - layout.titleY) / (2 * height) + 0.035;
  for (let y = 0; y < textureHeight; y += 1) {
    const ny = (y + 0.5) / textureHeight;
    // Wide, softly feathered horizontal credit band stays quiet while the
    // artwork breathes. The ellipse protects the entire moving hero volume.
    const creditMask = 1 - 0.98 * Math.exp(-Math.pow((ny - textCenterY) / textHalfHeight, 4));
    for (let x = 0; x < textureWidth; x += 1) {
      const nx = (x + 0.5) / textureWidth;
      const index = (y * textureWidth + x) * 4;
      const red = image.data[index]!;
      const green = image.data[index + 1]!;
      const blue = image.data[index + 2]!;
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      const mappedLuminance = 8 + 95 * Math.pow(luminance / 255, 0.9);
      for (let channel = 0; channel < 3; channel += 1) {
        image.data[index + channel] = clamp(mappedLuminance + (image.data[index + channel]! - luminance) * 0.36, 0, 135);
      }
      const heroX = (nx - layout.centerX / width) / 0.43;
      const heroY = (ny - layout.horizon / height) / ((layout.graphBottom - layout.graphTop) / (2 * height) + 0.06);
      const heroMask = 1 - 0.6 * Math.exp(-Math.pow(heroX * heroX + heroY * heroY, 2));
      // This belongs to the artwork itself, independently of the final scene's
      // vignette. Corners dissolve while the inner periphery retains texture.
      const edgeDistance = Math.hypot((nx - 0.5) / 0.7, (ny - 0.5) / 0.7);
      const imageVignette = 1 - 0.58 * smoothstep(0.48, 1.02, edgeDistance);
      image.data[index + 3] = Math.round(image.data[index + 3]! * creditMask * heroMask * imageVignette * 0.92);
    }
  }
  context.putImageData(image, 0, 0);
  const reliefWidth = Math.max(16, Math.round(textureWidth / 2));
  const reliefHeight = Math.max(16, Math.round(textureHeight / 2));
  const relief = createCanvas(reliefWidth, reliefHeight);
  const reliefContext = relief.getContext("2d");
  reliefContext.drawImage(raw, 0, 0, reliefWidth, reliefHeight);
  const material = createMaterialFromRgba(
    reliefContext.getImageData(0, 0, reliefWidth, reliefHeight).data,
    reliefWidth, reliefHeight,
  );
  reliefContext.clearRect(0, 0, reliefWidth, reliefHeight);
  reliefContext.drawImage(canvas, 0, 0, reliefWidth, reliefHeight);
  const protectedPixels = reliefContext.getImageData(0, 0, reliefWidth, reliefHeight).data;
  for (let index = 3; index < material.albedo.length; index += 4) {
    material.albedo[index] = protectedPixels[index]!;
  }
  return { canvas, width, height, ...colors, material };
}

/** Slow breathing plus a 1.2% bass impulse zoom; opacity never follows a beat. */
export function drawArtwork(
  context: SKRSContext2D,
  artwork: PreparedArtwork,
  time: number,
  music?: MusicMotion,
): void {
  const motion = deriveArtworkMotion(time, music);
  const width = artwork.width * motion.zoom;
  const height = artwork.height * motion.zoom;
  context.save();
  context.globalCompositeOperation = "screen";
  context.globalAlpha = motion.opacity;
  context.filter = `hue-rotate(${motion.hueShift}deg) saturate(${motion.saturation})`;
  context.drawImage(artwork.canvas, (artwork.width - width) / 2, (artwork.height - height) / 2, width, height);
  context.restore();
}

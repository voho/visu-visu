import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createCanvas, loadImage, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { resolveArtworkPath } from "../config.js";
import { clamp, smoothstep } from "../math/random.js";
import { createSafeLayout } from "./layout.js";
import { extractPalette, rgbHue, type ScenePalette } from "./palette.js";
import type { MusicMotion } from "./music-motion.js";
import { createMaterialFromRgba, type MaterialMap } from "./material.js";
import { ArtworkWarp, type ArtworkWarpField } from "./artwork-warp.js";

// Cache by the actual source canvas, including replacement canvases used when
// isolating the object texture. A copied PreparedArtwork cannot revive a cover.
const artworkWarps = new WeakMap<Canvas, ArtworkWarp>();

export interface PreparedArtwork {
  /** Low-resolution, softened and masked texture; no per-frame image decoding. */
  canvas: Canvas;
  /** Sharp, ungraded square cover for the track-credit lockup. */
  thumbnail?: Canvas;
  /** Target render dimensions (the texture itself is deliberately smaller). */
  width: number;
  height: number;
  accentHue: number;
  secondaryHue: number;
  palette: ScenePalette;
  /** Luminance-derived shallow relief, with the same quiet-area masks. */
  material?: MaterialMap;
  /** Full, uncropped cover pigment and relief for the moving object itself. */
  objectMaterial?: MaterialMap;
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
    hueShift: 0,
    saturation: 1 + bass * 0.045 + mid * 0.03 + treble * 0.015,
    opacity: 0.72 + energy(music?.sustain) * 0.09,
  };
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

  // Sample the whole source before the aspect-specific crop or quiet masks.
  // Landscape/portrait exports therefore keep the same artist-chosen colors.
  const paletteScale = Math.min(1, 256 / Math.max(source.width, source.height));
  const paletteCanvas = createCanvas(Math.max(1, Math.round(source.width * paletteScale)), Math.max(1, Math.round(source.height * paletteScale)));
  const paletteContext = paletteCanvas.getContext("2d");
  paletteContext.drawImage(source, 0, 0, paletteCanvas.width, paletteCanvas.height);
  const palettePixels = paletteContext.getImageData(0, 0, paletteCanvas.width, paletteCanvas.height).data;
  const palette = extractPalette(palettePixels);
  // Credits show a recognizable miniature of the source, independently of the
  // softened, darkened background and the object's lighting/normal maps.
  const thumbnail = createCanvas(256, 256);
  const sourceSide = Math.min(source.width, source.height);
  thumbnail.getContext("2d").drawImage(
    source, (source.width - sourceSide) / 2, (source.height - sourceSide) / 2,
    sourceSide, sourceSide, 0, 0, thumbnail.width, thumbnail.height,
  );
  // The object receives the complete image before background contrast changes,
  // aspect cropping, vignette or credit/hero masks. Tiny dimensions are expanded
  // only to satisfy finite-difference normal sampling.
  const objectCanvas = createCanvas(Math.max(2, paletteCanvas.width), Math.max(2, paletteCanvas.height));
  const objectContext = objectCanvas.getContext("2d");
  objectContext.drawImage(source, 0, 0, objectCanvas.width, objectCanvas.height);
  const objectMaterial = createMaterialFromRgba(
    objectContext.getImageData(0, 0, objectCanvas.width, objectCanvas.height).data,
    objectCanvas.width, objectCanvas.height,
    { blurRadius: Math.max(1, Math.round(Math.min(objectCanvas.width, objectCanvas.height) * 0.008)), strength: 0.035 },
  );
  for (let index = 0; index < objectMaterial.roughness.length; index += 1) {
    objectMaterial.roughness[index] = clamp(0.68 - objectMaterial.heightMap[index]! * 0.14, 0.5, 0.74);
  }
  const colors = {
    palette, accentHue: palette.anchorHue,
    secondaryHue: rgbHue(palette.colors[1] ?? palette.colors[0] ?? [0.5, 0.5, 0.5]),
  };

  const scale = Math.min(1, 512 / Math.max(width, height));
  const textureWidth = Math.max(16, Math.round(width * scale));
  const textureHeight = Math.max(16, Math.round(height * scale));
  const raw = createCanvas(textureWidth, textureHeight);
  const rawContext = raw.getContext("2d");
  const cover = Math.max(textureWidth / source.width, textureHeight / source.height);
  const drawWidth = source.width * cover;
  const drawHeight = source.height * cover;
  rawContext.drawImage(source, (textureWidth - drawWidth) / 2, (textureHeight - drawHeight) / 2, drawWidth, drawHeight);

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
  artworkWarps.set(canvas, new ArtworkWarp(canvas));
  return { canvas, thumbnail, width, height, ...colors, material, objectMaterial };
}

/** Slow breathing plus a 1.2% bass impulse zoom; opacity never follows a beat. */
export function drawArtwork(
  context: SKRSContext2D,
  artwork: PreparedArtwork,
  time: number,
  music?: MusicMotion,
  warpField?: ArtworkWarpField,
): void {
  const motion = deriveArtworkMotion(time, music);
  const width = artwork.width * motion.zoom;
  const height = artwork.height * motion.zoom;
  context.save();
  context.globalCompositeOperation = "screen";
  context.globalAlpha = motion.opacity;
  context.filter = `saturate(${motion.saturation})`;
  let canvas = artwork.canvas;
  if (warpField) {
    let warp = artworkWarps.get(canvas);
    if (!warp) { warp = new ArtworkWarp(canvas); artworkWarps.set(canvas, warp); }
    canvas = warp.render(warpField, motion.zoom);
  }
  context.drawImage(canvas, (artwork.width - width) / 2, (artwork.height - height) / 2, width, height);
  context.restore();
}

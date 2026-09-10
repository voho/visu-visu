import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createCanvas, loadImage, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { resolveArtworkPath } from "../config.js";
import { clamp, lerp, smoothstep } from "../math/random.js";
import { createSafeLayout, creditLockupEllipse } from "./layout.js";
import type { Rgb } from "./lighting.js";
import { extractPalette, rgbHue, type ScenePalette } from "./palette.js";
import { createMaterialFromRgba, type MaterialMap } from "./material.js";

/** Crop-normalized points the cover camera travels between. */
export interface ArtworkFocalPoints {
  /** Luma-weighted centre of the brightest tenth of the crop (a window, a sky). */
  a: readonly [number, number];
  /** Chroma-weighted centre of the saturated, lit pixels (a figure, a subject). */
  b: readonly [number, number];
}

const CENTER_FOCAL: ArtworkFocalPoints = { a: [0.5, 0.5], b: [0.5, 0.5] };

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
  /** Missing on hand-built fixtures: the camera then stays centred. */
  focal?: ArtworkFocalPoints;
  /** The cover's brightest saturated pixels (0..1 RGB), the light its embers float in; missing on fixtures. */
  emberColors?: Rgb[];
}

export interface ArtworkMotion {
  zoom: number;
  hueShift: number;
  saturation: number;
  opacity: number;
}

export interface CoverCamera {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export interface ArtworkDrawOptions {
  /** Section level (0 quiet .. 1 loudest passage): pushes in and brightens. */
  section?: number;
  /** The room's hit momentum (0..1): a short lean-in that peaks 140 ms after a kept kick. */
  kick?: number;
  /** Graph-camera pan in pixels; the cover follows a third of it as parallax. */
  panX?: number;
  panY?: number;
  /** Per-render phase so two covers never share the same Ken Burns timing. */
  seedPhase?: number;
  /** A camera the caller already derived for its parallax planes; derived from the options above when absent. */
  camera?: CoverCamera;
  /** How much of the sculpture is there (0..1); before it arrives the cover alone carries the shot, a little brighter. */
  presence?: number;
}

/** Ember colours to keep: enough for variety, few enough that each is a real spark, window or leaf. */
const EMBER_COLOR_COUNT = 32;
/** Minimum distance (px on the 192 px crop) between picks, so one bright spark does not supply every ember. */
const EMBER_PICK_SPACING = 6;
/** Below this chroma x luma a pixel is grey or dark: no ember light in it. */
const EMBER_MIN_SCORE = 0.02;

const unit = (value: number | undefined): number => Number.isFinite(value) ? clamp(value!) : 0;

/**
 * The room pushes in and brightens with the musical section; a kick leans it
 * in a little further, with the momentum of the heaviest thing in the frame.
 * Colour is never graded here: the texture carries its own chroma.
 */
export function deriveArtworkMotion(section = 0, kick = 0): ArtworkMotion {
  return {
    zoom: 1.06 + unit(section) * 0.12 + unit(kick) * 0.025,
    hueShift: 0,
    saturation: 1,
    opacity: 0.80 + unit(section) * 0.14,
  };
}

/**
 * Ken Burns between the cover's brightest and most chromatic regions over a
 * 48 s sinusoid, plus a slow wander. The offset never exceeds the margin the
 * zoom creates, so the base beneath the cover stays hidden at every pose.
 */
export function coverCameraAt(
  time: number,
  section: number,
  kick: number,
  focal: ArtworkFocalPoints,
  seedPhase: number,
  width: number,
  height: number,
  panX = 0,
  panY = 0,
): CoverCamera {
  const safeTime = Number.isFinite(time) ? time : 0;
  const { zoom } = deriveArtworkMotion(section, kick);
  const travel = 0.5 + 0.5 * Math.sin((2 * Math.PI * safeTime) / 48 + (Number.isFinite(seedPhase) ? seedPhase : 0));
  const targetX = lerp(focal.a[0], focal.b[0], travel) + Math.sin(safeTime * 0.061) * 0.012;
  const targetY = lerp(focal.a[1], focal.b[1], travel) + Math.cos(safeTime * 0.049) * 0.009;
  // Twice the shift that would centre the target: at the small zooms of quiet
  // passages the drift between window and figure would otherwise be invisible.
  const marginX = ((zoom - 1) * width) / 2;
  const marginY = ((zoom - 1) * height) / 2;
  return {
    zoom,
    offsetX: clamp((0.5 - targetX) * 2 * (zoom - 1) * width + (Number.isFinite(panX) ? panX : 0), -marginX, marginX),
    offsetY: clamp((0.5 - targetY) * 2 * (zoom - 1) * height + (Number.isFinite(panY) ? panY : 0), -marginY, marginY),
  };
}

/**
 * Where the eye goes on this cover, measured once on a small crop. Both points
 * fall back to the centre when their pixel set is empty (flat or grey images).
 */
function findFocalPoints(pixels: Uint8ClampedArray, width: number, height: number): ArtworkFocalPoints {
  const count = width * height;
  const lumas = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const at = index * 4;
    lumas[index] = (0.2126 * pixels[at]! + 0.7152 * pixels[at + 1]! + 0.0722 * pixels[at + 2]!) / 255;
  }
  const sorted = Float32Array.from(lumas).sort();
  const brightFloor = sorted[Math.min(count - 1, Math.floor(count * 0.9))] ?? 1;
  let brightX = 0, brightY = 0, brightWeight = 0;
  let chromaX = 0, chromaY = 0, chromaWeight = 0;
  for (let index = 0; index < count; index += 1) {
    const x = ((index % width) + 0.5) / width;
    const y = (Math.floor(index / width) + 0.5) / height;
    // Weight by the excess over the floor: a flat background sitting exactly on
    // the percentile contributes nothing and cannot drag the point to the centre.
    const brightness = lumas[index]! - brightFloor;
    if (brightness > 0) {
      brightX += x * brightness; brightY += y * brightness; brightWeight += brightness;
    }
    const luma = lumas[index]!;
    const at = index * 4;
    const chroma = (Math.max(pixels[at]!, pixels[at + 1]!, pixels[at + 2]!) - Math.min(pixels[at]!, pixels[at + 1]!, pixels[at + 2]!)) / 255;
    if (chroma > 0.25 && luma > 0.35) {
      chromaX += x * chroma; chromaY += y * chroma; chromaWeight += chroma;
    }
  }
  return {
    a: brightWeight > 0 ? [brightX / brightWeight, brightY / brightWeight] : [0.5, 0.5],
    b: chromaWeight > 0 ? [chromaX / chromaWeight, chromaY / chromaWeight] : [0.5, 0.5],
  };
}

/**
 * The cover's own light: its most saturated bright pixels, spaced apart on
 * the crop so several regions contribute (this cover: orange sparks, window
 * cream, teal frame). Empty for grey covers; the renderer then uses the
 * accent swatches.
 */
function findEmberColors(pixels: Uint8ClampedArray, width: number, height: number): Rgb[] {
  const scored: Array<{ index: number; score: number }> = [];
  for (let index = 0; index < width * height; index += 1) {
    const at = index * 4;
    const red = pixels[at]! / 255, green = pixels[at + 1]! / 255, blue = pixels[at + 2]! / 255;
    const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const score = chroma * luma;
    if (score >= EMBER_MIN_SCORE) scored.push({ index, score });
  }
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  const picks: number[] = [];
  for (const { index } of scored) {
    if (picks.length === EMBER_COLOR_COUNT) break;
    const x = index % width, y = Math.floor(index / width);
    if (picks.every((pick) => Math.hypot(x - (pick % width), y - Math.floor(pick / width)) >= EMBER_PICK_SPACING)) picks.push(index);
  }
  return picks.map((index) => [pixels[index * 4]! / 255, pixels[index * 4 + 1]! / 255, pixels[index * 4 + 2]! / 255]);
}

/**
 * Prepare local raster artwork once. The cover keeps its own chroma and most
 * of its tonal range; only a soft hero hole, a corner vignette and a shade
 * under the credit lockup are baked in so the sculpture and the letters read.
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
  // only to satisfy finite-difference normal sampling. 512 px on the long edge
  // with a ~1.5 px relief blur keeps the skin's tiles reading as pigment rather
  // than macroblocks; sampling cost is per face, not per texel.
  const objectScale = Math.min(1, 512 / Math.max(source.width, source.height));
  const objectCanvas = createCanvas(
    Math.max(2, Math.round(source.width * objectScale)),
    Math.max(2, Math.round(source.height * objectScale)),
  );
  const objectContext = objectCanvas.getContext("2d");
  objectContext.drawImage(source, 0, 0, objectCanvas.width, objectCanvas.height);
  const objectMaterial = createMaterialFromRgba(
    objectContext.getImageData(0, 0, objectCanvas.width, objectCanvas.height).data,
    objectCanvas.width, objectCanvas.height,
    { blurRadius: Math.max(1, Math.round(Math.min(objectCanvas.width, objectCanvas.height) * 0.003)), strength: 0.035 },
  );
  for (let index = 0; index < objectMaterial.roughness.length; index += 1) {
    objectMaterial.roughness[index] = clamp(0.68 - objectMaterial.heightMap[index]! * 0.14, 0.5, 0.74);
  }
  const colors = {
    palette, accentHue: palette.anchorHue,
    secondaryHue: rgbHue(palette.colors[1] ?? palette.colors[0] ?? [0.5, 0.5, 0.5]),
  };

  const scale = Math.min(1, 768 / Math.max(width, height));
  const textureWidth = Math.max(16, Math.round(width * scale));
  const textureHeight = Math.max(16, Math.round(height * scale));
  const raw = createCanvas(textureWidth, textureHeight);
  const rawContext = raw.getContext("2d");
  const cover = Math.max(textureWidth / source.width, textureHeight / source.height);
  const drawWidth = source.width * cover;
  const drawHeight = source.height * cover;
  rawContext.drawImage(source, (textureWidth - drawWidth) / 2, (textureHeight - drawHeight) / 2, drawWidth, drawHeight);

  const focalScale = 192 / Math.max(textureWidth, textureHeight);
  const focalCanvas = createCanvas(Math.max(1, Math.round(textureWidth * focalScale)), Math.max(1, Math.round(textureHeight * focalScale)));
  focalCanvas.getContext("2d").drawImage(raw, 0, 0, focalCanvas.width, focalCanvas.height);
  const focalPixels = focalCanvas.getContext("2d").getImageData(0, 0, focalCanvas.width, focalCanvas.height).data;
  const focal = findFocalPoints(focalPixels, focalCanvas.width, focalCanvas.height);
  const emberColors = findEmberColors(focalPixels, focalCanvas.width, focalCanvas.height);

  const canvas = createCanvas(textureWidth, textureHeight);
  const context = canvas.getContext("2d");
  context.filter = `blur(${Math.max(0.65, Math.min(textureWidth, textureHeight) * 0.0035)}px)`;
  context.drawImage(raw, 0, 0);
  context.filter = "none";
  const image = context.getImageData(0, 0, textureWidth, textureHeight);
  const layout = createSafeLayout(width, height);
  // The lockup sits between titleY and graphTop; shade an ellipse around it.
  const credit = creditLockupEllipse(layout, width, height);
  for (let y = 0; y < textureHeight; y += 1) {
    const ny = (y + 0.5) / textureHeight;
    for (let x = 0; x < textureWidth; x += 1) {
      const nx = (x + 0.5) / textureWidth;
      const index = (y * textureWidth + x) * 4;
      const red = image.data[index]!;
      const green = image.data[index + 1]!;
      const blue = image.data[index + 2]!;
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      // Lift the blacks a little and cap the highlights so white letters and
      // the sculpture's halo stay the brightest things in the frame; the
      // pigment's own chroma is kept in full.
      const mappedLuminance = 255 * (0.03 + 0.78 * Math.pow(luminance / 255, 0.95));
      for (let channel = 0; channel < 3; channel += 1) {
        image.data[index + channel] = clamp(mappedLuminance + (image.data[index + channel]! - luminance), 0, 215);
      }
      const heroX = (nx - layout.centerX / width) / 0.43;
      const heroY = (ny - layout.horizon / height) / ((layout.graphBottom - layout.graphTop) / (2 * height) + 0.06);
      const heroMask = 1 - 0.42 * Math.exp(-Math.pow(heroX * heroX + heroY * heroY, 2));
      // This belongs to the artwork itself, independently of the final scene's
      // vignette. Corners dissolve while the inner periphery retains texture.
      const edgeDistance = Math.hypot((nx - 0.5) / 0.7, (ny - 0.5) / 0.7);
      const imageVignette = 1 - 0.45 * smoothstep(0.55, 1.02, edgeDistance);
      const creditDistance = ((nx - credit.x) / credit.rx) ** 2 + ((ny - credit.y) / credit.ry) ** 2;
      const creditShade = 1 - 0.40 * Math.exp(-Math.pow(creditDistance, 1.5));
      image.data[index + 3] = Math.round(image.data[index + 3]! * heroMask * imageVignette * creditShade);
    }
  }
  context.putImageData(image, 0, 0);
  const reliefScale = Math.min(0.5, 256 / Math.max(textureWidth, textureHeight));
  const reliefWidth = Math.max(16, Math.round(textureWidth * reliefScale));
  const reliefHeight = Math.max(16, Math.round(textureHeight * reliefScale));
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
  return { canvas, thumbnail, width, height, ...colors, material, objectMaterial, focal, emberColors };
}

/** The camera drawArtwork would derive from these options; callers that need it for parallax share it. */
export function artworkCameraAt(artwork: PreparedArtwork, time: number, options: ArtworkDrawOptions = {}): CoverCamera {
  return coverCameraAt(
    time, unit(options.section), unit(options.kick), artwork.focal ?? CENTER_FOCAL, options.seedPhase ?? 0,
    artwork.width, artwork.height, (options.panX ?? 0) * 0.35, (options.panY ?? 0) * 0.35,
  );
}

/** The cover as an opaque room: source-over, no filter, camera from the section and kick. */
export function drawArtwork(
  context: SKRSContext2D,
  artwork: PreparedArtwork,
  time: number,
  options: ArtworkDrawOptions = {},
): void {
  const section = unit(options.section);
  const kick = unit(options.kick);
  const camera = options.camera ?? artworkCameraAt(artwork, time, options);
  const width = artwork.width * camera.zoom;
  const height = artwork.height * camera.zoom;
  context.save();
  context.globalCompositeOperation = "source-over";
  // The opening shot is the cover alone, a little brighter; it settles to its
  // section exposure as the sculpture arrives, so the steady state is unchanged.
  const presence = options.presence === undefined ? 1 : unit(options.presence);
  context.globalAlpha = Math.min(1, deriveArtworkMotion(section, kick).opacity * (1 + 0.12 * (1 - presence)));
  context.imageSmoothingEnabled = true;
  // The texture is pre-blurred; bicubic resampling costs 24 ms more per frame
  // at 1080p for no visible gain over bilinear.
  context.imageSmoothingQuality = "medium";
  context.drawImage(
    artwork.canvas,
    (artwork.width - width) / 2 + camera.offsetX,
    (artwork.height - height) / 2 + camera.offsetY,
    width, height,
  );
  context.restore();
}

import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { clamp, smoothstep } from "../math/random.js";
import type { SafeLayout } from "./layout.js";
import type { ResonanceFilament } from "./resonance.js";

export interface ArtworkWarpCamera {
  a: number; b: number; c: number; d: number; e: number; f: number;
}

export interface ArtworkWarpAnchor {
  x: number;
  y: number;
  directionX: number;
  directionY: number;
  radius: number;
  weight: number;
}

/** Screen-space geometry landmarks; callers supply delayed, smoothed poses. */
export interface ArtworkWarpField {
  width: number;
  height: number;
  creditBottom: number;
  maximum: number;
  anchors: readonly ArtworkWarpAnchor[];
}

const IDENTITY: ArtworkWarpCamera = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const GRID_SIZE = 33;
const fieldGrids = new WeakMap<ArtworkWarpField, Float32Array>();

/** Stable strand/point indices avoid depth-sort flicker as the sculpture turns. */
export function createArtworkWarpField(
  filaments: readonly ResonanceFilament[],
  width: number,
  height: number,
  layout: SafeLayout,
  camera: ArtworkWarpCamera = IDENTITY,
  strength = 1,
): ArtworkWarpField {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Artwork warp dimensions must be finite and positive");
  }
  const matrix = Object.values(camera).every(Number.isFinite) ? camera : IDENTITY;
  const centerX = matrix.a * layout.centerX + matrix.c * layout.horizon + matrix.e;
  const centerY = matrix.b * layout.centerX + matrix.d * layout.horizon + matrix.f;
  const shorter = Math.min(width, height);
  const anchors: ArtworkWarpAnchor[] = [];
  const strandCount = Math.min(6, filaments.length);
  for (let strand = 0; strand < strandCount; strand += 1) {
    const points = filaments[Math.floor(strand * filaments.length / strandCount)]!.points;
    const count = points.length - 1;
    if (count < 2) continue;
    for (let sample = 0; sample < Math.min(4, count); sample += 1) {
      const index = Math.floor(sample * count / Math.min(4, count));
      const point = points[index]!;
      const previous = points[(index + count - 1) % count]!;
      const next = points[(index + 1) % count]!;
      const x = matrix.a * point.x + matrix.c * point.y + matrix.e;
      const y = matrix.b * point.x + matrix.d * point.y + matrix.f;
      const tangentX = matrix.a * (next.x - previous.x) + matrix.c * (next.y - previous.y);
      const tangentY = matrix.b * (next.x - previous.x) + matrix.d * (next.y - previous.y);
      if (![x, y, tangentX, tangentY].every(Number.isFinite)) continue;
      const tangentLength = Math.max(1, Math.hypot(tangentX, tangentY));
      const radialLength = Math.max(shorter * 0.035, Math.hypot(x - centerX, y - centerY));
      const depth = Number.isFinite(point.depth) ? clamp(point.depth) : 0.5;
      anchors.push({
        x, y,
        directionX: (x - centerX) / radialLength * 0.75 + tangentX / tangentLength * 0.25,
        directionY: (y - centerY) / radialLength * 0.75 + tangentY / tangentLength * 0.25,
        radius: shorter * (0.19 + depth * 0.07),
        weight: 0.45 + depth * 0.55,
      });
    }
  }
  return {
    width, height, creditBottom: layout.graphTop,
    maximum: shorter * 0.006 * (Number.isFinite(strength) ? clamp(strength) : 0),
    anchors,
  };
}

/** Blend corresponding landmarks, never history-dependent pixel feedback. */
export function blendArtworkWarpFields(fields: readonly ArtworkWarpField[], weights: readonly number[]): ArtworkWarpField {
  if (fields.length === 0 || fields.length !== weights.length) throw new Error("Artwork warp fields need matching weights");
  const first = fields[0]!;
  if (fields.some((field) => field.width !== first.width || field.height !== first.height || field.anchors.length !== first.anchors.length)) {
    throw new Error("Artwork warp fields must share dimensions and landmark count");
  }
  const safeWeights = weights.map((weight) => Number.isFinite(weight) ? Math.max(0, weight) : 0);
  const total = safeWeights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) throw new Error("Artwork warp weights must have a positive sum");
  const weighted = (get: (field: ArtworkWarpField) => number): number => fields.reduce((sum, field, index) => sum + get(field) * safeWeights[index]! / total, 0);
  return {
    width: first.width, height: first.height,
    creditBottom: weighted((field) => field.creditBottom),
    maximum: weighted((field) => field.maximum),
    anchors: first.anchors.map((_, index) => ({
      x: weighted((field) => field.anchors[index]!.x),
      y: weighted((field) => field.anchors[index]!.y),
      directionX: weighted((field) => field.anchors[index]!.directionX),
      directionY: weighted((field) => field.anchors[index]!.directionY),
      radius: weighted((field) => field.anchors[index]!.radius),
      weight: weighted((field) => field.anchors[index]!.weight),
    })),
  };
}

function protection(field: ArtworkWarpField, x: number, y: number): number {
  const edge = Math.min(field.width, field.height) * 0.085;
  return smoothstep(field.creditBottom, field.creditBottom + field.height * 0.10, y)
    * smoothstep(0, edge, x) * (1 - smoothstep(field.width - edge, field.width, x))
    * (1 - smoothstep(field.height - edge, field.height, y));
}

function rawDisplacement(field: ArtworkWarpField, x: number, y: number, out: { x: number; y: number }): void {
  let dx = 0;
  let dy = 0;
  let total = 0;
  for (const anchor of field.anchors) {
    const rx = (x - anchor.x) / anchor.radius;
    const ry = (y - anchor.y) / anchor.radius;
    const squared = rx * rx + ry * ry;
    if (squared >= 1) continue;
    const weight = (1 - squared) ** 3 * anchor.weight;
    dx += (rx * 0.8 + anchor.directionX * 0.4) * weight;
    dy += (ry * 0.8 + anchor.directionY * 0.4) * weight;
    total += weight;
  }
  const gain = field.maximum * 1.4 / (0.55 + total);
  const length = Math.hypot(dx * gain, dy * gain);
  const limit = length > field.maximum && length > 0 ? field.maximum / length : 1;
  out.x = dx * gain * limit;
  out.y = dy * gain * limit;
}

/** Outward/tangential displacement in final output pixels, always bounded. */
export function artworkDisplacementAt(
  field: ArtworkWarpField, x: number, y: number, out = { x: 0, y: 0 },
): { x: number; y: number } {
  rawDisplacement(field, x, y, out);
  const mask = protection(field, x, y);
  out.x *= mask;
  out.y *= mask;
  return out;
}

function displacementGrid(field: ArtworkWarpField): Float32Array {
  const cached = fieldGrids.get(field);
  if (cached) return cached;
  const grid = new Float32Array(GRID_SIZE * GRID_SIZE * 2);
  const point = { x: 0, y: 0 };
  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      rawDisplacement(field, x * field.width / (GRID_SIZE - 1), y * field.height / (GRID_SIZE - 1), point);
      const index = (y * GRID_SIZE + x) * 2;
      grid[index] = point.x;
      grid[index + 1] = point.y;
    }
  }
  fieldGrids.set(field, grid);
  return grid;
}

/**
 * Inverse bilinear resampling preserves alpha and never pulls hidden RGB into
 * the image. The same function warps the low-resolution shaded relief so its
 * highlights remain registered to the cover. Source pixels are never changed.
 */
export function warpArtworkPixels(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  field: ArtworkWarpField,
  output: Uint8ClampedArray = new Uint8ClampedArray(source.length),
  zoom = 1,
): Uint8ClampedArray {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || source.length !== width * height * 4 || output.length !== source.length || output.buffer === source.buffer) {
    throw new Error("Artwork warp needs matching, separate RGBA source and output buffers");
  }
  if (!Number.isFinite(zoom) || zoom <= 0) zoom = 1;
  if (!(field.maximum > 0) || field.anchors.length === 0) { output.set(source); return output; }
  const grid = displacementGrid(field);
  const scaleX = width / (field.width * zoom);
  const scaleY = height / (field.height * zoom);
  const edge = Math.min(field.width, field.height) * 0.085;
  const gridColumns = new Uint16Array(width);
  const gridFractions = new Float32Array(width);
  const edgeMasks = new Float32Array(width);
  for (let x = 0; x < width; x += 1) {
    const screenX = ((x + 0.5) / width * zoom + (1 - zoom) / 2) * field.width;
    const gx = clamp(screenX / field.width) * (GRID_SIZE - 1);
    gridColumns[x] = Math.min(GRID_SIZE - 2, Math.floor(gx));
    gridFractions[x] = gx - gridColumns[x]!;
    edgeMasks[x] = smoothstep(0, edge, screenX) * (1 - smoothstep(field.width - edge, field.width, screenX));
  }
  for (let y = 0; y < height; y += 1) {
    const screenY = ((y + 0.5) / height * zoom + (1 - zoom) / 2) * field.height;
    const rowMask = smoothstep(field.creditBottom, field.creditBottom + field.height * 0.10, screenY)
      * (1 - smoothstep(field.height - edge, field.height, screenY));
    if (!(rowMask > 0)) {
      output.set(source.subarray(y * width * 4, (y + 1) * width * 4), y * width * 4);
      continue;
    }
    const gy = clamp(screenY / field.height) * (GRID_SIZE - 1);
    const gyi = Math.min(GRID_SIZE - 2, Math.floor(gy));
    const fy = gy - gyi;
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const mask = rowMask * edgeMasks[x]!;
      if (!(mask > 0)) {
        output[at] = source[at]!; output[at + 1] = source[at + 1]!;
        output[at + 2] = source[at + 2]!; output[at + 3] = source[at + 3]!;
        continue;
      }
      const gxi = gridColumns[x]!;
      const fx = gridFractions[x]!;
      const gi = (gyi * GRID_SIZE + gxi) * 2;
      const below = gi + GRID_SIZE * 2;
      const dx = ((grid[gi]! * (1 - fx) + grid[gi + 2]! * fx) * (1 - fy)
        + (grid[below]! * (1 - fx) + grid[below + 2]! * fx) * fy) * mask;
      const dy = ((grid[gi + 1]! * (1 - fx) + grid[gi + 3]! * fx) * (1 - fy)
        + (grid[below + 1]! * (1 - fx) + grid[below + 3]! * fx) * fy) * mask;
      if (Math.abs(dx) + Math.abs(dy) < 1e-9) {
        output[at] = source[at]!; output[at + 1] = source[at + 1]!;
        output[at + 2] = source[at + 2]!; output[at + 3] = source[at + 3]!;
        continue;
      }
      const sx = clamp(x - dx * scaleX, 0, width - 1);
      const sy = clamp(y - dy * scaleY, 0, height - 1);
      const left = Math.floor(sx);
      const top = Math.floor(sy);
      const ax = sx - left;
      const ay = sy - top;
      const a = (top * width + left) * 4;
      const b = (top * width + Math.min(width - 1, left + 1)) * 4;
      const c = (Math.min(height - 1, top + 1) * width + left) * 4;
      const d = (Math.min(height - 1, top + 1) * width + Math.min(width - 1, left + 1)) * 4;
      const wa = (1 - ax) * (1 - ay) * source[a + 3]!;
      const wb = ax * (1 - ay) * source[b + 3]!;
      const wc = (1 - ax) * ay * source[c + 3]!;
      const wd = ax * ay * source[d + 3]!;
      const alpha = wa + wb + wc + wd;
      output[at + 3] = alpha;
      if (alpha <= 0) {
        output[at] = 0; output[at + 1] = 0; output[at + 2] = 0;
      } else {
        for (let channel = 0; channel < 3; channel += 1) {
          output[at + channel] = (source[a + channel]! * wa + source[b + channel]! * wb
            + source[c + channel]! * wc + source[d + channel]! * wd) / alpha;
        }
      }
    }
  }
  return output;
}

/** Immutable decoded cover plus a reusable 512px output; no per-frame decode. */
export class ArtworkWarp {
  private readonly source: Uint8ClampedArray;
  private readonly canvas: Canvas;
  private readonly image: ReturnType<ReturnType<Canvas["getContext"]>["createImageData"]>;

  constructor(source: Canvas) {
    this.source = source.getContext("2d").getImageData(0, 0, source.width, source.height).data;
    this.canvas = createCanvas(source.width, source.height);
    this.image = this.canvas.getContext("2d").createImageData(source.width, source.height);
  }

  render(field: ArtworkWarpField, zoom = 1): Canvas {
    warpArtworkPixels(this.source, this.canvas.width, this.canvas.height, field, this.image.data, zoom);
    this.canvas.getContext("2d").putImageData(this.image, 0, 0);
    return this.canvas;
  }
}

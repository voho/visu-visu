import { silkHeightBytes, silkHeightSize } from "../../assets/materials/silk-height.js";
import { clamp, createRandom, deriveSeed } from "../math/random.js";

export interface MaterialMap {
  width: number;
  height: number;
  /** Linear-ish neutral silk color, stored as unsigned RGBA bytes. */
  albedo: Uint8ClampedArray;
  /** Unit tangent-space vectors: +X right, +Y up, +Z toward the viewer. */
  normals: Float32Array;
  roughness: Float32Array;
  heightMap: Float32Array;
  /** Artwork clamps at its edges; the silk surface repeats seamlessly. */
  wrap: boolean;
}

export interface MaterialSample {
  r: number;
  g: number;
  b: number;
  a: number;
  nx: number;
  ny: number;
  nz: number;
  roughness: number;
  height: number;
}

export interface ReliefOptions {
  blurRadius?: number;
  strength?: number;
}

const TAU = Math.PI * 2;
const coordinate = (value: number, size: number, wrap: boolean): number => wrap
  ? ((value % size) + size) % size
  : Math.max(0, Math.min(size - 1, value));

function dimensions(width: number, height: number, maximum = 256): void {
  if (![width, height].every((size) => Number.isInteger(size) && size >= 2 && size <= maximum)) {
    throw new Error(`Material dimensions must be integers between 2 and ${maximum}`);
  }
}

/** A seed-stable analytic height field. Integer harmonics give a periodic seam. */
export function createProceduralHeight(seed: string, size = 128): Float32Array {
  dimensions(size, size, 2048);
  const random = createRandom(deriveSeed(seed, "silk-material"));
  const phases = Array.from({ length: 5 }, () => random() * TAU);
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    const v = y / size * TAU;
    for (let x = 0; x < size; x += 1) {
      const u = x / size * TAU;
      const warp = 0.43 * Math.sin(v * 2 + phases[0]!) + 0.28 * Math.sin(u + v + phases[1]!);
      const folds = Math.sin(u * 3 + v * 2 + warp + phases[2]!);
      const ribbons = Math.sin(u * 7 - v * 3 + 0.8 * warp + phases[3]!);
      const grain = Math.sin(u * 19 + v * 13 + phases[4]!) * Math.sin(u * 11 - v * 17);
      heights[y * size + x] = 0.5 + folds * 0.25 + ribbons * 0.115 + grain * 0.022;
    }
  }
  return heights;
}

function valueAt(values: ArrayLike<number>, width: number, height: number, x: number, y: number, wrap: boolean): number {
  return values[coordinate(y, height, wrap) * width + coordinate(x, width, wrap)] ?? 0;
}

/** One source of truth for the exported RGB normal maps and CPU shading. */
export function normalsFromHeight(
  heights: ArrayLike<number>, width: number, height: number, strength = 0.1, wrap = true,
): Float32Array {
  dimensions(width, height, 2048);
  if (heights.length !== width * height) throw new Error("Height data must match material dimensions");
  if (!Number.isFinite(strength) || strength < 0) throw new Error("Normal strength must be finite and nonnegative");
  for (let index = 0; index < heights.length; index += 1) {
    if (!Number.isFinite(heights[index])) throw new Error("Height data must contain only finite values");
  }
  const normals = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Texture rows run downwards. Negating dH/dX and retaining dH/dRow
      // converts the gradient to the documented +Y-up tangent convention.
      const dx = (valueAt(heights, width, height, x + 1, y, wrap) - valueAt(heights, width, height, x - 1, y, wrap)) * width * 0.5;
      const dy = (valueAt(heights, width, height, x, y + 1, wrap) - valueAt(heights, width, height, x, y - 1, wrap)) * height * 0.5;
      const nx = -dx * strength;
      const ny = dy * strength;
      const length = Math.hypot(nx, ny, 1);
      const index = (y * width + x) * 3;
      normals[index] = nx / length;
      normals[index + 1] = ny / length;
      normals[index + 2] = 1 / length;
    }
  }
  return normals;
}

/** Smooth, weighted scalar resampling; u/v are normalized texture coordinates. */
function bilinearScalar(values: ArrayLike<number>, width: number, height: number, u: number, v: number): number {
  const x = ((u % 1 + 1) % 1) * width;
  const y = ((v % 1 + 1) % 1) * height;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const a = valueAt(values, width, height, x0, y0, true);
  const b = valueAt(values, width, height, x0 + 1, y0, true);
  const c = valueAt(values, width, height, x0, y0 + 1, true);
  const d = valueAt(values, width, height, x0 + 1, y0 + 1, true);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/**
 * Synchronous: the bundled 128² source contains only bytes, so constructing a
 * renderer never decodes an image or hits the filesystem. Explicit heights
 * bypass that source; a procedural material is always available as a fallback.
 */
export function createMaterial(seed: string, size = 128, heightData?: ArrayLike<number>): MaterialMap {
  dimensions(size, size);
  if (heightData && heightData.length !== size * size) throw new Error("Height data must match material dimensions");
  let heightMap: Float32Array;
  if (heightData) {
    heightMap = Float32Array.from(heightData, (value) => {
      if (!Number.isFinite(value)) throw new Error("Height data must contain only finite values");
      return clamp(value);
    });
  } else if (silkHeightBytes.length === silkHeightSize * silkHeightSize) {
    const random = createRandom(deriveSeed(seed, "silk-placement"));
    const uOffset = random();
    const vOffset = random();
    heightMap = new Float32Array(size * size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        heightMap[y * size + x] = bilinearScalar(silkHeightBytes, silkHeightSize, silkHeightSize, x / size + uOffset, y / size + vOffset) / 255;
      }
    }
  } else {
    heightMap = createProceduralHeight(seed, size);
  }
  return createMaterialFromHeight(heightMap, size, size);
}

/** Build coherent maps at asset resolution; runtime createMaterial stays bounded to 256². */
export function createMaterialFromHeight(heightData: ArrayLike<number>, width: number, height: number): MaterialMap {
  dimensions(width, height, 2048);
  if (heightData.length !== width * height) throw new Error("Height data must match material dimensions");
  const heightMap = Float32Array.from(heightData, (value) => {
    if (!Number.isFinite(value)) throw new Error("Height data must contain only finite values");
    return clamp(value);
  });
  const normals = normalsFromHeight(heightMap, width, height);
  const albedo = new Uint8ClampedArray(width * height * 4);
  const roughness = new Float32Array(width * height);
  for (let index = 0; index < heightMap.length; index += 1) {
    const relief = heightMap[index]!;
    const slope = 1 - normals[index * 3 + 2]!;
    // Restrained neutral pearl: colored lights supply most of the color.
    albedo[index * 4] = 116 + relief * 103;
    albedo[index * 4 + 1] = 123 + relief * 101;
    albedo[index * 4 + 2] = 138 + relief * 101;
    albedo[index * 4 + 3] = 255;
    roughness[index] = clamp(0.65 - relief * 0.25 + slope * 0.1, 0.3, 0.76);
  }
  return { width, height, albedo, normals, roughness, heightMap, wrap: true };
}

/** Box blur with a clamped boundary, used only once during artwork preparation. */
function blurred(values: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius === 0) return values;
  const horizontal = new Float32Array(values.length);
  const result = new Float32Array(values.length);
  const diameter = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let dx = -radius; dx <= radius; dx += 1) sum += valueAt(values, width, height, dx, y, false);
    for (let x = 0; x < width; x += 1) {
      horizontal[y * width + x] = sum / diameter;
      sum += valueAt(values, width, height, x + radius + 1, y, false) - valueAt(values, width, height, x - radius, y, false);
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let dy = -radius; dy <= radius; dy += 1) sum += valueAt(horizontal, width, height, x, dy, false);
    for (let y = 0; y < height; y += 1) {
      result[y * width + x] = sum / diameter;
      sum += valueAt(horizontal, width, height, x, y + radius + 1, false) - valueAt(horizontal, width, height, x, y - radius, false);
    }
  }
  return result;
}

/**
 * Artistic relief from blurred luminance, not an estimate of physical depth.
 * Original color and alpha survive unchanged; invisible pixels cannot inject
 * their hidden RGB into the inferred surface. Suitable for prepared cover art.
 */
export function createMaterialFromRgba(
  pixels: Uint8ClampedArray, width: number, height: number, options: ReliefOptions = {},
): MaterialMap {
  dimensions(width, height);
  if (pixels.length !== width * height * 4) throw new Error("RGBA data must match material dimensions");
  const radius = options.blurRadius ?? Math.max(1, Math.round(Math.min(width, height) * 0.016));
  if (!Number.isInteger(radius) || radius < 0 || radius > Math.max(width, height)) {
    throw new Error("Relief blur radius must be a nonnegative integer within the image dimensions");
  }
  const alpha = new Float32Array(width * height);
  const luminance = new Float32Array(width * height);
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = pixels[index * 4 + 3]! / 255;
    luminance[index] = (pixels[index * 4]! * 0.2126 + pixels[index * 4 + 1]! * 0.7152 + pixels[index * 4 + 2]! * 0.0722) / 255 * alpha[index]!;
  }
  const blurredAlpha = blurred(alpha, width, height, radius);
  const blurredLuminance = blurred(luminance, width, height, radius);
  const heightMap = Float32Array.from(blurredLuminance, (value, index) => blurredAlpha[index]! > 1e-5 ? value / blurredAlpha[index]! : 0.5);
  const normals = normalsFromHeight(heightMap, width, height, options.strength ?? 0.045, false);
  const roughness = Float32Array.from(heightMap, (value) => clamp(0.79 - value * 0.13, 0.6, 0.85));
  return { width, height, albedo: pixels.slice(), normals, roughness, heightMap, wrap: false };
}

/** Wrapped bilinear sampling reuses an optional result object in the hot path. */
export function sampleMaterial(map: MaterialMap, u: number, v: number, target?: MaterialSample): MaterialSample {
  const out = target ?? { r: 0, g: 0, b: 0, a: 1, nx: 0, ny: 0, nz: 1, roughness: 0.5, height: 0.5 };
  const safeU = Number.isFinite(u) ? u : 0;
  const safeV = Number.isFinite(v) ? v : 0;
  const x = map.wrap ? ((safeU % 1 + 1) % 1) * map.width : clamp(safeU) * (map.width - 1);
  const y = map.wrap ? ((safeV % 1 + 1) % 1) * map.height : clamp(safeV) * (map.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i00 = coordinate(y0, map.height, map.wrap) * map.width + coordinate(x0, map.width, map.wrap);
  const i10 = coordinate(y0, map.height, map.wrap) * map.width + coordinate(x0 + 1, map.width, map.wrap);
  const i01 = coordinate(y0 + 1, map.height, map.wrap) * map.width + coordinate(x0, map.width, map.wrap);
  const i11 = coordinate(y0 + 1, map.height, map.wrap) * map.width + coordinate(x0 + 1, map.width, map.wrap);
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  const sample = (array: ArrayLike<number>, stride: number, channel: number): number =>
    array[i00 * stride + channel]! * w00 + array[i10 * stride + channel]! * w10
    + array[i01 * stride + channel]! * w01 + array[i11 * stride + channel]! * w11;
  out.r = sample(map.albedo, 4, 0) / 255;
  out.g = sample(map.albedo, 4, 1) / 255;
  out.b = sample(map.albedo, 4, 2) / 255;
  out.a = sample(map.albedo, 4, 3) / 255;
  out.nx = sample(map.normals, 3, 0);
  out.ny = sample(map.normals, 3, 1);
  out.nz = sample(map.normals, 3, 2);
  const length = Math.hypot(out.nx, out.ny, out.nz) || 1;
  out.nx /= length;
  out.ny /= length;
  out.nz /= length;
  out.roughness = sample(map.roughness, 1, 0);
  out.height = sample(map.heightMap, 1, 0);
  return out;
}

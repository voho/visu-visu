import { hashString } from "../math/random.js";
import type { MusicMotion } from "./music-motion.js";

export type Rgb = [number, number, number];
export type Vec3 = [number, number, number];

/** Scene coordinates: +X right, +Y up, +Z toward the viewer. */
export interface PointLight {
  position: Vec3;
  color: Rgb;
  intensity: number;
  falloff: number;
}

export interface LightingState {
  /** Bass key, midrange fill, and treble rim, in that order. */
  lights: [PointLight, PointLight, PointLight];
  ambient: Rgb;
  exposure: number;
  /** Optional reflected FFT strip: the spectrum is itself a colored light. */
  spectrum?: SpectrumStripLight;
}

export interface SpectrumStripLight {
  /** 32 normalized radiance samples, with wider/stronger low frequencies. */
  values: Float32Array;
  angle: number;
  /** Precomputed cosine/sine of the strip's rotation about scene Y. */
  rotation: [number, number];
  strength: number;
}

/** Compatible with sampleMaterial; values are normalized, with signed normals. */
export interface SurfaceSample {
  r: number;
  g: number;
  b: number;
  nx: number;
  ny: number;
  nz: number;
  roughness: number;
}

function bounded(value: number, min = 0, max = 1, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function tint(hue: number, saturation: number): Rgb {
  const channel = (offset: number): number => {
    const h = ((hue / 60 + offset) % 6 + 6) % 6;
    return 1 - saturation * Math.max(0, Math.min(h, 4 - h, 1));
  };
  return [channel(5), channel(3), channel(1)];
}

/** Per-frame preparation only; surface shading samples this strip in O(1). */
function spectrumStrip(source: Float32Array, angle: number, lowFlash: boolean): SpectrumStripLight | undefined {
  if (source.length === 0) return undefined;
  const bins = new Float32Array(32);
  let audible = false;
  for (let bin = 0; bin < bins.length; bin += 1) {
    const start = bin / bins.length * source.length;
    const end = (bin + 1) / bins.length * source.length;
    let total = 0;
    for (let index = Math.floor(start); index < Math.ceil(end); index += 1) {
      total += bounded(source[index] ?? 0)
        * Math.max(0, Math.min(end, index + 1) - Math.max(start, index));
    }
    bins[bin] = total / Math.max(1e-9, end - start);
    if (bins[bin]! > 0) audible = true;
  }
  if (!audible) return undefined;
  const values = new Float32Array(32);
  // A bass bin illuminates a wider region of the material. High bins retain
  // narrower detail. Peak radiance stays bounded even for a full-band impulse.
  for (let sourceBin = 0; sourceBin < bins.length; sourceBin += 1) {
    const frequency = sourceBin / 31;
    const weight = 0.24 + 0.76 * (1 - frequency) ** 1.5;
    const radius = 0.6 + 2.2 * (1 - frequency) ** 1.3;
    for (let target = 0; target < values.length; target += 1) {
      const distance = (target - sourceBin) / radius;
      values[target] = values[target]! + bins[sourceBin]! * weight * Math.exp(-0.5 * distance * distance) / 2.6;
    }
  }
  for (let index = 0; index < values.length; index += 1) values[index] = bounded(values[index]!);
  return { values, angle, rotation: [Math.cos(angle), Math.sin(angle)], strength: lowFlash ? 0.234 : 0.52 };
}

/** Same texture-center interpolation used by a GL_LINEAR/CLAMP_TO_EDGE strip. */
function stripAt(values: Float32Array, u: number): number {
  const position = bounded(u * 32 - 0.5, 0, 31);
  const left = Math.floor(position);
  const right = Math.min(31, left + 1);
  const a = bounded(values[left] ?? 0);
  return a + (bounded(values[right] ?? 0) - a) * (position - left);
}

/**
 * Three moving lights, evaluated from absolute musical time (no frame history).
 * Bass makes the broadest, strongest response; treble adds a small quick rim.
 * Pulse energy only affects local lights, never the ambient or exposure.
 */
export function lightingAt(
  motion: MusicMotion,
  time: number,
  seed: string,
  paletteHue: number,
  lowFlash = false,
  spectrum?: Float32Array,
): LightingState {
  const safeTime = bounded(time, 0, 1e9);
  const slow = bounded(motion.slowTime, 0, 1e9, safeTime * 0.2);
  const fast = bounded(motion.fastTime, 0, 1e9, safeTime);
  const bass = bounded(motion.bassEnergy);
  const mids = bounded(motion.midEnergy);
  const treble = bounded(motion.trebleEnergy);
  const sustain = bounded(motion.sustain);
  const bassPulse = bounded(motion.bassPulse);
  const treblePulse = bounded(motion.treblePulse);
  const accent = lowFlash ? 0.18 : 1;
  const phase = hashString(`${seed}:material-lights`) / 0x100000000 * Math.PI * 2;
  const hue = bounded(paletteHue, -1e9, 1e9);
  const keyAngle = phase + slow * 0.27;
  const fillAngle = phase * 1.7 - slow * 0.19;
  const rimAngle = phase * 0.7 + fast * 0.43;
  const keyRadius = 0.5 + bass * 0.27 + bassPulse * 0.16;

  const state: LightingState = {
    lights: [
      {
        position: [Math.cos(keyAngle) * keyRadius, Math.sin(keyAngle * 0.83) * keyRadius, 1.05 + bassPulse * 0.3],
        color: tint(hue - 18 + bass * 18, 0.62),
        intensity: 0.22 + bass * 1.15 + bassPulse * 1.1 * accent,
        falloff: 0.4,
      },
      {
        position: [Math.cos(fillAngle) * 0.74, Math.sin(fillAngle) * 0.68, 1.3],
        color: tint(hue + 84 + mids * 24, 0.72),
        intensity: 0.12 + mids * 0.52 + sustain * 0.13,
        falloff: 0.5,
      },
      {
        position: [Math.cos(rimAngle) * 0.93, Math.sin(rimAngle) * 0.86, 0.38 + treble * 0.1],
        color: tint(hue + 174 + treble * 16, 0.46),
        intensity: 0.065 + treble * 0.23 + treblePulse * 0.2 * accent,
        falloff: 0.85,
      },
    ],
    ambient: [0.075 + sustain * 0.016, 0.083 + sustain * 0.016, 0.105 + sustain * 0.018],
    exposure: 1.16 + sustain * 0.1,
  };
  if (spectrum) {
    const strip = spectrumStrip(spectrum, phase + slow * 0.11, lowFlash);
    if (strip) state.spectrum = strip;
  }
  return state;
}

/**
 * Bounded diffuse + roughness-dependent Blinn specular with Schlick Fresnel.
 * The camera is at (0, 0, 3.4); falloff is 1 / (1 + d² * light.falloff).
 * Final Reinhard tone mapping preserves highlight detail without frame flashes.
 * Supply `out` to shade a material grid or filament segments without allocations.
 * The browser preview mirrors this formula in its fragment shader.
 */
export function shadeSurface(
  state: LightingState,
  x: number,
  y: number,
  z: number,
  sample: SurfaceSample,
  out: Rgb = [0, 0, 0],
): Rgb {
  x = bounded(x, -100, 100);
  y = bounded(y, -100, 100);
  z = bounded(z, -100, 100);
  let nx = bounded(sample.nx, -1, 1);
  let ny = bounded(sample.ny, -1, 1);
  let nz = bounded(sample.nz, -1, 1, 1);
  const normalLength = Math.hypot(nx, ny, nz);
  if (normalLength > 1e-6) {
    nx /= normalLength;
    ny /= normalLength;
    nz /= normalLength;
  } else {
    nx = 0;
    ny = 0;
    nz = 1;
  }
  const albedoR = bounded(sample.r);
  const albedoG = bounded(sample.g);
  const albedoB = bounded(sample.b);
  const roughness = bounded(sample.roughness, 0.08, 1, 0.65);
  const exponent = 4 + (1 - roughness) ** 2 * 92;
  const gloss = 0.15 + (1 - roughness) * 0.45;
  const viewLength = Math.max(1e-6, Math.hypot(x, y, 3.4 - z));
  const vx = -x / viewLength;
  const vy = -y / viewLength;
  const vz = (3.4 - z) / viewLength;
  const ndotv = Math.max(0, nx * vx + ny * vy + nz * vz);
  let r = albedoR * bounded(state.ambient[0], 0, 2);
  let g = albedoG * bounded(state.ambient[1], 0, 2);
  let b = albedoB * bounded(state.ambient[2], 0, 2);

  for (const light of state.lights) {
    const dx = bounded(light.position[0], -100, 100) - x;
    const dy = bounded(light.position[1], -100, 100) - y;
    const dz = bounded(light.position[2], -100, 100) - z;
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    const length = Math.sqrt(Math.max(1e-12, distanceSquared));
    const lx = dx / length;
    const ly = dy / length;
    const lz = dz / length;
    const ndotl = Math.max(0, nx * lx + ny * ly + nz * lz);
    if (ndotl <= 0) continue;
    const halfLength = Math.max(1e-6, Math.hypot(lx + vx, ly + vy, lz + vz));
    const hx = (lx + vx) / halfLength;
    const hy = (ly + vy) / halfLength;
    const hz = (lz + vz) / halfLength;
    const ndoth = Math.max(0, nx * hx + ny * hy + nz * hz);
    const vdoth = Math.max(0, Math.min(1, vx * hx + vy * hy + vz * hz));
    const fresnel = 0.06 + 0.94 * (1 - vdoth) ** 5;
    const specular = ndoth ** exponent * gloss * (0.25 + fresnel * 2);
    const rim = (1 - ndotv) ** 3 * 0.045 * (1 - roughness * 0.6);
    const attenuation = bounded(light.intensity, 0, 4)
      / (1 + distanceSquared * bounded(light.falloff, 0, 4));
    const diffuse = ndotl * 0.88;
    const shine = (specular + rim) * ndotl;
    r += (albedoR * diffuse + shine) * bounded(light.color[0]) * attenuation;
    g += (albedoG * diffuse + shine) * bounded(light.color[1]) * attenuation;
    b += (albedoB * diffuse + shine) * bounded(light.color[2]) * attenuation;
  }

  const strip = state.spectrum;
  if (strip && ndotv > 0) {
    // An environment reflection, not a screen overlay: every surface normal
    // selects a different frequency, so the strip bends across the sculpture.
    const rx = 2 * ndotv * nx - vx;
    const ry = 2 * ndotv * ny - vy;
    const rz = 2 * ndotv * nz - vz;
    const cosine = bounded(strip.rotation[0], -1, 1, 1);
    const sine = bounded(strip.rotation[1], -1, 1);
    const sx = cosine * rx + sine * rz;
    const sz = -sine * rx + cosine * rz;
    const frequency = Math.atan2(sx, sz) / (Math.PI * 2) + 0.5;
    const blur = 0.009 + roughness * roughness * 0.11;
    const radiance = stripAt(strip.values, frequency) * 0.5
      + stripAt(strip.values, frequency - blur) * 0.25
      + stripAt(strip.values, frequency + blur) * 0.25;
    const gate = Math.exp(-ry * ry / (0.022 + roughness * roughness * 0.48 + (1 - frequency) * 0.06));
    const fresnel = 0.16 + 0.84 * (1 - ndotv) ** 5;
    const amount = radiance * gate * bounded(strip.strength)
      * (0.28 + (1 - roughness) * 0.4 + fresnel * 0.45);
    const keyColor = state.lights[0].color;
    const rimColor = state.lights[2].color;
    r += amount * (bounded(keyColor[0]) * (1 - frequency) + bounded(rimColor[0]) * frequency) * (albedoR * 0.35 + 0.65);
    g += amount * (bounded(keyColor[1]) * (1 - frequency) + bounded(rimColor[1]) * frequency) * (albedoG * 0.35 + 0.65);
    b += amount * (bounded(keyColor[2]) * (1 - frequency) + bounded(rimColor[2]) * frequency) * (albedoB * 0.35 + 0.65);
  }

  const exposure = bounded(state.exposure, 0, 4, 1);
  r *= exposure;
  g *= exposure;
  b *= exposure;
  out[0] = r / (1 + r);
  out[1] = g / (1 + g);
  out[2] = b / (1 + b);
  return out;
}

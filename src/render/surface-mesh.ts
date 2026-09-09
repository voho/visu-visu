import type { SKRSContext2D } from "@napi-rs/canvas";
import { clamp } from "../math/random.js";
import type { AnalysisFrame } from "../types.js";
import { shadeSurface, type LightingState, type Rgb } from "./lighting.js";
import type { MaterialMap, MaterialSample } from "./material.js";
import type { MusicMotion } from "./music-motion.js";
import type { ResonanceFilament, ResonancePoint } from "./resonance.js";
import { sampleResonanceMaterial } from "./surface-material.js";
import { sampleSurfaceFeature, surfaceFeatureSamples } from "./surface-signal.js";

const TAU = Math.PI * 2;
const wrap = (value: number): number => ((value % 1) + 1) % 1;

interface Face {
  points: [ResonancePoint, ResonancePoint, ResonancePoint, ResonancePoint];
  strand: number;
  index: number;
  depth: number;
  u: number;
  v: number;
  coverage: number;
}

/** A shaded piece of the original surface, ready for frozen rigid-body motion. */
export interface CapturedSurfaceFace {
  /** Original geometry references; capture callers must not mutate them. */
  points: [ResonancePoint, ResonancePoint, ResonancePoint, ResonancePoint];
  /** Display-graded, clamped RGB in 0..1, identical to the live skin formula. */
  color: Rgb;
  alpha: number;
  /** Cell-center coordinates on the original closed surface, before photo UV mirroring. */
  u: number;
  v: number;
}

export type SurfaceCoverage = (u: number, v: number) => number;

/** A translucent material skin on the very same morphing surface as the filaments. */
export function drawMaterialSurface(
  context: SKRSContext2D,
  filaments: ResonanceFilament[],
  frame: AnalysisFrame,
  motion: MusicMotion,
  material: MaterialMap,
  lights: LightingState,
  strength: number,
  lowFlash: boolean,
  opacityAt?: SurfaceCoverage,
): void {
  context.save();
  context.globalCompositeOperation = "source-over";
  renderOrCaptureSurface(filaments, frame, motion, material, lights, strength, lowFlash, opacityAt, context);
  context.restore();
}

/** Select actual surface polygons before sorting or shading; no screen crop. */
export function captureMaterialSurface(
  filaments: ResonanceFilament[],
  frame: AnalysisFrame,
  motion: MusicMotion,
  material: MaterialMap,
  lights: LightingState,
  strength: number,
  lowFlash: boolean,
  includeFace?: SurfaceCoverage,
): CapturedSurfaceFace[] {
  const captured: CapturedSurfaceFace[] = [];
  renderOrCaptureSurface(filaments, frame, motion, material, lights, strength, lowFlash, includeFace, undefined, captured);
  return captured;
}

/** Shared shading keeps captured fragments and the live skin pixel-identical. */
function renderOrCaptureSurface(
  filaments: ResonanceFilament[],
  frame: AnalysisFrame,
  motion: MusicMotion,
  material: MaterialMap,
  lights: LightingState,
  strength: number,
  lowFlash: boolean,
  coverageAt: SurfaceCoverage | undefined,
  context?: SKRSContext2D,
  captured?: CapturedSurfaceFace[],
): void {
  if (!(strength > 0) || filaments.length < 2) return;
  const count = (filaments[0]?.points.length ?? 1) - 1;
  if (count < 4) return;
  const artwork = material.pigment === "artwork";
  const rowStep = artwork ? 1 : 2;
  const pointStep = artwork ? 2 : 3;
  const samples = surfaceFeatureSamples(frame);
  const faces: Face[] = [];
  // Keep photo detail at 72×120 samples; procedural silk needs only 36×80.
  // Both reuse actual source vertices, independently of Full HD delivery size.
  for (let strand = 0; strand < filaments.length; strand += rowStep) {
    const row = filaments[strand]!.points;
    const next = filaments[(strand + rowStep) % filaments.length]!.points;
    for (let index = 0; index < count; index += pointStep) {
      const end = Math.min(count, index + pointStep);
      const u = (index + end) / (2 * count);
      const v = wrap((strand + rowStep * 0.5) / filaments.length);
      const requestedCoverage = coverageAt?.(u, v) ?? 1;
      const coverage = Number.isFinite(requestedCoverage) ? clamp(requestedCoverage) : 0;
      if (!(coverage > 0)) continue;
      const a = row[index]!, b = row[end]!, c = next[end]!, d = next[index]!;
      if (!a || !b || !c || !d) continue;
      faces.push({ points: [a, b, c, d], strand, index, u, v, coverage,
        depth: (a.surfaceZ + b.surfaceZ + c.surfaceZ + d.surfaceZ) / 4 });
    }
  }
  faces.sort((a, b) => a.depth - b.depth);
  const sample: MaterialSample = { r: 0, g: 0, b: 0, a: 1, nx: 0, ny: 0, nz: 1, roughness: 0.5, height: 0.5 };
  const rgb: Rgb = [0, 0, 0];
  const pulse = motion.bassPulse * (lowFlash ? 0.18 : 1);
  for (const face of faces) {
    const [a, b, c, d] = face.points;
    const u = face.index / count;
    const v = face.strand / filaments.length;
    const position = 0.5 - Math.cos(u * TAU + motion.slowTime * 0.13) * 0.5;
    const spectrum = sampleSurfaceFeature(samples, "spectrum", position) * (1 - position * 0.72);
    const wavePosition = wrap(u + motion.slowTime * 0.025);
    const wave = sampleSurfaceFeature(samples, "waveform", wavePosition);
    const waveSlope = sampleSurfaceFeature(samples, "waveform", wrap(wavePosition + 1 / 32))
      - sampleSurfaceFeature(samples, "waveform", wrap(wavePosition - 1 / 32));
    sampleResonanceMaterial(material, filaments, face.strand + (artwork ? rowStep * 0.5 : 0),
      face.index + (artwork ? pointStep * 0.5 : 1), sample);
    if (sample.a <= 0) continue;
    const alpha = clamp(strength) * (artwork ? 0.98 : 0.78) * sample.a * face.coverage;
    // The same waveform changes relief and the reflected light ribbon.
    sample.nx += waveSlope * (0.1 + motion.bassEnergy * 0.18);
    sample.ny += Math.sin(v * TAU * 3 - motion.fastTime * 0.32) * spectrum * 0.19;
    sample.roughness = clamp(sample.roughness - spectrum * 0.12 + Math.abs(wave) * 0.06, 0.18, 0.9);
    shadeSurface(lights, (a.surfaceX + b.surfaceX + c.surfaceX + d.surfaceX) / 4,
      (a.surfaceY + b.surfaceY + c.surfaceY + d.surfaceY) / 4, face.depth, sample, rgb);
    const latitude = Math.sin(v * TAU + motion.slowTime * 0.28);
    const scopeDistance = (latitude - wave * 0.55) / (0.035 + spectrum * 0.045);
    const spectrumDistance = (latitude - (spectrum - 0.35) * 1.15) / 0.065;
    const scopeReflection = Math.exp(-scopeDistance * scopeDistance) * (0.025 + motion.bassEnergy * 0.095 + pulse * 0.05);
    const spectrumReflection = Math.exp(-spectrumDistance * spectrumDistance) * spectrum * 0.15;
    // A common display gain preserves photographic hues; per-channel gamma
    // would change them and wash out the input image's spatial color details.
    const photoGain = 1 / Math.sqrt(Math.max(0.01, rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722));
    const reflectionScale = artwork ? 0.5 : 1;
    const r = (artwork ? rgb[0] * photoGain : Math.sqrt(rgb[0]))
      + (lights.lights[0].color[0] * scopeReflection + lights.lights[1].color[0] * spectrumReflection) * reflectionScale;
    const g = (artwork ? rgb[1] * photoGain : Math.sqrt(rgb[1]))
      + (lights.lights[0].color[1] * scopeReflection + lights.lights[1].color[1] * spectrumReflection) * reflectionScale;
    const blue = (artwork ? rgb[2] * photoGain : Math.sqrt(rgb[2]))
      + (lights.lights[0].color[2] * scopeReflection + lights.lights[1].color[2] * spectrumReflection) * reflectionScale;
    if (context) {
      context.globalAlpha = alpha;
      context.fillStyle = `rgb(${Math.round(clamp(r) * 255)},${Math.round(clamp(g) * 255)},${Math.round(clamp(blue) * 255)})`;
      context.beginPath();
      context.moveTo(a.x, a.y); context.lineTo(b.x, b.y);
      context.lineTo(c.x, c.y); context.lineTo(d.x, d.y);
      context.closePath(); context.fill();
    } else {
      captured!.push({ points: face.points, color: [clamp(r), clamp(g), clamp(blue)], alpha, u: face.u, v: face.v });
    }
  }
}

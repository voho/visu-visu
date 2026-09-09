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
}

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
): void {
  if (!(strength > 0) || filaments.length < 2) return;
  const count = (filaments[0]?.points.length ?? 1) - 1;
  if (count < 4) return;
  const samples = surfaceFeatureSamples(frame);
  const faces: Face[] = [];
  // 72×240 source topology becomes 36×80 quads; cost does not grow with Full HD.
  for (let strand = 0; strand < filaments.length; strand += 2) {
    const row = filaments[strand]!.points;
    const next = filaments[(strand + 2) % filaments.length]!.points;
    for (let index = 0; index < count; index += 3) {
      const end = Math.min(count, index + 3);
      const a = row[index]!, b = row[end]!, c = next[end]!, d = next[index]!;
      if (!a || !b || !c || !d) continue;
      faces.push({ points: [a, b, c, d], strand, index,
        depth: (a.surfaceZ + b.surfaceZ + c.surfaceZ + d.surfaceZ) / 4 });
    }
  }
  faces.sort((a, b) => a.depth - b.depth);
  const sample: MaterialSample = { r: 0, g: 0, b: 0, a: 1, nx: 0, ny: 0, nz: 1, roughness: 0.5, height: 0.5 };
  const rgb: Rgb = [0, 0, 0];
  const pulse = motion.bassPulse * (lowFlash ? 0.18 : 1);
  context.save();
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = clamp(strength) * 0.78;
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
    sampleResonanceMaterial(material, filaments, face.strand, face.index + 1, sample);
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
    const r = Math.sqrt(rgb[0]) + lights.lights[0].color[0] * scopeReflection + lights.lights[1].color[0] * spectrumReflection;
    const g = Math.sqrt(rgb[1]) + lights.lights[0].color[1] * scopeReflection + lights.lights[1].color[1] * spectrumReflection;
    const blue = Math.sqrt(rgb[2]) + lights.lights[0].color[2] * scopeReflection + lights.lights[1].color[2] * spectrumReflection;
    context.fillStyle = `rgb(${Math.round(clamp(r) * 255)},${Math.round(clamp(g) * 255)},${Math.round(clamp(blue) * 255)})`;
    context.beginPath();
    context.moveTo(a.x, a.y); context.lineTo(b.x, b.y);
    context.lineTo(c.x, c.y); context.lineTo(d.x, d.y);
    context.closePath(); context.fill();
  }
  context.restore();
}

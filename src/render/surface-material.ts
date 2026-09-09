import { sampleMaterial, type MaterialMap, type MaterialSample } from "./material.js";
import { smoothstep } from "../math/random.js";
import type { ResonanceFilament } from "./resonance.js";

function cyclicCoordinate(value: number, count: number): number {
  return Number.isFinite(value) && count > 0 ? ((value % count) + count) % count : 0;
}

/** Full image out-and-back across a closed axis; no cropped or clamped half. */
export function mirroredArtworkUv(position: number): { coordinate: number; normalSign: number } {
  const phase = cyclicCoordinate(position, 1);
  const edge = Math.min(phase, Math.abs(phase - 0.5), 1 - phase);
  return {
    coordinate: 1 - Math.abs(phase * 2 - 1),
    normalSign: (phase < 0.5 ? 1 : -1) * smoothstep(0, 0.018, edge),
  };
}

/** Transform the tangent-space texture normal onto the actual moving surface. */
export function sampleResonanceMaterial(
  map: MaterialMap,
  filaments: ResonanceFilament[],
  strand: number,
  index: number,
  out?: MaterialSample,
): MaterialSample {
  if (filaments.length === 0) return sampleMaterial(map, 0, 0, out);
  const strandPosition = cyclicCoordinate(strand, filaments.length);
  strand = Math.floor(strandPosition);
  const points = filaments[strand]!.points;
  const count = points.length - 1;
  if (count < 2) return sampleMaterial(map, 0, strand / filaments.length * 2, out);
  const pointPosition = cyclicCoordinate(index, count);
  index = Math.floor(pointPosition);
  let sample: MaterialSample;
  if (map.pigment === "artwork") {
    const u = mirroredArtworkUv(pointPosition / count);
    const v = mirroredArtworkUv(strandPosition / filaments.length);
    sample = sampleMaterial(map, u.coordinate, v.coordinate, out);
    sample.nx *= u.normalSign;
    sample.ny *= v.normalSign;
    const mirroredLength = Math.max(1e-8, Math.hypot(sample.nx, sample.ny, sample.nz));
    sample.nx /= mirroredLength; sample.ny /= mirroredLength; sample.nz /= mirroredLength;
  } else {
    sample = sampleMaterial(map, pointPosition / count * 2, strandPosition / filaments.length * 2, out);
  }
  const previous = points[(index - 1 + count) % count]!;
  const next = points[(index + 1) % count]!;
  const upper = filaments[(strand - 1 + filaments.length) % filaments.length]!.points[index];
  const lower = filaments[(strand + 1) % filaments.length]!.points[index];
  if (!upper || !lower) return sample;
  let tx = next.surfaceX - previous.surfaceX;
  let ty = next.surfaceY - previous.surfaceY;
  let tz = next.surfaceZ - previous.surfaceZ;
  const tangentLength = Math.hypot(tx, ty, tz);
  if (!Number.isFinite(tangentLength) || tangentLength < 1e-8) return sample;
  tx /= tangentLength; ty /= tangentLength; tz /= tangentLength;
  // Texture normal green points toward decreasing texture-row coordinates.
  const bx = upper.surfaceX - lower.surfaceX;
  const by = upper.surfaceY - lower.surfaceY;
  const bz = upper.surfaceZ - lower.surfaceZ;
  let nx = ty * bz - tz * by;
  let ny = tz * bx - tx * bz;
  let nz = tx * by - ty * bx;
  const normalLength = Math.hypot(nx, ny, nz);
  if (!Number.isFinite(normalLength) || normalLength < 1e-8) return sample;
  nx /= normalLength; ny /= normalLength; nz /= normalLength;
  const bitangentX = ny * tz - nz * ty;
  const bitangentY = nz * tx - nx * tz;
  const bitangentZ = nx * ty - ny * tx;
  const mappedX = tx * sample.nx + bitangentX * sample.ny + nx * sample.nz;
  const mappedY = ty * sample.nx + bitangentY * sample.ny + ny * sample.nz;
  const mappedZ = tz * sample.nx + bitangentZ * sample.ny + nz * sample.nz;
  const length = Math.max(1e-8, Math.hypot(mappedX, mappedY, mappedZ));
  sample.nx = mappedX / length;
  sample.ny = mappedY / length;
  sample.nz = mappedZ / length;
  return sample;
}

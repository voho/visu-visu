import { sampleMaterial, type MaterialMap, type MaterialSample } from "./material.js";
import type { ResonanceFilament } from "./resonance.js";

function cyclicIndex(value: number, count: number): number {
  return Number.isFinite(value) ? ((Math.floor(value) % count) + count) % count : 0;
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
  strand = cyclicIndex(strand, filaments.length);
  const points = filaments[strand]!.points;
  const count = points.length - 1;
  if (count < 2) return sampleMaterial(map, 0, strand / filaments.length * 2, out);
  index = cyclicIndex(index, count);
  const sample = sampleMaterial(map, index / count * 2, strand / filaments.length * 2, out);
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

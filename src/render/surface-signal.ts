import type { AnalysisFrame } from "../types.js";

export const SURFACE_FEATURE_BANDS = 32;
const featuresByFrame = new WeakMap<AnalysisFrame, Float32Array>();

/**
 * Shared material signals: 32 spectrum bins followed by 32 signed waveform bins.
 * Area averaging preserves each source interval and limits aliasing. The result
 * belongs to the frame cache; callers must not mutate it.
 */
export function surfaceFeatureSamples(frame: AnalysisFrame): Float32Array {
  const cached = featuresByFrame.get(frame);
  if (cached) return cached;
  const samples = new Float32Array(SURFACE_FEATURE_BANDS * 2);
  let offset = 0;
  for (const source of [frame.spectrum, frame.waveform]) {
    const minimum = offset === 0 ? 0 : -1;
    for (let band = 0; band < SURFACE_FEATURE_BANDS; band += 1) {
      const start = band / SURFACE_FEATURE_BANDS * source.length;
      const end = (band + 1) / SURFACE_FEATURE_BANDS * source.length;
      let sum = 0;
      // Fractional overlap also handles analyses with fewer than 32 spectrum bins.
      for (let point = Math.floor(start); point < Math.ceil(end); point += 1) {
        const raw = source[point] ?? 0;
        const value = Number.isFinite(raw) ? Math.max(minimum, Math.min(1, raw)) : 0;
        sum += value * Math.max(0, Math.min(end, point + 1) - Math.max(start, point));
      }
      samples[offset++] = sum / Math.max(1e-9, end - start);
    }
  }
  featuresByFrame.set(frame, samples);
  return samples;
}

/** Bilinear one-row sampling, matching GL_LINEAR / CLAMP_TO_EDGE texture lookup. */
export function sampleSurfaceFeature(samples: Float32Array, kind: "spectrum" | "waveform", u: number): number {
  const coordinate = Math.max(0, Math.min(SURFACE_FEATURE_BANDS - 1,
    (Number.isFinite(u) ? u : 0) * SURFACE_FEATURE_BANDS - 0.5));
  const left = Math.floor(coordinate);
  const right = Math.min(SURFACE_FEATURE_BANDS - 1, left + 1);
  const offset = kind === "spectrum" ? 0 : SURFACE_FEATURE_BANDS;
  const a = samples[offset + left] ?? 0;
  const b = samples[offset + right] ?? 0;
  return a + (b - a) * (coordinate - left);
}

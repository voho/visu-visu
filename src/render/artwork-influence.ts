import type { AudioAnalysis } from "../types.js";
import { blendArtworkWarpFields, type ArtworkWarpField } from "./artwork-warp.js";

/**
 * A gentle wake of actual past object shapes. Sampling at 10 Hz and blending
 * three delayed poses smooths the field without keeping rendered-frame state.
 */
export class ArtworkInfluence {
  private readonly fields = new Map<number, ArtworkWarpField>();
  private analysis: AudioAnalysis | undefined;

  at(analysis: AudioAnalysis, time: number, capture: (time: number) => ArtworkWarpField): ArtworkWarpField {
    if (this.analysis !== analysis) {
      this.fields.clear();
      this.analysis = analysis;
    }
    const seconds = Number.isFinite(time) ? Math.max(0, time) : 0;
    const fields: ArtworkWarpField[] = [];
    const weights: number[] = [];
    for (const [delay, weight] of [[0.35, 0.50], [0.70, 0.32], [1.15, 0.18]] as const) {
      const position = Math.max(0, seconds - delay) * 10;
      const first = Math.floor(position);
      const mix = position - first;
      fields.push(this.capture(first, capture));
      weights.push(weight * (1 - mix));
      // The upper bracket is still at least 250 ms in the past. At startup,
      // a zero interpolation weight must not trigger a capture from the future.
      if (mix > 0) {
        fields.push(this.capture(first + 1, capture));
        weights.push(weight * mix);
      }
    }
    return blendArtworkWarpFields(fields, weights);
  }

  private capture(index: number, capture: (time: number) => ArtworkWarpField): ArtworkWarpField {
    let field = this.fields.get(index);
    if (!field) field = capture(index / 10);
    // Bound memory and retain the most recently used time samples across seeks.
    this.fields.delete(index);
    this.fields.set(index, field);
    while (this.fields.size > 32) this.fields.delete(this.fields.keys().next().value!);
    return field;
  }
}

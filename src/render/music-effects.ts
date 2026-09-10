import { clamp } from "../math/random.js";
import type { MusicMotion } from "./music-motion.js";
import type { SceneDynamics } from "./scene-dynamics.js";

export interface MusicEffects {
  /** Degrees along the swatch ring from the anchor, for the lights and the nebula. */
  hueShift: number;
  saturation: number;
  glow: number;
}

/** Equal spectral amplitudes produce progressively smaller spatial responses. */
export function frequencyResponse(energy: number, bandPosition: number): number {
  return clamp(energy) * (0.14 + 0.86 * (1 - clamp(bandPosition)) ** 1.7);
}

/**
 * Light colour and glow from the music. Only light accents shrink under
 * lowFlash. `warmth` (conductor, track-relative smoothed centroid) anchors
 * the hue travel two swatches along the ring: dark, bassy passages sit on
 * the cool swatches and bright ones on the warm, with the band energies
 * nudging a little further and a slow breath on the drift clock. The phase
 * selects source swatches; it never hue-rotates the artwork.
 */
export function deriveMusicEffects(motion: MusicMotion, lowFlash: boolean, dynamics?: SceneDynamics, warmth = 0.5): MusicEffects {
  const bass = frequencyResponse(dynamics?.body.energy ?? motion.bassEnergy, 0);
  const mid = frequencyResponse(dynamics?.detail.energy ?? motion.midEnergy, 0.45);
  const treble = frequencyResponse(dynamics?.spark.energy ?? motion.trebleEnergy, 1);
  const lightAttack = Math.min(motion.attack, lowFlash ? 0.3 : 1);
  const breath = Math.sin((dynamics?.drift.clock ?? motion.slowTime) * 0.35) * 24;
  return {
    hueShift: (Number.isFinite(warmth) ? clamp(warmth) : 0.5) * 144 + bass * 60 + mid * 30 - treble * 20 + breath,
    saturation: 1.16 + bass * 0.24 + mid * 0.25 + lightAttack * 0.45,
    glow: clamp(bass * 0.5 + mid * 0.2 + lightAttack * 0.28),
  };
}

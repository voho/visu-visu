import { clamp } from "../math/random.js";
import type { MusicMotion } from "./music-motion.js";
import type { SceneDynamics } from "./scene-dynamics.js";

export interface MusicEffects {
  zoom: number;
  rotation: number;
  hueShift: number;
  saturation: number;
  dispersion: number;
  glow: number;
}

/** Equal spectral amplitudes produce progressively smaller spatial responses. */
export function frequencyResponse(energy: number, bandPosition: number): number {
  return clamp(energy) * (0.14 + 0.86 * (1 - clamp(bandPosition)) ** 1.7);
}

/** Low-end movement remains expressive with lowFlash; only light accents shrink. */
export function deriveMusicEffects(motion: MusicMotion, lowFlash: boolean, dynamics?: SceneDynamics): MusicEffects {
  const bass = frequencyResponse(dynamics?.body.energy ?? motion.bassEnergy, 0);
  const mid = frequencyResponse(dynamics?.detail.energy ?? motion.midEnergy, 0.45);
  const treble = frequencyResponse(dynamics?.spark.energy ?? motion.trebleEnergy, 1);
  const lightAttack = Math.min(motion.attack, lowFlash ? 0.3 : 1);
  return {
    zoom: 1 + bass * 0.045 + motion.bassPulse * 0.15 + mid * 0.009,
    rotation: Math.sin(motion.slowTime * 0.28) * (0.012 + mid * 0.045)
      + Math.sin(motion.slowTime * 0.073) * 0.018,
    // Travel between source swatches, with different spectral inertia. This
    // phase never hue-rotates the photograph or invents colors for gray artwork.
    hueShift: dynamics
      ? dynamics.drift.clock * 110 + dynamics.cloud.clock * 28
        + bass * 85 + mid * 65 - treble * 45 - 60
      : motion.slowTime * 34 + bass * 50 + mid * 30 + treble * 20
        + Math.sin(motion.fastTime * 0.11) * 12 - 60,
    saturation: 1.16 + bass * 0.24 + mid * 0.25 + lightAttack * 0.45,
    dispersion: motion.bassPulse * 0.75 + motion.treblePulse * 0.18,
    glow: clamp(bass * 0.5 + mid * 0.2 + lightAttack * 0.28),
  };
}

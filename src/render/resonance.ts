import { clamp, createRandom, deriveSeed, lerp } from "../math/random.js";
import type { AnalysisFrame } from "../types.js";
import { LOW_FLASH_TRANSIENT_CAP, type VisualState } from "./conductor.js";
import type { SafeLayout } from "./layout.js";
import type { MusicMotion } from "./music-motion.js";
import { frequencyResponse } from "./music-effects.js";

const TAU = Math.PI * 2;
const FILAMENT_COUNT = 72;
const POINT_COUNT = 240;
const SPECTRAL_KNOTS = 14;
const WAVEFORM_HARMONICS = 4;

export interface ResonanceStrand {
  phase: number;
  strength: number;
  hueOffset: number;
}

export interface ResonancePlan {
  phase: number;
  tiltPhase: number;
  filaments: readonly ResonanceStrand[];
}

/** Shared hero camera; translation is measured in the graph's half extents. */
export interface ResonanceCamera {
  x: number;
  y: number;
  roll: number;
  zoom: number;
}

export interface ResonancePoint {
  x: number;
  y: number;
  /** Normalized camera depth: 0 is distant; 1 is near; .5 divides the object. */
  depth: number;
  energy: number;
  /** Camera-space position before perspective/viewport fit; Y points up. */
  surfaceX: number;
  surfaceY: number;
  surfaceZ: number;
}

export interface ResonanceFilament {
  /** Closed path: the final point is an exact copy of the first. */
  points: ResonancePoint[];
  hueOffset: number;
  alpha: number;
  /** Mean depth for coarse painter order; use point depth for intersecting strands. */
  depth: number;
}

function unit(value: number): number {
  return Number.isFinite(value) ? clamp(value) : 0;
}

function signed(value: number): number {
  return Number.isFinite(value) ? clamp(value, -1, 1) : 0;
}

export function createResonancePlan(seed: string): ResonancePlan {
  const random = createRandom(deriveSeed(seed, "resonance-sculpture"));
  const phase = random() * TAU;
  const tiltPhase = random() * TAU;
  const filaments = Array.from({ length: FILAMENT_COUNT }, (_, index) => {
    const position = index / FILAMENT_COUNT;
    const angle = position * TAU;
    return {
      // Smoothly compress neighboring strands into silk-like bundles. The
      // angular mapping remains ordered rather than randomly crossing strands.
      phase: angle + Math.sin(angle * 3 + phase) * 0.2
        + Math.sin(angle * 6 + phase * 2) * 0.05 + (random() - 0.5) * 0.012,
      strength: 0.72 + random() * 0.28,
      hueOffset: Math.sin(position * TAU + phase) * 48 + (random() - 0.5) * 9,
    };
  });
  return { phase, tiltPhase, filaments };
}

/** Broad overlapping bands keep isolated FFT bins from turning into sharp teeth. */
function spectralEnvelope(spectrum: Float32Array): number[] {
  if (spectrum.length === 0) return Array<number>(SPECTRAL_KNOTS).fill(0);
  return Array.from({ length: SPECTRAL_KNOTS }, (_, index) => {
    const center = (index / (SPECTRAL_KNOTS - 1)) * (spectrum.length - 1);
    const radius = Math.max(1.5, spectrum.length / (SPECTRAL_KNOTS - 1));
    const first = Math.max(0, Math.ceil(center - radius));
    const last = Math.min(spectrum.length - 1, Math.floor(center + radius));
    let total = 0;
    let weight = 0;
    for (let bin = first; bin <= last; bin += 1) {
      const contribution = 0.5 + 0.5 * Math.cos(((bin - center) / radius) * Math.PI);
      total += unit(spectrum[bin] ?? 0) * contribution;
      weight += contribution;
    }
    return total / Math.max(weight, 1e-9);
  });
}

function sampleEnvelope(envelope: number[], position: number): number {
  const index = clamp(position) * (envelope.length - 1);
  const lower = Math.floor(index);
  const amount = index - lower;
  return lerp(
    envelope[lower] ?? 0,
    envelope[Math.min(envelope.length - 1, lower + 1)] ?? 0,
    amount * amount * (3 - 2 * amount),
  );
}

/**
 * Keep only broad waveform harmonics. Raw PCM spikes and high-frequency phase
 * changes should never become jagged edges on the sculpture.
 */
function waveformHarmonics(waveform: Float32Array): { sine: number; cosine: number }[] {
  return Array.from({ length: WAVEFORM_HARMONICS }, (_, index) => {
    const harmonic = index + 1;
    let sine = 0;
    let cosine = 0;
    for (let sample = 0; sample < waveform.length; sample += 1) {
      const angle = (sample / waveform.length) * TAU * harmonic;
      const value = signed(waveform[sample] ?? 0);
      sine += value * Math.sin(angle);
      cosine += value * Math.cos(angle);
    }
    // The falloff also bounds the total displacement for arbitrary waveforms.
    const scale = 1 / (Math.max(1, waveform.length) * harmonic * harmonic);
    return { sine: sine * scale, cosine: cosine * scale };
  });
}

/**
 * A flowing magnetic sculpture sampled directly from absolute song time. The
 * supplied musical clocks are continuous integrals; instantaneous energy only
 * changes displacement and light, so it cannot teleport the object's rotation.
 */
export function createResonanceFilaments(
  plan: ResonancePlan,
  frame: AnalysisFrame,
  visual: VisualState,
  layout: SafeLayout,
  time: number,
  lowFlash: boolean,
  motion?: MusicMotion,
  camera?: ResonanceCamera,
): ResonanceFilament[] {
  const seconds = Number.isFinite(time) ? time : 0;
  const slowTime = motion?.slowTime ?? seconds * 0.28;
  const fastTime = motion?.fastTime ?? seconds;
  // The causal envelopes reveal quiet tracks and keep releases flowing between
  // attacks. Bass owns the silhouette; upper bands articulate its surface.
  const bass = unit(motion?.bassEnergy ?? frame.bass);
  const mid = frequencyResponse(unit(motion?.midEnergy ?? frame.mid), 0.45);
  const treble = unit(motion?.trebleEnergy ?? frame.treble);
  const bassPulse = unit(motion?.bassPulse ?? 0);
  const treblePulse = unit(motion?.treblePulse ?? 0);
  const sustain = unit(motion?.sustain ?? visual.ambient);
  const drive = unit(visual.drive);
  const peak = unit(visual.peak);
  const beat = Math.min(unit(visual.beat), lowFlash ? LOW_FLASH_TRANSIENT_CAP : 1);
  const envelope = spectralEnvelope(frame.spectrum);
  const harmonics = waveformHarmonics(frame.waveform);
  const horizontalHalf = Math.max(0, Math.min(layout.centerX - layout.left, layout.right - layout.centerX));
  const verticalHalf = Math.max(0, Math.min(layout.horizon - layout.graphTop, layout.graphBottom - layout.horizon));
  const inset = 0.90;
  const radiusY = Math.min(verticalHalf, horizontalHalf) * inset;
  const radiusX = Math.min(horizontalHalf * inset, radiusY * 1.8);
  const drift = slowTime * 0.46 + plan.phase;
  // Continuous morphing closes the central aperture into an orb, then unfolds
  // it into a flower and a bent plasma knot. These change proportions, so the
  // safety fit cannot normalize away the movement as it could with pure scale.
  const morphTime = slowTime * 1.8;
  const orb = 0.5 + Math.sin(morphTime * 0.54 + plan.phase + 1.2) * 0.5;
  const flower = 0.5 + Math.sin(morphTime * 0.67 + plan.phase) * 0.5;
  const knot = 0.5 + Math.sin(morphTime * 0.41 + plan.tiltPhase) * 0.5;
  const tiltX = 0.55 + Math.sin(morphTime * 0.34 + plan.tiltPhase) * 0.78;
  const tiltY = Math.sin(morphTime * 0.29 + plan.phase) * 0.92;
  const roll = morphTime * 0.11 + Math.sin(morphTime * 0.21 + plan.tiltPhase) * 0.26;
  const sinX = Math.sin(tiltX);
  const cosX = Math.cos(tiltX);
  const sinY = Math.sin(tiltY);
  const cosY = Math.cos(tiltY);
  const sinZ = Math.sin(roll);
  const cosZ = Math.cos(roll);

  let projectedExtent = 0;
  const cameraCos = Math.cos(camera?.roll ?? 0);
  const cameraSin = Math.sin(camera?.roll ?? 0);
  const cameraZoom = camera?.zoom ?? (motion ? 1.118 : 1.07);
  const availableX = Math.max(1, horizontalHalf * (1 - Math.abs(camera?.x ?? (motion ? 0.02 : 0))));
  const availableY = Math.max(1, verticalHalf * (1 - Math.abs(camera?.y ?? (motion ? 0.015 : 0))));
  const filaments = plan.filaments.map((strand) => {
    const points: ResonancePoint[] = [];
    let depthSum = 0;
    for (let index = 0; index < POINT_COUNT; index += 1) {
      const u = (index / POINT_COUNT) * TAU;
      const angle = u + slowTime * 0.12 + plan.phase
        + Math.sin(u * 2 + drift * 0.4) * knot * 0.12;
      // Strand variation must wrap with the poloidal angle so the filled
      // surface joins continuously between its last and first rows.
      const bandPosition = 0.5 - Math.cos(u + Math.sin(strand.phase) * 0.18 + drift * 0.22) * 0.5;
      const band = sampleEnvelope(envelope, bandPosition);
      const displacement = frequencyResponse(band, bandPosition);
      let wave = 0;
      for (let harmonic = 0; harmonic < harmonics.length; harmonic += 1) {
        const coefficient = harmonics[harmonic];
        if (!coefficient) continue;
        const phase = (u + drift * 0.3) * (harmonic + 1);
        wave += coefficient.sine * Math.sin(phase) + coefficient.cosine * Math.cos(phase);
      }

      // A poloidal turn and shared flow gather strands into luminous folds.
      // Uneven spacing is carried around the tube, avoiding a uniform wire grid.
      const flow = strand.phase + u + drift
        + Math.sin(u + drift * 0.7) * (0.52 + knot * 0.46)
        + Math.sin(u * 3 + drift * 0.45) * (0.25 + mid * 0.12);
      const v = flow + Math.sin(flow * 2) * (0.26 + flower * 0.2);
      const lobe = Math.cos(u * 3 - drift * 0.62);
      const major = 0.57 - orb * 0.2 + bass * 0.045 + drive * 0.02 + peak * 0.025
        + beat * 0.004 + displacement * 0.12 + wave * 0.04
        + lobe * (0.035 + flower * 0.065 + bass * 0.12) * (1 - orb * 0.4)
        + Math.sin(u * 2 + drift * 0.4) * (0.02 + mid * 0.025 + displacement * 0.035)
        + bassPulse * (0.035 + Math.sin(u * 3 - fastTime * 0.68) * 0.12);
      const tube = (0.17 + orb * 0.18 + mid * 0.035 + peak * 0.025)
        * (1 + Math.sin(u * 2 + drift) * (0.18 + mid * 0.1 + bass * 0.12))
        + bassPulse * (0.025 + Math.sin(u * 2 + strand.phase) * 0.025)
        + treble * Math.sin(u * 7 - fastTime * 1.6 + strand.phase) * 0.009
        + treblePulse * Math.sin(u * 15 - fastTime * 3) * 0.006;
      const distance = major + Math.cos(v) * tube;
      // Opposing axes stretch and relax rather than breathing uniformly. Broad
      // bass folds bend the entire volume while treble stays finely textured.
      const stretch = Math.sin(drift * 0.8) * (0.04 + sustain * 0.07 + bass * 0.055);
      const x = Math.cos(angle) * distance * (1 + stretch);
      const y = Math.sin(angle) * distance * (1 - stretch);
      const z = Math.sin(v) * tube
        + Math.sin(u * 2 + drift * 0.6) * (0.025 + knot * 0.105 + bass * 0.075)
        + Math.sin(u * 3 - fastTime * 0.68) * bassPulse * 0.085;

      const rotatedY = y * cosX - z * sinX;
      const tiltedZ = y * sinX + z * cosX;
      const rotatedX = x * cosY + tiltedZ * sinY;
      const rotatedZ = -x * sinY + tiltedZ * cosY;
      const projectedX = rotatedX * cosZ - rotatedY * sinZ;
      const projectedY = rotatedX * sinZ + rotatedY * cosZ;
      // A distant camera gives gentle perspective without a near-plane hazard.
      const perspective = 3.8 / (3.8 - rotatedZ);
      const normalizedX = projectedX * perspective;
      const normalizedY = projectedY * perspective;
      const screenX = normalizedX * radiusX;
      const screenY = normalizedY * radiusY;
      // Fit the entire volume after the same camera that will draw it. Calls
      // without a camera retain a conservative reserve for maximum motion.
      const projectedWidth = camera
        ? Math.abs(screenX * cameraCos - screenY * cameraSin)
        : Math.abs(screenX) + Math.abs(screenY) * (motion ? 0.065 : 0);
      const projectedHeight = camera
        ? Math.abs(screenX * cameraSin + screenY * cameraCos)
        : Math.abs(screenY) + Math.abs(screenX) * (motion ? 0.065 : 0);
      projectedExtent = Math.max(projectedExtent,
        projectedWidth * cameraZoom / availableX,
        projectedHeight * cameraZoom / availableY);
      const depth = clamp(0.5 + rotatedZ / 3.2);
      const energy = clamp(0.19 + band * 0.45 + mid * 0.07 + beat * 0.055
        + treble * (0.055 + Math.cos(u * 7 - drift + strand.phase) * 0.055)
        + Math.abs(wave) * 0.08 + (Math.sin(v - 0.6) + 1) * 0.055);
      points.push({
        x: normalizedX,
        y: normalizedY,
        depth,
        energy,
        surfaceX: projectedX,
        surfaceY: -projectedY,
        surfaceZ: rotatedZ,
      });
      depthSum += depth;
    }
    const first = points[0];
    if (first) points.push({ ...first });
    return {
      points,
      hueOffset: strand.hueOffset,
      alpha: strand.strength * (0.32 + drive * 0.18 + peak * 0.12 + beat * 0.028),
      depth: depthSum / POINT_COUNT,
    };
  });
  // A smooth bounded close-up lets compact poses fill the scene, while still
  // leaving room for folds, drift and light. One scalar preserves the outline;
  // the soft floor avoids pumping the camera on edge-on poses or FFT boundaries.
  const fit = 0.94 / Math.pow(projectedExtent ** 8 + 0.70 ** 8, 1 / 8);
  for (const strand of filaments) {
    for (const point of strand.points) {
      point.x = layout.centerX + point.x * fit * radiusX;
      point.y = layout.horizon + point.y * fit * radiusY;
    }
  }
  return filaments;
}

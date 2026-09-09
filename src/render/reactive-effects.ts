import {
  clamp,
  createRandom,
  deriveSeed,
  lerp,
  randomBetween,
  smoothstep,
} from "../math/random.js";
import type { AnalysisFrame } from "../types.js";
import type { VisualState } from "./conductor.js";
import { safeGraphRadii, type SafeLayout } from "./layout.js";

export interface RibbonPlan {
  phase: number;
  direction: -1 | 1;
  speed: number;
  turns: number;
  hue: number;
  ripplePhase: number;
}

export interface RibbonPoint {
  x: number;
  y: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
  angle: number;
  depth: number;
  front: boolean;
  energy: number;
  progress: number;
  hue: number;
  halfWidth: number;
  waveform: number;
  emission: number;
}

export interface RibbonOptions {
  lowFlash?: boolean;
  samples?: number;
  waveformScale?: number;
}

export interface DepthGlint {
  angle: number;
  orbitRadius: number;
  depthOffset: number;
  travelSpeed: number;
  angularSpeed: number;
  size: number;
  phase: number;
  spectrumIndex: number;
  hue: number;
}

export interface DepthGlintPose {
  x: number;
  y: number;
  trailX: number;
  trailY: number;
  depth: number;
  size: number;
  alpha: number;
  trail: number;
  energy: number;
  hue: number;
}

export interface VortexRingPlan {
  lane: number;
  driftPhase: number;
  hueOffset: number;
  thickness: number;
}

export interface VortexPlan {
  phase: number;
  speed: number;
  hue: number;
  rings: VortexRingPlan[];
}

export interface VortexRingPose {
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  depth: number;
  visibility: number;
  alpha: number;
  lineWidth: number;
  hue: number;
  lane: number;
}

export interface DynamicGrade {
  hueShift: number;
  washAlpha: number;
  bloom: number;
  vignetteScale: number;
  grainScale: number;
}

interface RibbonCenter {
  x: number;
  y: number;
  angle: number;
  depth: number;
  energy: number;
  progress: number;
  hue: number;
  halfWidth: number;
  waveform: number;
  emission: number;
}

function wrap(value: number): number {
  return ((value % 1) + 1) % 1;
}

function normalizeHue(value: number): number {
  return ((value % 360) + 360) % 360;
}

function sample(values: Float32Array, progress: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0] ?? 0;
  const position = clamp(progress) * (values.length - 1);
  const left = Math.floor(position);
  const right = Math.min(values.length - 1, left + 1);
  return lerp(values[left] ?? 0, values[right] ?? 0, position - left);
}

export function createRibbonPlan(seed: string): RibbonPlan {
  const random = createRandom(deriveSeed(seed, "spectral-ribbon"));
  return {
    phase: randomBetween(random, 0, Math.PI * 2),
    direction: random() < 0.5 ? -1 : 1,
    speed: randomBetween(random, 0.034, 0.052),
    turns: randomBetween(random, 1.68, 1.88),
    hue: randomBetween(random, 0, 360),
    ripplePhase: randomBetween(random, 0, Math.PI * 2),
  };
}

export function visualTransient(beat: number, lowFlash: boolean): number {
  return lowFlash ? Math.min(beat, 0.3) : beat;
}

/**
 * Builds a single open spectral ribbon with perspective depth and asymmetric
 * waveform-driven edges. Rotation is based only on its seed and absolute time;
 * live audio changes shape, width, and light without accumulating render state.
 */
export function createSpectralRibbonPoints(
  frame: AnalysisFrame,
  visual: VisualState,
  layout: SafeLayout,
  time: number,
  plan: RibbonPlan,
  options: RibbonOptions = {},
): RibbonPoint[] {
  const radii = safeGraphRadii(layout);
  const transient = visualTransient(visual.beat, options.lowFlash ?? false);
  const requestedSamples =
    options.samples ?? Math.max(128, Math.max(frame.spectrum.length, frame.waveform.length) * 2);
  const sampleCount = Math.round(clamp(requestedSamples, 8, 512));
  const turns = plan.turns + visual.form * 0.34 + frame.mid * 0.06;
  const rotation = plan.phase + plan.direction * time * plan.speed;
  const bassBreath = 1 + frame.bass * 0.025 + transient * 0.01;
  const colorSpread = lerp(72, 300, clamp(visual.peak));
  const centers: RibbonCenter[] = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const progress = index / Math.max(1, sampleCount - 1);
    const energy = clamp(sample(frame.spectrum, progress)) ** 0.72;
    const waveform = clamp(
      sample(frame.waveform, progress) * clamp(options.waveformScale ?? 1),
      -1,
      1,
    );
    const angle =
      rotation + plan.direction * progress * Math.PI * 2 * turns;
    const depth = clamp(0.5 + Math.sin(angle) * 0.5);
    const perspective = 0.72 + depth * 0.34;
    const baseRadius = 0.09 + progress * 0.78;
    const displacement = energy * (0.022 + visual.peak * 0.055 + transient * 0.025);
    const harmonicRipple =
      Math.sin(progress * Math.PI * 12 + time * 0.27 + plan.ripplePhase) *
      frame.treble *
      0.006;
    const radius = baseRadius + displacement + harmonicRipple;
    const halfWidth =
      radii.y *
      (0.027 + energy * 0.046 + visual.peak * 0.028 + transient * 0.016) *
      (0.66 + depth * 0.5);

    centers.push({
      x:
        layout.centerX +
        Math.cos(angle) * radii.x * radius * perspective * bassBreath,
      y: layout.horizon + Math.sin(angle) * radii.y * radius * bassBreath,
      angle,
      depth,
      energy,
      progress,
      hue: normalizeHue(
        plan.hue + (progress - 0.5) * colorSpread + frame.centroid * 28,
      ),
      halfWidth,
      waveform,
      emission: clamp(0.14 + energy * 0.5 + visual.peak * 0.16 + transient * 0.12),
    });
  }

  return centers.map((center, index) => {
    const previous = centers[Math.max(0, index - 1)] ?? center;
    const next = centers[Math.min(centers.length - 1, index + 1)] ?? center;
    const tangentX = next.x - previous.x;
    const tangentY = next.y - previous.y;
    const tangentLength = Math.max(1e-9, Math.hypot(tangentX, tangentY));
    const normalX = -tangentY / tangentLength;
    const normalY = tangentX / tangentLength;
    const leftWidth = center.halfWidth * (1 + center.waveform * 0.28);
    const rightWidth = center.halfWidth * (1 - center.waveform * 0.28);

    return {
      x: center.x,
      y: center.y,
      leftX: center.x + normalX * leftWidth,
      leftY: center.y + normalY * leftWidth,
      rightX: center.x - normalX * rightWidth,
      rightY: center.y - normalY * rightWidth,
      angle: center.angle,
      depth: center.depth,
      front: center.depth >= 0.5,
      energy: center.energy,
      progress: center.progress,
      hue: center.hue,
      halfWidth: center.halfWidth,
      waveform: center.waveform,
      emission: center.emission,
    };
  });
}

export function createDepthGlints(
  seed: string,
  count: number,
  spectrumBands: number,
): DepthGlint[] {
  const random = createRandom(deriveSeed(seed, "depth-glints"));
  const safeCount = Math.round(clamp(count, 0, 512));
  const lastBand = Math.max(0, Math.round(spectrumBands) - 1);

  return Array.from({ length: safeCount }, (_, index) => {
    const direction = random() < 0.5 ? -1 : 1;
    return {
      angle: randomBetween(random, 0, Math.PI * 2),
      orbitRadius: Math.sqrt(randomBetween(random, 0.04, 1)),
      depthOffset: random(),
      travelSpeed: randomBetween(random, 0.009, 0.022),
      angularSpeed: randomBetween(random, 0.004, 0.016) * direction,
      size: randomBetween(random, 0.65, 1.9),
      phase: randomBetween(random, 0, Math.PI * 2),
      spectrumIndex: Math.round((index / Math.max(1, safeCount - 1)) * lastBand),
      hue: randomBetween(random, 0, 360),
    };
  });
}

export function depthGlintPose(
  glint: DepthGlint,
  frame: AnalysisFrame,
  visual: VisualState,
  time: number,
  width: number,
  height: number,
  layout: SafeLayout,
  lowFlash: boolean,
  intensity = 1,
): DepthGlintPose {
  const transient = visualTransient(visual.beat, lowFlash);
  const depth = wrap(glint.depthOffset + time * glint.travelSpeed);
  const angle = glint.angle + time * glint.angularSpeed;
  const depthScale = 0.16 + depth ** 1.8 * 1.1;
  const radial = glint.orbitRadius * depthScale * (1 + visual.drive * 0.08 + transient * 0.025);
  const x = layout.centerX + Math.cos(angle) * radial * width * 0.62;
  const y = layout.horizon + Math.sin(angle) * radial * height * 0.42;
  const visibility =
    smoothstep(0, 0.12, depth) * (1 - smoothstep(0.9, 1, depth));
  const energy = clamp(frame.spectrum[glint.spectrumIndex] ?? 0);
  const twinkle =
    (0.58 + Math.sin(time * (0.42 + glint.travelSpeed * 11) + glint.phase) * 0.42) ** 2;
  const titleDistance = Math.hypot(
    (x - layout.centerX) / Math.max(1, layout.width * 0.34),
    (y - layout.titleY) / Math.max(1, height * 0.1),
  );
  const titleMask = lerp(0.12, 1, smoothstep(0.7, 1.2, titleDistance));
  const trail = clamp((visual.drive * 0.55 + visual.peak * 0.25 + transient * 0.5) * depth);
  const trailInset = 0.025 + trail * 0.1;
  const pixelScale = Math.max(0.55, width / 1920);

  return {
    x,
    y,
    trailX: lerp(x, layout.centerX, trailInset),
    trailY: lerp(y, layout.horizon, trailInset),
    depth,
    size:
      glint.size *
      pixelScale *
      (0.45 + depth ** 2 * 2.55) *
      (0.72 + energy * 0.78 + transient * 0.32),
    alpha: clamp(
      visibility *
        depth ** 1.3 *
        (0.02 + frame.treble * energy * 0.24 + visual.peak * 0.1 + transient * 0.07) *
        twinkle *
        Math.max(0, intensity) *
        titleMask,
      0,
      0.62,
    ),
    trail,
    energy,
    hue: normalizeHue(glint.hue + energy * 42 + frame.centroid * 28),
  };
}

export function createVortexPlan(seed: string, count = 8): VortexPlan {
  const random = createRandom(deriveSeed(seed, "vortex-rings"));
  const safeCount = Math.round(clamp(count, 1, 24));
  return {
    phase: random(),
    speed: randomBetween(random, 0.055, 0.085),
    hue: randomBetween(random, 0, 360),
    rings: Array.from({ length: safeCount }, (_, index) => ({
      lane: wrap(index / safeCount + randomBetween(random, -0.018, 0.018)),
      driftPhase: randomBetween(random, 0, Math.PI * 2),
      hueOffset: randomBetween(random, -42, 42),
      thickness: randomBetween(random, 0.78, 1.22),
    })),
  };
}

export function createVortexRings(
  plan: VortexPlan,
  frame: AnalysisFrame,
  visual: VisualState,
  layout: SafeLayout,
  time: number,
  lowFlash = false,
): VortexRingPose[] {
  const radii = safeGraphRadii(layout);
  const transient = visualTransient(visual.beat, lowFlash);

  return plan.rings
    .map((ring): VortexRingPose => {
      const laneDepth = wrap(plan.phase + time * plan.speed + ring.lane);
      const depth = laneDepth ** 1.7;
      const visibility =
        smoothstep(0, 0.12, laneDepth) * (1 - smoothstep(0.82, 1, laneDepth));
      const bassScale = 1 + frame.bass * 0.018 + transient * 0.012;
      const x =
        layout.centerX +
        Math.sin(time * 0.09 + ring.driftPhase) * layout.width * 0.016 * (1 - depth);
      const y =
        layout.horizon +
        Math.cos(time * 0.07 + ring.driftPhase) * layout.height * 0.01 * (1 - depth);

      return {
        x,
        y,
        radiusX: radii.x * (0.12 + depth) * bassScale,
        radiusY: radii.y * (0.08 + depth * 0.92) * bassScale,
        depth,
        visibility,
        alpha: clamp(
          visibility *
            (0.021 + depth * 0.105) *
            (0.32 + visual.drive * 0.62 + visual.peak * 0.38 + transient * 0.12),
          0,
          0.22,
        ),
        lineWidth:
          Math.max(0.55, layout.height / 760) *
          ring.thickness *
          (0.65 + depth * 2.5),
        hue: normalizeHue(
          plan.hue + ring.hueOffset + depth * 78 + frame.centroid * 32,
        ),
        lane: ring.lane,
      };
    })
    .sort((left, right) => left.depth - right.depth);
}

export function deriveDynamicGrade(
  frame: AnalysisFrame,
  visual: VisualState,
  time: number,
  lowFlash: boolean,
): DynamicGrade {
  const transient = visualTransient(visual.beat, lowFlash);
  const colorEnergy = clamp(
    frame.rms * 0.2 +
      frame.treble * 0.18 +
      visual.drive * 0.26 +
      visual.peak * 0.42 +
      transient * 0.24,
  );

  return {
    hueShift: clamp((frame.centroid - 0.5) * 72 + Math.sin(time * 0.14) * 12, -48, 48),
    washAlpha: clamp(0.006 + colorEnergy * 0.028, 0, 0.04),
    bloom: clamp(0.025 + visual.peak * 0.055 + transient * 0.085, 0, 0.17),
    vignetteScale: clamp(0.98 + visual.ambient * 0.06 - transient * 0.12, 0.82, 1.08),
    grainScale: clamp(0.7 + frame.treble * 0.24 + visual.drive * 0.08, 0.7, 1.02),
  };
}

import {
  clamp,
  createRandom,
  deriveSeed,
  lerp,
  randomBetween,
} from "../math/random.js";
import type { AnalysisFrame } from "../types.js";
import { LOW_FLASH_TRANSIENT_CAP, type VisualState } from "./conductor.js";
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

export interface DynamicGrade {
  bloom: number;
  vignetteScale: number;
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
  return lowFlash ? Math.min(beat, LOW_FLASH_TRANSIENT_CAP) : beat;
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

export function deriveDynamicGrade(visual: VisualState, lowFlash: boolean): DynamicGrade {
  const transient = visualTransient(visual.beat, lowFlash);
  return {
    bloom: clamp(0.025 + visual.peak * 0.055 + transient * 0.085, 0, 0.17),
    vignetteScale: clamp(0.98 + visual.ambient * 0.06 - transient * 0.12, 0.82, 1.08),
  };
}

import type { AnalysisFrame, AudioAnalysis } from "../types.js";

export const SCENE_LAYER_NAMES = ["drift", "cloud", "body", "detail", "spark", "impact"] as const;
export type SceneLayerName = typeof SCENE_LAYER_NAMES[number];
export interface SceneLayerDynamics {
  energy: number;
  /** Integrated momentum: motion stays continuous across audio frame boundaries. */
  clock: number;
}
export type SceneDynamics = Record<SceneLayerName, SceneLayerDynamics>;

interface LayerSettings {
  band: readonly [number, number];
  sensitivity: number;
  attack: number;
  release: number;
  momentum: number;
  baseSpeed: number;
  energySpeed: number;
}

const settings: Record<SceneLayerName, LayerSettings> = {
  drift: { band: [0, 0.13], sensitivity: 1, attack: 2.4, release: 8, momentum: 3.2, baseSpeed: 0.04, energySpeed: 0.12 },
  cloud: { band: [0.1, 0.4], sensitivity: 0.92, attack: 0.65, release: 3, momentum: 1.05, baseSpeed: 0.1, energySpeed: 0.28 },
  body: { band: [0, 0.3], sensitivity: 1, attack: 0.05, release: 0.7, momentum: 0.22, baseSpeed: 0.24, energySpeed: 0.8 },
  detail: { band: [0.32, 0.72], sensitivity: 0.7, attack: 0.022, release: 0.3, momentum: 0.085, baseSpeed: 0.6, energySpeed: 1.8 },
  spark: { band: [0.68, 1], sensitivity: 0.48, attack: 0.008, release: 0.12, momentum: 0.028, baseSpeed: 1.2, energySpeed: 3.6 },
  impact: { band: [0, 0.3], sensitivity: 1, attack: 0.006, release: 1.2, momentum: 0.1, baseSpeed: 0.08, energySpeed: 1.6 },
};

interface LayerProfile {
  targets: Float64Array;
  energies: Float64Array;
  momenta: Float64Array;
  clocks: Float64Array;
}
interface DynamicsProfile {
  fps: number;
  count: number;
  layers: Record<SceneLayerName, LayerProfile>;
}
const profiles = new WeakMap<AudioAnalysis, DynamicsProfile>();
const unit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Fractional FFT intervals keep the same spectral ranges at any band count. */
function spectralEnergy(frame: AnalysisFrame, layer: SceneLayerName): number {
  if (frame.spectrum.length === 0) {
    return unit(layer === "spark" ? frame.treble : layer === "detail" ? frame.mid
      : layer === "cloud" ? frame.bass * 0.6 + frame.mid * 0.4 : frame.bass);
  }
  const [low, high] = settings[layer].band;
  const start = low * frame.spectrum.length;
  const end = high * frame.spectrum.length;
  let squares = 0;
  for (let index = Math.floor(start); index < Math.ceil(end); index += 1) {
    const value = unit(frame.spectrum[index] ?? 0);
    const weight = Math.max(0, Math.min(end, index + 1) - Math.max(start, index));
    squares += value * value * weight;
  }
  return Math.sqrt(squares / Math.max(1e-9, end - start));
}

/** Exact cascade of an attack/release envelope and a momentum low-pass. */
function advance(energy: number, momentum: number, target: number, elapsed: number, layer: LayerSettings): { energy: number; momentum: number; area: number } {
  const a = target > energy ? layer.attack : layer.release;
  const b = layer.momentum;
  const decayA = Math.exp(-elapsed / a);
  const decayB = Math.exp(-elapsed / b);
  const areaA = a * -Math.expm1(-elapsed / a);
  const areaB = b * -Math.expm1(-elapsed / b);
  // All configured poles are distinct. Keeping the analytic limit here also
  // makes future timing adjustments safe when attack and momentum coincide.
  const samePole = Math.abs(a - b) < 1e-9;
  const drivenMomentum = samePole
    ? (energy - target) * elapsed / a * decayA
    : (energy - target) * a / (a - b) * (decayA - decayB);
  const drivenArea = samePole
    ? (energy - target) * (areaA - elapsed * decayA)
    : (energy - target) * a / (a - b) * (areaA - areaB);
  const area = target * elapsed + (momentum - target) * areaB + drivenArea;
  return {
    energy: unit(target + (energy - target) * decayA),
    momentum: unit(target + (momentum - target) * decayB + drivenMomentum),
    area: Math.max(0, Math.min(elapsed, area)),
  };
}

function buildProfile(analysis: AudioAnalysis): DynamicsProfile {
  const count = analysis.frames.length;
  const fps = Number.isFinite(analysis.fps) && analysis.fps > 0 ? analysis.fps : 30;
  const layers = Object.fromEntries(SCENE_LAYER_NAMES.map((name) => [name, {
    targets: Float64Array.from(analysis.frames, (frame) => spectralEnergy(frame, name)),
    energies: new Float64Array(count), momenta: new Float64Array(count), clocks: new Float64Array(count),
  }])) as Record<SceneLayerName, LayerProfile>;
  // A shared sensitivity gain reveals quieter recordings without normalizing
  // away the deliberate stronger response of bass versus upper frequencies.
  const levels = Array.from({ length: count }, (_, index) => Math.max(
    layers.drift.targets[index]!, layers.cloud.targets[index]!, layers.body.targets[index]!,
    layers.detail.targets[index]!, layers.spark.targets[index]!,
  )).sort((left, right) => left - right);
  const ceiling = levels[Math.floor((levels.length - 1) * 0.9)] ?? 0;
  const gain = Math.min(5, 0.9 / Math.max(0.09, ceiling));
  const bass = Float64Array.from(layers.body.targets, (value) => unit(Math.max(0, value - 0.0015) * gain));
  for (const name of SCENE_LAYER_NAMES) {
    const layer = layers[name];
    const parameters = settings[name];
    for (let index = 0; index < count; index += 1) {
      if (name === "impact") {
        // A loud first sample is not an onset. Only new bass or a new onset
        // supported by bass can excite the impact tier.
        const current = analysis.frames[index]!;
        const previous = analysis.frames[Math.max(0, index - 1)]!;
        const flux = index === 0 ? 0 : Math.max(0, bass[index]! - bass[index - 1]!) * 1.4;
        const onset = index === 0 ? 0 : Math.max(0, unit(current.onset) - unit(previous.onset)) * Math.sqrt(bass[index]!) * 0.85;
        layer.targets[index] = unit(Math.max(flux, onset));
      } else {
        layer.targets[index] = unit(Math.max(0, layer.targets[index]! - 0.0015) * gain) * parameters.sensitivity;
      }
      if (index === 0) continue;
      const previous = index - 1;
      const next = advance(layer.energies[previous]!, layer.momenta[previous]!, layer.targets[previous]!, 1 / fps, parameters);
      layer.energies[index] = next.energy;
      layer.momenta[index] = next.momentum;
      layer.clocks[index] = layer.clocks[previous]! + parameters.baseSpeed / fps + parameters.energySpeed * next.area;
    }
  }
  return { fps, count, layers };
}

/**
 * Six independent spectral/momentum tiers, evaluated at absolute song time.
 * Prefix integration gives O(6) seeks without accumulating rendered-frame state.
 * No future FFT frame is used to start an envelope or change a clock's speed.
 */
export function deriveSceneDynamics(analysis: AudioAnalysis, time: number): SceneDynamics {
  const safeTime = Number.isFinite(time) ? Math.max(0, Math.min(1e9, time)) : 0;
  let profile = profiles.get(analysis);
  if (!profile) {
    profile = buildProfile(analysis);
    profiles.set(analysis, profile);
  }
  let index = Math.min(profile.count - 1, Math.floor(safeTime * profile.fps));
  if (index > 0 && index / profile.fps > safeTime) index -= 1;
  if (index + 1 < profile.count && (index + 1) / profile.fps <= safeTime) index += 1;
  const elapsed = profile.count === 0 ? safeTime : safeTime - index / profile.fps;
  return Object.fromEntries(SCENE_LAYER_NAMES.map((name) => {
    const parameters = settings[name];
    if (profile.count === 0) return [name, { energy: 0, clock: parameters.baseSpeed * safeTime }];
    const layer = profile.layers[name];
    const sample = advance(layer.energies[index]!, layer.momenta[index]!, layer.targets[index]!, elapsed, parameters);
    return [name, { energy: sample.energy,
      clock: layer.clocks[index]! + parameters.baseSpeed * elapsed + parameters.energySpeed * sample.area }];
  })) as SceneDynamics;
}

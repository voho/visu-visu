import type { ScenePalette } from '../render/palette.js';
import type { spectralFlowPaths } from '../render/spectral-flow.js';

export interface FlowPreviewProfile {
  stride: number;
  duration: number;
  seed?: string;
  lowFlash?: boolean;
  palette: ScenePalette;
}
export function sampleSpectralFlowTimeline(time: number, profile: Pick<FlowPreviewProfile, 'stride' | 'duration'>,
  sampleTimeline: (time: number, values: Float32Array) => void): Parameters<typeof spectralFlowPaths>[0];
export function buildFlowRibbons(paths: ReturnType<typeof spectralFlowPaths>, colors: ScenePalette['colors'],
  frame: { width: number; height: number; creditFloor: number; creditCeiling: number; lowFlash?: boolean }): Float32Array;
export function createSpectralFlow(gl: unknown, profile: FlowPreviewProfile,
  sampleTimeline: (time: number, values: Float32Array) => void): {
  draw(time: number, values: Float32Array, width: number, height: number): void;
  inspect(): { paths: number; vertices: number; history: number };
};

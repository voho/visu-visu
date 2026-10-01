export const FLOW_AGES: readonly [1.4, 1.0, 0.65, 0.32, 0];
export interface SpectralFlowState {
  time: number;
  bass: number;
  mid: number;
  treble: number;
  impact: number;
  slow: number;
  fast: number;
  energy: number;
  presence: number;
  spectrum: ArrayLike<number>;
  waveform: ArrayLike<number>;
}
export interface SpectralFlowSample { age: number; state: SpectralFlowState }
export interface SpectralFlowPath {
  points: Array<{ x: number; y: number }>;
  family: 0 | 1;
  age: number;
  alpha: number;
  width: number;
  blur: number;
  color: number;
}
export function spectralFlowPaths(samples: readonly SpectralFlowSample[], seed: string | number): SpectralFlowPath[];

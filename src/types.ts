export const ANALYSIS_VERSION = 1;
export const RENDERER_VERSION = 4;

export interface OutputConfig {
  width: number;
  height: number;
  fps: number;
  renderScale: number;
  crf: number;
  preset: "ultrafast" | "veryfast" | "fast" | "medium" | "slow";
}

export interface TextConfig {
  title: string;
  artist: string;
}

export interface VisualConfig {
  seed: string;
  intensity: number;
  bokehCount: number;
  spectrumBands: number;
  grain: number;
  vignette: number;
  lowFlash: boolean;
}

export interface ProjectConfig {
  version: 1;
  output: OutputConfig;
  text: TextConfig;
  visual: VisualConfig;
}

export interface AudioPcm {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
  sourceHash: string;
  sourceFileHash: string;
}

export interface AnalysisFrame {
  rms: number;
  peak: number;
  bass: number;
  mid: number;
  treble: number;
  centroid: number;
  flux: number;
  onset: number;
  spectrum: Float32Array;
  waveform: Float32Array;
}

export interface AudioAnalysis {
  version: number;
  sampleRate: number;
  fps: number;
  duration: number;
  spectrumBands: number;
  waveformPoints: number;
  sourceHash: string;
  sourceFileHash: string;
  frames: AnalysisFrame[];
}

export interface RenderRequest {
  audioPath: string;
  outputPath: string;
  config: ProjectConfig;
  start: number;
  duration?: number;
  overwrite: boolean;
}

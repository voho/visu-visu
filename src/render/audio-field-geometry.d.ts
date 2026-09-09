export interface AudioFieldPoint { x: number; y: number; front: boolean }
export interface AudioFieldSpoke {
  x1: number; y1: number; x2: number; y2: number;
  energy: number; phase: number; front: boolean;
}
export interface AudioFieldGeometry {
  spokes: AudioFieldSpoke[];
  halos: Array<{ points: AudioFieldPoint[]; alpha: number; width: number; phase: number }>;
  wave: AudioFieldPoint[];
  waveAlpha: number;
}
export function audioFieldGeometry(
  spectrum: ArrayLike<number>, waveform: ArrayLike<number>, fast: number, slow: number, phase: number,
): AudioFieldGeometry;

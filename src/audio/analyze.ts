import { RealFft } from "../math/fft.js";
import { clamp } from "../math/random.js";
import { ANALYSIS_VERSION, type AnalysisFrame, type AudioAnalysis, type AudioPcm } from "../types.js";

const FFT_SIZE = 2048;
const WAVEFORM_POINTS = 192;
const MIN_FREQUENCY = 32;

interface RawFrame {
  rms: number;
  peak: number;
  centroid: number;
  flux: number;
  spectrum: Float32Array;
  waveform: Float32Array;
}

function percentile(values: number[], position: number): number {
  if (values.length === 0) return 1;
  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(position * (sorted.length - 1))));
  return sorted[index] ?? 1;
}

function logBandRanges(sampleRate: number, bandCount: number): Array<[number, number]> {
  const nyquist = sampleRate / 2;
  const maxFrequency = Math.min(16_000, nyquist * 0.98);
  const binFrequency = sampleRate / FFT_SIZE;
  const ranges: Array<[number, number]> = [];

  for (let band = 0; band < bandCount; band += 1) {
    const startRatio = band / bandCount;
    const endRatio = (band + 1) / bandCount;
    const startFrequency = MIN_FREQUENCY * (maxFrequency / MIN_FREQUENCY) ** startRatio;
    const endFrequency = MIN_FREQUENCY * (maxFrequency / MIN_FREQUENCY) ** endRatio;
    const startBin = Math.max(1, Math.floor(startFrequency / binFrequency));
    const endBin = Math.max(startBin + 1, Math.ceil(endFrequency / binFrequency));
    ranges.push([startBin, Math.min(FFT_SIZE / 2 + 1, endBin)]);
  }
  return ranges;
}

function bandMean(values: Float32Array, start: number, end: number): number {
  if (end <= start) return 0;
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += values[index] ?? 0;
  return sum / (end - start);
}

function rangeEnergy(spectrum: Float32Array, startRatio: number, endRatio: number): number {
  const start = Math.floor(startRatio * spectrum.length);
  const end = Math.max(start + 1, Math.ceil(endRatio * spectrum.length));
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += spectrum[index] ?? 0;
  return sum / (end - start);
}

export function analyzeAudio(pcm: AudioPcm, fps: number, spectrumBands: number): AudioAnalysis {
  if (pcm.samples.length === 0) throw new Error("Cannot analyze empty audio");
  const fft = new RealFft(FFT_SIZE);
  const window = new Float32Array(FFT_SIZE);
  const hann = new Float32Array(FFT_SIZE);
  for (let index = 0; index < FFT_SIZE; index += 1) {
    hann[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (FFT_SIZE - 1));
  }

  const ranges = logBandRanges(pcm.sampleRate, spectrumBands);
  const frameCount = Math.max(1, Math.ceil(pcm.duration * fps));
  const rawFrames: RawFrame[] = [];
  let previousSpectrum = new Float32Array(spectrumBands);

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const centerSample = Math.floor((frameIndex / fps) * pcm.sampleRate);
    const startSample = centerSample - FFT_SIZE / 2;
    let squareSum = 0;
    let peak = 0;

    for (let index = 0; index < FFT_SIZE; index += 1) {
      const sample = pcm.samples[startSample + index] ?? 0;
      window[index] = sample * (hann[index] ?? 0);
      squareSum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }

    const magnitudes = fft.magnitudes(window);
    const spectrum = new Float32Array(spectrumBands);
    let flux = 0;
    let weightedFrequency = 0;
    let magnitudeSum = 0;

    for (let band = 0; band < ranges.length; band += 1) {
      const [startBin, endBin] = ranges[band] ?? [0, 1];
      const rawMagnitude = bandMean(magnitudes, startBin, endBin);
      const value = Math.log1p(rawMagnitude * 240);
      spectrum[band] = value;
      flux += Math.max(0, value - (previousSpectrum[band] ?? 0));
    }

    for (let bin = 1; bin < magnitudes.length; bin += 1) {
      const magnitude = magnitudes[bin] ?? 0;
      weightedFrequency += magnitude * ((bin * pcm.sampleRate) / FFT_SIZE);
      magnitudeSum += magnitude;
    }

    const waveform = new Float32Array(WAVEFORM_POINTS);
    for (let point = 0; point < WAVEFORM_POINTS; point += 1) {
      const position = Math.floor((point / (WAVEFORM_POINTS - 1)) * (FFT_SIZE - 1));
      const sampleIndex = startSample + position;
      const before = pcm.samples[sampleIndex - 1] ?? 0;
      const current = pcm.samples[sampleIndex] ?? 0;
      const after = pcm.samples[sampleIndex + 1] ?? 0;
      waveform[point] = (before + current * 2 + after) / 4;
    }

    rawFrames.push({
      rms: Math.sqrt(squareSum / FFT_SIZE),
      peak,
      centroid: magnitudeSum > 0 ? weightedFrequency / magnitudeSum : 0,
      flux: flux / spectrumBands,
      spectrum,
      waveform,
    });
    previousSpectrum = spectrum;
  }

  const rmsScale = Math.max(0.0001, percentile(rawFrames.map((frame) => frame.rms), 0.95));
  const peakScale = Math.max(0.0001, percentile(rawFrames.map((frame) => frame.peak), 0.99));
  const fluxScale = Math.max(0.0001, percentile(rawFrames.map((frame) => frame.flux), 0.98));
  const spectrumValues: number[] = [];
  for (const frame of rawFrames) {
    for (const value of frame.spectrum) spectrumValues.push(value);
  }
  const spectrumScale = Math.max(0.0001, percentile(spectrumValues, 0.985));
  const normalizedFlux = rawFrames.map((frame) => clamp(frame.flux / fluxScale));
  const frames: AnalysisFrame[] = [];
  let smoothedRms = 0;

  for (let frameIndex = 0; frameIndex < rawFrames.length; frameIndex += 1) {
    const raw = rawFrames[frameIndex];
    if (!raw) continue;
    const targetRms = clamp(raw.rms / rmsScale);
    smoothedRms += (targetRms - smoothedRms) * (targetRms > smoothedRms ? 0.42 : 0.1);
    const spectrum = new Float32Array(spectrumBands);
    for (let band = 0; band < spectrumBands; band += 1) {
      spectrum[band] = clamp(((raw.spectrum[band] ?? 0) / spectrumScale) ** 0.82);
    }

    const localStart = Math.max(0, frameIndex - Math.round(fps * 0.4));
    const localEnd = Math.min(normalizedFlux.length, frameIndex + Math.round(fps * 0.4) + 1);
    let localFlux = 0;
    for (let index = localStart; index < localEnd; index += 1) localFlux += normalizedFlux[index] ?? 0;
    const threshold = (localFlux / Math.max(1, localEnd - localStart)) * 1.35;
    const flux = normalizedFlux[frameIndex] ?? 0;
    const onset = clamp((flux - threshold) * 3.2);

    const waveform = new Float32Array(raw.waveform.length);
    for (let index = 0; index < waveform.length; index += 1) {
      waveform[index] = clamp((raw.waveform[index] ?? 0) / peakScale, -1, 1);
    }

    frames.push({
      rms: smoothedRms,
      peak: clamp(raw.peak / peakScale),
      bass: rangeEnergy(spectrum, 0, 0.24),
      mid: rangeEnergy(spectrum, 0.24, 0.68),
      treble: rangeEnergy(spectrum, 0.68, 1),
      centroid: clamp(raw.centroid / (pcm.sampleRate / 2)),
      flux,
      onset,
      spectrum,
      waveform,
    });
  }

  return {
    version: ANALYSIS_VERSION,
    sampleRate: pcm.sampleRate,
    fps,
    duration: pcm.duration,
    spectrumBands,
    waveformPoints: WAVEFORM_POINTS,
    sourceHash: pcm.sourceHash,
    sourceFileHash: pcm.sourceFileHash,
    frames,
  };
}

export function frameAt(analysis: AudioAnalysis, time: number): AnalysisFrame {
  if (analysis.frames.length === 0) throw new Error("Analysis contains no frames");
  const index = Math.min(
    analysis.frames.length - 1,
    Math.max(0, Math.round(time * analysis.fps)),
  );
  return analysis.frames[index] ?? analysis.frames[0]!;
}

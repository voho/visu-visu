import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ANALYSIS_VERSION, type AnalysisFrame, type AudioAnalysis } from "../types.js";

interface SerializedFrame extends Omit<AnalysisFrame, "spectrum" | "spectrumLeft" | "spectrumRight" | "waveform"> {
  spectrum: number[];
  spectrumLeft?: number[];
  spectrumRight?: number[];
  waveform: number[];
}

interface SerializedAnalysis extends Omit<AudioAnalysis, "frames"> {
  frames: SerializedFrame[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkedNumber(
  value: unknown,
  label: string,
  min: number,
  max: number,
  integer = false,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  if (value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`);
  if (integer && !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function checkedHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 hash`);
  }
  return value;
}

function checkedArray(
  value: unknown,
  expectedLength: number,
  label: string,
  min: number,
  max: number,
): Float32Array {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw new Error(`${label} must contain exactly ${expectedLength} values`);
  }
  const output = new Float32Array(expectedLength);
  for (let index = 0; index < value.length; index += 1) {
    output[index] = checkedNumber(value[index], `${label}[${index}]`, min, max);
  }
  return output;
}

export async function saveAnalysis(path: string, analysis: AudioAnalysis): Promise<void> {
  const absolutePath = resolve(path);
  const serialized: SerializedAnalysis = {
    ...analysis,
    frames: analysis.frames.map(({ spectrumLeft, spectrumRight, ...frame }) => ({
      ...frame,
      spectrum: Array.from(frame.spectrum),
      ...(spectrumLeft === undefined ? {} : { spectrumLeft: Array.from(spectrumLeft) }),
      ...(spectrumRight === undefined ? {} : { spectrumRight: Array.from(spectrumRight) }),
      waveform: Array.from(frame.waveform),
    })),
  };
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(serialized)}\n`, "utf8");
}

export async function loadAnalysis(path: string): Promise<AudioAnalysis> {
  const absolutePath = resolve(path);
  let parsed: unknown;
  try {
    const info = await stat(absolutePath);
    if (info.size > 192 * 1024 * 1024) {
      throw new Error("analysis cache exceeds the 192 MiB JSON limit");
    }
    parsed = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read analysis ${absolutePath}: ${message}`);
  }
  if (!isRecord(parsed)) throw new Error(`Invalid analysis file: ${absolutePath}`);
  if (parsed.version !== ANALYSIS_VERSION) {
    throw new Error(
      `Analysis version ${String(parsed.version)} is not supported (expected ${ANALYSIS_VERSION})`,
    );
  }

  const sampleRate = checkedNumber(parsed.sampleRate, "sampleRate", 8_000, 384_000, true);
  const fps = checkedNumber(parsed.fps, "fps", 12, 60, true);
  const duration = checkedNumber(parsed.duration, "duration", Number.EPSILON, 21_600);
  const spectrumBands = checkedNumber(parsed.spectrumBands, "spectrumBands", 16, 128, true);
  const waveformPoints = checkedNumber(parsed.waveformPoints, "waveformPoints", 192, 192, true);
  const sourceHash = checkedHash(parsed.sourceHash, "sourceHash");
  const sourceFileHash = checkedHash(parsed.sourceFileHash, "sourceFileHash");
  if (!Array.isArray(parsed.frames)) throw new Error("frames must be an array");
  const expectedFrames = Math.ceil(duration * fps);
  if (expectedFrames > 100_000) throw new Error("Analysis timeline is too large");
  if (parsed.frames.length !== expectedFrames) {
    throw new Error(`frames must contain ${expectedFrames} entries for ${duration}s at ${fps} fps`);
  }
  const first = parsed.frames[0];
  const stereo = isRecord(first) && (first.spectrumLeft !== undefined || first.spectrumRight !== undefined);
  if (expectedFrames * (8 + spectrumBands * (stereo ? 3 : 1) + waveformPoints) > 10_000_000) {
    throw new Error("Analysis feature data is too large");
  }

  const frames: AnalysisFrame[] = parsed.frames.map((value, index) => {
    if (!isRecord(value)) throw new Error(`frames[${index}] must be an object`);
    if ((value.spectrumLeft !== undefined) !== stereo || (value.spectrumRight !== undefined) !== stereo) {
      throw new Error("Stereo spectra must include both channels on every frame");
    }
    const scalar = (name: string): number =>
      checkedNumber(value[name], `frames[${index}].${name}`, 0, 1);
    return {
      rms: scalar("rms"),
      peak: scalar("peak"),
      bass: scalar("bass"),
      mid: scalar("mid"),
      treble: scalar("treble"),
      centroid: scalar("centroid"),
      flux: scalar("flux"),
      onset: scalar("onset"),
      spectrum: checkedArray(value.spectrum, spectrumBands, `frames[${index}].spectrum`, 0, 1),
      ...(stereo ? {
        spectrumLeft: checkedArray(value.spectrumLeft, spectrumBands, `frames[${index}].spectrumLeft`, 0, 1),
        spectrumRight: checkedArray(value.spectrumRight, spectrumBands, `frames[${index}].spectrumRight`, 0, 1),
      } : {}),
      waveform: checkedArray(value.waveform, waveformPoints, `frames[${index}].waveform`, -1, 1),
    };
  });

  return {
    version: ANALYSIS_VERSION,
    sampleRate,
    fps,
    duration,
    spectrumBands,
    waveformPoints,
    sourceHash,
    sourceFileHash,
    frames,
  };
}

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAnalysis, saveAnalysis } from "../src/audio/cache.js";
import type { AudioAnalysis } from "../src/types.js";

const directory = join(tmpdir(), `visu-visu-cache-test-${process.pid}`);
const validPath = join(directory, "nested", "valid.analysis.json");
const invalidPath = join(directory, "invalid.analysis.json");

const analysis: AudioAnalysis = {
  version: 1,
  sampleRate: 24_000,
  fps: 30,
  duration: 1 / 30,
  spectrumBands: 16,
  waveformPoints: 192,
  sourceHash: "a".repeat(64),
  sourceFileHash: "b".repeat(64),
  frames: [
    {
      rms: 0.5,
      peak: 0.8,
      bass: 0.4,
      mid: 0.3,
      treble: 0.2,
      centroid: 0.5,
      flux: 0.1,
      onset: 0,
      spectrum: new Float32Array(16).fill(0.25),
      waveform: new Float32Array(192).fill(-0.2),
    },
  ],
};

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("analysis cache", () => {
  test("round-trips typed feature frames and creates parent directories", async () => {
    await saveAnalysis(validPath, analysis);
    const loaded = await loadAnalysis(validPath);
    expect(loaded).toEqual(analysis);
    expect(loaded.frames[0]?.spectrum).toBeInstanceOf(Float32Array);
  });

  test("rejects non-finite and structurally inconsistent feature data", async () => {
    await mkdir(directory, { recursive: true });
    const invalid = {
      ...analysis,
      frames: [{ ...analysis.frames[0], rms: "0.5", spectrum: [0.1] }],
    };
    await writeFile(invalidPath, JSON.stringify(invalid), "utf8");
    expect(loadAnalysis(invalidPath)).rejects.toThrow();
  });
});

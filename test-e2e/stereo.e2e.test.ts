import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { analyzeAudio, frameAt } from "../src/audio/analyze.js";
import { loadAnalysis, saveAnalysis } from "../src/audio/cache.js";
import { decodeAudio } from "../src/audio/decode.js";
import { ensureStereoAnalysis } from "../src/audio/stereo.js";

const execute = promisify(execFile);
let directory: string, audioPath: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "visu-stereo-e2e-"));
  audioPath = join(directory, "distinct stereo.wav");
  await execute("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i",
    "aevalsrc=0.6*sin(2*PI*375*t)|0.3*sin(2*PI*3000*t):s=48000:d=1:c=stereo",
    "-c:a", "pcm_f32le", audioPath], { timeout: 30_000 });
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("real stereo decode and legacy cache compatibility", () => {
  test("preserves L/R through resampling and keeps the established mono PCM hash", async () => {
    const pcm = await decodeAudio(audioPath);
    const reference = (await execute("ffmpeg", ["-v", "error", "-i", audioPath,
      "-vn", "-ac", "1", "-ar", "24000", "-f", "f32le", "-acodec", "pcm_f32le", "-"],
    { encoding: "buffer", timeout: 30_000 })).stdout;
    expect(pcm.sampleRate).toBe(24_000);
    expect(pcm.duration).toBe(1);
    expect(Buffer.from(pcm.samples.buffer)).toEqual(reference);
    expect(pcm.sourceHash).toBe(createHash("sha256").update(reference).digest("hex"));
    expect(pcm.channels!.left).toHaveLength(24_000);
    expect(pcm.channels!.right).toHaveLength(24_000);
    for (const [channel, frequency, amplitude] of [["left", 375, 0.6], ["right", 3000, 0.3]] as const) {
      let error = 0;
      for (let index = 100; index < 23_900; index++) {
        error += Math.abs(pcm.channels![channel][index]! - Math.sin(2 * Math.PI * frequency * index / 24_000) * amplitude);
      }
      expect(error / 23_800).toBeLessThan(0.0001);
    }
  });

  test("enriches a version-2 mono cache without changing motion, identity or the cached input", async () => {
    const pcm = await decodeAudio(audioPath);
    const { channels: _channels, ...monoPcm } = pcm;
    const mono = analyzeAudio(monoPcm, 60, 64);
    const legacy = { ...mono, frames: mono.frames.map(({ spectrumLeft: _left, spectrumRight: _right, ...frame }) => frame) };
    const path = join(directory, "legacy.analysis.json");
    await saveAnalysis(path, legacy);
    const loaded = await loadAnalysis(path);
    const enriched = await ensureStereoAnalysis(audioPath, loaded);
    expect(enriched.sourceHash).toBe(loaded.sourceHash);
    expect(enriched.sourceFileHash).toBe(loaded.sourceFileHash);
    expect(enriched.frames.map(({ spectrumLeft: _left, spectrumRight: _right, ...frame }) => frame)).toEqual(loaded.frames);
    expect(loaded.frames[0]!.spectrumLeft).toBeUndefined();
    const frame = frameAt(enriched, 0.5);
    const leftBand = frame.spectrumLeft!.indexOf(Math.max(...frame.spectrumLeft!));
    const rightBand = frame.spectrumRight!.indexOf(Math.max(...frame.spectrumRight!));
    expect(rightBand - leftBand).toBeGreaterThan(15);
    expect(frame.spectrumRight![leftBand]!).toBeLessThan(0.01);
    expect(frame.spectrumLeft![rightBand]!).toBeLessThan(0.01);
    expect(await ensureStereoAnalysis("absent.wav", enriched)).toBe(enriched);
    await expect(ensureStereoAnalysis(audioPath, { ...loaded, sourceFileHash: "a".repeat(64) }))
      .rejects.toThrow("different audio file");
    await saveAnalysis(path, enriched);
    expect(await loadAnalysis(path)).toEqual(enriched);
  });
});

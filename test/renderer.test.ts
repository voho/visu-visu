import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { analyzeAudio } from "../src/audio/analyze.js";
import { parseProjectConfig } from "../src/config.js";
import { VisualizerRenderer } from "../src/render/renderer.js";
import type { AudioPcm } from "../src/types.js";

describe("visualizer renderer", () => {
  test("renders identical RGBA bytes for the same time and seed", () => {
    const sampleRate = 24_000;
    const samples = Float32Array.from({ length: sampleRate }, (_, index) =>
      Math.sin((2 * Math.PI * 180 * index) / sampleRate) * 0.55,
    );
    const pcm: AudioPcm = {
      samples,
      sampleRate,
      duration: 1,
      sourceHash: "fixture",
      sourceFileHash: "fixture-file",
    };
    const config = parseProjectConfig({
      output: { width: 320, height: 240, fps: 12 },
      text: { title: "Signal", artist: "Test" },
      visual: { bokehCount: 12, spectrumBands: 32 },
    });
    const analysis = analyzeAudio(pcm, 12, 32);
    analysis.frames[4]!.onset = 0.08;
    analysis.frames[5]!.onset = 0.9;
    analysis.frames[6]!.onset = 0.06;
    const renderer = new VisualizerRenderer(config, "fixed-seed");
    const freshRenderer = new VisualizerRenderer(config, "fixed-seed");
    const first = renderer.render(analysis, 0.5);
    const digest = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");
    const firstDigest = digest(first);

    expect(first.byteLength).toBe(320 * 240 * 4);
    const earlier = renderer.render(analysis, 0.2);
    const later = renderer.render(analysis, 0.8);
    const replayed = renderer.render(analysis, 0.5);
    const fresh = freshRenderer.render(analysis, 0.5);
    expect(digest(first)).toBe(firstDigest);
    expect(digest(replayed)).toBe(firstDigest);
    expect(digest(fresh)).toBe(firstDigest);
    expect(digest(earlier)).not.toBe(digest(later));
    expect(digest(new VisualizerRenderer(config, "other-seed").render(analysis, 0.5))).not.toBe(
      firstDigest,
    );

    const quietAnalysis = analyzeAudio(
      {
        ...pcm,
        samples: new Float32Array(sampleRate),
        sourceHash: "quiet",
        sourceFileHash: "quiet-file",
      },
      12,
      32,
    );
    const statefulRenderer = new VisualizerRenderer(config, "state-seed");
    statefulRenderer.render(quietAnalysis, 0.5);
    statefulRenderer.render(analysis, 0.5);
    const afterQuietAndPeak = statefulRenderer.render(analysis, 0.5);
    const freshPeak = new VisualizerRenderer(config, "state-seed").render(analysis, 0.5);
    expect(digest(afterQuietAndPeak)).toBe(digest(freshPeak));

    // Re-analysis of the same source can retain hashes and frame count while
    // changing features. Background caches must follow the analysis object.
    const reanalyzed = structuredClone(quietAnalysis);
    reanalyzed.sourceHash = analysis.sourceHash;
    reanalyzed.sourceFileHash = analysis.sourceFileHash;
    const reused = new VisualizerRenderer(config, "analysis-identity");
    reused.render(analysis, 0.5);
    const switched = reused.render(reanalyzed, 0.5);
    const isolated = new VisualizerRenderer(config, "analysis-identity").render(reanalyzed, 0.5);
    expect(digest(switched)).toBe(digest(isolated));

    const highFrequencyAnalysis = analyzeAudio(
      {
        ...pcm,
        samples: Float32Array.from({ length: sampleRate }, (_, index) =>
          Math.sin((2 * Math.PI * 6_000 * index) / sampleRate) * 0.55,
        ),
        sourceHash: "high-frequency",
        sourceFileHash: "high-frequency-file",
      },
      12,
      32,
    );
    const lowFrequencyFrame = new VisualizerRenderer(config, "frequency-seed").render(
      analysis,
      0.5,
    );
    const highFrequencyFrame = new VisualizerRenderer(config, "frequency-seed").render(
      highFrequencyAnalysis,
      0.5,
    );
    let pixelDifference = 0;
    let channelCount = 0;
    for (let index = 0; index < lowFrequencyFrame.length; index += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        pixelDifference += Math.abs(
          (lowFrequencyFrame[index + channel] ?? 0) -
            (highFrequencyFrame[index + channel] ?? 0),
        );
        channelCount += 1;
      }
    }
    expect(pixelDifference / channelCount).toBeGreaterThan(0.25);

    const portraitConfig = parseProjectConfig({
      output: { width: 180, height: 320, fps: 12 },
      text: { title: "Portrait Signal", artist: "Test" },
      visual: { bokehCount: 8, spectrumBands: 32 },
    });
    const portrait = new VisualizerRenderer(portraitConfig, "fixed-seed").render(analysis, 0.5);
    expect(portrait.byteLength).toBe(180 * 320 * 4);
  });

  test("reports every render stage in draw order to the profiler without changing a pixel", () => {
    const sampleRate = 24_000;
    const analysis = analyzeAudio({
      samples: Float32Array.from({ length: sampleRate }, (_, index) =>
        Math.sin((2 * Math.PI * 180 * index) / sampleRate) * 0.55),
      sampleRate, duration: 1, sourceHash: "profiled", sourceFileHash: "profiled-file",
    }, 12, 32);
    const config = parseProjectConfig({
      output: { width: 320, height: 180, fps: 12 },
      text: { title: "Profiled", artist: "Test" },
      visual: { bokehCount: 12, spectrumBands: 32 },
    });
    const plain = new VisualizerRenderer(config, "profiled").render(analysis, 0.8);
    const profiled = new VisualizerRenderer(config, "profiled");
    const stages: string[] = [];
    profiled.profiler = (stage, surface) => {
      surface.getContext("2d").getImageData(0, 0, 1, 1);
      stages.push(stage);
    };
    expect(Buffer.from(profiled.render(analysis, 0.8)).equals(Buffer.from(plain))).toBe(true);
    expect(stages).toEqual([
      "signals", "room", "emission", "bloom", "ghosts", "composite", "band", "hits", "skin",
      "filaments", "fragments", "embers", "post", "dither", "vignette", "typography", "readback",
    ]);
  });

  test("keeps every hit inside the flash budget under lowFlash while still registering", () => {
    const sampleRate = 24_000;
    const duration = 3;
    const pcm: AudioPcm = {
      samples: Float32Array.from({ length: sampleRate * duration }, (_, index) =>
        Math.sin((2 * Math.PI * 180 * index) / sampleRate) * 0.55,
      ),
      sampleRate,
      duration,
      sourceHash: "dense-hits",
      sourceFileHash: "dense-hits-file",
    };
    const fps = 12;
    const analysis = analyzeAudio(pcm, fps, 32);
    // An onset every 0.25 s; the plan's refractory keeps every other one (0.25, 0.75, 1.25, ...).
    for (let index = 3; index < analysis.frames.length; index += 3) analysis.frames[index]!.onset = 1;
    const config = parseProjectConfig({
      output: { width: 320, height: 180, fps },
      text: { title: "Budget", artist: "Test" },
      visual: { bokehCount: 12, spectrumBands: 32, lowFlash: true },
    });
    const meanLuma = (buffer: Buffer): number => {
      let sum = 0;
      for (let index = 0; index < buffer.length; index += 4) {
        sum += buffer[index]! * 0.2126 + buffer[index + 1]! * 0.7152 + buffer[index + 2]! * 0.0722;
      }
      return sum / (buffer.length / 4) / 255;
    };
    const renderer = new VisualizerRenderer(config, "budget-seed");
    const hitTime = 1.25;
    const onHit = meanLuma(Buffer.from(renderer.render(analysis, hitTime + 1 / fps)));
    const later = meanLuma(Buffer.from(renderer.render(analysis, hitTime + 0.4)));
    expect(Math.abs(onHit - later)).toBeLessThanOrEqual(0.08);
    // The floor only proves the hit registers at all (lift + burst + ring on a
    // small, chapter-0 hit); the budget is the upper bound.
    expect(Math.abs(onHit - later)).toBeGreaterThanOrEqual(0.003);
  });
});

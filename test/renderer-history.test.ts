import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectConfig } from "../src/config.js";
import { prepareArtwork } from "../src/render/artwork.js";
import { cloudEventsAt } from "../src/render/frozen-cloud.js";
import { VisualizerRenderer } from "../src/render/renderer.js";
import { ANALYSIS_VERSION, type AudioAnalysis } from "../src/types.js";

function historyAnalysis(): AudioAnalysis {
  const fps = 30;
  const duration = 24;
  return {
    version: ANALYSIS_VERSION, sampleRate: 48_000, fps, duration,
    spectrumBands: 16, waveformPoints: 32,
    sourceHash: "material-history", sourceFileHash: "material-history-file",
    frames: Array.from({ length: fps * duration }, (_, index) => {
      const time = index / fps;
      const hit = index >= fps && (index - fps) % (fps * 3) === 0;
      return {
        rms: 0.15, peak: hit ? 0.8 : 0.25, bass: hit ? 0.24 : 0.015,
        mid: 0.04 + Math.sin(time * 0.7) * 0.025,
        treble: 0.025 + Math.sin(time * 1.9) * 0.02,
        centroid: 0.25 + Math.sin(time * 0.4) * 0.15,
        flux: hit ? 0.4 : 0, onset: hit ? 0.8 : 0,
        spectrum: Float32Array.from({ length: 16 }, (_, band) =>
          (0.08 + Math.sin(time * (0.25 + band * 0.07) + band) * 0.07) *
          (hit && band < 4 ? 4 : 1)),
        waveform: Float32Array.from({ length: 32 }, (_, sample) =>
          Math.sin(sample * 0.43 + time * 2.1) * (hit ? 0.5 : 0.15)),
      };
    }),
  };
}

function digest(pixels: Buffer): string {
  return createHash("sha256").update(pixels).digest("hex");
}

/** A small painted cover with warm, cool and bright regions, written to a temp dir. */
async function coverFixture(width: number, height: number) {
  const directory = await mkdtemp(join(tmpdir(), "visu-history-"));
  const cover = createCanvas(80, 80);
  const paint = cover.getContext("2d");
  const gradient = paint.createLinearGradient(0, 0, 80, 80);
  gradient.addColorStop(0, "#dd7826");
  gradient.addColorStop(0.45, "#274768");
  gradient.addColorStop(1, "#40a787");
  paint.fillStyle = gradient;
  paint.fillRect(0, 0, 80, 80);
  paint.fillStyle = "#efc586";
  paint.fillRect(13, 15, 19, 46);
  const path = join(directory, "cover.png");
  await writeFile(path, cover.toBuffer("image/png"));
  const artwork = await prepareArtwork(path, width, height);
  return { path, artwork, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

describe("material sculpture history integration", () => {
  for (const [width, height] of [[320, 180], [180, 320]] as const) {
    test(`reconstructs frozen material, camera, and cover after cache eviction at ${width}×${height}`, async () => {
      const { path, artwork, cleanup } = await coverFixture(width, height);
      try {
        expect(artwork?.material).toBeDefined();
        const config = parseProjectConfig({
          output: { width, height, fps: 30 },
          text: { title: "Frozen Signal", artist: "voho" },
          visual: { imagePath: path, lighting: 0.8, bokehCount: 8, spectrumBands: 16 },
        });
        const source = historyAnalysis();
        const target = 4.75;
        expect(cloudEventsAt(source, target).length).toBeGreaterThanOrEqual(2);
        const createRenderer = (): VisualizerRenderer => new VisualizerRenderer(
          config, "history-integration", { width, height }, artwork,
        );
        const renderer = createRenderer();
        const direct = digest(createRenderer().render(source, target));
        for (const time of [0, 1.05, 1.8, 3.5, 4.4]) renderer.render(source, time);
        expect(digest(renderer.render(source, target))).toBe(direct);

        // These frames discard every original capture, then force reconstruction
        // while the live shape, spectral lighting, and camera are different.
        for (const time of [21.2, 0, 11.4, 1.3]) renderer.render(source, time);
        expect(digest(renderer.render(source, target))).toBe(direct);

        // A new analysis object can retain the source identifiers. None of its
        // captures or material lighting may leak into the original analysis.
        const changed = structuredClone(source);
        for (const frame of changed.frames) {
          frame.bass = 0;
          frame.onset = 0;
          frame.spectrum.fill(0.3);
        }
        renderer.render(changed, target);
        expect(digest(renderer.render(source, target))).toBe(direct);
      } finally {
        await cleanup();
      }
    });
  }

  test("cover frames at three times are byte-identical after forward, reverse and direct seeks", async () => {
    const { path, artwork, cleanup } = await coverFixture(320, 180);
    try {
      const config = parseProjectConfig({
        output: { width: 320, height: 180, fps: 30 },
        text: { title: "Seek Order", artist: "voho" },
        visual: { imagePath: path, bokehCount: 8, spectrumBands: 16 },
      });
      const source = historyAnalysis();
      const fresh = (): VisualizerRenderer => new VisualizerRenderer(config, "seek-order", { width: 320, height: 180 }, artwork);
      // Before the lockup settles, at a frozen-cloud capture, and mid-track with
      // fragments alive: the three states that carry per-renderer caches.
      const times = [0.4, 1.05, 4.75];
      const direct = new Map(times.map((time) => [time, digest(fresh().render(source, time))]));
      const forward = fresh();
      for (const time of times) expect(digest(forward.render(source, time))).toBe(direct.get(time)!);
      const reverse = fresh();
      for (const time of [...times].reverse()) expect(digest(reverse.render(source, time))).toBe(direct.get(time)!);
      for (const time of times) expect(digest(forward.render(source, time))).toBe(direct.get(time)!);
    } finally {
      await cleanup();
    }
  });
});

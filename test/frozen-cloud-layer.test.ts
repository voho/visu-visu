import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { describe, expect, test } from "bun:test";
import { FrozenCloudLayer } from "../src/render/frozen-cloud-layer.js";
import { FROZEN_CLOUD_LIFETIME } from "../src/render/frozen-cloud.js";
import { createSafeLayout } from "../src/render/layout.js";
import { ANALYSIS_VERSION, type AudioAnalysis } from "../src/types.js";

function analysis(): AudioAnalysis {
  const fps = 60;
  return {
    version: ANALYSIS_VERSION, sampleRate: 48_000, fps, duration: 12,
    spectrumBands: 16, waveformPoints: 16, sourceHash: "cloud-layer", sourceFileHash: "cloud-layer",
    frames: Array.from({ length: fps * 12 }, (_, index) => ({
      rms: 0, peak: 0, bass: index >= fps && (index - fps) % (fps * 3) === 0 ? 0.08 : 0,
      mid: 0, treble: 0, centroid: 0, flux: 0, onset: 0,
      spectrum: new Float32Array(16), waveform: new Float32Array(16),
    })),
  };
}

function fixture(width = 360, height = 640, seed = "cloud-layer") {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const layout = createSafeLayout(width, height);
  const layer = new FrozenCloudLayer(width, height, layout, seed);
  const captureTimes: number[] = [];
  const capture = (drawing: SKRSContext2D, time: number): void => {
    captureTimes.push(time);
    drawing.strokeStyle = time < 4 ? "#e0a0ff" : "#40d8ff";
    drawing.lineWidth = 14;
    drawing.beginPath();
    drawing.ellipse(layout.centerX, layout.horizon, width * 0.2, height * 0.11, time * 0.3, 0, Math.PI * 2);
    drawing.stroke();
    drawing.fillStyle = "white";
    drawing.fillRect(layout.centerX + width * 0.12, layout.horizon - height * 0.03, width * 0.08, height * 0.08);
  };
  const render = (source: AudioAnalysis, time: number, draw = capture): Buffer => {
    context.clearRect(0, 0, width, height);
    layer.draw(context, source, time, draw);
    return Buffer.from(context.getImageData(0, 0, width, height).data);
  };
  return { context, captureTimes, render };
}

function alphaStats(pixels: Buffer): { max: number; count: number; sum: number } {
  let max = 0, count = 0, sum = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    const alpha = pixels[index]!;
    max = Math.max(max, alpha);
    count += Number(alpha > 0);
    sum += alpha;
  }
  return { max, count, sum };
}

describe("frozen cloud optical layer", () => {
  test("replays identical pixels after forward and reverse seeks, including evicted captures", () => {
    const source = analysis();
    const reused = fixture();
    const expected = reused.render(source, 4.617);
    expect(alphaStats(expected).count).toBeGreaterThan(1000);
    for (const time of [10.2, 0, 7.4, 1.61, 11.8]) reused.render(source, time);
    expect(reused.render(source, 4.617)).toEqual(expected);
    expect(fixture().render(source, 4.617)).toEqual(expected);
    expect(fixture(360, 640, "other-cloud-seed").render(source, 4.617)).not.toEqual(expected);
  });

  test("captures only fixed event timestamps, reuses live snapshots, and invalidates a changed analysis", () => {
    const source = analysis();
    const subject = fixture();
    subject.render(source, 1.5);
    expect(subject.captureTimes).toEqual([1]);
    subject.render(source, 1.8);
    subject.render(source, 3.9);
    expect(subject.captureTimes).toEqual([1]);
    subject.render(source, 4.6);
    expect(subject.captureTimes).toEqual([1, 4]);
    // Seeking backwards while a snapshot is cached never changes its capture.
    subject.render(source, 1.8);
    expect(subject.captureTimes).toEqual([1, 4]);
    const reanalyzed = analysis();
    const refreshed = subject.render(reanalyzed, 1.8);
    expect(subject.captureTimes).toEqual([1, 4, 1]);
    expect(refreshed).toEqual(fixture().render(reanalyzed, 1.8));
  });

  test("evicts expired captures and reconstructs them only if a later seek needs them", () => {
    const source = analysis();
    const subject = fixture();
    const first = subject.render(source, 1.6);
    expect(subject.captureTimes).toEqual([1]);
    subject.render(source, 8.6);
    expect(subject.captureTimes).toEqual([1, 4, 7]);
    subject.render(source, 8.8);
    expect(subject.captureTimes).toEqual([1, 4, 7]);
    expect(subject.render(source, 1.6)).toEqual(first);
    expect(subject.captureTimes).toEqual([1, 4, 7, 1]);
  });

  test("keeps white fog subtle and completely out of the title and artist band", () => {
    const source = analysis();
    for (const [width, height] of [[640, 360], [360, 640], [360, 360]] as const) {
      const subject = fixture(width, height);
      // Deliberately paint behind every text pixel to exercise the protection
      // mask independently of normal sculpture geometry and safe bounds.
      const pixels = subject.render(source, 7.6, (context) => {
        context.fillStyle = "white";
        context.fillRect(0, 0, width, height);
      });
      const textBandEnd = Math.floor(height * 0.25);
      expect(alphaStats(pixels.subarray(0, textBandEnd * width * 4)).max).toBe(0);
      const full = alphaStats(pixels);
      expect(full.count).toBeGreaterThan(width * height * 0.2);
      expect(full.max).toBeGreaterThan(10);
      // All three live ghosts together stay below one third opacity, even
      // when every captured surface is opaque white rather than lit sculpture.
      expect(full.max).toBeLessThan(85);
    }
  });

  test("fades visible frozen geometry away and leaves output context state intact", () => {
    const source = analysis();
    // Keep a single hit, so subsequent captures cannot hide the last one's fade.
    for (let index = 61; index < source.frames.length; index += 1) source.frames[index]!.bass = 0;
    const subject = fixture();
    const beginning = subject.render(source, 1.6);
    const fog = subject.render(source, 6.5);
    const end = subject.render(source, 1 + FROZEN_CLOUD_LIFETIME - 0.01);
    const gone = subject.render(source, 1 + FROZEN_CLOUD_LIFETIME);
    expect(alphaStats(beginning).sum).toBeGreaterThan(1000);
    expect(alphaStats(fog).sum).toBeGreaterThan(0);
    expect(alphaStats(fog).sum).toBeLessThan(alphaStats(beginning).sum);
    expect(alphaStats(end).max).toBe(0);
    expect(alphaStats(gone).max).toBe(0);
    subject.context.globalAlpha = 0.7;
    subject.context.globalCompositeOperation = "multiply";
    subject.context.filter = "blur(0.1px)";
    const savedAlpha = subject.context.globalAlpha;
    subject.render(source, 1.5);
    expect(subject.context.globalAlpha).toBe(savedAlpha);
    expect(subject.context.globalCompositeOperation).toBe("multiply");
    expect(subject.context.filter).toBe("blur(0.1px)");
  });
});

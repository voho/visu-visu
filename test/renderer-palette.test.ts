import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectConfig } from "../src/config.js";
import { prepareArtwork } from "../src/render/artwork.js";
import { VisualizerRenderer } from "../src/render/renderer.js";
import { ANALYSIS_VERSION, type AudioAnalysis } from "../src/types.js";

function energeticAnalysis(): AudioAnalysis {
  const fps = 60;
  const duration = 12;
  return {
    version: ANALYSIS_VERSION, sampleRate: 48_000, fps, duration,
    spectrumBands: 32, waveformPoints: 64,
    sourceHash: "palette-music", sourceFileHash: "palette-music-file",
    frames: Array.from({ length: fps * duration }, (_, index) => {
      const time = index / fps;
      const hit = index >= fps && (index - fps) % (fps * 3) === 0;
      return {
        rms: hit ? 0.65 : 0.2, peak: hit ? 0.95 : 0.4,
        bass: hit ? 0.45 : 0.03,
        mid: 0.12 + Math.sin(time * 0.9) * 0.07,
        treble: 0.1 + Math.sin(time * 2.7) * 0.06,
        centroid: 0.5 + Math.sin(time * 0.6) * 0.25,
        flux: hit ? 0.85 : 0.01, onset: hit ? 0.95 : 0,
        spectrum: Float32Array.from({ length: 32 }, (_, band) =>
          (0.2 + Math.sin(time * (0.3 + band * 0.05) + band * 0.8) * 0.15) *
          (hit && band < 8 ? 2 : 1)),
        waveform: Float32Array.from({ length: 64 }, (_, sample) =>
          Math.sin(sample * 0.3 + time * 1.7) * (hit ? 0.65 : 0.3)),
      };
    }),
  };
}

interface ColorStats {
  chromaticPixels: number;
  largestChannelSpread: number;
  hueDistribution: Float64Array;
  largestHueDistance: number;
}

function colorStats(pixels: Buffer, sourceHue?: number): ColorStats {
  let chromaticPixels = 0, largestChannelSpread = 0, largestHueDistance = 0;
  const hueDistribution = new Float64Array(24);
  let chromaWeight = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index]!, g = pixels[index + 1]!, b = pixels[index + 2]!;
    const high = Math.max(r, g, b), low = Math.min(r, g, b), chroma = high - low;
    largestChannelSpread = Math.max(largestChannelSpread, chroma);
    // Near-black and near-neutral quantization can have arbitrary HSL hue.
    // Twelve bytes of channel separation still catches faint colored fog.
    if (chroma < 12 || high < 16) continue;
    let hue = high === r ? (g - b) / chroma : high === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
    hue = ((hue * 60) % 360 + 360) % 360;
    chromaticPixels++;
    const bucket = Math.min(23, Math.floor(hue / 15));
    hueDistribution[bucket] = hueDistribution[bucket]! + chroma;
    chromaWeight += chroma;
    if (sourceHue !== undefined) {
      const distance = Math.abs(hue - sourceHue);
      largestHueDistance = Math.max(largestHueDistance, Math.min(distance, 360 - distance));
    }
  }
  return {
    chromaticPixels, largestChannelSpread, largestHueDistance,
    hueDistribution: hueDistribution.map(value => value / Math.max(1, chromaWeight)),
  };
}

async function createCover(directory: string, name: string, rgb: readonly [number, number, number]): Promise<string> {
  const canvas = createCanvas(96, 96);
  const context = canvas.getContext("2d");
  // Source variations retain exactly one hue while providing recognizable
  // contrast and luminance relief for the normal-mapped artwork path.
  for (let column = 0; column < 8; column++) {
    const shade = 0.2 + column * 0.1;
    context.fillStyle = `rgb(${rgb.map(value => Math.round(value * shade)).join(",")})`;
    context.fillRect(column * 12, 0, 12, 96);
  }
  context.fillStyle = `rgb(${rgb.join(",")})`;
  context.fillRect(17, 15, 21, 63);
  const path = join(directory, `${name}.png`);
  await writeFile(path, canvas.toBuffer("image/png"));
  return path;
}

function config(width = 320, height = 180, lighting = 1) {
  return parseProjectConfig({
    output: { width, height, fps: 60 },
    text: { title: "Palette Signal", artist: "voho" },
    visual: { spectrumBands: 32, bokehCount: 16, intensity: 1, lighting, lowFlash: false },
  });
}

describe("complete renderer artwork palette", () => {
  test("keeps monochrome artwork, materials, ghosts, flares, atmosphere, and credits neutral", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visu-neutral-palette-"));
    try {
      const path = await createCover(directory, "monochrome", [224, 224, 224]);
      const analysis = energeticAnalysis();
      for (const [width, height] of [[320, 180], [180, 320]] as const) {
        const artwork = await prepareArtwork(path, width, height);
        for (const lighting of [0, 1]) {
          const renderer = new VisualizerRenderer(config(width, height, lighting), "neutral-cover", { width, height }, artwork);
          // Transient light, overlapping frozen objects, and slower fog all
          // participate; checking only a quiet opening would miss color leaks.
          for (const time of [1.04, 4.7, 7.6]) {
            const pixels = renderer.render(analysis, time);
            expect(colorStats(pixels).largestChannelSpread).toBeLessThanOrEqual(2);
            expect(pixels.some((value, index) => index % 4 !== 3 && value > 100)).toBe(true);
          }
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const { name, rgb, hue } of [
    { name: "green", rgb: [40, 200, 40] as const, hue: 120 },
    { name: "magenta", rgb: [200, 40, 200] as const, hue: 300 },
  ]) {
    test(`uses only the ${name} cover family and neutral shades throughout the scene`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "visu-color-palette-"));
      try {
        const path = await createCover(directory, name, rgb);
        const artwork = await prepareArtwork(path, 320, 180);
        const analysis = energeticAnalysis();
        for (const seed of ["cover-palette-one", "cover-palette-two"]) {
          const renderer = new VisualizerRenderer(config(), seed, { width: 320, height: 180 }, artwork);
          for (const time of [1.04, 4.7, 7.6]) {
            const stats = colorStats(renderer.render(analysis, time), hue);
            expect(stats.chromaticPixels).toBeGreaterThan(100);
            expect(stats.largestHueDistance).toBeLessThanOrEqual(12);
          }
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  test("creates a repeatable seeded color palette when there is no artwork", () => {
    const analysis = energeticAnalysis();
    const first = new VisualizerRenderer(config(), "fallback-palette-amber");
    const expected = Buffer.from(first.render(analysis, 4.7));
    first.render(analysis, 10.2);
    expect(first.render(analysis, 4.7)).toEqual(expected);
    expect(new VisualizerRenderer(config(), "fallback-palette-amber").render(analysis, 4.7)).toEqual(expected);
    const other = new VisualizerRenderer(config(), "fallback-palette-violet").render(analysis, 4.7);
    const a = colorStats(expected), b = colorStats(other);
    expect(a.chromaticPixels).toBeGreaterThan(100);
    expect(b.chromaticPixels).toBeGreaterThan(100);
    // Compare the complete color distribution: different multicolor palettes
    // can have the same average hue, and a shape-only pixel difference would
    // not establish that changing the seed changes the rendered colors.
    const distance = a.hueDistribution.reduce((sum, value, index) =>
      sum + Math.abs(value - b.hueDistribution[index]!), 0);
    expect(distance).toBeGreaterThan(0.15);
  });
});

import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectConfig } from "../src/config.js";
import { prepareArtwork, type PreparedArtwork } from "../src/render/artwork.js";
import { cloudEventsAt } from "../src/render/frozen-cloud.js";
import { createSafeLayout } from "../src/render/layout.js";
import type { MaterialMap } from "../src/render/material.js";
import { VisualizerRenderer } from "../src/render/renderer.js";
import { ANALYSIS_VERSION, type AudioAnalysis } from "../src/types.js";

function music(): AudioAnalysis {
  const fps = 30;
  const duration = 21;
  return {
    version: ANALYSIS_VERSION, sampleRate: 48_000, fps, duration,
    spectrumBands: 32, waveformPoints: 64,
    sourceHash: "photograph-history", sourceFileHash: "photograph-history-file",
    frames: Array.from({ length: fps * duration }, (_, index) => {
      const time = index / fps;
      const hit = index >= fps && (index - fps) % (fps * 3) === 0;
      return {
        rms: hit ? 0.45 : 0.12, peak: hit ? 0.85 : 0.3,
        bass: hit ? 0.3 : 0.025, mid: 0.06, treble: 0.025,
        centroid: 0.3, flux: hit ? 0.5 : 0, onset: hit ? 0.85 : 0,
        spectrum: Float32Array.from({ length: 32 }, (_, band) =>
          0.08 + (1 + Math.sin(time * 0.4 + band * 0.3)) * 0.05),
        waveform: Float32Array.from({ length: 64 }, (_, sample) =>
          Math.sin(sample * 0.24 + time * 1.3) * 0.25),
      };
    }),
  };
}

// These distinctly colored pixels have exactly the same Rec.709 luminance.
// Replacing their positions must alter pigment, not just a grayscale relief.
const PINK = [204, 36, 132] as const;
const TEAL = [40, 90, 80] as const;
const luminance = (rgb: readonly number[]): number => rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;

async function writeCover(directory: string, horizontal: boolean): Promise<string> {
  const image = createCanvas(96, 96);
  const context = image.getContext("2d");
  context.fillStyle = `rgb(${PINK.join(",")})`;
  context.fillRect(0, 0, 96, 96);
  context.fillStyle = `rgb(${TEAL.join(",")})`;
  context.fillRect(horizontal ? 0 : 48, horizontal ? 48 : 0, horizontal ? 96 : 48, horizontal ? 48 : 96);
  const path = join(directory, horizontal ? "horizontal.png" : "vertical.png");
  await writeFile(path, image.toBuffer("image/png"));
  return path;
}

function flatPhoto(material: MaterialMap): MaterialMap {
  const count = material.width * material.height;
  const normals = new Float32Array(count * 3);
  for (let index = 0; index < count; index++) normals[index * 3 + 2] = 1;
  return {
    ...material,
    normals,
    roughness: new Float32Array(count).fill(0.7),
    heightMap: new Float32Array(count).fill(0.5),
  };
}

function withoutBackground(source: PreparedArtwork, reference: PreparedArtwork, includePhoto = true): PreparedArtwork {
  if (!source.objectMaterial) throw new Error("The prepared cover must include its unmasked object material");
  return {
    canvas: createCanvas(source.canvas.width, source.canvas.height),
    width: source.width, height: source.height,
    // Exact palette identity excludes extraction order or source hue weighting
    // as a possible cause of a different material appearance.
    palette: reference.palette, accentHue: reference.accentHue, secondaryHue: reference.secondaryHue,
    ...(includePhoto ? { objectMaterial: flatPhoto(source.objectMaterial) } : {}),
    // Deliberately omit the background relief material as well as its pixels.
  };
}

function sculptureDifference(a: Buffer, b: Buffer, width: number, height: number): { changed: number; meanChroma: number } {
  const layout = createSafeLayout(width, height);
  let changed = 0, sum = 0, pixels = 0;
  for (let y = Math.ceil(layout.graphTop); y < Math.floor(layout.graphBottom); y++) {
    for (let x = Math.ceil(layout.left); x < Math.floor(layout.right); x++) {
      const offset = (y * width + x) * 4;
      const differences = [0, 1, 2].map(channel => a[offset + channel]! - b[offset + channel]!);
      const chroma = Math.max(...differences) - Math.min(...differences);
      changed += Number(chroma > 2);
      sum += chroma;
      pixels++;
    }
  }
  return { changed, meanChroma: sum / pixels };
}

describe("photograph mapped onto the sculpture", () => {
  for (const [width, height] of [[320, 180], [180, 320]] as const) {
    test(`preserves spatial image colors independently of palette and background at ${width}×${height}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "visu-object-photo-"));
      try {
        expect(luminance(PINK)).toBeCloseTo(luminance(TEAL), 10);
        const firstPath = await writeCover(directory, false);
        const secondPath = await writeCover(directory, true);
        const first = (await prepareArtwork(firstPath, width, height))!;
        const second = (await prepareArtwork(secondPath, width, height))!;
        const a = withoutBackground(first, first);
        const b = withoutBackground(second, first);
        const config = parseProjectConfig({
          output: { width, height, fps: 30 },
          text: { title: "Photograph", artist: "voho" },
          visual: { lighting: 0.9, spectrumBands: 32, bokehCount: 8, lowFlash: true },
        });
        const source = music();
        const render = (artwork: PreparedArtwork): VisualizerRenderer => new VisualizerRenderer(
          config, "same-photo-geometry", { width, height }, artwork,
        );
        const time = 4.7;
        expect(cloudEventsAt(source, time).length).toBeGreaterThanOrEqual(2);
        const renderer = render(a);
        const firstPixels = Buffer.from(renderer.render(source, time));
        const secondPixels = render(b).render(source, time);
        const difference = sculptureDifference(firstPixels, secondPixels, width, height);
        expect(difference.changed).toBeGreaterThan(100);
        expect(difference.meanChroma).toBeGreaterThan(0.2);

        // Removing only the photo restores identical output: palette, camera,
        // geometry, atmosphere and the prepared backgrounds are held constant.
        const plainA = render(withoutBackground(first, first, false)).render(source, time);
        const plainB = render(withoutBackground(second, first, false)).render(source, time);
        expect(plainA).toEqual(plainB);

        // Photo-bearing ghosts must be reconstructed with the same texture and
        // captured lighting after both complete eviction and a reverse seek.
        for (const seek of [18.4, 0, 10.8, 1.4]) renderer.render(source, seek);
        expect(renderer.render(source, time)).toEqual(firstPixels);
        expect(render(a).render(source, time)).toEqual(firstPixels);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

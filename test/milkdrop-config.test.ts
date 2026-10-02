import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, test } from "bun:test";
import { overrideConfig } from "../src/cli.js";
import { DEFAULT_CONFIG, parseProjectConfig } from "../src/config.js";
import { resolveRenderSeed } from "../src/render/render.js";
import { VisualizerRenderer, type RenderStage } from "../src/render/renderer.js";
import { ANALYSIS_VERSION, type AudioAnalysis } from "../src/types.js";
import { MILKDROP_DEFAULT_PRESET_IDS, milkdropPreset } from "../src/milkdrop/presets.js";

function analysis(): AudioAnalysis {
  const fps = 30, duration = 12;
  return {
    version: ANALYSIS_VERSION, fps, duration, sampleRate: 48_000,
    spectrumBands: 16, waveformPoints: 32, sourceHash: "milkdrop-config", sourceFileHash: "milkdrop-config-file",
    frames: Array.from({ length: fps * duration }, (_, index) => {
      const time = index / fps, hit = index >= fps && (index - fps) % (fps * 3) === 0;
      return {
        rms: hit ? 0.6 : 0.18, peak: hit ? 0.9 : 0.3, bass: hit ? 0.3 : 0.02,
        mid: 0.05, treble: 0.03, centroid: 0.4, flux: hit ? 0.4 : 0, onset: hit ? 0.8 : 0,
        spectrum: Float32Array.from({ length: 16 }, (_, band) => 0.12 + Math.sin(time * 0.9 + band * 0.3) * 0.1),
        waveform: Float32Array.from({ length: 32 }, (_, sample) => Math.sin(sample * 0.4 + time) * 0.3),
      };
    }),
  };
}

describe("MilkDrop engine selection and composition", () => {
  test("validates preset candidate pools from JSON and CLI without changing automatic defaults", () => {
    expect(parseProjectConfig({}).visual.milkdropPresets).toEqual([]);
    expect(MILKDROP_DEFAULT_PRESET_IDS).toEqual(["vortex", "ribbons", "cosmic-dust", "fog-tunnel", "julia-fractal", "plasma", "folded-tunnel", "moebius"]);
    const custom = overrideConfig(DEFAULT_CONFIG, { engine: "milkdrop", milkdropPresets: "tunnel-race, mandelbox-explorer" });
    expect(custom.visual.milkdropPresets).toEqual(["tunnel-race", "mandelbox-explorer"]);
    expect(parseProjectConfig(custom)).toEqual(custom);
    for (const value of [null, "tunnel-race", [1], [""], ["unknown"], ["vortex", "vortex"], ["vortex", " vortex "]]) {
      expect(() => parseProjectConfig({ visual: { milkdropPresets: value } })).toThrow();
    }
    for (const milkdropPresets of ["", "tunnel-race,", "not-a-preset", "vortex,vortex"]) {
      expect(() => overrideConfig(DEFAULT_CONFIG, { milkdropPresets })).toThrow();
    }
    for (const id of ["tunnel-race", "mandelbox-explorer", "fractal-descent"]) {
      const first = milkdropPreset(id);
      const next = milkdropPreset(id);
      expect(first).toEqual(next);
      expect(first).not.toBe(next);
      expect(typeof first.comp).toBe("string");
    }
  });

  test("preserves render seeds for existing preset configurations and explicit seeds", () => {
    const source = analysis();
    const base = overrideConfig(DEFAULT_CONFIG, { engine: "milkdrop" });
    const legacy = structuredClone(base);
    delete legacy.visual.milkdropPresets;
    expect(resolveRenderSeed(base, source)).toBe(resolveRenderSeed(legacy, source));
    const first = overrideConfig(base, { milkdropPresets: "tunnel-race,mandelbox-explorer" });
    const reverse = overrideConfig(base, { milkdropPresets: "mandelbox-explorer,tunnel-race" });
    expect(resolveRenderSeed(first, source)).not.toBe(resolveRenderSeed(base, source));
    expect(resolveRenderSeed(first, source)).not.toBe(resolveRenderSeed(reverse, source));
    expect(resolveRenderSeed(overrideConfig(first, { seed: "pavana" }), source)).toBe("pavana");
  });

  test("keeps resonance as the default and validates explicit JSON or CLI engine selection", () => {
    expect(DEFAULT_CONFIG.visual.engine).toBe("resonance");
    expect(parseProjectConfig({}).visual.engine).toBe("resonance");
    const milkdrop = parseProjectConfig({ visual: { engine: "milkdrop" } });
    expect(milkdrop.visual.engine).toBe("milkdrop");
    expect(overrideConfig(DEFAULT_CONFIG, { engine: "milkdrop" }).visual.engine).toBe("milkdrop");
    expect(overrideConfig(milkdrop, {}).visual.engine).toBe("milkdrop");
    expect(overrideConfig(milkdrop, { engine: "resonance" }).visual.engine).toBe("resonance");
    expect(milkdrop.visual.engine).toBe("milkdrop");
    for (const engine of ["", "MILKDROP", "unknown", 1, null]) {
      expect(() => parseProjectConfig({ visual: { engine } })).toThrow(/engine/);
    }
    for (const engine of ["", "MILKDROP", "unknown"]) {
      expect(() => overrideConfig(DEFAULT_CONFIG, { engine })).toThrow(/--engine/);
    }
  });

  test("separates automatic engine seeds while preserving explicit visual seeds and legacy resonance", () => {
    const source = analysis(), resonance = parseProjectConfig({});
    const legacy = structuredClone(resonance);
    delete legacy.visual.engine;
    const milkdrop = overrideConfig(resonance, { engine: "milkdrop" });
    const original = resolveRenderSeed(resonance, source), other = resolveRenderSeed(milkdrop, source);
    expect(original).toBe(resolveRenderSeed(legacy, source));
    expect(other).not.toBe(original);
    expect(other).toBe(resolveRenderSeed(milkdrop, source));
    expect(other).toMatch(/^[a-f0-9]{16}$/);
    for (const config of [resonance, milkdrop]) {
      expect(resolveRenderSeed(overrideConfig(config, { seed: "same-sculpture" }), source)).toBe("same-sculpture");
    }
  });

  test("composes the existing foreground stages and credits identically over an external background", () => {
    const source = analysis(), width = 320, height = 180;
    const base = parseProjectConfig({ output: { width, height, fps: 30 },
      text: { title: "RESONANCE", artist: "voho" }, visual: { bokehCount: 8, spectrumBands: 16 } });
    const background = createCanvas(width, height), paint = background.getContext("2d");
    paint.fillStyle = "#0c0710"; paint.fillRect(0, 0, width, height);
    paint.fillStyle = "#1f301a"; paint.fillRect(width * 0.2, 0, width * 0.4, height);
    const before = Buffer.from(paint.getImageData(0, 0, width, height).data);
    const legacy = new VisualizerRenderer(base, "same-sculpture");
    const hybrid = new VisualizerRenderer(overrideConfig(base, { engine: "milkdrop" }), "same-sculpture");
    const stages: RenderStage[] = [];
    hybrid.profiler = stage => { stages.push(stage); };
    const expected = Buffer.from(legacy.render(source, 4.75, background));
    const actual = hybrid.render(source, 4.75, background);
    expect(actual).toEqual(expected);
    expect(actual).not.toEqual(before);
    expect(Buffer.from(paint.getImageData(0, 0, width, height).data)).toEqual(before);
    for (const stage of ["room", "ghosts", "band", "skin", "filaments", "fragments", "embers", "typography"] as const) {
      expect(stages).toContain(stage);
    }
    let readable = 0;
    for (let y = Math.floor(height * 0.16); y < height * 0.30; y++) for (let x = 20; x < width - 20; x++) {
      const index = (y * width + x) * 4;
      readable += Number(Math.min(actual[index]!, actual[index + 1]!, actual[index + 2]!) > 150);
    }
    expect(readable).toBeGreaterThan(100);
    const normal = Buffer.from(legacy.render(source, 4.75));
    expect(normal).not.toEqual(expected);
    hybrid.render(source, 8.2);
    hybrid.render(source, 1.2, background);
    expect(hybrid.render(source, 4.75, background)).toEqual(expected);
    // Returning to ordinary rendering must not retain a previously supplied
    // GPU frame or bypass the original room after a backend was used.
    expect(hybrid.render(source, 4.75)).toEqual(normal);
  });
});

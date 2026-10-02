import { describe, expect, test } from "bun:test";
import { overrideConfig } from "../src/cli.js";
import { DEFAULT_CONFIG, parseProjectConfig, validatePromoRequirements } from "../src/config.js";
import { renderVideo, resolveRenderSeed } from "../src/render/render.js";
import { ANALYSIS_VERSION, type AudioAnalysis } from "../src/types.js";

const source: AudioAnalysis = {
  version: ANALYSIS_VERSION, sampleRate: 48_000, fps: 60, duration: 1,
  spectrumBands: 64, waveformPoints: 32, sourceHash: "promo-audio",
  sourceFileHash: "promo-file", frames: [],
};

function completePromo() {
  return overrideConfig(DEFAULT_CONFIG, {
    mode: "promo", image: "cover.png", title: "Night Signal", artist: "voho",
  });
}

describe("promo configuration", () => {
  test("defaults to standard and selects MilkDrop for promo from JSON or CLI", () => {
    expect(parseProjectConfig({}).visual.mode).toBe("standard");
    const promo = parseProjectConfig({ visual: { mode: "promo" } });
    expect(promo.visual.engine).toBe("milkdrop");
    expect(overrideConfig(DEFAULT_CONFIG, { mode: "promo" }).visual.engine).toBe("milkdrop");
    expect(overrideConfig(promo, { engine: "resonance" }).visual.engine).toBe("milkdrop");
    expect(overrideConfig(promo, { mode: "standard", engine: "resonance" }).visual.engine).toBe("resonance");
    for (const mode of ["", "PROMO", "unknown", null, 3]) {
      expect(() => parseProjectConfig({ visual: { mode } })).toThrow(/mode/);
    }
    expect(() => overrideConfig(DEFAULT_CONFIG, { mode: "unknown" })).toThrow(/--mode/);
  });

  test("accepts partial promo projects before CLI and metadata enrichment", () => {
    const partial = parseProjectConfig({ visual: { mode: "promo" } });
    expect(() => validatePromoRequirements(partial)).toThrow(/--image.*--title.*--artist/);
    const enriched = overrideConfig(partial, {
      image: "cover.png", title: "  Night Signal  ", artist: " voho ",
    });
    expect(() => validatePromoRequirements(enriched)).not.toThrow();
    expect(enriched.text).toEqual({ title: "Night Signal", artist: "voho" });
    expect(partial.text).toEqual({ title: "", artist: "" });
  });

  test("requires every promo credit while leaving standard metadata optional", () => {
    const complete = completePromo();
    expect(() => validatePromoRequirements(complete)).not.toThrow();
    expect(() => validatePromoRequirements(DEFAULT_CONFIG)).not.toThrow();
    for (const [field, expected] of [["title", "--title"], ["artist", "--artist"]] as const) {
      const missing = structuredClone(complete);
      missing.text[field] = "   ";
      expect(() => validatePromoRequirements(missing)).toThrow(expected);
    }
    for (const imagePath of [undefined, "", "   "]) {
      const missing = structuredClone(complete);
      if (imagePath === undefined) delete missing.visual.imagePath;
      else missing.visual.imagePath = imagePath;
      expect(() => validatePromoRequirements(missing)).toThrow("--image");
    }
  });

  test("rejects incomplete direct API calls before touching audio or output files", async () => {
    for (const missing of ["image", "title", "artist"] as const) {
      const config = completePromo();
      if (missing === "image") config.visual.imagePath = "";
      else config.text[missing] = "";
      await expect(renderVideo({
        audioPath: "/does-not-exist.wav", outputPath: "/must-not-be-created.mp4",
        config, start: 0, overwrite: false,
      }, source)).rejects.toThrow(`--${missing}`);
    }
  });

  test("separates automatic promo seeds and preserves standard and explicit seeds", () => {
    const standard = parseProjectConfig({ visual: { engine: "milkdrop" } });
    const legacy = structuredClone(standard);
    delete legacy.visual.mode;
    expect(resolveRenderSeed(standard, source)).toBe(resolveRenderSeed(legacy, source));
    const promo = completePromo();
    expect(resolveRenderSeed(promo, source)).not.toBe(resolveRenderSeed(standard, source));
    const direct = structuredClone(promo);
    direct.visual.engine = "resonance";
    expect(resolveRenderSeed(direct, source)).toBe(resolveRenderSeed(promo, source));
    expect(resolveRenderSeed(overrideConfig(promo, { seed: "release-promo" }), source)).toBe("release-promo");
  });
});

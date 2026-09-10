import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { overrideConfig } from "../src/cli.js";
import {
  DEFAULT_CONFIG,
  dimensionsFor,
  loadProjectConfig,
  parseProjectConfig,
  parseRatio,
  parseSize,
} from "../src/config.js";

describe("project configuration", () => {
  test("defaults to native Full HD 60 with practical upload encoding", () => {
    const config = parseProjectConfig({});
    expect(config.output.width).toBe(1920);
    expect(config.output.height).toBe(1080);
    expect(config.output.fps).toBe(60);
    expect(config.output.width / config.output.height).toBeCloseTo(16 / 9, 8);
    expect(config.output.renderScale).toBe(1);
    expect(config.output.crf).toBe(18);
    expect(config.output.preset).toBe("fast");
    expect(config.output.maxBitrateMbps).toBe(16);
    expect(config.output.fadeSeconds).toBe(3);
    expect(config.visual.grain).toBe(0.03);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test("merges partial sections over defaults", () => {
    const config = parseProjectConfig({
      output: { fps: 24 },
      text: { title: "  Signal  " },
      visual: { seed: "night" },
    });
    expect(config.output.fps).toBe(24);
    expect(config.output.width).toBe(1920);
    expect(config.text.title).toBe("Signal");
    expect(config.visual.seed).toBe("night");
  });

  test("validates material lighting and allows CLI disabling", () => {
    expect(DEFAULT_CONFIG.visual.lighting).toBe(0.65);
    const config = parseProjectConfig({ visual: { lighting: 0.9 } });
    expect(config.visual.lighting).toBe(0.9);
    expect(overrideConfig(config, { lighting: "0" }).visual.lighting).toBe(0);
    expect(overrideConfig(config, { lighting: "1" }).visual.lighting).toBe(1);
    for (const lighting of [-0.1, 1.1, NaN, Infinity, "0.5"]) {
      expect(() => parseProjectConfig({ visual: { lighting } })).toThrow("visual.lighting");
    }
    expect(() => overrideConfig(config, { lighting: "no" })).toThrow("--lighting");
  });

  test("rejects unknown config versions", () => {
    expect(() => parseProjectConfig({ version: 2 })).toThrow("Unsupported configuration version");
  });

  test("requires even dimensions", () => {
    expect(() => parseSize("1921x1080")).toThrow("must be even");
  });

  test("validates the internal render scale", () => {
    expect(() => parseProjectConfig({ output: { renderScale: 0.1 } })).toThrow(
      "output.renderScale must be between 0.25 and 1",
    );
    expect(parseProjectConfig({ output: { renderScale: 1 } }).output.renderScale).toBe(1);
  });

  test("validates the synchronized fade duration", () => {
    expect(() => parseProjectConfig({ output: { fadeSeconds: -0.1 } })).toThrow(
      "output.fadeSeconds must be between 0 and 30",
    );
    expect(parseProjectConfig({ output: { fadeSeconds: 0 } }).output.fadeSeconds).toBe(0);
  });

  test("accepts a custom or disabled video bitrate ceiling and rejects invalid limits", () => {
    expect(parseProjectConfig({ output: { maxBitrateMbps: 7.5 } }).output.maxBitrateMbps).toBe(7.5);
    expect(parseProjectConfig({ output: { maxBitrateMbps: 0 } }).output.maxBitrateMbps).toBe(0);
    for (const maxBitrateMbps of [-1, 201, Infinity, "16"]) {
      expect(() => parseProjectConfig({ output: { maxBitrateMbps } })).toThrow("output.maxBitrateMbps");
    }
  });

  test("quality presets keep chosen frame rate and explicit render scale", () => {
    const preview = overrideConfig(DEFAULT_CONFIG, { quality: "preview", fps: "24" });
    expect(preview.output).toMatchObject({
      fps: 24, renderScale: 0.5, crf: 22, preset: "veryfast", maxBitrateMbps: 8,
    });
    const final = overrideConfig(preview, { quality: "final" });
    expect(final.output).toMatchObject({
      fps: 24, renderScale: 1, crf: 18, preset: "fast", maxBitrateMbps: 16,
    });
    const master = overrideConfig(preview, { quality: "master", fps: "60" });
    expect(master.output).toMatchObject({
      fps: 60, renderScale: 1, crf: 8, preset: "slow", maxBitrateMbps: 0,
    });
    for (const quality of ["preview", "final", "master"]) {
      expect(overrideConfig(DEFAULT_CONFIG, { quality, renderScale: "0.75" }).output.renderScale).toBe(0.75);
    }
    expect(() => overrideConfig(DEFAULT_CONFIG, { quality: "unknown" })).toThrow("--quality must be");
  });

  test("combines an independent resolution and aspect ratio", () => {
    expect(dimensionsFor("fullhd", parseRatio("3:2"))).toEqual({ width: 1920, height: 1280 });
    expect(dimensionsFor("fullhd", parseRatio("9:16"))).toEqual({ width: 1080, height: 1920 });
    expect(dimensionsFor("4k", parseRatio("16:9"))).toEqual({ width: 3840, height: 2160 });
  });

  test("resolves JSON artwork beside its config and CLI artwork from the current directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visu-visu-artwork-config-"));
    try {
      const path = join(directory, "project.json");
      await writeFile(path, JSON.stringify({ visual: { imagePath: "covers/song.png" } }));
      const config = await loadProjectConfig(path);
      expect(config.visual.imagePath).toBe(join(directory, "covers/song.png"));
      expect(overrideConfig(config, { image: "different cover.jpg" }).visual.imagePath).toBe(resolve("different cover.jpg"));
      expect(overrideConfig(config, { image: "" }).visual.imagePath).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(() => parseProjectConfig({ visual: { imagePath: 12 } })).toThrow("visual.imagePath must be a string");
    expect(() => parseProjectConfig({ visual: { imagePath: "https://example.com/a.png" } })).toThrow("local file path");
    expect(() => overrideConfig(DEFAULT_CONFIG, { image: "data:image/png;base64,AAAA" })).toThrow("local file path");
  });
});

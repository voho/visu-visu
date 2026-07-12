import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  dimensionsFor,
  parseProjectConfig,
  parseRatio,
  parseSize,
} from "../src/config.js";

describe("project configuration", () => {
  test("uses a standard Full HD default", () => {
    const config = parseProjectConfig({});
    expect(config.output.width).toBe(1920);
    expect(config.output.height).toBe(1080);
    expect(config.output.width / config.output.height).toBeCloseTo(16 / 9, 8);
    expect(config.output.renderScale).toBe(1);
    expect(config.output.crf).toBe(8);
    expect(config.output.preset).toBe("slow");
    expect(config.visual.grain).toBe(0.018);
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

  test("combines an independent resolution and aspect ratio", () => {
    expect(dimensionsFor("fullhd", parseRatio("3:2"))).toEqual({ width: 1920, height: 1280 });
    expect(dimensionsFor("fullhd", parseRatio("9:16"))).toEqual({ width: 1080, height: 1920 });
    expect(dimensionsFor("4k", parseRatio("16:9"))).toEqual({ width: 3840, height: 2160 });
  });
});

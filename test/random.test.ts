import { describe, expect, test } from "bun:test";
import { createRandom, deriveSeed, hashString } from "../src/math/random.js";

describe("seeded randomness", () => {
  test("repeats the exact sequence for a seed", () => {
    const left = createRandom(42);
    const right = createRandom(42);
    expect(Array.from({ length: 20 }, left)).toEqual(Array.from({ length: 20 }, right));
  });

  test("separates named random streams", () => {
    expect(deriveSeed("track", "bokeh")).not.toBe(deriveSeed("track", "grain"));
    expect(deriveSeed("track", "bokeh")).toBe(deriveSeed("track", "bokeh"));
  });

  test("hashes strings consistently", () => {
    expect(hashString("visu-visu")).toBe(3_019_804_154);
  });
});

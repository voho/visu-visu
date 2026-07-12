import { describe, expect, test } from "bun:test";
import { RealFft } from "../src/math/fft.js";

describe("RealFft", () => {
  test("places a bin-aligned sine wave in the expected bin", () => {
    const size = 1024;
    const targetBin = 32;
    const samples = new Float32Array(size);
    for (let index = 0; index < size; index += 1) {
      samples[index] = Math.sin((2 * Math.PI * targetBin * index) / size);
    }
    const magnitudes = new RealFft(size).magnitudes(samples);
    let peakBin = 0;
    for (let index = 1; index < magnitudes.length; index += 1) {
      if ((magnitudes[index] ?? 0) > (magnitudes[peakBin] ?? 0)) peakBin = index;
    }
    expect(peakBin).toBe(targetBin);
    expect(magnitudes[targetBin]).toBeCloseTo(0.5, 5);
  });

  test("rejects non-power-of-two sizes", () => {
    expect(() => new RealFft(1000)).toThrow("power of two");
  });
});

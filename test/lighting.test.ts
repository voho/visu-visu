import { describe, expect, test } from "bun:test";
import { lightingAt, shadeSurface, type LightingState, type Rgb, type SurfaceSample } from "../src/render/lighting.js";
import type { MusicMotion } from "../src/render/music-motion.js";

const quiet: MusicMotion = {
  slowTime: 0, fastTime: 0, bassPulse: 0, treblePulse: 0,
  bassEnergy: 0, midEnergy: 0, trebleEnergy: 0, attack: 0, sustain: 0,
};
const surface: SurfaceSample = { r: 0.7, g: 0.7, b: 0.7, nx: 0, ny: 0, nz: 1, roughness: 0.45 };

function luminance(rgb: Rgb): number {
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

function singleLight(x = 0, y = 0, z = 1): LightingState {
  return {
    lights: [
      { position: [x, y, z], color: [1, 1, 1], intensity: 1, falloff: 0.4 },
      { position: [0, 0, 1], color: [1, 1, 1], intensity: 0, falloff: 0.4 },
      { position: [0, 0, 1], color: [1, 1, 1], intensity: 0, falloff: 0.4 },
    ],
    ambient: [0, 0, 0],
    exposure: 1,
  };
}

describe("music-driven point lights", () => {
  test("bass has the largest response for equal band energy and pulse", () => {
    const resting = lightingAt(quiet, 0, "lights", 220);
    const bass = lightingAt({ ...quiet, bassEnergy: 1, bassPulse: 1 }, 0, "lights", 220);
    const mids = lightingAt({ ...quiet, midEnergy: 1 }, 0, "lights", 220);
    const treble = lightingAt({ ...quiet, trebleEnergy: 1, treblePulse: 1 }, 0, "lights", 220);
    const bassResponse = bass.lights[0].intensity - resting.lights[0].intensity;
    const midResponse = mids.lights[1].intensity - resting.lights[1].intensity;
    const trebleResponse = treble.lights[2].intensity - resting.lights[2].intensity;
    expect(bassResponse).toBeGreaterThan(midResponse * 4);
    expect(midResponse).toBeGreaterThan(trebleResponse);
    expect(bassResponse).toBeGreaterThan(trebleResponse * 5);
  });

  test("direct seeks reproduce lights and lowFlash reduces accents without moving them", () => {
    const motion = { ...quiet, slowTime: 12.3, fastTime: 68.4, bassEnergy: 0.7, bassPulse: 1, treblePulse: 1, sustain: 0.7 };
    const expected = lightingAt(motion, 30, "repeatable", 180);
    lightingAt({ ...motion, slowTime: 100, fastTime: 500 }, 300, "repeatable", 180);
    expect(lightingAt(motion, 30, "repeatable", 180)).toEqual(expected);
    const capped = lightingAt(motion, 30, "repeatable", 180, true);
    expect(capped.ambient).toEqual(expected.ambient);
    expect(capped.exposure).toBe(expected.exposure);
    for (let index = 0; index < 3; index += 1) {
      expect(capped.lights[index]!.position).toEqual(expected.lights[index]!.position);
      expect(capped.lights[index]!.color).toEqual(expected.lights[index]!.color);
    }
    expect(capped.lights[0].intensity).toBeLessThan(expected.lights[0].intensity);
    expect(capped.lights[2].intensity).toBeLessThan(expected.lights[2].intensity);
    expect(capped.lights[1].intensity).toBe(expected.lights[1].intensity);
  });

  test("silence stays softly lit and movement is continuous at 60 fps", () => {
    const first = lightingAt(quiet, 0, "quiet", 210);
    const later = lightingAt({ ...quiet, slowTime: 90, fastTime: 450 }, 450, "quiet", 210);
    expect(later.lights.map((light) => light.intensity)).toEqual(first.lights.map((light) => light.intensity));
    expect(later.ambient).toEqual(first.ambient);
    expect(luminance(shadeSurface(first, 0, 0, 0, surface))).toBeLessThan(0.2);
    const next = lightingAt({ ...quiet, slowTime: 0.2 / 60, fastTime: 1 / 60 }, 1 / 60, "quiet", 210);
    for (let index = 0; index < 3; index += 1) {
      const current = first.lights[index]!.position;
      const following = next.lights[index]!.position;
      expect(Math.hypot(...following.map((coordinate, axis) => coordinate - current[axis]!))).toBeLessThan(0.012);
    }
  });

  test("malformed audio values and arbitrary palette angles cannot produce unsafe lights", () => {
    const state = lightingAt({
      slowTime: NaN, fastTime: Infinity, bassPulse: Infinity, treblePulse: -1,
      bassEnergy: 200, midEnergy: NaN, trebleEnergy: -100, attack: Infinity, sustain: NaN,
    }, Infinity, "bad-input", NaN, true);
    for (const light of state.lights) {
      expect(light.intensity).toBeGreaterThanOrEqual(0);
      expect(light.intensity).toBeLessThanOrEqual(2.5);
      expect(Math.abs(light.position[0])).toBeLessThanOrEqual(1);
      expect(Math.abs(light.position[1])).toBeLessThanOrEqual(1);
      expect(light.position[2]).toBeGreaterThan(0);
      expect(light.color.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
    }
    expect(state.ambient.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(state.exposure)).toBe(true);
  });
});

describe("normal-mapped surface shading", () => {
  test("uses surface normals and the upward Y convention to face each light", () => {
    const front = shadeSurface(singleLight(), 0, 0, 0, surface);
    const back = shadeSurface(singleLight(), 0, 0, 0, { ...surface, nz: -1 });
    expect(luminance(front)).toBeGreaterThan(0.2);
    expect(back).toEqual([0, 0, 0]);
    const above = singleLight(0, 1, 0.3);
    const upward = shadeSurface(above, 0, 0, 0, { ...surface, ny: 0.8, nz: 0.6 });
    const downward = shadeSurface(above, 0, 0, 0, { ...surface, ny: -0.8, nz: 0.6 });
    expect(luminance(upward)).toBeGreaterThan(luminance(downward) + 0.2);
  });

  test("attenuates distant lights and gives smooth material a stronger focused reflection", () => {
    const near = shadeSurface(singleLight(), 0, 0, 0, surface);
    const far = shadeSurface(singleLight(0, 0, 4), 0, 0, 0, surface);
    expect(luminance(near)).toBeGreaterThan(luminance(far) * 2);
    const polished = shadeSurface(singleLight(), 0, 0, 0, { ...surface, roughness: 0.08 });
    const matte = shadeSurface(singleLight(), 0, 0, 0, { ...surface, roughness: 1 });
    expect(luminance(polished)).toBeGreaterThan(luminance(matte));
    const red = singleLight();
    red.lights[0].color = [1, 0, 0];
    const colored = shadeSurface(red, 0, 0, 0, surface);
    expect(colored[0]).toBeGreaterThan(0.2);
    expect(colored[1]).toBe(0);
    expect(colored[2]).toBe(0);
  });

  test("reuses output storage, normalizes normals, and remains bounded with malformed samples", () => {
    const state = lightingAt({ ...quiet, bassEnergy: 1, bassPulse: 1, midEnergy: 1, trebleEnergy: 1 }, 0, "sample", 45);
    const out: Rgb = [NaN, NaN, NaN];
    expect(shadeSurface(state, 0, 0, 0, surface, out)).toBe(out);
    expect(out).toEqual(shadeSurface(state, 0, 0, 0, { ...surface, nz: 0.3 }));
    const malformed = shadeSurface(state, Infinity, NaN, -Infinity, {
      r: Infinity, g: -9, b: 100, nx: NaN, ny: Infinity, nz: 0, roughness: NaN,
    }, out);
    expect(malformed.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
    const zeroNormal = shadeSurface(state, 0, 0, 0, { ...surface, nz: 0 });
    expect(zeroNormal).toEqual(shadeSurface(state, 0, 0, 0, surface));
  });
});

describe("FFT environment illumination", () => {
  function isolatedStrip(spectrum: Float32Array): LightingState {
    const state = lightingAt(quiet, 0, "spectrum-test", 210, false, spectrum);
    state.ambient = [0, 0, 0];
    state.exposure = 1;
    for (const light of state.lights) {
      light.intensity = 0;
      light.color = [1, 1, 1];
    }
    if (state.spectrum) {
      state.spectrum.angle = 0;
      state.spectrum.rotation = [1, 0];
    }
    return state;
  }

  function normalForBand(bin: number): SurfaceSample {
    const angle = ((bin + 0.5) / 32 - 0.5) * Math.PI;
    return { ...surface, nx: Math.sin(angle), nz: Math.cos(angle), roughness: 0.35 };
  }

  test("the FFT produces light that bends with normals, even with all point lights off", () => {
    const spectrum = new Float32Array(32);
    spectrum[5] = 1;
    const state = isolatedStrip(spectrum);
    const facingBand = shadeSurface(state, 0, 0, 0, normalForBand(5));
    const awayFromBand = shadeSurface(state, 0, 0, 0, normalForBand(26));
    expect(luminance(facingBand)).toBeGreaterThan(0.05);
    expect(luminance(facingBand)).toBeGreaterThan(luminance(awayFromBand) * 20);
    expect(shadeSurface(state, 0, 0, 0, { ...surface, nz: -1 })).toEqual([0, 0, 0]);
  });

  test("equal-energy bass creates brighter and broader illumination than treble", () => {
    const bass = new Float32Array(32);
    const treble = new Float32Array(32);
    bass[5] = 0.9;
    treble[26] = 0.9;
    const low = isolatedStrip(bass);
    const high = isolatedStrip(treble);
    const lowPeak = luminance(shadeSurface(low, 0, 0, 0, normalForBand(5)));
    const highPeak = luminance(shadeSurface(high, 0, 0, 0, normalForBand(26)));
    expect(lowPeak).toBeGreaterThan(highPeak * 3);
    const lowShoulder = luminance(shadeSurface(low, 0, 0, 0, normalForBand(8))) / lowPeak;
    const highShoulder = luminance(shadeSurface(high, 0, 0, 0, normalForBand(23))) / highPeak;
    expect(lowShoulder).toBeGreaterThan(highShoulder * 3);
  });

  test("empty or silent FFT adds no energy, while seeks and hostile FFT samples stay deterministic and bounded", () => {
    const plain = lightingAt(quiet, 2, "spectrum-test", 210);
    for (const spectrum of [new Float32Array(), new Float32Array(64)]) {
      expect(lightingAt(quiet, 2, "spectrum-test", 210, false, spectrum)).toEqual(plain);
    }
    const fft = Float32Array.from({ length: 64 }, (_, index) => index % 4 === 0 ? 0.8 : 0.1);
    const expected = lightingAt(quiet, 2, "spectrum-test", 210, false, fft);
    lightingAt({ ...quiet, slowTime: 100 }, 500, "spectrum-test", 210, false, fft);
    expect(lightingAt(quiet, 2, "spectrum-test", 210, false, fft)).toEqual(expected);
    expect(expected.spectrum!.values).toHaveLength(32);
    const capped = lightingAt(quiet, 2, "spectrum-test", 210, true, fft);
    expect(capped.spectrum!.values).toEqual(expected.spectrum!.values);
    expect(capped.spectrum!.rotation).toEqual(expected.spectrum!.rotation);
    expect(capped.spectrum!.strength).toBeLessThan(expected.spectrum!.strength);
    const invalid = lightingAt(quiet, NaN, "spectrum-test", Infinity, false,
      Float32Array.from([Infinity, NaN, -1, 400, 0.5, 0, -Infinity]));
    expect(invalid.spectrum!.values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
    expect(shadeSurface(invalid, 0, 0, 0, surface).every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { deriveMusicEffects, frequencyResponse } from "../src/render/music-effects.js";
import type { MusicMotion } from "../src/render/music-motion.js";

const still: MusicMotion = {
  slowTime: 0, fastTime: 0, bassPulse: 0, treblePulse: 0,
  bassEnergy: 0, midEnergy: 0, trebleEnergy: 0, attack: 0, sustain: 0,
};

describe("frequency-weighted visual effects", () => {
  test("gives equal low-frequency energy a much larger displacement than treble", () => {
    const bass = frequencyResponse(0.8, 0);
    const mids = frequencyResponse(0.8, 0.5);
    const treble = frequencyResponse(0.8, 1);
    expect(bass).toBeGreaterThan(mids * 2);
    expect(mids).toBeGreaterThan(treble * 2);
    expect(bass).toBeGreaterThan(treble * 6);
    expect(frequencyResponse(0, 0)).toBe(0);
  });

  test("gives bass the strongest zoom and chromatic displacement", () => {
    const bass = deriveMusicEffects({ ...still, bassEnergy: 1, bassPulse: 1 }, true);
    const mid = deriveMusicEffects({ ...still, midEnergy: 1 }, true);
    const treble = deriveMusicEffects({ ...still, trebleEnergy: 1, treblePulse: 1 }, true);
    expect(bass.zoom - 1).toBeGreaterThan((mid.zoom - 1) * 10);
    expect(treble.zoom).toBe(1);
    expect(bass.dispersion).toBeGreaterThan(treble.dispersion * 4);
    expect(bass.zoom).toBeLessThanOrEqual(1.2);
  });

  test("caps light accents while preserving bass-driven movement", () => {
    const motion = { ...still, bassEnergy: 1, bassPulse: 1, attack: 1 };
    const capped = deriveMusicEffects(motion, true);
    const full = deriveMusicEffects(motion, false);
    expect(capped.zoom).toBe(full.zoom);
    expect(capped.rotation).toBe(full.rotation);
    expect(capped.glow).toBeLessThan(full.glow);
    expect(capped.saturation).toBeLessThan(full.saturation);
  });
});

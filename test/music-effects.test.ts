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

  test("anchors the hue travel on the track's warmth and nudges it with bass", () => {
    const loud = { ...still, bassEnergy: 0.6, midEnergy: 0.6, trebleEnergy: 0.6 };
    const dark = deriveMusicEffects(loud, true, undefined, 0);
    const bright = deriveMusicEffects(loud, true, undefined, 1);
    expect(bright.hueShift - dark.hueShift).toBeGreaterThanOrEqual(100);
    expect(deriveMusicEffects(loud, true, undefined, 0.5).hueShift).toBeWithin(dark.hueShift, bright.hueShift);
    const bass = deriveMusicEffects({ ...still, bassEnergy: 1 }, true);
    const treble = deriveMusicEffects({ ...still, trebleEnergy: 1 }, true);
    expect(bass.hueShift).toBeGreaterThan(treble.hueShift);
    expect(deriveMusicEffects(loud, true, undefined, Number.NaN).hueShift).toBe(deriveMusicEffects(loud, true).hueShift);
  });

  test("caps light accents while preserving the colour travel", () => {
    const motion = { ...still, bassEnergy: 1, bassPulse: 1, attack: 1 };
    const capped = deriveMusicEffects(motion, true);
    const full = deriveMusicEffects(motion, false);
    expect(capped.hueShift).toBe(full.hueShift);
    expect(capped.glow).toBeLessThan(full.glow);
    expect(capped.saturation).toBeLessThan(full.saturation);
    expect(Object.keys(capped).sort()).toEqual(["glow", "hueShift", "saturation"]);
  });
});

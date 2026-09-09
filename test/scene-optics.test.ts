import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, test } from "bun:test";
import { createSafeLayout } from "../src/render/layout.js";
import { drawAtmosphericBloom, inertialMusicMotion, sceneCameraAt } from "../src/render/scene-optics.js";
import { SCENE_LAYER_NAMES, type SceneDynamics } from "../src/render/scene-dynamics.js";
import type { MusicMotion } from "../src/render/music-motion.js";
import { createResonanceFilaments, createResonancePlan } from "../src/render/resonance.js";
import { audioFieldGeometry } from "../src/render/audio-field-geometry.js";
import { safeGraphRadius } from "../src/render/layout.js";
import type { VisualState } from "../src/render/conductor.js";

function dynamics(energy: number, time: number): SceneDynamics {
  return Object.fromEntries(SCENE_LAYER_NAMES.map((name, index) => [name,
    { energy, clock: time * (0.08 + index * 0.25) },
  ])) as SceneDynamics;
}
const motion: MusicMotion = { slowTime: 2, fastTime: 6, bassEnergy: 1, midEnergy: 1, trebleEnergy: 1,
  bassPulse: 1, treblePulse: 0.2, attack: 1, sustain: 1 };

describe("inertial scene optics", () => {
  test("holds large forms through an immediate hit while preserving small quick accents", () => {
    const quiet = dynamics(0, 3);
    const eased = inertialMusicMotion(motion, quiet);
    expect(eased.bassEnergy).toBe(0);
    expect(eased.bassPulse).toBe(0);
    expect(eased.attack).toBe(1);
    expect(eased.treblePulse).toBe(motion.treblePulse);
    const moving = dynamics(0.6, 3);
    const before = sceneCameraAt(moving);
    const fineHit = { ...moving, detail: { energy: 1, clock: 100 }, spark: { energy: 1, clock: 200 } };
    expect(sceneCameraAt(fineHit)).toEqual(before);
    expect(sceneCameraAt(quiet).zoom).toBeLessThan(before.zoom);
  });

  test("keeps the textured sculpture and audio orbits inside the graph even at maximum camera drive", () => {
    const plan = createResonancePlan("optics-bounds");
    const frame = { rms: 1, peak: 1, bass: 1, mid: 1, treble: 1, centroid: 0.5,
      flux: 1, onset: 1, spectrum: new Float32Array(32).fill(1), waveform: new Float32Array(32).fill(0.9) };
    const visual = { drive: 1, peak: 1, ambient: 1, beat: 1 } as VisualState;
    for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080]] as const) {
      const layout = createSafeLayout(width, height);
      const halfY = Math.min(layout.horizon - layout.graphTop, layout.graphBottom - layout.horizon);
      for (const time of [0, 7, 21, 56, 103]) {
        const state = dynamics(1, time);
        const camera = sceneCameraAt(state, 1.7);
        const shape = createResonanceFilaments(plan, frame, visual, layout, time, false,
          { ...motion, slowTime: time * 0.3, fastTime: time * 2 });
        const radius = safeGraphRadius(layout);
        const field = audioFieldGeometry(frame.spectrum, frame.waveform, 1, 1, time);
        const points: Array<{ x: number; y: number }> = shape.flatMap(strand => strand.points);
        points.push(...field.spokes.flatMap(spoke => [
          { x: layout.centerX + spoke.x2 * Math.min(layout.width * 0.4, radius * 1.55),
            y: layout.horizon + spoke.y2 * radius * 0.78 },
        ]));
        let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
        for (const point of points) {
          const x = point.x - layout.centerX, y = point.y - layout.horizon;
          const rx = layout.centerX + camera.x * layout.width / 2
            + (x * Math.cos(camera.roll) - y * Math.sin(camera.roll)) * camera.zoom;
          const ry = layout.horizon + camera.y * halfY
            + (x * Math.sin(camera.roll) + y * Math.cos(camera.roll)) * camera.zoom;
          left = Math.min(left, rx); right = Math.max(right, rx);
          top = Math.min(top, ry); bottom = Math.max(bottom, ry);
        }
        expect(left).toBeGreaterThan(layout.left);
        expect(right).toBeLessThan(layout.right);
        expect(top).toBeGreaterThan(layout.graphTop);
        expect(bottom).toBeLessThan(layout.graphBottom);
      }
    }
  });

  test("spreads source-colored light into soft trails but leaves the credit band untouched", () => {
    for (const [width, height] of [[640, 360], [360, 640]] as const) {
      const layout = createSafeLayout(width, height);
      const emission = createCanvas(width / 4, height / 4);
      const source = emission.getContext("2d");
      source.fillStyle = "#00cc00";
      source.fillRect(layout.centerX / 4 - 7, layout.horizon / 4 - 3, 14, 6);
      const canvas = createCanvas(emission.width, emission.height);
      const context = canvas.getContext("2d");
      context.globalAlpha = 0.7;
      context.filter = "blur(0.1px)";
      const alpha = context.globalAlpha;
      drawAtmosphericBloom(context, emission, layout, width, height, dynamics(1, 14), 0.8, 1.3, false);
      expect(context.globalAlpha).toBe(alpha);
      expect(context.filter).toBe("blur(0.1px)");
      expect(context.globalCompositeOperation).toBe("source-over");
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let lit = 0, outsideHue = 0, creditAlpha = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        outsideHue = Math.max(outsideHue, pixels[index]!, pixels[index + 2]!);
        if (index < Math.floor(canvas.height * 0.25) * canvas.width * 4) creditAlpha = Math.max(creditAlpha, pixels[index + 3]!);
        if (pixels[index + 3]! > 0) lit++;
      }
      expect(outsideHue).toBe(0);
      expect(creditAlpha).toBe(0);
      expect(lit).toBeGreaterThan(14 * 6 * 4);
    }
  });
});

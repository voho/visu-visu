import { describe, expect, test } from "bun:test";
import { ArtworkInfluence } from "../src/render/artwork-influence.js";
import type { ArtworkWarpField } from "../src/render/artwork-warp.js";
import { ANALYSIS_VERSION, type AudioAnalysis } from "../src/types.js";

function analysis(): AudioAnalysis {
  return { version: ANALYSIS_VERSION, sourceHash: "influence", sourceFileHash: "influence-file",
    sampleRate: 48_000, fps: 60, duration: 0, spectrumBands: 32, waveformPoints: 32, frames: [] };
}
function field(x: number): ArtworkWarpField {
  return { width: 1920, height: 1080, creditBottom: 345.6, maximum: 6.48,
    anchors: [{ x, y: 640, directionX: 0.8, directionY: 0.2, radius: 200, weight: 0.8 }] };
}
const pose = (time: number): ArtworkWarpField => field(900 + Math.sin(time * 0.7) * 70);

describe("delayed artwork influence", () => {
  test("samples only past object poses and eases a change through three delayed layers", () => {
    const history = new ArtworkInfluence(), source = analysis();
    let now = 0;
    const captures: number[] = [];
    const capture = (time: number): ArtworkWarpField => {
      expect(time).toBeLessThanOrEqual(now);
      captures.push(time);
      return field(time < 1 ? 0 : 100);
    };
    for (now of [0, 0.01, 0.2, 0.8, 1.24]) expect(history.at(source, now, capture).anchors[0]!.x).toBe(0);
    now = 1.5;
    const first = history.at(source, now, capture).anchors[0]!.x;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(70);
    now = 1.9;
    const middle = history.at(source, now, capture).anchors[0]!.x;
    expect(middle).toBeGreaterThan(first);
    expect(middle).toBeLessThan(100);
    now = 2.3;
    expect(history.at(source, now, capture).anchors[0]!.x).toBeCloseTo(100, 10);
    expect(captures.every(time => Math.abs(time * 10 - Math.round(time * 10)) < 1e-9)).toBe(true);
  });

  test("reconstructs identical fields after reverse seeks, eviction and analysis replacement", () => {
    const history = new ArtworkInfluence(), source = analysis();
    const expected = history.at(source, 4.763, pose);
    for (const time of [23, 0, 103, 2.05, 27]) history.at(source, time, pose);
    expect(history.at(source, 4.763, pose)).toEqual(expected);
    expect(new ArtworkInfluence().at(source, 4.763, pose)).toEqual(expected);
    const changed = analysis();
    expect(history.at(changed, 4.763, time => field(200 + time))).not.toEqual(expected);
    expect(history.at(source, 4.763, pose)).toEqual(expected);
    expect(new ArtworkInfluence().at(source, 4.763, time => time > 5 ? field(3000) : pose(time))).toEqual(expected);
  });

  test("reuses a shared ten-hertz capture cache across delays and interpolates continuously", () => {
    const history = new ArtworkInfluence(), source = analysis();
    const captures: number[] = [];
    const capture = (time: number): ArtworkWarpField => { captures.push(time); return pose(time); };
    for (let index = 0; index <= 600; index++) history.at(source, index / 60, capture);
    expect(captures.length).toBeLessThanOrEqual(101);
    expect(new Set(captures).size).toBe(captures.length);
    const before = captures.length;
    history.at(source, 10, capture);
    expect(captures.length).toBe(before);
    // Crossing any capture-grid boundary must not snap the background's pose.
    for (const time of [1.35, 2.7, 3.15, 8.45, 9.9]) {
      const left = history.at(source, time - 1e-6, capture).anchors[0]!.x;
      const right = history.at(source, time + 1e-6, capture).anchors[0]!.x;
      expect(Math.abs(right - left)).toBeLessThan(0.0002);
    }
  });
});

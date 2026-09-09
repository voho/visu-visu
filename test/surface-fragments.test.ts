import { describe, expect, test } from "bun:test";
import {
  fragmentCoverage, surfaceFragmentCandidates, surfaceFragmentEventsAt,
  surfaceFragmentPose, SURFACE_FRAGMENT_LIFETIME,
  type SurfaceFragmentEvent,
} from "../src/render/surface-fragments.js";
import { frozenCloudPlan } from "../src/render/frozen-cloud.js";
import { ANALYSIS_VERSION, type AudioAnalysis } from "../src/types.js";

const event = { id: 60, captureTime: 1, strength: 1 };
const candidates = surfaceFragmentCandidates(event, "fragments");

function audio(bass: (time: number) => number, treble = false, duration = 14): AudioAnalysis {
  const fps = 60;
  return {
    version: ANALYSIS_VERSION, fps, duration, sampleRate: 48_000,
    spectrumBands: 16, waveformPoints: 16, sourceHash: "fragments", sourceFileHash: "fragments",
    frames: Array.from({ length: duration * fps }, (_, index) => ({
      rms: 0.4, peak: 0.6, bass: treble ? 0 : bass(index / fps), mid: 0,
      treble: treble ? bass(index / fps) : 0, centroid: 0, flux: 0, onset: 0,
      spectrum: new Float32Array(16), waveform: new Float32Array(16),
    })),
  };
}

describe("captured surface fragments", () => {
  test("stratifies reproducible source UV candidates without changing their identity on seeks", () => {
    expect(candidates).toHaveLength(18);
    expect(new Set(candidates.map((piece) => piece.id)).size).toBe(18);
    const saved = structuredClone(candidates);
    for (const piece of candidates) {
      expect(piece.u).toBeGreaterThanOrEqual(0);
      expect(piece.u).toBeLessThan(1);
      expect(piece.v).toBeGreaterThanOrEqual(0);
      expect(piece.v).toBeLessThan(1);
      expect(piece.halfU).toBeGreaterThanOrEqual(0.025);
      expect(piece.halfU).toBeLessThanOrEqual(0.043);
      expect(piece.halfV).toBeGreaterThanOrEqual(0.045);
      expect(piece.halfV).toBeLessThanOrEqual(0.075);
      for (const time of [6, 1.5, 7, 3, 0]) surfaceFragmentPose(event, piece, time);
    }
    expect(candidates).toEqual(saved);
    expect(surfaceFragmentCandidates(event, "fragments")).toEqual(saved);
    expect(surfaceFragmentCandidates(event, "another seed")).not.toEqual(saved);
    expect(surfaceFragmentCandidates({ ...event, id: 240, captureTime: 4 }, "fragments")).not.toEqual(saved);
    for (const invalid of [{ ...event, captureTime: NaN }, { ...event, strength: Infinity }, { ...event, captureTime: -1 }]) {
      expect(surfaceFragmentCandidates(invalid, "fragments")).toEqual([]);
    }
  });

  test("covers irregular source patches continuously across both UV seams, without mirrored copies", () => {
    const piece = { ...candidates[0]!, u: 0.995, v: 0.997, phase: 0 };
    expect(fragmentCoverage(piece.u, piece.v, piece)).toBe(1);
    expect(fragmentCoverage(piece.u + 0.5, piece.v, piece)).toBe(0);
    expect(fragmentCoverage(0.75, 0.7, { ...piece, u: 0.25, v: 0.3 })).toBe(0);
    let fractional = 0;
    for (let index = 0; index <= 80; index += 1) {
      const x = piece.u + index / 80 * piece.halfU;
      const value = fragmentCoverage(x, piece.v, piece);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      expect(fragmentCoverage(x - 1, piece.v + 1, piece)).toBeCloseTo(value, 12);
      if (value > 0 && value < 1) fractional += 1;
    }
    expect(fractional).toBeGreaterThan(4);
    // Equal elliptical radii differ around the ragged boundary, rather than
    // exposing a rectangle or a perfectly machined disk cut from the texture.
    expect(fragmentCoverage(piece.u + piece.halfU * 0.86, piece.v, piece)).toBe(0);
    expect(fragmentCoverage(piece.u + Math.cos(Math.PI / 6) * piece.halfU * 0.86,
      piece.v + Math.sin(Math.PI / 6) * piece.halfV * 0.86, piece)).toBe(1);
    for (let index = 0; index < 24; index += 1) {
      const angle = index / 24 * Math.PI * 2;
      expect(fragmentCoverage(piece.u + Math.cos(angle) * piece.halfU, piece.v + Math.sin(angle) * piece.halfV, piece)).toBe(0);
    }
    expect(fragmentCoverage(NaN, 0, piece)).toBe(0);
    expect(fragmentCoverage(0, 0, { ...piece, halfU: 0 })).toBe(0);
  });

  test("peels from rest with bounded momentum and perspective, then falls while approaching", () => {
    for (const piece of candidates.slice(0, 6)) {
      const at = (age: number) => surfaceFragmentPose(event, piece, event.captureTime + age)!;
      expect(at(0)).toMatchObject({ scale: 1, opacity: 0 });
      for (const age of [0, piece.delay * 0.9]) {
        for (const key of ["x", "y", "z", "peel", "rotation", "tiltX", "tiltY"] as const) {
          expect(Math.abs(at(age)[key])).toBe(0);
        }
      }
      const earlyDistance = at(piece.delay + 0.01).z;
      expect(earlyDistance).toBeGreaterThan(0);
      expect(at(piece.delay + 0.02).z / earlyDistance).toBeGreaterThan(3.8);
      expect(at(1.5).peel).toBe(1);
      let previous = at(0);
      for (let index = 1; index < 63; index += 1) {
        const current = at(index / 10);
        expect(current.z).toBeGreaterThanOrEqual(previous.z);
        expect(current.scale).toBeCloseTo(1 / (1 - current.z), 14);
        expect(current.scale).toBeLessThan(2.4);
        expect(Math.abs(current.x - previous.x)).toBeLessThan(0.02);
        expect(Math.abs(current.y - previous.y)).toBeLessThan(0.045);
        expect(Math.abs(current.rotation - previous.rotation)).toBeLessThan(0.03);
        previous = current;
      }
      expect(at(6.2).y).toBeGreaterThan(0.4);
      expect(at(6.2).z).toBeGreaterThan(0.56);
      expect(at(6.2).scale).toBeGreaterThan(2.25);
      expect(at(6.2).y).toBeGreaterThan(at(5.2).y);
    }
    const trajectories = candidates.map((piece) => surfaceFragmentPose(event, piece, 5)!);
    expect(trajectories.some((pose) => pose.x < -0.1)).toBe(true);
    expect(trajectories.some((pose) => pose.x > 0.1)).toBe(true);
  });

  test("heals the live tear before the next burst, while detached pieces keep fading and softening", () => {
    const piece = candidates[0]!;
    const at = (age: number) => surfaceFragmentPose(event, piece, 1 + age)!;
    expect(at(0.1).opacity).toBeLessThan(at(0.25).opacity);
    expect(at(0.7).tear).toBe(1);
    expect(at(2.2).tear).toBeGreaterThan(0);
    expect(at(2.7).tear).toBe(0);
    expect(at(3).opacity).toBeGreaterThan(0.4);
    expect(at(3).opacity).toBeLessThan(at(1).opacity);
    expect(at(5).opacity).toBeLessThan(at(3).opacity);
    expect(at(1.2).blur).toBeCloseTo(0, 14);
    expect(at(3).blur).toBeGreaterThan(0);
    expect(at(6).blur).toBeGreaterThan(at(3).blur);
    expect(at(6.3 - 1e-6).blur).toBeLessThanOrEqual(0.055);
    expect(at(6.3 - 1e-6).opacity).toBeLessThan(1e-12);
    const weaker = surfaceFragmentPose({ ...event, strength: 0.3 }, piece, 4)!;
    expect(weaker.opacity).toBeLessThan(at(3).opacity);
    expect(weaker.scale).toBeLessThan(at(3).scale);
    expect(Math.abs(weaker.x)).toBeLessThan(Math.abs(at(3).x));
    for (const time of [1 - 1e-9, 1 + SURFACE_FRAGMENT_LIFETIME, NaN, Infinity]) {
      expect(surfaceFragmentPose(event, piece, time)).toBeUndefined();
    }
    expect(surfaceFragmentPose(event, { ...piece, momentum: 0 }, 2)).toBeUndefined();
  });

  test("queries only past bursts, keeps their complete tails, and bounds renderer captures to three", () => {
    const schedule = Array.from({ length: 10 }, (_, index) => ({ id: index, captureTime: 1 + index * 3, strength: 1 }));
    const saved = structuredClone(schedule);
    for (let time = 0; time < 40; time += 0.1) {
      const active = surfaceFragmentEventsAt(schedule, time);
      expect(active.length).toBeLessThanOrEqual(3);
      expect(active).toEqual(schedule.filter((capture) => capture.captureTime <= time && capture.captureTime + 6.3 > time));
      const openTears = active.filter((capture) => surfaceFragmentPose(capture, candidates[0]!, time)!.tear > 0);
      expect(openTears.length).toBeLessThanOrEqual(1);
    }
    for (const capture of schedule) {
      expect(surfaceFragmentEventsAt(schedule, capture.captureTime + 6.3 - 1e-5)).toContain(capture);
      expect(surfaceFragmentEventsAt(schedule, capture.captureTime + 6.3)).not.toContain(capture);
    }
    // An over-dense caller is still bounded rather than allocating every burst.
    expect(surfaceFragmentEventsAt(schedule.map((capture, index) => ({ ...capture, captureTime: index / 10 })), 1)).toHaveLength(3);
    expect(surfaceFragmentEventsAt(schedule, 0.999)).toEqual([]);
    for (const time of [-1, NaN, Infinity]) expect(surfaceFragmentEventsAt(schedule, time)).toEqual([]);
    expect(surfaceFragmentEventsAt([], 2)).toEqual([]);
    expect(schedule).toEqual(saved);
  });

  test("reuses causal bass captures and reproduces fragments independently of seek order or frame rate", () => {
    const hits = (time: number) => time >= 1 && (time - 1) % 3 < 0.1 ? 0.08 : 0;
    const schedule = frozenCloudPlan(audio(hits));
    expect(schedule.length).toBeGreaterThan(3);
    expect(frozenCloudPlan(audio(() => 0))).toEqual([]);
    expect(frozenCloudPlan(audio(hits, true))).toEqual([]);
    expect(frozenCloudPlan(audio(() => 0.3))).toEqual([]);
    const future = frozenCloudPlan(audio((time) => time < 6 ? hits(time) : (time * 60) % 3 === 0 ? 1 : 0));
    const snapshot = (events: readonly SurfaceFragmentEvent[], time: number) => surfaceFragmentEventsAt(events, time)
      .map((capture) => surfaceFragmentCandidates(capture, "seek").slice(0, 6)
        .map((piece) => ({ id: piece.id, ...surfaceFragmentPose(capture, piece, time) })));
    const expected = snapshot(schedule, 5.25);
    for (const time of [12, 2, 8, 0, 5.25, 9]) snapshot(schedule, time);
    expect(snapshot(schedule, 5.25)).toEqual(expected);
    expect(snapshot(future, 5.25)).toEqual(expected);
    for (const fps of [24, 30, 60]) {
      for (let frame = 0; frame < 5 * fps; frame += 1) snapshot(schedule, frame / fps);
      expect(snapshot(schedule, 5.25)).toEqual(expected);
    }
  });
});

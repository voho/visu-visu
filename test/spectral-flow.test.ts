import { describe, expect, test } from "bun:test";
import { FLOW_AGES, spectralFlowPaths } from "../src/render/spectral-flow.js";

function state(time: number, overrides = {}) {
  return {
    time, bass: 0.62, mid: 0.43, treble: 0.27, impact: 0.4,
    slow: time * 0.7, fast: time * 2.1, energy: 0.7, presence: 0.85,
    spectrum: Float32Array.from({ length: 32 }, (_, band) => 0.35 + Math.sin(band * 0.4 + time * 0.2) * 0.15),
    waveform: Float32Array.from({ length: 64 }, (_, point) => Math.sin(point * 0.28 + time * 0.3) * 0.4),
    ...overrides,
  };
}

const samples = (time: number) => FLOW_AGES.filter(age => age <= time)
  .map(age => ({ age, state: state(time - age) }));
type Paths = ReturnType<typeof spectralFlowPaths>;

function distance(a: Paths, b: Paths): number {
  if (a.length !== b.length) throw new Error("Compared flow paths must have equal topology");
  let squares = 0, count = 0;
  for (let path = 0; path < a.length; path++) {
    const left = a[path]!.points, right = b[path]!.points;
    if (left.length !== right.length) throw new Error("Compared flow paths must have equal point counts");
    for (let point = 0; point < left.length; point++) {
      squares += (left[point]!.x - right[point]!.x) ** 2 + (left[point]!.y - right[point]!.y) ** 2;
      count++;
    }
  }
  return Math.sqrt(squares / Math.max(1, count));
}

describe("deterministic spectral feedback paths", () => {
  test("replays the same geometry after forward, backward and differently sampled transport", () => {
    const source = samples(8.25);
    const saved = structuredClone(source);
    const expected = spectralFlowPaths(source, "flow-seek");
    expect(expected.length).toBeGreaterThan(1);
    for (const time of [24, 0, 11, 2, 8.25]) spectralFlowPaths(samples(time), "flow-seek");
    expect(spectralFlowPaths(source, "flow-seek")).toEqual(expected);
    for (const fps of [24, 30, 60]) {
      for (let frame = 0; frame < fps; frame++) spectralFlowPaths(samples(7.25 + frame / fps), "flow-seek");
      expect(spectralFlowPaths(source, "flow-seek")).toEqual(expected);
    }
    expect(source).toEqual(saved);
    expect(distance(spectralFlowPaths(source, "other-seed"), expected)).toBeGreaterThan(0.005);
  });

  test("gives equal bass energy more geometric influence than mids or treble", () => {
    let bass = 0, mid = 0, treble = 0;
    for (const time of [2.7, 7.1, 13.2, 23.4]) {
      // Hold loudness, impulses and detailed waveform constant, so only the
      // requested frequency family can explain the change in geometry.
      const base = state(time, {
        bass: 0, mid: 0, treble: 0, impact: 0,
        spectrum: new Float32Array(32), waveform: new Float32Array(64),
      });
      const at = (band?: "bass" | "mid" | "treble") => spectralFlowPaths([
        { age: 0, state: band ? { ...base, [band]: 0.8 } : base },
      ], "frequency-response");
      const rest = at();
      bass += distance(rest, at("bass"));
      mid += distance(rest, at("mid"));
      treble += distance(rest, at("treble"));
    }
    expect(treble).toBeGreaterThan(0.001);
    expect(mid).toBeGreaterThan(treble * 1.1);
    expect(bass).toBeGreaterThan(mid * 1.25);
  });

  test("retains both flowing families and changes continuously across musical time", () => {
    let traveled = 0;
    let largestStep = 0;
    for (let time = 2; time < 100; time += 0.71) {
      const current = spectralFlowPaths(samples(time), "flow-continuity");
      expect(new Set(current.map(path => path.family))).toEqual(new Set([0, 1]));
      const near = spectralFlowPaths(samples(time + 0.001), "flow-continuity");
      largestStep = Math.max(largestStep, distance(current, near));
      traveled += distance(current, spectralFlowPaths(samples(time + 0.5), "flow-continuity"));
    }
    expect(traveled).toBeGreaterThan(1);
    // Coordinates use hero-relative units: a millisecond must not relocate
    // the filaments by a visible fraction of the whole sculpture.
    expect(largestStep).toBeLessThan(0.012);
  });

  test("bounds history and keeps every optical and geometric value finite", () => {
    expect(FLOW_AGES).toHaveLength(5);
    expect(FLOW_AGES.at(-1)).toBe(0);
    expect(FLOW_AGES[0]).toBeLessThanOrEqual(1.5);
    for (const time of [0, 0.01, 0.31, 1.4, 7, 121, 3600]) {
      const paths = spectralFlowPaths(samples(time), "bounded-flow");
      expect(new Set(paths.map(path => path.age)).size).toBeLessThanOrEqual(5);
      expect(paths.length).toBeLessThanOrEqual(40);
      for (const path of paths) {
        expect(path.points.length).toBeGreaterThan(16);
        expect(path.points.length).toBeLessThanOrEqual(192);
        for (const value of [path.alpha, path.width, path.blur, path.color, path.age]) expect(Number.isFinite(value)).toBe(true);
        expect(path.alpha).toBeGreaterThanOrEqual(0);
        expect(path.alpha).toBeLessThanOrEqual(1);
        expect(path.width).toBeGreaterThan(0);
        expect(path.blur).toBeGreaterThanOrEqual(0);
        expect(path.color).toBeGreaterThanOrEqual(0);
        expect(path.color).toBeLessThanOrEqual(1);
        for (const point of path.points) {
          expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
          expect(Math.hypot(point.x, point.y)).toBeLessThan(8);
        }
      }
    }
  });

  test("lets quiet histories disappear instead of accumulating permanent feedback", () => {
    const loud = spectralFlowPaths(samples(8), "flow-silence");
    const quiet = spectralFlowPaths(FLOW_AGES.map(age => ({ age, state: state(8 - age, {
      bass: 0, mid: 0, treble: 0, impact: 0, energy: 0, presence: 0,
      spectrum: new Float32Array(32), waveform: new Float32Array(64),
    }) })), "flow-silence");
    expect(loud.reduce((sum, path) => sum + path.alpha, 0)).toBeGreaterThan(0.1);
    expect(quiet.reduce((sum, path) => sum + path.alpha, 0)).toBe(0);
    expect(spectralFlowPaths([], "flow-silence")).toEqual([]);
  });

  test("advects captured curves through a nonuniform field while expanding, softening and fading", () => {
    const captured = state(3);
    const birth = spectralFlowPaths([{ age: 0, state: captured }], "history-warp");
    const history = spectralFlowPaths([
      { age: 1.4, state: captured }, { age: 0, state: state(4.4) },
    ], "history-warp").filter(path => path.age === 1.4);
    expect(history).toHaveLength(birth.length);
    for (let path = 0; path < birth.length; path++) {
      const a = birth[path]!, b = history[path]!, count = a.points.length;
      const center = (points: typeof a.points) => points.reduce((sum, point) =>
        ({ x: sum.x + point.x / count, y: sum.y + point.y / count }), { x: 0, y: 0 });
      const ca = center(a.points), cb = center(b.points);
      let dot = 0, cross = 0, denominator = 0;
      for (let index = 0; index < count; index++) {
        const x = a.points[index]!.x - ca.x, y = a.points[index]!.y - ca.y;
        const u = b.points[index]!.x - cb.x, v = b.points[index]!.y - cb.y;
        dot += x * u + y * v; cross += x * v - y * u; denominator += x * x + y * y;
      }
      const scale = dot / denominator, rotation = cross / denominator;
      // Fit the best whole-curve translation, rotation and scale. A visible
      // residual proves feedback is liquid deformation, not another rigid
      // duplicate of the existing sculpture-history effect.
      const residual = Math.sqrt(a.points.reduce((sum, point, index) => {
        const x = point.x - ca.x, y = point.y - ca.y;
        return sum + (cb.x + scale * x - rotation * y - b.points[index]!.x) ** 2
          + (cb.y + rotation * x + scale * y - b.points[index]!.y) ** 2;
      }, 0) / count);
      expect(residual).toBeGreaterThan(0.003);
      expect(Math.hypot(scale, rotation)).toBeGreaterThan(1.1);
      expect(b.blur).toBeGreaterThan(a.blur);
      expect(b.alpha).toBeLessThan(a.alpha * 0.3);
    }
  });

  test("rejects pre-roll, future and duplicate history and sanitizes malformed signal values", () => {
    const source = samples(8);
    const expected = spectralFlowPaths(source, "validated-history");
    const expanded = [
      ...source, ...source, ...source,
      { age: 2.5, state: state(5.5) },
      { age: -1, state: state(9) },
      { age: NaN, state: state(8) },
    ];
    expect(spectralFlowPaths(expanded, "validated-history")).toEqual(expected);
    expect(spectralFlowPaths([{ age: 1.4, state: state(3) }], "validated-history")).toEqual([]);
    const current = [{ age: 0, state: state(0.3) }];
    expect(spectralFlowPaths([
      { age: 0.32, state: state(-0.02) }, { age: 0.65, state: state(0.4) }, ...current,
    ], "validated-history")).toEqual(spectralFlowPaths(current, "validated-history"));
    const malformed = spectralFlowPaths([{ age: 0, state: state(8, {
      bass: NaN, mid: Infinity, treble: -Infinity, impact: NaN, slow: NaN, fast: Infinity,
      spectrum: Float32Array.from([NaN, Infinity, -Infinity]), waveform: Float32Array.from([NaN, Infinity]),
    }) }], "validated-history");
    expect(malformed.length).toBeGreaterThan(0);
    for (const path of malformed) {
      for (const value of [path.alpha, path.width, path.blur, path.color]) expect(Number.isFinite(value)).toBe(true);
      for (const point of path.points) expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    }
  });
});

import { describe, expect, test } from "bun:test";
import {
  cloudEventsAt, FROZEN_CLOUD_LIFETIME, frozenCloudAt, frozenCloudPlan,
  type FrozenCloudEvent,
} from "../src/render/frozen-cloud.js";
import { ANALYSIS_VERSION, type AnalysisFrame, type AudioAnalysis } from "../src/types.js";

function frame(overrides: Partial<AnalysisFrame> = {}): AnalysisFrame {
  return {
    rms: 0, peak: 0, bass: 0, mid: 0, treble: 0, centroid: 0, flux: 0, onset: 0,
    spectrum: new Float32Array(16), waveform: new Float32Array(16), ...overrides,
  };
}

function analysis(sample: (time: number, index: number) => AnalysisFrame, fps = 60, duration = 12): AudioAnalysis {
  return {
    version: ANALYSIS_VERSION, sampleRate: 48_000, fps, duration,
    spectrumBands: 16, waveformPoints: 16, sourceHash: "frozen-cloud", sourceFileHash: "frozen-cloud",
    frames: Array.from({ length: Math.ceil(fps * duration) }, (_, index) => sample(index / fps, index)),
  };
}

function singleHit(): AudioAnalysis {
  return analysis((time) => frame({ bass: time >= 1 && time < 1.1 ? 0.08 : 0 }));
}

function cloudAt(source: AudioAnalysis, age: number): FrozenCloudEvent {
  const event = cloudEventsAt(source, 1 + age)[0];
  expect(event).toBeDefined();
  return event!;
}

describe("frozen shape cloud events", () => {
  test("never anticipates a hit or invents a capture from the first FFT", () => {
    const source = singleHit();
    expect(cloudEventsAt(source, 1 - 1e-9)).toEqual([]);
    expect(cloudAt(source, 0)).toMatchObject({ captureTime: 1, age: 0, opacity: 0, scale: 1, dissolve: 0 });
    expect(cloudEventsAt(analysis(() => frame({ bass: 1 })), 0.5)).toEqual([]);
    for (const time of [-1, NaN, Infinity]) expect(cloudEventsAt(source, time)).toEqual([]);
  });

  test("keeps capture identity fixed while snapshots slowly grow, blur, dissolve, and fade", () => {
    const source = singleHit();
    const initial = cloudAt(source, 0);
    const samples = Array.from({ length: FROZEN_CLOUD_LIFETIME * 60 }, (_, index) => cloudAt(source, index / 60));
    for (let index = 0; index < samples.length; index += 1) {
      const current = samples[index]!;
      expect(current.id).toBe(initial.id);
      expect(current.captureTime).toBe(initial.captureTime);
      expect(current.strength).toBe(initial.strength);
      expect(current.opacity).toBeGreaterThanOrEqual(0);
      expect(current.opacity).toBeLessThanOrEqual(0.20);
      if (index === 0) continue;
      const previous = samples[index - 1]!;
      expect(current.scale).toBeGreaterThan(previous.scale);
      expect(current.scale - previous.scale).toBeLessThan(0.0061);
      expect(current.blur).toBeGreaterThanOrEqual(previous.blur);
      expect(current.dissolve).toBeGreaterThanOrEqual(previous.dissolve);
      if (current.age > 0.61) expect(current.opacity).toBeLessThan(previous.opacity);
    }
    expect(cloudAt(source, 0.1).opacity).toBeLessThan(cloudAt(source, 0.6).opacity);
    expect(cloudAt(source, 3).opacity).toBeLessThan(0.12);
    const end = cloudAt(source, FROZEN_CLOUD_LIFETIME - 1e-5);
    expect(end.scale).toBeGreaterThan(2);
    expect(end.scale).toBeLessThan(2.3);
    expect(end.blur).toBeCloseTo(0.22, 9);
    expect(end.dissolve).toBeCloseTo(1, 9);
    expect(end.opacity).toBeLessThan(1e-10);
    expect(cloudEventsAt(source, 1 + FROZEN_CLOUD_LIFETIME)).toEqual([]);
  });

  test("preserves a recognizable first second before eroding into an approaching cloud", () => {
    const source = singleHit();
    for (const age of [0, 0.25, 0.6, 1, 1.1]) {
      expect(cloudAt(source, age).blur).toBeCloseTo(cloudAt(source, 0).blur, 12);
      expect(cloudAt(source, age).dissolve).toBe(0);
    }
    expect(cloudAt(source, 1.6).dissolve).toBeGreaterThan(0);
    expect(cloudAt(source, 1.6).blur).toBeGreaterThan(cloudAt(source, 1).blur);
    // Constant motion toward the viewer expands more quickly in perspective
    // as the object comes closer, while keeping its captured pose unchanged.
    expect(cloudAt(source, 6).scale - cloudAt(source, 5).scale)
      .toBeGreaterThan(cloudAt(source, 2).scale - cloudAt(source, 1).scale);
  });

  test("the shared capture plan reconstructs the same history for an independent renderer", () => {
    const source = analysis((_time, index) => frame({ bass: index % 31 === 0 ? 0.08 : 0 }));
    const plan = frozenCloudPlan(source);
    const saved = structuredClone(plan);
    for (const time of [0, 1.5, 4.6, 11, 7.5, 2.3]) {
      const reconstructed = plan.map((event) => frozenCloudAt(event, time)).filter((event) => event !== undefined);
      expect(reconstructed).toEqual(cloudEventsAt(source, time));
    }
    expect(plan).toEqual(saved);
    const event = plan[0]!;
    for (const time of [event.captureTime - 1e-8, event.captureTime + FROZEN_CLOUD_LIFETIME, NaN, Infinity]) {
      expect(frozenCloudAt(event, time)).toBeUndefined();
    }
  });

  test("uses identical frozen timestamps and envelopes for direct or reverse seeks", () => {
    const sample = (_time: number, index: number) => frame({ bass: index % 31 === 0 ? 0.08 : 0 });
    const source = analysis(sample);
    const expected = cloudEventsAt(source, 6.217);
    for (const time of [11, 1, 6.3, 0, 9.8, 4.02]) cloudEventsAt(source, time);
    expect(cloudEventsAt(source, 6.217)).toEqual(expected);
    expect(cloudEventsAt(analysis(sample), 6.217)).toEqual(expected);
  });

  test("later audio cannot alter earlier capture times, strengths, or envelopes", () => {
    const sample = (time: number, index: number) => frame({ bass: index % 31 === 0 ? 0.022 + time * 0.001 : 0 });
    const short = analysis(sample, 60, 5);
    const long = analysis((time, index) => time < 5 ? sample(time, index) : frame({ bass: index % 3 === 0 ? 1 : 0 }));
    for (const time of [0, 1, 2.17, 3.9, 4.99]) {
      expect(cloudEventsAt(long, time)).toEqual(cloudEventsAt(short, time));
    }
  });

  test("keeps at most three live clouds with a three second gap and uncut tails", () => {
    const source = analysis((_time, index) => frame({ bass: index % 2 === 1 ? 0.08 : 0 }), 60, 18);
    const captures = new Map<number, number>();
    for (let index = 0; index < 1440; index += 1) {
      const events = cloudEventsAt(source, index / 60);
      expect(events.length).toBeLessThanOrEqual(3);
      for (const event of events) captures.set(event.id, event.captureTime);
    }
    const times = [...captures.values()];
    expect(times.length).toBeGreaterThan(4);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(3 - 1e-9);
    }
    for (const [id, captureTime] of captures) {
      expect(cloudEventsAt(source, captureTime + FROZEN_CLOUD_LIFETIME - 0.01).some((event) => event.id === id)).toBe(true);
      expect(cloudEventsAt(source, captureTime + FROZEN_CLOUD_LIFETIME).some((event) => event.id === id)).toBe(false);
    }
  });

  test("silence, numerical noise, slow ramps, and treble-only hits do not create clouds", () => {
    const sources = [
      analysis(() => frame()),
      analysis((time) => frame({ bass: (1 + Math.sin(time * 40)) * 0.0002 })),
      analysis((time) => frame({ bass: time * 0.01 })),
      analysis((_time, index) => frame({ treble: index % 30 === 0 ? 1 : 0 })),
      analysis(() => frame(), 60, 0),
    ];
    for (const source of sources) {
      for (const time of [0, 1, 3.17, 6, 9.7, 14]) expect(cloudEventsAt(source, time)).toEqual([]);
    }
  });

  test("captures an aligned bass onset at its timestamp with different analysis rates", () => {
    const reference = cloudAt(singleHit(), 0.5);
    for (const fps of [24, 30, 60]) {
      const source = analysis((time) => frame({ bass: time >= 1 && time < 2 ? 0.08 : 0 }), fps);
      expect(cloudEventsAt(source, 1 - 1e-9)).toEqual([]);
      expect(cloudAt(source, 0.5).captureTime).toBe(1);
      expect(cloudAt(source, 0.5).scale).toBe(reference.scale);
      expect(cloudAt(source, 0.5).blur).toBe(reference.blur);
      expect(cloudAt(source, 0.5).dissolve).toBe(reference.dissolve);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { novaEventsAt, type SupernovaEvent } from "../src/render/supernova.js";
import { ANALYSIS_VERSION, type AnalysisFrame, type AudioAnalysis } from "../src/types.js";

function frame(overrides: Partial<AnalysisFrame> = {}): AnalysisFrame {
  return {
    rms: 0, peak: 0, bass: 0, mid: 0, treble: 0, centroid: 0, flux: 0, onset: 0,
    spectrum: new Float32Array(16), waveform: new Float32Array(16), ...overrides,
  };
}

function analysis(sample: (time: number, index: number) => AnalysisFrame, fps = 30, duration = 6): AudioAnalysis {
  return {
    version: ANALYSIS_VERSION, sampleRate: 48_000, fps, duration,
    spectrumBands: 16, waveformPoints: 16, sourceHash: "supernova", sourceFileHash: "supernova",
    frames: Array.from({ length: Math.ceil(fps * duration) }, (_, index) => sample(index / fps, index)),
  };
}

function singleHit(band: "bass" | "treble", amplitude = 0.08): AudioAnalysis {
  return analysis((time) => frame({ [band]: time >= 1 && time < 1.1 ? amplitude : 0 }));
}

function eventAt(source: AudioAnalysis, age: number, lowFlash = false): SupernovaEvent {
  const event = novaEventsAt(source, 1 + age, "nova-test", lowFlash)[0];
  expect(event).toBeDefined();
  return event!;
}

describe("deterministic supernova events", () => {
  test("never anticipates a hit or invents one from the first FFT", () => {
    const source = singleHit("bass");
    expect(novaEventsAt(source, 1 - 1e-9, "seed", false)).toEqual([]);
    const initial = eventAt(source, 0);
    expect(initial.age).toBe(0);
    expect(initial.flash).toBe(0);
    expect(initial.flare).toBe(0);
    expect(initial.afterglow).toBe(0);
    expect(novaEventsAt(analysis(() => frame({ bass: 1, treble: 1, onset: 1 })), 0.3, "seed", false)).toEqual([]);
    expect(novaEventsAt(source, -0.1, "seed", false)).toEqual([]);
  });

  test("keeps direct and reverse seeks identical, with stable named randomness", () => {
    const sample = (_time: number, index: number) => frame({ bass: index % 24 === 0 ? 0.16 : 0 });
    const source = analysis(sample);
    const expected = novaEventsAt(source, 2.217, "seed", false);
    for (const time of [5.4, 0, 3.6, 0.92, 4.1, 1.1]) novaEventsAt(source, time, "seed", false);
    expect(novaEventsAt(source, 2.217, "seed", false)).toEqual(expected);
    expect(novaEventsAt(analysis(sample), 2.217, "seed", false)).toEqual(expected);
    const alternative = novaEventsAt(source, 2.217, "other-seed", false);
    expect(alternative.map(({ id, age, strength, expansion }) => ({ id, age, strength, expansion })))
      .toEqual(expected.map(({ id, age, strength, expansion }) => ({ id, age, strength, expansion })));
    expect(alternative.map((event) => event.hue)).not.toEqual(expected.map((event) => event.hue));
  });

  test("expands continuously at 60fps, with a short flash, longer flare, and clean afterglow fade", () => {
    const source = singleHit("bass");
    const samples = Array.from({ length: 144 }, (_, index) => eventAt(source, index / 60));
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]!.expansion).toBeGreaterThan(samples[index - 1]!.expansion);
    }
    expect(samples.at(-1)!.expansion).toBeGreaterThan(2.4);
    expect(eventAt(source, 0.045).flash).toBeCloseTo(1, 9);
    expect(eventAt(source, 0.205).flash).toBeCloseTo(1 / Math.E, 9);
    expect(eventAt(source, 0.55).flare).toBeGreaterThan(eventAt(source, 0.55).flash * 8);
    expect(eventAt(source, 1.4).afterglow).toBeGreaterThan(0.35);
    const end = eventAt(source, 2.4 - 1e-5);
    expect(end.flash + end.flare + end.afterglow).toBeLessThan(1e-8);
    expect(novaEventsAt(source, 3.4, "nova-test", false)).toEqual([]);
  });

  test("gives bass more strength, radius, and persistence than equal-amplitude treble", () => {
    const bass = singleHit("bass");
    const treble = singleHit("treble");
    const kick = eventAt(bass, 0.4);
    const shimmer = eventAt(treble, 0.4);
    expect(kick.kind).toBe("nova");
    expect(shimmer.kind).toBe("flare");
    expect(kick.strength).toBeGreaterThan(shimmer.strength * 1.8);
    expect(kick.expansion).toBeGreaterThan(shimmer.expansion * 1.4);
    expect(kick.flash).toBeGreaterThan(shimmer.flash);
    expect(novaEventsAt(treble, 2.1, "nova-test", false)).toEqual([]);
    expect(novaEventsAt(bass, 2.1, "nova-test", false)).toHaveLength(1);
  });

  test("lowFlash softens light while preserving event identity, strength, and all geometry", () => {
    const source = singleHit("bass");
    for (const age of [0, 0.04, 0.075, 0.2, 0.65, 1.7, 2.39]) {
      const normal = eventAt(source, age);
      const softened = eventAt(source, age, true);
      for (const key of ["id", "age", "kind", "strength", "hue", "angle", "originX", "originY", "expansion"] as const) {
        expect(softened[key]).toBe(normal[key]);
      }
    }
    const normalPeak = eventAt(source, 0.045);
    const softAtNormalPeak = eventAt(source, 0.045, true);
    const softPeak = eventAt(source, 0.075, true);
    expect(softAtNormalPeak.flash).toBeLessThan(softPeak.flash);
    expect(softPeak.flash).toBeCloseTo(0.28, 9);
    expect(softPeak.flash).toBeLessThan(normalPeak.flash * 0.3);
    expect(eventAt(source, 0.3, true).afterglow).toBeGreaterThan(0.5);
  });

  test("enforces separate refractory times and keeps at most four live voices without truncating tails", () => {
    const source = analysis((_time, index) => frame({
      bass: index % 4 === 0 ? 0.2 : 0,
      treble: index % 4 === 2 ? 0.07 : 0,
    }));
    const seen = new Map<number, { time: number; kind: SupernovaEvent["kind"] }>();
    for (let index = 0; index < 420; index += 1) {
      const time = index / 60;
      const events = novaEventsAt(source, time, "seed", false);
      expect(events.length).toBeLessThanOrEqual(4);
      for (const event of events) {
        seen.set(event.id, { time: time - event.age, kind: event.kind });
        expect(Math.abs(event.originX)).toBeLessThanOrEqual(0.2);
        expect(Math.abs(event.originY)).toBeLessThanOrEqual(0.2);
      }
    }
    for (const kind of ["nova", "flare"] as const) {
      const times = Array.from(seen.values()).filter((event) => event.kind === kind).map((event) => event.time).sort((a, b) => a - b);
      expect(times.length).toBeGreaterThan(2);
      for (let index = 1; index < times.length; index += 1) {
        expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual((kind === "nova" ? 0.75 : 0.3) - 1e-9);
      }
    }
    for (const [id, event] of seen) {
      const age = event.kind === "nova" ? 2.39 : 1.09;
      expect(novaEventsAt(source, event.time + age, "seed", false).some((live) => live.id === id)).toBe(true);
    }
  });

  test("does not amplify silence, noise, or empty analyses into explosions", () => {
    const source = analysis((time) => frame({
      bass: (1 + Math.sin(time * 40)) * 0.0002,
      treble: (1 + Math.cos(time * 30)) * 0.0002,
    }));
    for (let index = 0; index < 360; index += 1) {
      expect(novaEventsAt(source, index / 60, "seed", false)).toEqual([]);
    }
    expect(novaEventsAt(analysis(() => frame(), 30, 0), 3, "seed", false)).toEqual([]);
  });

  test("detects moving high-frequency content even if the mean treble is steady", () => {
    const source = analysis((time) => frame({
      treble: 0.08,
      spectrum: Float32Array.from({ length: 16 }, (_, index) =>
        index < 10 ? 0 : index % 2 === (time >= 1 ? 0 : 1) ? 0.16 : 0,
      ),
    }));
    expect(novaEventsAt(source, 1 - 1e-9, "seed", false)).toEqual([]);
    expect(eventAt(source, 0.1).kind).toBe("flare");
  });
});

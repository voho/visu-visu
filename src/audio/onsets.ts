import type { AudioAnalysis } from "../types.js";

export interface OnsetEvent {
  index: number;
  time: number;
  strength: number;
}

const eventCache = new WeakMap<AudioAnalysis, readonly OnsetEvent[]>();

function eventsFor(analysis: AudioAnalysis): readonly OnsetEvent[] {
  const cached = eventCache.get(analysis);
  if (cached) return cached;
  const events: OnsetEvent[] = [];
  // The first FFT compares against silence, so frame zero is not a musical hit.
  for (let index = 1; index < analysis.frames.length; index += 1) {
    const strength = analysis.frames[index]?.onset ?? 0;
    const previous = analysis.frames[index - 1]?.onset ?? 0;
    const next = analysis.frames[index + 1]?.onset ?? 0;
    // A clipped/flat peak belongs to its leading edge, exactly once.
    if (strength < 0.08 || strength <= previous || strength < next) continue;
    events.push({ index, time: index / analysis.fps, strength });
  }
  eventCache.set(analysis, events);
  return events;
}

/** Finds musical hits within inclusive absolute-time bounds, in time order. */
export function onsetEventsBetween(
  analysis: AudioAnalysis,
  startTime: number,
  endTime: number,
): readonly OnsetEvent[] {
  if (endTime < startTime) return [];
  const events = eventsFor(analysis);
  let left = 0;
  let right = events.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if ((events[middle]?.time ?? Infinity) < startTime) left = middle + 1;
    else right = middle;
  }
  const start = left;
  right = events.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if ((events[middle]?.time ?? Infinity) <= endTime) left = middle + 1;
    else right = middle;
  }
  return events.slice(start, left);
}

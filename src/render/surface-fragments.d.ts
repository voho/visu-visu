export interface SurfaceFragmentEvent {
  id: number;
  /** Absolute song time; geometry, lighting, material and camera are frozen here. */
  captureTime: number;
  strength: number;
}
export interface SurfaceFragmentCandidate {
  id: string;
  index: number;
  /** Original periodic surface coordinates, before photo texture mirroring. */
  u: number;
  v: number;
  halfU: number;
  halfV: number;
  phase: number;
  driftX: number;
  driftY: number;
  gravity: number;
  spin: number;
  tiltX: number;
  tiltY: number;
  delay: number;
  momentum: number;
}
export interface SurfaceFragmentPose {
  age: number;
  /** Attachment release, 0..1. */
  peel: number;
  /** Coverage to remove from the live surface; closes by age 2.7 seconds. */
  tear: number;
  opacity: number;
  /** Perspective growth, exactly 1 / (1 - z). */
  scale: number;
  /** Projected hero-radius units; positive right/down. */
  x: number;
  y: number;
  /** Fraction of the distance from the source plane toward the viewer. */
  z: number;
  /** Local rotations about the frozen patch anchor, in radians. */
  rotation: number;
  tiltX: number;
  tiltY: number;
  /** Blur radius in projected hero-radius units. */
  blur: number;
}
export const SURFACE_FRAGMENT_LIFETIME: 6.3;
/** Eighteen candidates; select at most six visible patches per event. */
export function surfaceFragmentCandidates(event: SurfaceFragmentEvent, seed: string | number): SurfaceFragmentCandidate[];
export function surfaceFragmentPose(event: SurfaceFragmentEvent, piece: SurfaceFragmentCandidate, time: number): SurfaceFragmentPose | undefined;
export function fragmentCoverage(u: number, v: number, piece: SurfaceFragmentCandidate): number;
/** Defines surfaceFragmentCoverage(vec2 uv, vec4 patch, float phase). */
export const FRAGMENT_COVERAGE_GLSL: string;
/** Input is sorted by captureTime. Returns original events in chronological order, at most three. */
export function surfaceFragmentEventsAt<T extends SurfaceFragmentEvent>(schedule: readonly T[], time: number): T[];

import type { Canvas, SKRSContext2D } from "@napi-rs/canvas";
import type { SafeLayout } from "./layout.js";
import type { SceneDynamics } from "./scene-dynamics.js";
import type { MusicMotion } from "./music-motion.js";
import { clamp } from "../math/random.js";

const unit = (value: number): number => Number.isFinite(value) ? clamp(value) : 0;

/**
 * Large forms carry inertia, but the raw envelopes still reach the picture:
 * the smoothed scene layers set the ceiling while the causal band envelopes
 * (bass 0.2 -> 1.0 across this song's sections) keep their section contrast.
 * `bassPunch` is the kick as the sculpture feels it: the body momentum of the
 * kept hits (momentum.ts), which rises over a few frames instead of stepping;
 * without one the raw one-frame pulse is used. The impact layer's 1.2 s tail
 * only floors it. `lightPunch` is the same for the light accents (the bloom's
 * glow and saturation through music-effects): the hits' flick, so a hat no
 * longer steps the bloom in one frame.
 */
export function inertialMusicMotion(
  motion: MusicMotion,
  dynamics: SceneDynamics,
  bassPunch = motion.bassPulse,
  lightPunch = motion.attack,
): MusicMotion {
  return {
    ...motion,
    attack: unit(lightPunch),
    bassEnergy: dynamics.body.energy * (0.30 + 0.70 * motion.bassEnergy),
    midEnergy: dynamics.detail.energy * (0.5 + 0.5 * motion.midEnergy),
    trebleEnergy: dynamics.spark.energy * (0.5 + 0.5 * motion.trebleEnergy),
    bassPulse: Math.max(unit(bassPunch), dynamics.impact.energy * 0.5),
    sustain: dynamics.cloud.energy * (0.30 + 0.70 * motion.sustain),
  };
}

export interface SceneCameraPose {
  /** Translation in graph half extents. */
  x: number;
  y: number;
  roll: number;
  zoom: number;
}

/**
 * Inertial camera motion stays inside the sculpture's reserved framing margin.
 * `kick` (the camera's hit momentum, 0..1) and `section` (surrounding
 * loudness) are geometry, so they are never capped by lowFlash; the kick
 * pushes harder at peaks and, through its kernel, never moves the zoom by
 * more than about 1% between frames at 60 fps.
 */
export function sceneCameraAt(dynamics: SceneDynamics, phase = 0, direction = 1, kick = 0, section = 0): SceneCameraPose {
  const { drift, cloud, body } = dynamics;
  const level = unit(section);
  const punch = unit(kick) * (0.5 + 0.5 * level);
  return {
    x: Math.sin(cloud.clock * 0.47 + phase) * (0.006 + cloud.energy * 0.012),
    y: Math.cos(drift.clock * 0.83 + phase * 0.7) * (0.005 + body.energy * 0.010 + level * 0.02),
    roll: direction * 0.003
      + Math.sin(cloud.clock * 0.63 + phase) * (0.028 + cloud.energy * 0.016)
      + Math.sin(body.clock * 0.25 + phase * 0.7) * (0.010 + body.energy * 0.012),
    zoom: 1 + body.energy * 0.050 + punch * 0.045 + level * 0.050
      + cloud.energy * 0.012 + drift.energy * 0.006,
  };
}

/**
 * Share of the safe graph the sculpture may fill: small and wispy in quiet
 * passages, close to the full reserve at peaks. Geometry, so never capped.
 */
export function sculptureFit(section: number): number {
  return 0.66 + unit(section) * 0.30;
}

/** The same projection is used by every layer that shares the pose. */
export function sceneCameraMatrix(layout: SafeLayout, pose: SceneCameraPose) {
  const halfY = Math.min(layout.horizon - layout.graphTop, layout.graphBottom - layout.horizon);
  const a = Math.cos(pose.roll) * pose.zoom, b = Math.sin(pose.roll) * pose.zoom;
  const c = -b, d = a;
  return { a, b, c, d,
    e: layout.centerX + pose.x * layout.width / 2 - a * layout.centerX - c * layout.horizon,
    f: layout.horizon + pose.y * halfY - b * layout.centerX - d * layout.horizon };
}

/**
 * Largest multiple of `radii` an ellipse centred on the sculpture's core can
 * grow to, drawn with a stroke reaching `halfStroke` graph units beyond its
 * edge, and still lie inside the graph clip under `pose`: the zoom enlarges
 * the projection, the pan moves its centre toward one edge and the roll
 * lifts the wide ellipse's height. Ring layers grow toward this instead of
 * into the clip, whose straight edges would otherwise cut them flat.
 */
export function ringReachWithin(
  layout: SafeLayout,
  pose: SceneCameraPose,
  radii: { x: number; y: number },
  halfStroke = 0,
): number {
  const halfY = Math.min(layout.horizon - layout.graphTop, layout.graphBottom - layout.horizon);
  const centerX = layout.centerX + pose.x * layout.width / 2;
  const centerY = layout.horizon + pose.y * halfY;
  const cos = Math.abs(Math.cos(pose.roll));
  const sin = Math.abs(Math.sin(pose.roll));
  // Half extents of the rolled ellipse per unit reach, before the zoom; the
  // extreme point along an axis has its normal on that axis, so the stroke
  // adds exactly halfStroke to each extent.
  const halfWidth = Math.hypot(radii.x * cos, radii.y * sin);
  const halfHeight = Math.hypot(radii.x * sin, radii.y * cos);
  const zoom = Math.max(1e-6, pose.zoom);
  const fit = (room: number, extent: number) => (room / zoom - halfStroke) / Math.max(1e-6, extent);
  return Math.max(0, Math.min(
    fit(centerX - layout.left, halfWidth),
    fit(layout.right - centerX, halfWidth),
    fit(centerY - layout.graphTop, halfHeight),
    fit(layout.graphBottom - centerY, halfHeight),
  ));
}

/**
 * Optical copies of the low-resolution light field, never of the finished frame.
 * Broad bloom and one rotating zoom smear leave the photo skin and credits
 * sharp. Three copies whose alphas sum below ~0.8: five stacked screen passes
 * clipped dense emission to white and lost the pigment's chroma. The hit's
 * flick pulses the smear (a luminance transient, so lowFlash halves it).
 */
export function drawAtmosphericBloom(
  context: SKRSContext2D,
  emission: Canvas,
  layout: SafeLayout,
  outputWidth: number,
  outputHeight: number,
  dynamics: SceneDynamics,
  strength: number,
  saturation: number,
  lowFlash: boolean,
  kick = 0,
): void {
  const width = emission.width, height = emission.height;
  const cx = layout.centerX * width / outputWidth;
  const cy = layout.horizon * height / outputHeight;
  const { cloud, body, impact } = dynamics;
  const pulse = Math.max(impact.energy, unit(kick)) * (lowFlash ? 0.5 : 1);
  const radius = Math.min(width, height);
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = "screen";
  context.globalAlpha = clamp(strength * (0.50 + cloud.energy * 0.18));
  context.filter = `blur(${radius * (0.032 + cloud.energy * 0.022)}px) saturate(${saturation})`;
  context.drawImage(emission, 0, 0);

  // The smear travels through the same light field; the integrated cloud
  // clock keeps its turning smooth even on short drum hits.
  const scale = 1 + 2 * (0.035 + body.energy * 0.012 + pulse * 0.012);
  context.save();
  context.translate(cx, cy);
  context.rotate(Math.sin(cloud.clock * 0.42 + 1.6) * 0.056);
  context.scale(scale, scale);
  context.globalAlpha = clamp(strength * (0.14 + cloud.energy * 0.08 + pulse * 0.12));
  context.filter = `blur(${radius * 0.024}px) saturate(${saturation})`;
  context.drawImage(emission, -cx, -cy);
  context.restore();

  context.globalAlpha = clamp(strength * 0.22);
  context.filter = `blur(${Math.max(0.6, radius * 0.009)}px)`;
  context.drawImage(emission, 0, 0);

  // Filtering can spread past the geometry clip. Protect credits after all
  // optical transforms, in fixed output space, including portrait output.
  context.filter = "none";
  context.globalAlpha = 1;
  context.globalCompositeOperation = "destination-in";
  const protection = context.createLinearGradient(0, 0, 0, height);
  protection.addColorStop(0, "transparent");
  protection.addColorStop(layout.graphTop / outputHeight - 0.025, "transparent");
  protection.addColorStop(layout.graphTop / outputHeight + 0.055, "white");
  protection.addColorStop(0.87, "white");
  protection.addColorStop(1, "transparent");
  context.fillStyle = protection;
  context.fillRect(0, 0, width, height);
  context.restore();
}

import type { Canvas, SKRSContext2D } from "@napi-rs/canvas";
import type { SafeLayout } from "./layout.js";
import type { SceneDynamics } from "./scene-dynamics.js";
import type { MusicMotion } from "./music-motion.js";
import { clamp } from "../math/random.js";

/** Large forms carry inertia; fine waveform detail and small light attacks remain quick. */
export function inertialMusicMotion(motion: MusicMotion, dynamics: SceneDynamics): MusicMotion {
  return {
    ...motion,
    bassEnergy: dynamics.body.energy,
    midEnergy: dynamics.detail.energy,
    trebleEnergy: dynamics.spark.energy,
    bassPulse: dynamics.impact.energy,
    sustain: dynamics.cloud.energy,
  };
}

/** Inertial camera motion stays inside the sculpture's reserved framing margin. */
export function sceneCameraAt(dynamics: SceneDynamics, phase = 0, direction = 1) {
  const { drift, cloud, body, impact } = dynamics;
  return {
    x: Math.sin(cloud.clock * 0.47 + phase) * (0.006 + cloud.energy * 0.012),
    y: Math.cos(drift.clock * 0.83 + phase * 0.7) * (0.005 + body.energy * 0.010),
    roll: direction * 0.003
      + Math.sin(cloud.clock * 0.63 + phase) * (0.018 + cloud.energy * 0.016)
      + Math.sin(body.clock * 0.25 + phase * 0.7) * (0.007 + body.energy * 0.012),
    zoom: 1 + body.energy * 0.040 + impact.energy * 0.060
      + cloud.energy * 0.012 + drift.energy * 0.006,
  };
}

/** The same projection is used by visible geometry and its background influence. */
export function sceneCameraMatrix(layout: SafeLayout, dynamics: SceneDynamics, phase = 0, direction = 1) {
  const pose = sceneCameraAt(dynamics, phase, direction);
  const halfY = Math.min(layout.horizon - layout.graphTop, layout.graphBottom - layout.horizon);
  const a = Math.cos(pose.roll) * pose.zoom, b = Math.sin(pose.roll) * pose.zoom;
  const c = -b, d = a;
  return { a, b, c, d,
    e: layout.centerX + pose.x * layout.width / 2 - a * layout.centerX - c * layout.horizon,
    f: layout.horizon + pose.y * halfY - b * layout.centerX - d * layout.horizon };
}

/**
 * Optical copies of the low-resolution light field, never of the finished frame.
 * Broad bloom and rotating zoom smears leave the photo skin and credits sharp.
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
): void {
  const width = emission.width, height = emission.height;
  const cx = layout.centerX * width / outputWidth;
  const cy = layout.horizon * height / outputHeight;
  const { cloud, body, impact } = dynamics;
  const pulse = impact.energy * (lowFlash ? 0.3 : 1);
  const radius = Math.min(width, height);
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = "screen";
  context.globalAlpha = clamp(strength * (0.70 + cloud.energy * 0.22));
  context.filter = `blur(${radius * (0.032 + cloud.energy * 0.022)}px) saturate(${saturation})`;
  context.drawImage(emission, 0, 0);

  // Each copy travels a different distance through the same light field. The
  // integrated clocks keep their turning smooth even on short drum hits.
  for (let index = 1; index <= 3; index++) {
    const scale = 1 + index * (0.035 + body.energy * 0.012 + pulse * 0.012);
    context.save();
    context.translate(cx, cy);
    context.rotate(Math.sin(cloud.clock * 0.42 + index * 0.8) * index * 0.028);
    context.scale(scale, scale);
    context.globalAlpha = clamp(strength * (0.17 + cloud.energy * 0.10 + pulse * 0.10) / index);
    context.filter = `blur(${radius * (0.010 + index * 0.007)}px) saturate(${saturation})`;
    context.drawImage(emission, -cx, -cy);
    context.restore();
  }
  context.globalAlpha = clamp(strength * 0.58);
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

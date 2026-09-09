import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { clamp, smoothstep } from "../math/random.js";
import type { AnalysisFrame, AudioAnalysis } from "../types.js";
import { frozenCloudPlan } from "./frozen-cloud.js";
import { safeGraphRadius, type SafeLayout } from "./layout.js";
import type { LightingState } from "./lighting.js";
import type { MaterialMap } from "./material.js";
import type { MusicMotion } from "./music-motion.js";
import type { ResonanceFilament, ResonancePoint } from "./resonance.js";
import { captureMaterialSurface, type SurfaceCoverage } from "./surface-mesh.js";
import { fragmentCoverage, surfaceFragmentCandidates, surfaceFragmentEventsAt, surfaceFragmentPose,
  type SurfaceFragmentCandidate, type SurfaceFragmentEvent, type SurfaceFragmentPose } from "./surface-fragments.js";

type Point3 = { x: number; y: number; z: number };
type Face = { points: Point3[]; color: string; alpha: number };
export interface FragmentSource {
  filaments: ResonanceFilament[];
  frame: AnalysisFrame;
  motion: MusicMotion;
  material: MaterialMap;
  lights: LightingState;
  strength: number;
  lowFlash: boolean;
  camera: { a: number; b: number; c: number; d: number; e: number; f: number };
}
interface Fragment {
  event: SurfaceFragmentEvent;
  candidate: SurfaceFragmentCandidate;
  faces: Face[];
  anchor: Point3;
  origin: { x: number; y: number };
  distance: number;
  selection: { birthSpan: number; aspect: number; visibility: number; depthRatio: number };
}

/** Unproject the original camera exactly, then keep real curved polygons for tumbling. */
export function fragmentProjection(source: FragmentSource, layout: SafeLayout) {
  const { camera } = source;
  const zoom = Math.hypot(camera.a, camera.b);
  let depthScale = safeGraphRadius(layout) * zoom;
  outer: for (const filament of source.filaments) for (const point of filament.points) {
    if (Math.abs(point.surfaceY) < 0.1) continue;
    const p = 3.8 / (3.8 - point.surfaceZ);
    const scale = (point.y - layout.horizon) / (-point.surfaceY * p) * zoom;
    if (Number.isFinite(scale) && scale > 0) { depthScale = scale; break outer; }
  }
  const origin = {
    x: camera.a * layout.centerX + camera.c * layout.horizon + camera.e,
    y: camera.b * layout.centerX + camera.d * layout.horizon + camera.f,
  };
  const distance = depthScale * 3.8;
  return { origin, distance, point: (point: ResonancePoint): Point3 => {
    const p = 3.8 / (3.8 - point.surfaceZ);
    return {
      x: (camera.a * point.x + camera.c * point.y + camera.e - origin.x) / p,
      y: (camera.b * point.x + camera.d * point.y + camera.f - origin.y) / p,
      z: point.surfaceZ * depthScale,
    };
  } };
}

/** A local rigid rotation, followed by approach in the captured camera's 3D space. */
export function projectFragmentPoint(point: Point3, anchor: Point3, pose: SurfaceFragmentPose,
  origin: { x: number; y: number }, distance: number, radius: number): Point3 {
  const x = point.x - anchor.x, y = point.y - anchor.y, z = point.z - anchor.z;
  const cx = Math.cos(pose.tiltX), sx = Math.sin(pose.tiltX);
  const cy = Math.cos(pose.tiltY), sy = Math.sin(pose.tiltY);
  const cz = Math.cos(pose.rotation), sz = Math.sin(pose.rotation);
  const y1 = y * cx - z * sx, z1 = y * sx + z * cx;
  const x2 = x * cy + z1 * sy, z2 = -x * sy + z1 * cy;
  const depth = anchor.z + z2 + pose.z * (distance - anchor.z);
  const perspective = distance / Math.max(distance * 0.12, distance - depth);
  // Shared x/y are projected offsets; undo perspective on translation only.
  return { x: origin.x + (anchor.x + x2 * cz - y1 * sz) * perspective + pose.x * radius,
    y: origin.y + (anchor.y + x2 * sz + y1 * cz) * perspective + pose.y * radius, z: depth };
}

/** Sparse, immutable mesh captures; independent of frame order and current camera motion. */
export class SurfaceFragmentLayer {
  private readonly scratch = createCanvas(384, 384);
  private readonly scratchContext = this.scratch.getContext("2d");
  private readonly bursts = new Map<number, Fragment[]>();
  private analysis: AudioAnalysis | undefined;
  private active: { fragment: Fragment; pose: SurfaceFragmentPose }[] = [];
  private tears: { candidate: SurfaceFragmentCandidate; amount: number }[] = [];

  constructor(private readonly layout: SafeLayout, private readonly seed: string) {}

  /** Undefined when healed: ordinary skin/filament rendering retains its fast path. */
  get opacityAt(): SurfaceCoverage | undefined {
    return this.tears.length ? this.coverage : undefined;
  }

  private readonly coverage: SurfaceCoverage = (u, v) => {
    let removed = 0;
    for (const tear of this.tears) {
      // Cheap periodic bounding check avoids trig for almost all live vertices.
      const du = Math.abs(u - tear.candidate.u), dv = Math.abs(v - tear.candidate.v);
      if (Math.min(du, 1 - du) > tear.candidate.halfU || Math.min(dv, 1 - dv) > tear.candidate.halfV) continue;
      removed = Math.max(removed, tear.amount * fragmentCoverage(u, v, tear.candidate));
    }
    return 1 - removed;
  };

  update(analysis: AudioAnalysis, time: number, capture: (time: number) => FragmentSource): void {
    if (analysis !== this.analysis) { this.bursts.clear(); this.analysis = analysis; }
    const events = surfaceFragmentEventsAt(frozenCloudPlan(analysis), time);
    const ids = new Set(events.map(event => event.id));
    for (const id of this.bursts.keys()) if (!ids.has(id)) this.bursts.delete(id);
    this.active = [];
    this.tears = [];
    for (const event of events) {
      if (!this.bursts.has(event.id)) this.bursts.set(event.id, this.capture(event, capture(event.captureTime)));
      for (const fragment of this.bursts.get(event.id)!) {
        const pose = surfaceFragmentPose(event, fragment.candidate, time);
        if (!pose) continue;
        this.active.push({ fragment, pose });
        if (pose.tear > 0.001) this.tears.push({ candidate: fragment.candidate, amount: pose.tear });
      }
    }
    this.active.sort((a, b) => a.fragment.anchor.z + a.pose.z * (a.fragment.distance - a.fragment.anchor.z)
      - b.fragment.anchor.z - b.pose.z * (b.fragment.distance - b.fragment.anchor.z));
  }

  private capture(event: SurfaceFragmentEvent, source: FragmentSource): Fragment[] {
    const projection = fragmentProjection(source, this.layout);
    const radius = safeGraphRadius(this.layout);
    // A coarse opaque depth guide rules out rear folds before they can be drawn
    // over the live skin. It is rebuilt only at sparse capture timestamps.
    const gridSize = 96;
    const depthGrid = new Float32Array(gridSize * gridSize).fill(-Infinity);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const strand of source.filaments) for (const point of strand.points) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
    }
    if (!Number.isFinite(minX + minY + maxX + maxY)) return [];
    const gridX = (gridSize - 1) / Math.max(1, maxX - minX);
    const gridY = (gridSize - 1) / Math.max(1, maxY - minY);
    const raster = (a: ResonancePoint, b: ResonancePoint, c: ResonancePoint) => {
      const ax = (a.x - minX) * gridX, ay = (a.y - minY) * gridY;
      const bx = (b.x - minX) * gridX, by = (b.y - minY) * gridY;
      const cx = (c.x - minX) * gridX, cy = (c.y - minY) * gridY;
      const determinant = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(determinant) < 1e-8) return;
      const left = Math.max(0, Math.ceil(Math.min(ax, bx, cx)));
      const right = Math.min(gridSize - 1, Math.floor(Math.max(ax, bx, cx)));
      const top = Math.max(0, Math.ceil(Math.min(ay, by, cy)));
      const bottom = Math.min(gridSize - 1, Math.floor(Math.max(ay, by, cy)));
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
        const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / determinant;
        const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / determinant;
        if (u < 0 || v < 0 || u + v > 1) continue;
        const depth = 3.8 - 1 / (u / (3.8 - a.surfaceZ) + v / (3.8 - b.surfaceZ) + (1 - u - v) / (3.8 - c.surfaceZ));
        const at = y * gridSize + x;
        depthGrid[at] = Math.max(depthGrid[at]!, depth);
      }
    };
    const count = (source.filaments[0]?.points.length ?? 1) - 1;
    for (let strand = 0; strand < source.filaments.length; strand += 2) {
      const row = source.filaments[strand]!.points;
      const next = source.filaments[(strand + 2) % source.filaments.length]!.points;
      for (let index = 0; index < count; index += 4) {
        const end = Math.min(count, index + 4);
        if (row[index] && row[end] && next[index] && next[end]) {
          raster(row[index]!, row[end]!, next[end]!);
          raster(row[index]!, next[end]!, next[index]!);
        }
      }
    }
    const frontDepth = (x: number, y: number): number => {
      const gx = clamp(Math.round((x - minX) * gridX), 0, gridSize - 1);
      const gy = clamp(Math.round((y - minY) * gridY), 0, gridSize - 1);
      return depthGrid[gy * gridSize + gx]!;
    };
    const capturePatch = (candidate: SurfaceFragmentCandidate) => {
      const captured = captureMaterialSurface(source.filaments, source.frame, source.motion, source.material,
        source.lights, source.strength, source.lowFlash, (u, v) => {
          const du = Math.abs(u - candidate.u), dv = Math.abs(v - candidate.v);
          if (Math.min(du, 1 - du) > candidate.halfU || Math.min(dv, 1 - dv) > candidate.halfV) return 0;
          return fragmentCoverage(u, v, candidate);
        });
      let area = 0, depth = 0, visibleArea = 0;
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      const points = new Map<ResonancePoint, Point3>();
      const { camera } = source;
      for (const face of captured) {
        const [a, b, c, d] = face.points;
        const faceArea = Math.abs(a.x * b.y - b.x * a.y + b.x * c.y - c.x * b.y
          + c.x * d.y - d.x * c.y + d.x * a.y - a.x * d.y) * 0.5 * face.alpha;
        area += faceArea;
        depth += faceArea * (a.depth + b.depth + c.depth + d.depth) / 4;
        const centerX = (a.x + b.x + c.x + d.x) / 4, centerY = (a.y + b.y + c.y + d.y) / 4;
        const centerZ = (a.surfaceZ + b.surfaceZ + c.surfaceZ + d.surfaceZ) / 4;
        if (centerZ >= frontDepth(centerX, centerY) - 0.045) visibleArea += faceArea;
        for (const point of face.points) {
          if (!points.has(point)) points.set(point, projection.point(point));
          const x = camera.a * point.x + camera.c * point.y + camera.e;
          const y = camera.b * point.x + camera.d * point.y + camera.f;
          left = Math.min(left, x); right = Math.max(right, x);
          top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
      }
      const anchor = { x: 0, y: 0, z: 0 };
      for (const point of points.values()) { anchor.x += point.x; anchor.y += point.y; anchor.z += point.z; }
      anchor.x /= Math.max(1, points.size); anchor.y /= Math.max(1, points.size); anchor.z /= Math.max(1, points.size);
      let span3D = 0;
      for (const point of points.values()) span3D = Math.max(span3D, Math.hypot(point.x - anchor.x, point.y - anchor.y, point.z - anchor.z));
      const longest = Math.max(right - left, bottom - top);
      const aspect = longest / Math.max(1, Math.min(right - left, bottom - top));
      const depthRatio = span3D / Math.max(1, projection.distance - anchor.z);
      const visibility = area > 0 ? visibleArea / area : 0;
      const near = area > 0 ? depth / area : 0;
      return { candidate, captured, points, anchor, area, near, longest, aspect, depthRatio, visibility,
        score: area * (0.15 + near ** 3) * visibility ** 2 };
    };
    const candidates = surfaceFragmentCandidates(event, this.seed).map(original => {
      let patch = capturePatch(original);
      // Uniformly shrink the UV island itself, not its rendered bitmap. The
      // modified descriptor is retained for the corresponding tear in the skin.
      for (let attempt = 0; attempt < 2 && (patch.longest > radius * 0.8 || patch.depthRatio > 0.14); attempt++) {
        const fit = Math.min(radius * 0.8 / patch.longest, 0.14 / patch.depthRatio, 1) * 0.94;
        patch = capturePatch({ ...patch.candidate, halfU: patch.candidate.halfU * fit, halfV: patch.candidate.halfV * fit });
      }
      return patch;
    }).filter(patch => patch.area > radius * radius * 0.0008 && patch.near > 0.42
      && patch.longest <= radius * 0.8 && patch.aspect <= 5 && patch.depthRatio <= 0.14 && patch.visibility >= 0.80)
      .sort((a, b) => b.score - a.score || a.candidate.index - b.candidate.index);
    const selected: Fragment[] = [];
    for (const patch of candidates) {
      if (selected.length === 6) break;
      if (selected.some(({ candidate }) => {
        const du = Math.abs(candidate.u - patch.candidate.u), dv = Math.abs(candidate.v - patch.candidate.v);
        return Math.min(du, 1 - du) < candidate.halfU + patch.candidate.halfU
          && Math.min(dv, 1 - dv) < candidate.halfV + patch.candidate.halfV;
      })) continue;
      const faces = patch.captured.map(face => ({
        points: face.points.map(point => patch.points.get(point)!),
        color: `rgb(${face.color.map(channel => Math.round(channel * 255)).join(",")})`, alpha: face.alpha,
      }));
      selected.push({ event, candidate: patch.candidate, faces, anchor: patch.anchor, origin: projection.origin,
        distance: projection.distance, selection: { birthSpan: patch.longest / radius, aspect: patch.aspect,
          visibility: patch.visibility, depthRatio: patch.depthRatio } });
    }
    return selected;
  }

  draw(context: SKRSContext2D): void {
    const radius = safeGraphRadius(this.layout);
    const scratch = this.scratchContext;
    context.save();
    context.globalCompositeOperation = "source-over";
    for (const { fragment, pose } of this.active) {
      if (pose.opacity < 0.001) continue;
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      const faces = fragment.faces.map(face => {
        const points = face.points.map(point => {
          const projected = projectFragmentPoint(point, fragment.anchor, pose, fragment.origin, fragment.distance, radius);
          left = Math.min(left, projected.x); right = Math.max(right, projected.x);
          top = Math.min(top, projected.y); bottom = Math.max(bottom, projected.y);
          return projected;
        });
        return { ...face, points, depth: points.reduce((sum, point) => sum + point.z, 0) / 4 };
      }).sort((a, b) => a.depth - b.depth);
      const blur = pose.blur * radius;
      // Fade before a blurred fragment can enter the credit area. No opaque band or hard edge.
      const clearance = smoothstep(this.layout.graphTop + blur * 3,
        this.layout.graphTop + radius * 0.22 + blur * 3, top);
      if (clearance < 0.001 || !Number.isFinite(left + top + right + bottom)) continue;
      const padding = 2;
      left -= padding; top -= padding; right += padding; bottom += padding;
      const width = Math.max(1, right - left), height = Math.max(1, bottom - top);
      const scale = Math.min(1, 384 / Math.max(width, height));
      scratch.resetTransform(); scratch.clearRect(0, 0, 384, 384);
      scratch.setTransform(scale, 0, 0, scale, -left * scale, -top * scale);
      scratch.lineJoin = "round"; scratch.lineWidth = Math.max(0.35, radius * 0.0018);
      for (const face of faces) {
        scratch.globalAlpha = face.alpha;
        scratch.fillStyle = face.color; scratch.strokeStyle = face.color;
        scratch.beginPath(); scratch.moveTo(face.points[0]!.x, face.points[0]!.y);
        for (let index = 1; index < face.points.length; index++) scratch.lineTo(face.points[index]!.x, face.points[index]!.y);
        scratch.closePath(); scratch.fill();
        // Tiny same-pigment joins prevent hairline raster cracks during rotation.
        scratch.globalAlpha = face.alpha * 0.28; scratch.stroke();
      }
      context.globalAlpha = clamp(pose.opacity * clearance);
      context.filter = blur > 0.1 ? `blur(${blur}px)` : "none";
      context.drawImage(this.scratch, 0, 0, width * scale, height * scale, left, top, width, height);
    }
    context.restore();
  }

  inspect() {
    return { bursts: this.bursts.size, pieces: this.active.length, tears: this.tears.length,
      faces: this.active.reduce((sum, item) => sum + item.fragment.faces.length, 0),
      ids: this.active.map(item => item.fragment.candidate.id).sort(),
      selection: this.active.map(({ fragment }) => ({ id: fragment.candidate.id, ...fragment.selection,
        halfU: fragment.candidate.halfU, halfV: fragment.candidate.halfV })) };
  }
}

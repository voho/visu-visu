/** Shared, frame-rate independent motion for pieces of the captured surface. */
export const SURFACE_FRAGMENT_LIFETIME = 6.3;
const TAU = Math.PI * 2;

const clamp = (value) => Math.max(0, Math.min(1, value));
const wrap = (value) => value - Math.floor(value);
const smoothstep = (start, end, value) => {
  const t = clamp((value - start) / (end - start));
  return t * t * (3 - 2 * t);
};
const validEvent = (event) => event && Number.isFinite(event.id)
  && Number.isFinite(event.captureTime) && event.captureTime >= 0
  && Number.isFinite(event.strength) && event.strength >= 0;

// Keep this module browser-safe; the project's seed utility also imports Node.
function randomFor(seed) {
  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    state = Math.imul(state ^ seed.charCodeAt(index), 0x01000193);
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Eighteen stable, unmirrored surface UV candidates; renderers choose at most four visible patches. */
export function surfaceFragmentCandidates(event, seed) {
  if (!validEvent(event)) return [];
  const random = randomFor(`${String(seed)}\u241fsurface-fragments\u241f${event.id}\u241f${event.captureTime}`);
  const offsetU = random();
  const offsetV = random();
  return Array.from({ length: 18 }, (_, index) => ({
    id: `${event.id}:${index}`,
    index,
    u: wrap(offsetU + (index % 6 + 0.18 + random() * 0.64) / 6),
    v: wrap(offsetV + (Math.floor(index / 6) + 0.18 + random() * 0.64) / 3),
    halfU: 0.0375 + random() * 0.027,
    halfV: 0.0675 + random() * 0.045,
    phase: random() * TAU,
    driftX: (random() < 0.5 ? -1 : 1) * (0.34 + random() * 0.46),
    driftY: -0.08 + random() * 0.26,
    gravity: 0.60 + random() * 0.40,
    spin: (random() < 0.5 ? -1 : 1) * (0.65 + random() * 0.65),
    tiltX: (random() * 2 - 1) * 0.90,
    tiltY: (random() * 2 - 1) * 0.80,
    delay: 0.10 + random() * 0.10,
    momentum: 0.65 + random() * 0.45,
  }));
}

/** Smoothly peel, drift toward the viewer, tumble, then fade without changing source geometry. */
export function surfaceFragmentPose(event, piece, time) {
  if (!validEvent(event) || !piece || !Number.isFinite(time)
    || time < event.captureTime || time >= event.captureTime + SURFACE_FRAGMENT_LIFETIME) return undefined;
  if (![piece.driftX, piece.driftY, piece.gravity, piece.spin, piece.tiltX,
    piece.tiltY, piece.delay, piece.momentum].every(Number.isFinite)
    || piece.delay < 0 || piece.delay >= SURFACE_FRAGMENT_LIFETIME || piece.momentum <= 0) return undefined;
  const age = time - event.captureTime;
  const elapsed = Math.max(0, age - piece.delay);
  const duration = SURFACE_FRAGMENT_LIFETIME - piece.delay;
  // Integrated exponential acceleration starts with zero velocity and settles
  // into a slow outward drift, independent of the frame sampling cadence.
  const distance = (t) => t + piece.momentum * Math.expm1(-t / piece.momentum);
  const travel = clamp(distance(elapsed) / distance(duration));
  const strength = clamp(event.strength);
  const response = 0.65 + strength * 0.35;
  const z = travel * (0.50 + strength * 0.08);
  return {
    age,
    peel: smoothstep(piece.delay, piece.delay + 1.25, age),
    // The live skin closes before the next 3-second bass capture can open it.
    tear: smoothstep(0.10, 0.65, age) * (1 - smoothstep(1.65, 2.70, age)),
    opacity: (0.55 + strength * 0.45) * 0.90 * smoothstep(0, 0.25, age)
      * Math.exp(-Math.max(0, age - 0.25) / 7)
      * (1 - smoothstep(2.2, SURFACE_FRAGMENT_LIFETIME, age)),
    scale: 1 / (1 - z),
    x: piece.driftX * travel * response,
    y: (piece.driftY * travel + piece.gravity * travel * travel) * response,
    z,
    rotation: piece.spin * travel,
    tiltX: piece.tiltX * travel,
    tiltY: piece.tiltY * travel,
    blur: (0.04 + strength * 0.015) * smoothstep(1.2, SURFACE_FRAGMENT_LIFETIME, age),
  };
}

/** Ragged elliptical coverage in the original periodic surface UV, not mirrored photo UV. */
export function fragmentCoverage(u, v, piece) {
  if (!piece || ![u, v, piece.u, piece.v, piece.halfU, piece.halfV, piece.phase].every(Number.isFinite)
    || piece.halfU <= 0 || piece.halfV <= 0) return 0;
  const x = (wrap(u - piece.u + 0.5) - 0.5) / piece.halfU;
  const y = (wrap(v - piece.v + 0.5) - 0.5) / piece.halfV;
  const angle = Math.atan2(y, x);
  const edge = 0.86 + 0.08 * Math.sin(angle * 3 + piece.phase) + 0.05 * Math.sin(angle * 5 - piece.phase);
  return 1 - smoothstep(edge - 0.10, edge, Math.hypot(x, y));
}

/** GLSL equivalent of fragmentCoverage; patch = (u, v, halfU, halfV). */
export const FRAGMENT_COVERAGE_GLSL = `
float surfaceFragmentCoverage(vec2 uv, vec4 patch, float phase) {
  vec2 local = (mod(uv - patch.xy + 0.5, 1.0) - 0.5) / patch.zw;
  if (dot(local, local) < 0.000000000001) return 1.0;
  float angle = atan(local.y, local.x);
  float edge = 0.86 + 0.08 * sin(angle * 3.0 + phase) + 0.05 * sin(angle * 5.0 - phase);
  return 1.0 - smoothstep(edge - 0.10, edge, length(local));
}
`;

/** Query the chronological bass capture schedule; retain at most three live bursts. */
export function surfaceFragmentEventsAt(schedule, time) {
  if (!schedule?.length || !Number.isFinite(time) || time < 0) return [];
  let left = 0;
  let right = schedule.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (schedule[middle].captureTime <= time) left = middle + 1;
    else right = middle;
  }
  const result = [];
  for (let index = left - 1; index >= 0 && result.length < 3; index -= 1) {
    const event = schedule[index];
    if (event.captureTime + SURFACE_FRAGMENT_LIFETIME <= time) break;
    if (validEvent(event)) result.push(event);
  }
  return result.reverse();
}

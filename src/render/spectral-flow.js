// Original flow geometry inspired by MilkDrop's separation of persistent warp
// light and the sharp composite. A finite history replaces framebuffer feedback
// so a seek, parallel frame export and ordinary playback produce the same light.
export const FLOW_AGES = Object.freeze([1.4, 1.0, 0.65, 0.32, 0]);
const TAU = Math.PI * 2;
const unit = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const finite = value => Number.isFinite(value) ? value : 0;
const mix = (a, b, t) => a + (b - a) * t;

function seedPhase(seed) {
  let hash = 2166136261;
  for (const character of String(seed)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967296 * TAU;
}

function sample(values, position, signed = false) {
  if (!values?.length) return 0;
  const p = Math.max(0, Math.min(values.length - 1, position * (values.length - 1)));
  const left = Math.floor(p), right = Math.min(values.length - 1, left + 1);
  const read = index => Math.max(signed ? -1 : 0, Math.min(1, finite(values[index])));
  // A small spatial tent smooths FFT bins and PCM detail before curve warping.
  const filtered = index => (read(Math.max(0, index - 1)) + 2 * read(index) + read(Math.min(values.length - 1, index + 1))) * 0.25;
  return mix(filtered(left), filtered(right), p - left);
}

/** Spatially varying blend of an outward vortex and a folding, liquid flow. */
function transport(x, y, age, current, phase) {
  const bass = unit(current.bass), mid = unit(current.mid), treble = unit(current.treble);
  const slow = finite(current.slow), fast = finite(current.fast);
  const radius = Math.hypot(x, y), angle = Math.atan2(y, x);
  const blend = 0.5 + 0.5 * Math.sin(slow * 0.38 + phase
    + Math.sin(angle * 2 - slow * 0.13) * 0.85 + radius * 0.65);
  const zoom = 1 + age * (0.045 + bass * 0.15 + mid * 0.035 + treble * 0.008);
  const curl = age * (0.022 + bass * 0.028 + mid * 0.045)
    * (1 + 0.45 * Math.sin(radius * 5 - slow * 0.8 + phase));
  const a = angle + curl;
  const spiralX = Math.cos(a) * radius * zoom;
  const spiralY = Math.sin(a) * radius * zoom;
  const ripple = age * (bass * 0.055 + mid * 0.020 + treble * 0.005);
  const foldedX = x * zoom + Math.sin(y * 4.8 + slow * 0.7 + phase) * ripple;
  const foldedY = y * zoom + Math.sin(x * 5.2 - slow * 0.6 + phase) * ripple;
  const fine = age * treble * 0.003;
  return { x: mix(spiralX, foldedX, blend) + Math.sin(y * 11 + fast * 0.15) * fine,
    y: mix(spiralY, foldedY, blend) + Math.cos(x * 12 - fast * 0.13) * fine };
}

/**
 * Six musical ribbons at five fixed past ages, oldest first. No random calls,
 * advancing particles, accumulated canvas, or dependence on prior draw order.
 * Width/blur use the projection's smaller radius; color is a source-palette
 * position. Coordinates are in the surrounding light field's ellipse.
 */
export function spectralFlowPaths(samples, seed) {
  if (!Array.isArray(samples)) return [];
  const valid = samples.filter(item => item?.state && Number.isFinite(item.age)
    && FLOW_AGES.includes(item.age) && Number.isFinite(item.state.time) && item.state.time >= 0);
  // Select exactly one sample per supported age and require the current state.
  const current = valid.find(item => item.age === 0)?.state;
  if (!current || unit(current.presence) === 0) return [];
  const phase = seedPhase(seed), paths = [];
  const blend = 0.5 + 0.5 * Math.sin(finite(current.slow) * 0.38 + phase);
  for (const age of FLOW_AGES) {
    const state = valid.find(item => item.age === age)?.state;
    if (!state || age > current.time || Math.abs(current.time - age - state.time) > 1e-5) continue;
    const bass = unit(state.bass), mid = unit(state.mid), treble = unit(state.treble);
    const energy = unit(state.energy), presence = unit(state.presence) * unit(current.presence);
    const audible = Math.max(energy, bass * 0.8, mid * 0.5, treble * 0.25);
    if (audible < 0.0001 || presence === 0) continue;
    const slow = finite(state.slow), fast = finite(state.fast);
    const phaseRotation = slow * 0.13 + phase;
    // The lower the frequency, the broader the displacement. Impact is a
    // smoothed envelope and changes geometry independently of low-flash mode.
    const response = bass * 0.10 + mid * 0.026 + treble * 0.006 + unit(state.impact) * 0.028;
    for (let family = 0; family < 2; family++) for (let strand = 0; strand < 3; strand++) {
      const points = [];
      for (let index = 0; index <= 96; index++) {
        // Closed periodic sampling leaves neither a waveform nor an FFT seam.
        const theta = index / 96 * TAU;
        const position = 0.5 - 0.5 * Math.cos(theta + strand * 0.21);
        const spectrum = sample(state.spectrum, position) * (1 - position * 0.78);
        const wave = sample(state.waveform, 0.5 - 0.5 * Math.cos(theta - slow * 0.09), true);
        const radius = 0.61 + strand * 0.065 + response
          + Math.sin(theta * 3 + phaseRotation) * (0.022 + mid * 0.020)
          + spectrum * (0.025 + bass * 0.070) + wave * (0.018 + bass * 0.022);
        const angle = theta + phaseRotation * (family === 0 ? 1 : -0.55);
        let x, y;
        if (family === 0) {
          x = Math.cos(angle) * radius;
          y = Math.sin(angle) * radius;
        } else {
          // A folded oscilloscope contour crosses the circular flow; their
          // weights evolve together without a scene cut or doubled exposure.
          x = Math.cos(angle) * radius * 1.03;
          y = (Math.sin(angle) * 0.74 + Math.sin(angle * 2 + slow * 0.17) * 0.18) * radius;
          y += wave * (0.012 + mid * 0.025);
        }
        points.push(transport(x, y, age, current, phase));
      }
      const weight = family === 0 ? 0.30 + blend * 0.40 : 0.70 - blend * 0.40;
      const decay = Math.exp(-age * 1.65);
      paths.push({ points, family, age,
        alpha: presence * Math.sqrt(audible) * (0.30 + energy * 0.26 + bass * 0.14)
          * weight * [1, 0.68, 0.42][strand] * decay,
        width: 0.0055 + bass * 0.003 + mid * 0.0007 + age * 0.0015,
        blur: 0.0015 + age * 0.011,
        color: ((phase / TAU + family * 0.47 + strand * 0.045 + slow * 0.006) % 1 + 1) % 1,
      });
    }
  }
  return paths;
}

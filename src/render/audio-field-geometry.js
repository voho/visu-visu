// Shared by Canvas exports and the WebGL preview. Coordinates are normalized,
// +X right / +Y down; the caller fits this field to its protected graph region.
const TAU = Math.PI * 2;
const unit = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const signed = value => Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
const sample = (values, position) => {
  const at = Math.max(0, Math.min(Math.max(0, values.length - 1), position * (values.length - 1)));
  const index = Math.floor(at), mix = at - index;
  return signed(values[index] ?? 0) * (1 - mix) + signed(values[Math.min(index + 1, values.length - 1)] ?? 0) * mix;
};
// Monotone cubic interpolation rounds sample corners without overshooting the
// signed waveform. Extrema remain at the source samples instead of ringing.
export const smoothSample = (values, position) => {
  if (values.length < 2) return signed(values[0] ?? 0);
  const at = Math.max(0, Math.min(values.length - 1, position * (values.length - 1)));
  const index = Math.min(values.length - 2, Math.floor(at)), t = at - index;
  const atIndex = i => signed(values[Math.max(0, Math.min(values.length - 1, i))] ?? 0);
  const a = atIndex(index), b = atIndex(index + 1), delta = b - a;
  const slope = (left, right) => left * right <= 0 ? 0 : 2 * left * right / (left + right);
  const m0 = slope(a - atIndex(index - 1), delta);
  const m1 = slope(delta, atIndex(index + 2) - b);
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * a + (t3 - 2 * t2 + t) * m0
    + (-2 * t3 + 3 * t2) * b + (t3 - t2) * m1;
};

export function audioFieldGeometry(spectrum, waveform, fast, slow, phase) {
  fast = unit(fast); slow = unit(slow);
  phase = Number.isFinite(phase) ? phase : 0;
  const breathing = 0.69 + slow * 0.075;
  // A narrow, energy-preserving neighbor mix keeps isolated peaks legible and
  // in their original band while softening the crown's spatial stair steps.
  const bands = Array.from({ length: 32 }, (_, band) => unit(sample(spectrum, band / 31)));
  const spokes = [];
  for (let band = 0; band < 32; band++) {
    const frequency = (band + 0.5) / 32;
    const energy = bands[band] * 0.75 + bands[Math.max(0, band - 1)] * 0.125
      + bands[Math.min(31, band + 1)] * 0.125;
    const response = energy * (0.2 + 0.8 * (1 - frequency) ** 1.7);
    const angle = (0.08 + frequency * 0.84) * Math.PI;
    const bend = Math.sin(phase * 0.13 + frequency * TAU) * 0.035;
    const radius = breathing + 0.025;
    const tip = radius + 0.009 + response * 0.18;
    for (const side of [-1, 1]) {
      const x = Math.sin(angle + bend) * side;
      const y = Math.cos(angle + bend);
      spokes.push({ x1: x * radius, y1: y * radius, x2: x * tip, y2: y * tip,
        energy, phase: frequency * 280, front: y >= 0 });
    }
  }
  const halos = [
    { radius: breathing - 0.035, alpha: 0.075 + slow * 0.14, width: 1.0, phase: 30 },
    { radius: 0.79 + fast * 0.075, alpha: 0.055 + fast * 0.14, width: 1.45, phase: 155 },
  ].map(halo => ({ ...halo, points: Array.from({ length: 161 }, (_, index) => {
    const angle = index / 160 * TAU;
    return { x: Math.cos(angle) * halo.radius, y: Math.sin(angle) * halo.radius, front: Math.sin(angle) >= 0 };
  }) }));
  const wave = Array.from({ length: 257 }, (_, index) => {
    const position = index / 256;
    const angle = Math.PI * (0.1 + position * 0.8);
    const taper = index === 0 || index === 256 ? 0 : Math.sin(position * Math.PI) ** 1.2;
    const radius = 0.88 + smoothSample(waveform, position) * (0.025 + fast * 0.055) * taper;
    return { x: -Math.cos(angle) * radius, y: Math.sin(angle) * radius, front: true };
  });
  return { spokes, halos, wave, waveAlpha: 0.10 + fast * 0.30 };
}

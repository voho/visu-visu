// One camera for the lit mesh, its surrounding audio field, and frozen capture
// centers. Absolute audio clocks keep playback, seeking, and history identical.
export function previewCamera(values, width, height) {
  const drift = values[136], cloud = values[138], body = values[140];
  return {
    x: 0.5 + Math.sin(drift * 0.29) * values[135] * 0.009 + Math.sin(body * 0.15) * 0.002,
    y: (width < height ? 0.596 : 0.630) + Math.cos(drift * 0.23) * values[135] * 0.008,
    roll: Math.sin(drift * 0.26) * 0.062 + Math.sin(cloud * 0.13) * values[137] * 0.022,
    // Reserve projection headroom for large bass-driven folds and camera roll.
    zoom: (0.966 + values[139] * 0.047 + values[145] * 0.018 + Math.sin(cloud * 0.19) * 0.012) * 0.90,
  };
}

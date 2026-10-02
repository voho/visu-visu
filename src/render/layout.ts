export interface SafeLayout {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  centerX: number;
  textLeft: number;
  textWidth: number;
  textCenterX: number;
  titleY: number;
  graphTop: number;
  horizon: number;
  graphBottom: number;
}

export function createSafeLayout(width: number, height: number): SafeLayout {
  const aspectRatio = width / height;
  const profile =
    aspectRatio <= 0.85
      ? {
          left: 0.12,
          right: 0.24,
          top: 0.16,
          bottom: 0.38,
          titleY: 0.18,
          graphTop: 0.3,
          horizon: 0.45,
          graphBottom: 0.6,
        }
      : aspectRatio < 1.2
        ? {
            left: 0.08,
            right: 0.2,
            top: 0.16,
            bottom: 0.38,
            titleY: 0.18,
            graphTop: 0.3,
            horizon: 0.45,
            graphBottom: 0.6,
          }
        : {
            left: 0.08,
            right: 0.08,
            top: 0.16,
            bottom: 0.2,
            titleY: 0.18,
            graphTop: 0.32,
            horizon: 0.51,
            graphBottom: 0.7,
          };

  const left = width * profile.left;
  const right = width * (1 - profile.right);
  const top = height * profile.top;
  const bottom = height * (1 - profile.bottom);
  const safeWidth = right - left;
  const safeHeight = bottom - top;

  return {
    left,
    right,
    top,
    bottom,
    width: safeWidth,
    height: safeHeight,
    centerX: left + safeWidth / 2,
    textLeft: left,
    textWidth: width - left * 2,
    textCenterX: width / 2,
    titleY: height * profile.titleY,
    graphTop: height * profile.graphTop,
    horizon: height * profile.horizon,
    graphBottom: height * profile.graphBottom,
  };
}

export interface SignalBand {
  /** Rest line of the floor oscilloscope. */
  scopeY: number;
  /** Bars grow upward from here. */
  barBaseline: number;
  /** Tallest bar, so bars never reach the oscilloscope. */
  barMax: number;
  /** Fit vertical bar and waveform movement into the available readout space. */
  geometryScale: number;
}

/**
 * The music readouts live in the band below the graph, which no hero layer
 * enters. Reserve the bottom 20% for player controls and the seek bar. The
 * landscape band compresses slightly to keep the sculpture large; portrait
 * and square readouts already sit above this boundary. Only full-bleed
 * atmosphere may continue behind the player's hover overlays.
 */
export function signalBand(layout: SafeLayout, height: number): SignalBand {
  const span = Math.max(0, Math.min(height * 0.14, height * 0.8 - layout.graphBottom));
  const geometryScale = span / (height * 0.14);
  return {
    scopeY: layout.graphBottom + height * 0.028 * geometryScale,
    barBaseline: layout.graphBottom + span,
    barMax: height * 0.082 * geometryScale,
    geometryScale,
  };
}

/**
 * The ellipse around the title/artist lockup, in fractions of the frame. The
 * cover is shaded inside it and the ember planes dim there, so the lockup
 * stays the brightest, cleanest thing in the frame at any camera pose.
 */
export function creditLockupEllipse(layout: SafeLayout, width: number, height: number): { x: number; y: number; rx: number; ry: number } {
  return {
    x: layout.textCenterX / width,
    y: (layout.titleY + 0.55 * (layout.graphTop - layout.titleY)) / height,
    rx: 0.30,
    ry: 0.11,
  };
}

export function safeGraphRadius(layout: SafeLayout): number {
  return Math.min(
    layout.centerX - layout.left,
    layout.right - layout.centerX,
    layout.horizon - layout.graphTop,
    layout.graphBottom - layout.horizon,
  );
}

/**
 * Elliptical graph radii with enough inset for the renderer's camera breathing.
 * Unlike safeGraphRadius(), this lets hero shapes use the available horizontal
 * space without approaching social-player overlays or the graph clip edge.
 */
export function safeGraphRadii(layout: SafeLayout): { x: number; y: number } {
  const verticalHalf = Math.min(
    layout.horizon - layout.graphTop,
    layout.graphBottom - layout.horizon,
  );
  const horizontalHalf = Math.min(
    layout.centerX - layout.left,
    layout.right - layout.centerX,
  );
  const y = verticalHalf * 0.82;
  return {
    x: Math.min(
      horizontalHalf * 0.88,
      verticalHalf * 4.15,
    ),
    y,
  };
}

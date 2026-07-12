export interface SafeLayout {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  centerX: number;
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
          graphTop: 0.38,
          horizon: 0.49,
          graphBottom: 0.6,
        }
      : aspectRatio < 1.2
        ? {
            left: 0.08,
            right: 0.2,
            top: 0.16,
            bottom: 0.38,
            titleY: 0.18,
            graphTop: 0.38,
            horizon: 0.49,
            graphBottom: 0.6,
          }
        : {
            left: 0.08,
            right: 0.08,
            top: 0.16,
            bottom: 0.2,
            titleY: 0.18,
            graphTop: 0.4,
            horizon: 0.56,
            graphBottom: 0.72,
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
    titleY: height * profile.titleY,
    graphTop: height * profile.graphTop,
    horizon: height * profile.horizon,
    graphBottom: height * profile.graphBottom,
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

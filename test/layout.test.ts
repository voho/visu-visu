import { describe, expect, test } from "bun:test";
import { createSafeLayout, safeGraphRadii, safeGraphRadius } from "../src/render/layout.js";

function expectOrdered(layout: ReturnType<typeof createSafeLayout>): void {
  expect(layout.left).toBeLessThan(layout.centerX);
  expect(layout.centerX).toBeLessThan(layout.right);
  expect(layout.top).toBeLessThan(layout.titleY);
  expect(layout.titleY).toBeLessThan(layout.graphTop);
  expect(layout.graphTop).toBeLessThan(layout.horizon);
  expect(layout.horizon).toBeLessThan(layout.graphBottom);
  expect(layout.graphBottom).toBeLessThan(layout.bottom);
  const radius = safeGraphRadius(layout);
  expect(layout.centerX - radius).toBeGreaterThanOrEqual(layout.left);
  expect(layout.centerX + radius).toBeLessThanOrEqual(layout.right);
  expect(layout.horizon - radius).toBeGreaterThanOrEqual(layout.graphTop);
  expect(layout.horizon + radius).toBeLessThanOrEqual(layout.graphBottom);
  const radii = safeGraphRadii(layout);
  expect(layout.centerX - radii.x * 1.05).toBeGreaterThanOrEqual(layout.left);
  expect(layout.centerX + radii.x * 1.05).toBeLessThanOrEqual(layout.right);
  expect(layout.horizon - radii.y * 1.05).toBeGreaterThanOrEqual(layout.graphTop);
  expect(layout.horizon + radii.y * 1.05).toBeLessThanOrEqual(layout.graphBottom);
}

describe("platform-safe render layout", () => {
  test("keeps landscape content away from hover titles and player controls", () => {
    const layout = createSafeLayout(1920, 1080);
    expectOrdered(layout);
    expect(layout.top).toBeGreaterThanOrEqual(1080 * 0.16);
    expect(layout.bottom).toBeLessThanOrEqual(1080 * 0.8);
    expect(layout.left).toBeGreaterThanOrEqual(1920 * 0.08);
    expect(layout.right).toBeLessThanOrEqual(1920 * 0.92);
    expect(layout.graphTop).toBe(1080 * 0.32);
    expect(layout.graphBottom).toBe(1080 * 0.78);
  });

  test("reserves portrait space for captions, controls, and the right action rail", () => {
    const layout = createSafeLayout(1080, 1920);
    expectOrdered(layout);
    expect(layout.top).toBeGreaterThanOrEqual(1920 * 0.16);
    expect(layout.bottom).toBeLessThanOrEqual(1920 * 0.62);
    expect(layout.left).toBeGreaterThanOrEqual(1080 * 0.12);
    expect(layout.right).toBeLessThanOrEqual(1080 * 0.76);
    expect(layout.centerX).toBeLessThan(1080 / 2);
    expect(layout.textCenterX).toBe(1080 / 2);
    expect(layout.textLeft * 2 + layout.textWidth).toBe(1080);
    expect(layout.graphTop).toBe(1920 * 0.3);
    expect(layout.graphBottom).toBe(1920 * 0.6);
  });

  test("uses conservative asymmetric clearance for square feeds", () => {
    const layout = createSafeLayout(1080, 1080);
    expectOrdered(layout);
    expect(layout.bottom).toBeLessThanOrEqual(1080 * 0.62);
    expect(layout.right).toBeLessThanOrEqual(1080 * 0.8);
  });
});

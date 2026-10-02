import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchMilkdropChrome, type MilkdropChrome } from "../src/milkdrop/chrome.js";
import { milkdropBrowserPath } from "../src/milkdrop/export.js";

describe("MilkDrop Full HD frame transport", () => {
  test("acknowledges 600 complete RGBA frames without instrumenting their network payloads", async () => {
    // Quarter-scale render tests cannot reproduce the former Chrome crash:
    // network inspection duplicated each 8 MB upload into large CDP events.
    const frameBytes = 1920 * 1080 * 4, totalFrames = 600;
    const prefix = `/${crypto.randomUUID()}`;
    let received = 0, receivedBytes = 0, active = 0, peakActive = 0;
    let transportError: Error | undefined, browser: MilkdropChrome | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0, maxRequestBodySize: frameBytes + 1024,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path === `${prefix}/index.html`) {
          return new Response("<!doctype html><script>window.transportReady = true</script>", {
            headers: { "Content-Type": "text/html" },
          });
        }
        if (request.method !== "POST" || !path.startsWith(`${prefix}/frame/`)) return new Response(null, { status: 404 });
        active++;
        peakActive = Math.max(peakActive, active);
        try {
          if (active !== 1 || path !== `${prefix}/frame/${received}` || received >= totalFrames) {
            throw new Error(`Unexpected or overlapping frame: ${path}`);
          }
          const bytes = new Uint8Array(await request.arrayBuffer());
          if (bytes.length !== frameBytes) throw new Error(`Incomplete frame ${received}: ${bytes.length} bytes`);
          if (bytes[0] !== (received & 255) || bytes[1] !== (received >>> 8) || bytes[frameBytes - 1] !== ((received * 17) & 255)) {
            throw new Error(`Stale or corrupted frame ${received}`);
          }
          // Check samples across the entire image, including different rows.
          for (let index = 2; index < frameBytes - 1; index += 32749) {
            if (bytes[index] !== ((index * 17 + (index >>> 8)) & 255)) throw new Error(`Corrupted frame ${received} at byte ${index}`);
          }
          // Keep the response pending briefly to exercise producer backpressure.
          await Bun.sleep(2);
          receivedBytes += bytes.length;
          const acknowledged = received++;
          return new Response(null, { status: 204, headers: { "X-Frame-Index": String(acknowledged) } });
        } catch (error) {
          transportError = error instanceof Error ? error : new Error(String(error));
          return new Response(transportError.message, { status: 500 });
        } finally { active--; }
      },
    });
    try {
      browser = await launchMilkdropChrome(milkdropBrowserPath(), `http://127.0.0.1:${server.port}${prefix}/index.html`);
      expect(await browser.evaluate("window.transportReady")).toBe(true);
      const upload = browser.evaluate(`(async () => {
        const pixels = new Uint8Array(${frameBytes});
        for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 17 + (index >>> 8)) & 255;
        for (let frame = 0; frame < ${totalFrames}; frame++) {
          pixels[0] = frame & 255;
          pixels[1] = frame >>> 8;
          pixels[pixels.length - 1] = (frame * 17) & 255;
          const response = await fetch(${JSON.stringify(`${prefix}/frame/`)} + frame, {
            method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: pixels,
          });
          if (response.status !== 204 || response.headers.get("X-Frame-Index") !== String(frame)) {
            throw new Error("Frame " + frame + " was not acknowledged: " + await response.text());
          }
        }
        return ${totalFrames};
      })()`);
      const completed = await Promise.race([upload, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Full HD frame transport timed out")), 85_000);
      })]);
      clearTimeout(timeout);
      expect(completed).toBe(totalFrames);
      expect(transportError).toBeUndefined();
      expect(received).toBe(totalFrames);
      expect(receivedBytes).toBe(frameBytes * totalFrames);
      expect(peakActive).toBe(1);
      expect(active).toBe(0);
      await expect(browser.evaluate("Promise.reject(new Error('expected asynchronous browser error'))"))
        .rejects.toThrow("expected asynchronous browser error");
      const pending = browser.evaluate("new Promise(() => {})").catch((error: unknown) => error);
      await browser.close();
      expect(await pending).toBeInstanceOf(Error);
      await browser.close();
    } finally {
      clearTimeout(timeout);
      try { await browser?.close(); } finally { server.stop(true); }
    }
  }, 120_000);

  test("rejects browser startup and navigation failures", async () => {
    let browser: MilkdropChrome | undefined;
    try {
      await expect((async () => {
        browser = await launchMilkdropChrome(join(tmpdir(), `missing-milkdrop-chrome-${crypto.randomUUID()}`), "about:blank");
      })()).rejects.toThrow();
      await expect((async () => {
        browser = await launchMilkdropChrome(milkdropBrowserPath(), "http://127.0.0.1:1/");
      })()).rejects.toThrow("MilkDrop page could not load");
    } finally { await browser?.close(); }
  }, 45_000);
});

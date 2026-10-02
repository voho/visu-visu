import { describe, expect, test } from "bun:test";
import { heapStats } from "bun:jsc";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { FfmpegEncoder } from "../src/render/encoder.js";

/** A controllable pipe exercises real Writable backpressure without encoding. */
class EncoderProcess extends EventEmitter {
  readonly stdin: Writable;
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  writes = 0;
  private release: (() => void) | undefined;

  constructor(automaticDrain = false) {
    super();
    this.stdin = new Writable({
      highWaterMark: 1,
      write: (_chunk, _encoding, callback) => {
        this.writes++;
        if (automaticDrain) setImmediate(callback);
        else this.release = callback;
      },
    });
  }

  drain(): void { const release = this.release; this.release = undefined; release?.(); }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
    this.stdin.destroy();
    this.stderr.end();
  }
  kill(signal: NodeJS.Signals): boolean { setImmediate(() => this.exit(null, signal)); return true; }
}

function encoderFor(child: EncoderProcess): FfmpegEncoder {
  // The factory's file/FFmpeg setup is covered by the integration tests.
  return Reflect.construct(FfmpegEncoder, [child]) as FfmpegEncoder;
}

function expectNoWriteListeners(child: EncoderProcess): void {
  expect(child.stdin.listenerCount("drain")).toBe(0);
  expect(child.stdin.listenerCount("close")).toBe(0);
  expect(child.stdin.listenerCount("error")).toBe(1); // Permanent error recorder.
  expect(child.listenerCount("close")).toBe(child.exitCode === null && child.signalCode === null ? 1 : 0);
}

async function livePromises(): Promise<number> {
  await new Promise<void>(resolve => setImmediate(resolve));
  Bun.gc(true);
  return heapStats().objectTypeCounts.Promise ?? 0;
}

describe("encoder backpressure", () => {
  test("waits for each blocked write and releases its listeners after draining", async () => {
    const child = new EncoderProcess();
    const encoder = encoderFor(child);
    let completed = false;
    const write = encoder.write(Buffer.alloc(32)).then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    child.drain();
    await write;
    expect(completed).toBe(true);
    expectNoWriteListeners(child);
    child.exit(0);
  });

  test("thousands of writes do not retain a growing queue of pending promises", async () => {
    const child = new EncoderProcess(true);
    const encoder = encoderFor(child);
    const frame = Buffer.alloc(64);
    for (let index = 0; index < 100; index++) await encoder.write(frame);
    const before = await livePromises();
    for (let index = 0; index < 2000; index++) await encoder.write(frame);
    const after = await livePromises();
    expect(child.writes).toBe(2100);
    expectNoWriteListeners(child);
    // Allow runner/GC bookkeeping, but not even one retained promise per frame.
    expect(after - before).toBeLessThan(200);
    child.exit(0);
  });

  test("rejects a blocked write when FFmpeg exits and removes its listeners", async () => {
    const child = new EncoderProcess();
    const encoder = encoderFor(child);
    const write = encoder.write(Buffer.alloc(32));
    child.stderr.write("encoder failed");
    child.exit(1);
    await expect(write).rejects.toThrow("encoder failed");
    expectNoWriteListeners(child);
  });

  test("removes blocked-write listeners after a pipe error", async () => {
    const child = new EncoderProcess();
    const encoder = encoderFor(child);
    const write = encoder.write(Buffer.alloc(32));
    child.stdin.destroy(new Error("broken encoder pipe"));
    setImmediate(() => child.exit(1));
    await expect(write).rejects.toThrow("broken encoder pipe");
    expectNoWriteListeners(child);
  });

  test("abort releases a blocked write and prevents subsequent writes", async () => {
    const child = new EncoderProcess();
    const encoder = encoderFor(child);
    const write = encoder.write(Buffer.alloc(32));
    encoder.abort();
    await expect(write).rejects.toThrow("FFmpeg rejected frame input");
    expectNoWriteListeners(child);
    await expect(encoder.write(Buffer.alloc(32))).rejects.toThrow("finished encoder");
  });
});

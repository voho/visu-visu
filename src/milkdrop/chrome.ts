import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MilkdropChrome {
  evaluate(expression: string): Promise<unknown>;
  close(): Promise<void>;
}

interface ProtocolMessage {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: { name?: string; loaderId?: string; sessionId?: string; reason?: string };
  result?: Record<string, unknown>;
  error?: { message: string };
}

/** Own a temporary browser without enabling Network's raw-frame inspection. */
export async function launchMilkdropChrome(executablePath: string, url: string): Promise<MilkdropChrome> {
  const profile = await mkdtemp(join(tmpdir(), "visu-milkdrop-"));
  const endpoint = Promise.withResolvers<string>();
  const exited = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  const loaded = new Set<string>();
  let socket: WebSocket | undefined, stderr = "", sessionId = "", nextId = 0;
  let failure: Error | undefined, hasExited = false, wantedLoader: string | undefined;
  let closing: Promise<void> | undefined;
  // Register rejection handlers before startup events can reject these promises.
  void endpoint.promise.catch(() => {});
  void ready.promise.catch(() => {});
  const child = spawn(executablePath, [
    "--headless=new", "--force-color-profile=srgb", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, "--no-startup-window", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-default-apps", "--disable-extensions", "--disable-sync",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", "--mute-audio",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  function fail(error: Error): void {
    failure ??= error;
    endpoint.reject(error);
    ready.reject(error);
    for (const command of pending.values()) command.reject(error);
    pending.clear();
  }
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192);
    const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match?.[1]) endpoint.resolve(match[1]);
  });
  child.once("error", error => { hasExited = true; exited.resolve(); fail(error); });
  child.once("exit", (code, signal) => {
    hasExited = true;
    exited.resolve();
    fail(new Error(`MilkDrop Chrome exited (${signal ?? code}): ${stderr.trim()}`));
  });
  function command(method: string, params: Record<string, unknown> = {}, target?: string): Promise<Record<string, unknown>> {
    if (failure) return Promise.reject(failure);
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("MilkDrop Chrome connection is closed"));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { socket!.send(JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) })); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  async function waitForExit(milliseconds: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exited.promise, new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
    finally { clearTimeout(timer); }
  }
  function close(): Promise<void> {
    return closing ??= (async () => {
      try {
        if (!hasExited) {
          void command("Browser.close").catch(() => {});
          await waitForExit(1500);
          if (!hasExited) { child.kill("SIGTERM"); await waitForExit(1500); }
          if (!hasExited) { child.kill("SIGKILL"); await waitForExit(3000); }
        }
      } finally {
        fail(new Error("MilkDrop Chrome connection is closed"));
        socket?.close();
        await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    })();
  }
  const deadline = setTimeout(() => fail(new Error("MilkDrop Chrome startup timed out after 30 seconds")), 30_000);
  try {
    socket = new WebSocket(await endpoint.promise);
    const connected = Promise.withResolvers<void>();
    socket.onopen = () => connected.resolve();
    socket.onerror = () => { const error = new Error("MilkDrop Chrome protocol connection failed"); connected.reject(error); fail(error); };
    socket.onclose = () => { const error = new Error("MilkDrop Chrome protocol connection closed"); connected.reject(error); fail(error); };
    socket.onmessage = event => {
      let message: ProtocolMessage;
      try { message = JSON.parse(String(event.data)) as ProtocolMessage; }
      catch { fail(new Error("MilkDrop Chrome returned malformed protocol data")); return; }
      if (message.id !== undefined) {
        const response = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) response?.reject(new Error(`MilkDrop Chrome: ${message.error.message}`));
        else response?.resolve(message.result ?? {});
      } else if (sessionId && ((message.method === "Target.detachedFromTarget" && message.params?.sessionId === sessionId)
        || (message.sessionId === sessionId && (message.method === "Inspector.targetCrashed" || message.method === "Inspector.detached")))) {
        fail(new Error(`MilkDrop render page closed or crashed${message.params?.reason ? `: ${message.params.reason}` : ""}`));
      } else if (message.sessionId === sessionId && message.method === "Page.lifecycleEvent" && message.params?.name === "load") {
        const loader = message.params.loaderId;
        if (loader) { loaded.add(loader); if (loader === wantedLoader) ready.resolve(); }
      }
    };
    await Promise.race([connected.promise, ready.promise]);
    const target = await command("Target.createTarget", { url: "about:blank" });
    const attached = await command("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    sessionId = String(attached.sessionId);
    await command("Inspector.enable", {}, sessionId);
    await command("Page.enable", {}, sessionId);
    await command("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
    const navigation = await command("Page.navigate", { url }, sessionId);
    if (navigation.errorText) throw new Error(`MilkDrop page could not load: ${String(navigation.errorText)}`);
    wantedLoader = typeof navigation.loaderId === "string" ? navigation.loaderId : undefined;
    if (!wantedLoader || loaded.has(wantedLoader)) ready.resolve();
    await ready.promise;
    return {
      async evaluate(expression) {
        const response = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
        const exception = response.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
        if (exception) throw new Error(exception.exception?.description ?? exception.text ?? "MilkDrop browser evaluation failed");
        return (response.result as { value?: unknown } | undefined)?.value;
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  } finally { clearTimeout(deadline); }
}

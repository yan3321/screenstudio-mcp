import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { captureWindow, exec } from "./media.js";
import { statePath } from "./util.js";
export const HELPER_PATH = fileURLToPath(new URL("../../native/desktop-helper", import.meta.url));
const helper = HELPER_PATH;
const point = { x: z.number().finite().min(0), y: z.number().finite().min(0) };
/**
 * Shortcuts macOS handles itself, before the target app sees them: Spotlight,
 * the app switcher, Force Quit, lock screen, quitting the app. The focus check
 * cannot stop these, so they are refused outright.
 */
export function systemShortcut(key: string, modifiers: string[] = []) {
  const m = new Set(modifiers);
  if (!m.has("command")) return null;
  if (
    key === "space" ||
    key === "tab" ||
    key === "q" ||
    key === "w" ||
    key === "h" ||
    key === "m" ||
    key === "`" ||
    key === "escape"
  )
    return `command+${[...m]
      .filter((x) => x !== "command")
      .concat(key)
      .join("+")} is a system shortcut (Spotlight, app switcher, quit or force quit), so it is not sent.`;
  if (m.has("control") && key === "q") return "control+command+q locks the screen, so it is not sent.";
  return null;
}

export const desktopAction = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(["click", "doubleClick"]),
      ...point,
      durationMs: z.number().finite().min(0).max(15000).optional(),
      settleMs: z.number().finite().min(0).max(5000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("move"),
      ...point,
      durationMs: z.number().finite().min(0).max(15000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("drag"),
      ...point,
      toX: z.number().finite().min(0),
      toY: z.number().finite().min(0),
    })
    .strict(),
  z
    .object({
      type: z.literal("taps"),
      ...point,
      count: z.number().int().min(1).max(80),
      intervalMs: z.number().int().min(30).max(2000).default(110),
    })
    .strict(),
  z.object({ type: z.literal("hold"), ...point, ms: z.number().int().min(50).max(15000) }).strict(),
  z
    .object({
      type: z.literal("type"),
      text: z.string().max(2000),
      perCharMs: z.number().finite().min(0).max(2000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      lines: z.number().int().min(-100).max(100),
      x: point.x.optional(),
      y: point.y.optional(),
    })
    .strict()
    .refine((s) => (s.x === undefined) === (s.y === undefined), {
      message: "Give scroll both x and y, or neither.",
    }),
  z.object({ type: z.literal("focus") }).strict(),
  z
    .object({
      type: z.literal("key"),
      key: z
        .string()
        .regex(
          /^([a-z0-9=\-\[\];',./`\\]|return|tab|space|backspace|escape|delete|home|end|pageup|pagedown|left|right|up|down|selectAll)$/,
        ),
      modifiers: z
        .array(z.enum(["command", "shift", "option", "control"]))
        .max(4)
        .optional(),
    })
    .strict()
    .refine((k) => !systemShortcut(k.key, k.modifiers), {
      message:
        "System shortcuts (command+space, command+tab, command+q, command+option+escape, control+command+q) are not sent.",
    }),
]);
export type DesktopAction = z.infer<typeof desktopAction>;
export const desktopSessionAction = z.union([
  desktopAction,
  z.object({ type: z.enum(["down", "up"]), ...point }).strict(),
]);
export type DesktopSessionAction = z.infer<typeof desktopSessionAction>;

// How long the result of each kind of step stays on screen before the next one.
export const HOLD: Record<DesktopAction["type"], number> = {
  click: 1200,
  doubleClick: 1200,
  taps: 700,
  hold: 900,
  drag: 1200,
  type: 900,
  key: 1000,
  scroll: 1200,
  move: 400,
  focus: 600,
};

/** Observation tokens are single use and expire quickly, so input never lands on a stale layout. */
export const TOKEN_TTL_MS = 60000;

const HELPER_TIMEOUT_MS = 80000;

/**
 * How long the helper may take for one action. Typing costs up to about
 * 25ms + 190ms x pace per character plus a focus check, so its limit grows
 * with the text instead of cutting a long take off halfway.
 */
export function helperTimeoutMs(input: DesktopSessionAction, pace = 1): number {
  if (input.type === "taps") return Math.max(HELPER_TIMEOUT_MS, input.count * input.intervalMs + 10000);
  if (input.type === "hold") return Math.max(HELPER_TIMEOUT_MS, input.ms + 10000);
  if (input.type !== "type") return HELPER_TIMEOUT_MS;
  const perChar = input.perCharMs !== undefined ? Math.max(40, input.perCharMs + 40) : 40 + 200 * pace;
  return Math.max(HELPER_TIMEOUT_MS, Math.ceil(input.text.length * perChar) + 10000);
}

/** Command-line arguments the native helper takes for one action. */
export function helperArgs(input: DesktopSessionAction): string[] {
  switch (input.type) {
    case "click":
    case "doubleClick":
      return [
        String(input.x),
        String(input.y),
        ...(input.settleMs !== undefined
          ? [String(input.settleMs)]
          : input.durationMs !== undefined
            ? ["-1"]
            : []),
        ...(input.durationMs !== undefined ? [String(input.durationMs)] : []),
      ];
    case "move":
      return [
        String(input.x),
        String(input.y),
        ...(input.durationMs !== undefined ? [String(input.durationMs)] : []),
      ];
    case "down":
    case "up":
      return [String(input.x), String(input.y)];
    case "drag":
      return [input.x, input.y, input.toX, input.toY].map(String);
    case "taps":
      return [input.x, input.y, input.count, input.intervalMs].map(String);
    case "hold":
      return [input.x, input.y, input.ms].map(String);
    case "type":
      return [input.text, ...(input.perCharMs !== undefined ? [String(input.perCharMs)] : [])];
    case "scroll":
      return [input.lines, ...(input.x !== undefined && input.y !== undefined ? [input.x, input.y] : [])].map(
        String,
      );
    case "key":
      return [input.key, ...(input.modifiers?.length ? [input.modifiers.join(",")] : [])];
    case "focus":
      return [];
  }
}

/**
 * The last step's hold: its planned hold, or longer when the beat so far plus
 * that hold would end before `minDurationMs`.
 */
export function lastHoldMs(plannedMs: number, elapsedMs: number, minDurationMs: number) {
  return Math.max(plannedMs, Math.ceil(minDurationMs - elapsedMs));
}

/** Native injection times on the helper's clock; no UI paint guarantee. */
export interface DesktopKeyTiming {
  clock: string;
  onsetsMs: number[];
  /** Null when no key-up was posted (including empty text). */
  endAtMs: number | null;
}

export interface DesktopPerformTiming extends Partial<DesktopKeyTiming> {
  completedSteps: ({ type: string; holdMs: number } & Partial<DesktopKeyTiming>)[];
  failedStepIndex: number;
}

/** A failed action may still have injected part of the requested text. */
export class DesktopInputError extends Error {
  constructor(
    message: string,
    readonly timing: DesktopKeyTiming | DesktopPerformTiming,
  ) {
    super(message);
    this.name = "DesktopInputError";
  }
}

export class DesktopSession {
  private proc: ReturnType<typeof spawn>;
  private nextId = 1;
  private buffer = "";
  private closed = false;
  private stopped: Promise<void>;
  private stopError?: Error;
  private expectedTarget?: { pid: number; bounds: Record<string, number> };
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  private constructor(
    proc: ReturnType<typeof spawn>,
    private readonly windowId: number,
    private readonly defaultPace: number,
  ) {
    this.proc = proc;
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.resume();
    this.stopped = new Promise((resolve) => proc.once("close", () => resolve()));
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      this.buffer += chunk.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (this.closed) continue;
        const entry = this.pending.get(msg.id);
        if (!entry) continue;
        if (!msg.ok) {
          const message = msg.error || "Desktop helper action failed";
          void this.stop(
            msg.result?.onsetsMs ? new DesktopInputError(message, msg.result) : new Error(message),
          );
          continue;
        }
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg.result);
      }
    });
    const failAll = (err: Error) => {
      this.closed = true;
      for (const [id, entry] of this.pending) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(err);
      }
    };
    proc.stdin?.on("error", (err) => {
      void this.stop(err);
    });
    proc.on("error", (err) => failAll(err));
    proc.on("exit", (code, signal) => {
      failAll(this.stopError ?? new Error(`Desktop session exited (${signal ?? code ?? "unknown"})`));
    });
  }

  static async open(windowId: number, pace = 1, helperPath = helper): Promise<DesktopSession> {
    if (process.platform !== "darwin") throw new Error("Desktop input requires macOS.");
    await access(helperPath).catch(() => {
      throw new Error("Build the native desktop helper with npm run build:native.");
    });
    const proc = spawn(helperPath, ["--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SCREENSTUDIO_PACE: String(pace) },
    });
    return new DesktopSession(proc, windowId, pace);
  }

  private request(payload: Record<string, unknown>, timeoutMs = HELPER_TIMEOUT_MS): Promise<any> {
    if (this.closed || !this.proc.stdin?.writable) {
      return Promise.reject(new Error("Desktop session is closed."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.stop(new Error(`Desktop session timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin!.write(`${JSON.stringify({ ...payload, id })}\n`);
    });
  }

  async bounds() {
    const state = await this.request({
      action: "bounds",
      windowId: this.windowId,
      ...(this.expectedTarget ? { expect: this.expectedTarget } : {}),
    });
    this.expectedTarget ??= { pid: state.pid, bounds: state.bounds };
    return state;
  }
  hideApp(bundleId = "com.timpler.screenstudio") {
    return this.request({ action: "hide-app", bundleId });
  }
  inspect() {
    return this.request({ action: "inspect", windowId: this.windowId });
  }
  async focus() {
    if (!this.expectedTarget) await this.bounds();
    return this.request({ action: "focus", windowId: this.windowId, expect: this.expectedTarget });
  }
  async send(input: DesktopSessionAction, pace = this.defaultPace) {
    const parsed = desktopSessionAction.parse(input);
    if (!this.expectedTarget) await this.bounds();
    const { type, ...rest } = parsed;
    return this.request(
      { action: type, windowId: this.windowId, expect: this.expectedTarget, pace, ...rest },
      helperTimeoutMs(parsed, pace),
    );
  }
  private async stop(error: Error) {
    if (!this.closed) {
      this.closed = true;
      this.stopError = error;
      this.proc.kill("SIGTERM");
    }
    const force = setTimeout(() => this.proc.kill("SIGKILL"), 2000);
    try {
      await this.stopped;
    } finally {
      clearTimeout(force);
    }
  }
  async close() {
    if (this.closed) {
      await this.stopped;
      return;
    }
    this.closed = true;
    this.proc.stdin?.end();
    const terminate = setTimeout(() => this.proc.kill("SIGTERM"), 1000);
    const force = setTimeout(() => this.proc.kill("SIGKILL"), 3000);
    try {
      await this.stopped;
    } finally {
      clearTimeout(terminate);
      clearTimeout(force);
    }
  }
}

export class Desktop {
  constructor(private readonly helperPath = helper) {}

  private observations = new Map<string, { windowId: number; bounds: string; pid: number; at: number }>();
  private async run(
    action: string,
    target?: number | string,
    args: string[] = [],
    pace = 1,
    timeout = HELPER_TIMEOUT_MS,
    signal?: AbortSignal,
  ) {
    if (process.platform !== "darwin") throw new Error("Desktop input requires macOS.");
    await access(this.helperPath).catch(() => {
      throw new Error("Build the native desktop helper with npm run build:native.");
    });
    const argv = target === undefined ? [action, ...args] : [action, String(target), ...args];
    try {
      const { stdout } = await exec(this.helperPath, argv, {
        timeout,
        signal,
        env: { ...process.env, SCREENSTUDIO_PACE: String(pace) },
      });
      return JSON.parse(stdout);
    } catch (error: any) {
      if (signal?.aborted)
        throw new Error(`The ${action} step was cancelled; the helper let go of any held key or button.`);
      if (error?.killed)
        throw new Error(
          `The ${action} step did not finish within ${Math.round(timeout / 1000)}s and was stopped; it may have left partial input (for typing, some text in the field).`,
        );
      const reason = typeof error?.stderr === "string" ? error.stderr.trim() : "";
      if (reason) {
        if ((action === "type" || action === "key") && error?.stdout) {
          let timing: DesktopKeyTiming | undefined;
          try {
            timing = JSON.parse(error.stdout);
          } catch {
            // Older helpers report only stderr on failure.
          }
          if (timing?.onsetsMs) throw new DesktopInputError(reason, timing);
        }
        throw new Error(reason);
      }
      throw error;
    }
  }
  async findWindowByTitle(title: string): Promise<number> {
    return (await this.run("find-title", title)).windowId;
  }
  hideApp(bundleId = "com.timpler.screenstudio") {
    return this.run("hide-app", bundleId);
  }
  settleHiddenApp(bundleId = "com.timpler.screenstudio") {
    return this.run("settle-hidden-app", bundleId);
  }
  bounds(windowId: number) {
    return this.run("bounds", windowId);
  }
  startSession(windowId: number, pace = 1) {
    return DesktopSession.open(windowId, pace, this.helperPath);
  }
  async inspect(windowId: number) {
    const state = await this.run("inspect", windowId);
    const token = randomUUID();
    this.observations.set(token, {
      windowId,
      bounds: JSON.stringify(state.bounds),
      pid: state.pid,
      at: Date.now(),
    });
    for (const [k, v] of this.observations) if (Date.now() - v.at > TOKEN_TTL_MS) this.observations.delete(k);
    return { ...state, observationToken: token, expiresInMs: TOKEN_TTL_MS };
  }
  private async consume(token: string) {
    const observation = this.observations.get(token);
    this.observations.delete(token);
    if (!observation || Date.now() - observation.at > TOKEN_TTL_MS)
      throw new Error("Observation expired. Inspect the target again.");
    const current = await this.run("inspect", observation.windowId);
    if (current.pid !== observation.pid || JSON.stringify(current.bounds) !== observation.bounds)
      throw new Error("Target window changed. Inspect again before input.");
    return observation;
  }
  private step(windowId: number, input: DesktopAction, pace: number, signal?: AbortSignal) {
    return this.run(input.type, windowId, helperArgs(input), pace, helperTimeoutMs(input, pace), signal);
  }
  async action(token: string, input: DesktopAction, pace = 1, signal?: AbortSignal) {
    const observation = await this.consume(token);
    return this.step(observation.windowId, desktopAction.parse(input), pace, signal);
  }
  /**
   * Performs a beat in one take: each step, then a hold so its result is
   * visible. Recording one continuous take avoids dead air between tool calls.
   * `onBeatStart` runs once before the first step (it adds a recording marker),
   * and `minDurationMs` stretches the last hold so the beat lasts at least that
   * long from its first step, e.g. as long as its narration line.
   */
  async perform(
    token: string,
    steps: { action: DesktopAction; holdMs?: number }[],
    pace = 1,
    options: { onBeatStart?: () => Promise<unknown>; minDurationMs?: number; signal?: AbortSignal } = {},
  ) {
    const actions = steps.map((s) => desktopAction.parse(s.action));
    // A focus step mid-beat would take the window back from a person who clicked away to stop it.
    if (actions.slice(1).some((a) => a.type === "focus"))
      throw new Error("focus may only be the first step of a beat.");
    const observation = await this.consume(token);
    const notes: string[] = [];
    if (options.onBeatStart) {
      try {
        await options.onBeatStart();
      } catch (error) {
        throw new Error(
          `Could not add the beat's recording marker, so no input was sent: ${error instanceof Error ? error.message : error}. Start recording first, or perform without markers.`,
        );
      }
      notes.push(
        "Added a recording marker where this beat starts; screenstudio_analyze returns it in source ms.",
      );
    }
    const started = Date.now();
    const done: DesktopPerformTiming["completedSteps"] = [];
    for (const [i, action] of actions.entries()) {
      if (options.signal?.aborted)
        throw new Error(`Cancelled after ${done.length} of ${actions.length} steps.`);
      let result;
      try {
        result = await this.step(observation.windowId, action, pace, options.signal);
      } catch (error) {
        const message = `Step ${i + 1} (${action.type}) failed after ${done.length} completed: ${error instanceof Error ? error.message : error}${options.onBeatStart ? '. A recording marker was already added at this beat\'s start; when you redo the beat it gets a second marker, so pin narration with skipMarkers (or rely on pinToMarkers skipping a marker with no input after it) and plan with markers: "retake" if the take was spoken' : ""}`;
        throw new DesktopInputError(message, {
          ...(error instanceof DesktopInputError ? error.timing : {}),
          completedSteps: done,
          failedStepIndex: i,
        });
      }
      let holdMs = Math.round((steps[i].holdMs ?? HOLD[action.type]) * pace);
      if (i === actions.length - 1 && options.minDurationMs) {
        const held = lastHoldMs(holdMs, Date.now() - started, options.minDurationMs);
        if (held > holdMs)
          notes.push(
            `Held the last step ${held - holdMs}ms longer so the beat lasts ${options.minDurationMs}ms, as long as its line.`,
          );
        holdMs = held;
      }
      done.push({
        type: action.type,
        holdMs,
        ...(result?.onsetsMs
          ? { clock: result.clock, onsetsMs: result.onsetsMs, endAtMs: result.endAtMs }
          : {}),
      });
      await new Promise<void>((r) => {
        const t = setTimeout(r, holdMs);
        options.signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
      });
    }
    return {
      performed: done.length,
      steps: done,
      durationMs: Date.now() - started,
      ...(notes.length ? { notes } : {}),
    };
  }
  async screenshot(windowId: number, stateDir: string, width = 1280) {
    await this.run("inspect", windowId);
    const path = await statePath(stateDir, `window-${windowId}-${randomUUID()}.png`);
    await captureWindow(windowId, path);
    // Retina shots of a large window run to megabytes; scale down when wider than asked.
    const { stdout } = await exec("/usr/bin/sips", ["-g", "pixelWidth", path]).catch(() => ({ stdout: "" }));
    if (Number(/pixelWidth: (\d+)/.exec(stdout)?.[1]) > width)
      await exec("/usr/bin/sips", ["--resampleWidth", String(width), path], { timeout: 15000 }).catch(
        () => {},
      );
    return { path, data: await readFile(path) };
  }
}

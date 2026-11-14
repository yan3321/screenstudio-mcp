import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CommandNotSentError, withSession } from "../cdp/client.js";
import {
  APP_BUILD,
  INPUTS_CHUNK,
  INPUTS_EXPORT,
  NATIVE_CLIENT_CHUNK,
  NATIVE_CLIENT_EXPORT,
  PROJECT_SCHEMA,
} from "./compat.js";
import { exec, findTool, frameAt, probe } from "./media.js";
import { assertProjectBundle, findAssetReferences, projectEditFingerprint } from "./project.js";
import { assertUuid, statePath } from "./util.js";
import {
  access,
  copyFile,
  cp,
  link,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { connect, createServer } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
const j = JSON.stringify;

const DEFAULT_PORT = 9222;

/** SCREENSTUDIO_PORT, validated; null when unset or blank. */
export function configuredPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const fixed = env.SCREENSTUDIO_PORT?.trim();
  if (!fixed) return null;
  const port = Number(fixed);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("SCREENSTUDIO_PORT must be an integer from 1024 to 65535.");
  return port;
}

function findMainLine(ps: string, appPath: string): string | undefined {
  const lines = ps.split("\n");
  // The configured copy first; otherwise any Screen Studio.app, wherever macOS put it.
  return (
    lines.find((l) => l.startsWith(`${appPath}/Contents/MacOS/Screen Studio`)) ??
    lines.find((l) => /^\/.*\/Screen Studio\.app\/Contents\/MacOS\/Screen Studio( |$)/.test(l))
  );
}

/** The app's main process in `ps -o command=` output, with the debugging port it was started with. */
export function mainProcess(ps: string, appPath: string): { port: number | null } | null {
  const line = findMainLine(ps, appPath);
  if (line === undefined) return null;
  const port = Number(/--remote-debugging-port=(\d+)/.exec(line)?.[1]);
  return { port: port >= 1024 && port <= 65535 ? port : null };
}

/** The `.app` bundle path of the running Screen Studio main process, if found in `ps`. */
export function runningBundlePath(ps: string, appPath: string): string | null {
  const line = findMainLine(ps, appPath);
  if (line === undefined) return null;
  const match = /^(\/.*\/Screen Studio\.app)\/Contents\/MacOS\/Screen Studio(?: |$)/.exec(line);
  return match?.[1] ?? (line.startsWith(`${appPath}/Contents/MacOS/Screen Studio`) ? appPath : null);
}

export async function canonicalPath(target: string): Promise<string> {
  let cur = resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const base = await realpath(cur);
      return tail.length ? join(base, ...tail.reverse()) : base;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(cur, ...tail.reverse());
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/** Why launch cannot help with an app that is already running. */
export function runningAppError(
  running: { port: number | null },
  fixed: number | null,
  cause: unknown,
): string {
  const reason = cause instanceof Error ? cause.message : String(cause);
  if (running.port === null)
    return "Screen Studio is running without an automation connection. Ask the owner to quit it (Cmd+Q), then call screenstudio_launch again. Open projects reopen from the Projects folder.";
  if (fixed !== null && fixed !== running.port)
    return `Screen Studio is running with automation on port ${running.port}, but SCREENSTUDIO_PORT is ${fixed}. Set SCREENSTUDIO_PORT to ${running.port} or unset it.`;
  if (fixed === null && reason.includes("editor renderer was not found"))
    return `Port ${running.port} answers, but not as Screen Studio; another app may hold it. Ask the owner to quit Screen Studio (Cmd+Q), then call screenstudio_launch again; it picks a free port.`;
  return `Screen Studio is running with automation on port ${running.port} but did not respond (${reason}). It may be busy exporting, recording or loading; wait and call screenstudio_launch again.`;
}

/**
 * The environment for the spawned app. ELECTRON_RUN_AS_NODE would start it as plain Node,
 * and the app honours NODE_OPTIONS, so neither may leak in from the host running this server.
 */
export function appEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  delete out.NODE_OPTIONS;
  return out;
}

function listenOn(port: number): Promise<number | null> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(null));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      const bound = (server.address() as { port: number }).port;
      server.close(() => done(bound));
    });
  });
}

/** True when something on this machine already serves the port. */
export async function portTaken(port: number): Promise<boolean> {
  // Binding 127.0.0.1 can succeed beside a wildcard listener, so ask whether anyone answers first.
  const answers = await new Promise<boolean>((done) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.setTimeout(1000, () => {
      socket.destroy();
      done(false);
    });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
  return answers || (await listenOn(port)) === null;
}

/** The port to launch the app with: SCREENSTUDIO_PORT if free, else 9222, else any free port. */
export async function launchPort(fixed: number | null): Promise<number> {
  if (fixed !== null) {
    if (await portTaken(fixed))
      throw new Error(`Port ${fixed} is in use by another process; set SCREENSTUDIO_PORT to a free port.`);
    return fixed;
  }
  if (!(await portTaken(DEFAULT_PORT))) return DEFAULT_PORT;
  const free = await listenOn(0);
  if (free === null) throw new Error("No free local port for the automation connection.");
  return free;
}

/** Where a cross-volume delivery is copied before it is linked into place. */
export const partialPath = (outputPath: string, jobId: string) => `${outputPath}.partial-${jobId}`;

async function sameFile(a: string, b: string) {
  try {
    const [x, y] = await Promise.all([stat(a), stat(b)]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/**
 * Puts a rendered file at `out` without ever replacing an existing file. A hard link moves it
 * at no cost; across volumes it is copied beside `out` first, so a partial copy never sits at
 * `out`. The caller removes partialPath() once delivery is recorded; until then a retry after
 * a crash recognises its own earlier link instead of failing on EEXIST.
 */
export async function deliverFile(src: string, out: string, jobId: string) {
  if (await sameFile(src, out)) return;
  try {
    return await link(src, out);
  } catch (e: any) {
    if (!["EXDEV", "EPERM", "ENOTSUP", "EMLINK"].includes(e.code)) throw e;
  }
  const tmp = partialPath(out, jobId);
  if (await sameFile(tmp, out)) return;
  await rm(tmp, { force: true });
  await copyFile(src, tmp, constants.COPYFILE_EXCL);
  await link(tmp, out);
}

/** Refuses an export destination that cannot be written, before any rendering starts. */
export async function assertOutputWritable(outputPath: string) {
  try {
    await stat(outputPath);
    throw new Error("Output already exists; choose a new destination.");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const dir = dirname(outputPath);
  if (!(await stat(dir).catch(() => null))?.isDirectory())
    throw new Error(`Output folder ${dir} does not exist.`);
  await access(dir, constants.W_OK).catch(() => {
    throw new Error(`Output folder ${dir} is not writable.`);
  });
}

/**
 * The seek time for a preview frame. An accurate seek drops frames that start before the
 * requested time, so anything after the last frame's start yields no image; times in the
 * final frame interval go back far enough to land on the last frame.
 */
export function previewSeconds(timeMs: number, video: { endSec: number; frameSec: number }) {
  if (!(timeMs >= 0) || timeMs > video.endSec * 1000)
    throw new Error("Preview time is outside the exported playback duration.");
  return Math.min(timeMs / 1000, Math.max(0, video.endSec - video.frameSec * 1.5));
}

const rate = (r?: string) => {
  const [n, d] = String(r ?? "")
    .split("/")
    .map(Number);
  return n > 0 && d > 0 ? n / d : 0;
};

/** When the video stream (not the longest stream) ends, and how long one frame lasts. */
export async function videoTiming(path: string) {
  const { stdout } = await exec(
    await findTool("ffprobe"),
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "format=duration:stream=duration,avg_frame_rate,r_frame_rate",
      "-of",
      "json",
      path,
    ],
    { timeout: 15000, maxBuffer: 1024 * 1024 },
  );
  const { format, streams } = JSON.parse(stdout);
  const v = streams?.[0] ?? {};
  const fps = rate(v.avg_frame_rate) || rate(v.r_frame_rate) || 60;
  return { endSec: Number(v.duration) || Number(format?.duration) || 0, frameSec: 1 / fps };
}

export const EXPORT_SPECS = {
  mp4: {
    extension: "mp4",
    fps: [60, 50, 30, 25, 24, 20, 10] as const,
    qualities: ["studio", "social-media", "web-high", "web-low"] as const,
  },
  prores: {
    extension: "mov",
    fps: [60, 50, 30, 25, 24, 20, 10] as const,
    qualities: ["studio"] as const,
  },
  gif: {
    extension: "gif",
    fps: [50, 30, 25, 20, 15, 10] as const,
    qualities: ["studio", "social-media"] as const,
  },
} as const;

export type ExportFormat = keyof typeof EXPORT_SPECS;
export type ExportOptions = {
  height: number;
  fps: number;
  format: string;
  quality: string;
  mp4Codec?: "h264" | "h265" | "both";
  proResProfile?: "422-lt" | "422" | "422-hq" | "4444";
  gifDisableLoop?: boolean;
  keepRender?: boolean;
};

export function exportExtension(format: string): string {
  if (!(format in EXPORT_SPECS)) throw new Error(`Unsupported export format: ${format}.`);
  return EXPORT_SPECS[format as ExportFormat].extension;
}

export function dualMp4Paths(outputPath: string): { h264: string; h265: string } {
  const stem = outputPath.slice(0, -4);
  return { h264: `${stem}-h264.mp4`, h265: `${stem}-h265.mp4` };
}

export function validateExportOptions(options: ExportOptions) {
  if (!(options.format in EXPORT_SPECS))
    throw new Error(`Unsupported export format "${options.format}". Use mp4, prores, or gif.`);
  const spec = EXPORT_SPECS[options.format as ExportFormat];
  if (!spec.fps.includes(options.fps as never))
    throw new Error(`${options.format} exports support fps in [${spec.fps.join(", ")}], got ${options.fps}.`);
  if (!spec.qualities.includes(options.quality as never))
    throw new Error(
      `${options.format} exports support quality in [${spec.qualities.join(", ")}], got "${options.quality}".`,
    );
  if (options.mp4Codec !== undefined && options.format !== "mp4")
    throw new Error('mp4Codec is only valid when format is "mp4".');
  if (options.proResProfile !== undefined && options.format !== "prores")
    throw new Error('proResProfile is only valid when format is "prores".');
  if (options.gifDisableLoop !== undefined && options.format !== "gif")
    throw new Error('gifDisableLoop is only valid when format is "gif".');
}

type ExportJob = {
  projectPath?: string;
  editFingerprint?: string;
  outputPath: string;
  outputPaths?: string[];
  format: string;
  mp4Codec?: "h264" | "h265" | "both";
  /** Whether the render used the open editor's project or the saved one. */
  source?: "live" | "disk";
  keepRender?: boolean;
  /** Last status seen from the app; kept in memory only. */
  status?: string;
  renderedPath?: string;
  delivered?: boolean;
  deliveredCodecs?: Partial<Record<"h264" | "h265", { outputPath: string; renderedPath: string }>>;
  completed?: any;
};
const RUNNING = [undefined, "starting", "rendering"];

export class Studio {
  readonly appPath = resolve(
    process.env.SCREENSTUDIO_APP_PATH ??
      [join(homedir(), "Applications/Screen Studio.app")].find((p) => existsSync(p)) ??
      "/Applications/Screen Studio.app",
  );
  readonly stateDir = resolve(process.env.SCREENSTUDIO_STATE_DIR ?? join(homedir(), ".screenstudio-mcp"));
  private tail: Promise<unknown> = Promise.resolve();
  private projectLocks = new Map<string, Promise<unknown>>();
  private runningAppPath: string | null = null;
  private jobs = new Map<string, ExportJob>();
  /** The running app's main process, if any. */
  private async running() {
    const { stdout } = await exec("/bin/ps", ["-axww", "-o", "command="], {
      maxBuffer: 16 * 1024 * 1024,
    }).catch(() => ({ stdout: "" }));
    this.runningAppPath = runningBundlePath(stdout, this.appPath);
    return mainProcess(stdout, this.appPath);
  }
  /** Serializes open vs move/remove operations on the same project path without blocking Studio.lock. */
  async projectLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
    const key = await this.path(projectPath).catch(() => canonicalPath(projectPath));
    const previous = this.projectLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((r) => (release = r));
    this.projectLocks.set(key, tail);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.projectLocks.get(key) === tail) this.projectLocks.delete(key);
    }
  }
  /** Whether the app is running at all; when it is not, no editor holds unsaved edits. */
  async isRunning() {
    return !!(await this.running());
  }
  /** A fixed port, or the one the running app was launched with. */
  async port(): Promise<number> {
    const fixed = configuredPort();
    if (fixed !== null) return fixed;
    const running = await this.running();
    if (!running) throw new Error("Screen Studio is not running. Call screenstudio_launch.");
    // Never guess a port: whatever answers there may not be Screen Studio.
    if (running.port === null)
      throw new Error(
        "Screen Studio is running without an automation connection. Ask the owner to quit it (Cmd+Q), then call screenstudio_launch.",
      );
    return running.port;
  }
  async evaluate<T = any>(body: string, timeout = 30000): Promise<T> {
    const port = await this.port().catch((error) => {
      throw new CommandNotSentError(error);
    });
    return withSession(port, (c) => c.evaluateAwait<T>(`(async function(){${body}})()`, timeout));
  }
  /** A file path in the private state directory, which is created on first use. */
  statePath(name: string) {
    return statePath(this.stateDir, name);
  }
  private async getJob(jobId: string) {
    assertUuid(jobId, "Invalid export job ID.");
    let job = this.jobs.get(jobId);
    if (job?.completed) return job;
    // Another server process may have delivered this job since it was cached.
    try {
      const saved: ExportJob = JSON.parse(
        await readFile(join(this.stateDir, `export-${jobId}.json`), "utf8"),
      );
      if (job) Object.assign(job, saved);
      else this.jobs.set(jobId, (job = saved));
    } catch {
      if (!job) throw new Error("Unknown export job.");
    }
    return job;
  }
  private async saveJob(jobId: string) {
    const { status, ...job } = this.jobs.get(jobId)!;
    const path = await this.statePath(`export-${jobId}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, j(job), { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async lock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  async call<T = any>(
    kind: "query" | "mutation",
    route: string,
    input?: unknown,
    timeout = 30000,
  ): Promise<T> {
    const port = await this.port().catch((error) => {
      throw new CommandNotSentError(error);
    });
    return withSession(port, (c) =>
      c.evaluateAwait<T>(`bridge.client.${kind}(${j(route)},${j(input) ?? "undefined"})`, timeout),
    );
  }
  async subscription<T = any>(route: string, input?: unknown, timeoutMs = 5000): Promise<T> {
    return withSession(await this.port(), (c) =>
      c.evaluate<T>(
        `return new Promise((resolve,reject)=>{let stop;const timer=setTimeout(()=>{stop?.();reject(new Error('State subscription timed out'));},${timeoutMs});stop=bridge.client.subscription(${j(route)},${j(input) ?? "undefined"},{onNext(v){if(v.type==='data'){clearTimeout(timer);stop?.();resolve(v.data);}},onError(e){clearTimeout(timer);stop?.();reject(e);}});});`,
      ),
    );
  }
  async version() {
    return this.call<string>("query", "app.version");
  }
  /**
   * The app build, checked. Reading works on any 4.x build. Changing the app
   * (recording, editing, exporting) needs the tested build, or
   * SCREENSTUDIO_ALLOW_UNTESTED=1 to try an untested 4.x build at your own risk.
   */
  async requireVersion(kind: "read" | "write" = "write") {
    const v = await this.version();
    if (v === APP_BUILD) return v;
    const major4 = typeof v === "string" && v.startsWith("4.");
    if (major4 && (kind === "read" || process.env.SCREENSTUDIO_ALLOW_UNTESTED === "1")) return v;
    throw new Error(
      `Unsupported Screen Studio build ${v}. Tested build: ${APP_BUILD}. ${major4 ? "Set SCREENSTUDIO_ALLOW_UNTESTED=1 in the MCP server's environment to try anyway, and turn off Screen Studio's auto-update once it works." : "This adapter supports Screen Studio 4."}`,
    );
  }
  async launch() {
    if (process.platform !== "darwin") throw new Error("Screen Studio requires macOS.");
    const fixed = configuredPort();
    let cause: unknown;
    try {
      return { version: await this.requireVersion("read"), connected: true };
    } catch (e) {
      if (String(e).includes("Unsupported")) throw e;
      cause = e;
    }
    const app = this.appPath;
    await access(join(app, "Contents/MacOS/Screen Studio")).catch(() => {
      throw new Error(
        `Screen Studio was not found at ${app}. Install Screen Studio.app or set SCREENSTUDIO_APP_PATH.`,
      );
    });
    // Never restart or kill a running app: Electron's singleton may ignore these flags.
    const running = await this.running();
    if (running) throw new Error(runningAppError(running, fixed, cause));
    const preferred = process.env.SCREENSTUDIO_LAUNCH_PORT;
    const launchFixed = fixed ?? (preferred ? Number(preferred) : null);
    if (launchFixed !== null && (!Number.isInteger(launchFixed) || launchFixed < 1024 || launchFixed > 65535))
      throw new Error("SCREENSTUDIO_LAUNCH_PORT must be a port between 1024 and 65535.");
    const port = await launchPort(launchFixed);
    // Through LaunchServices, like a double-click: the app keeps its own Screen Recording
    // and microphone permissions instead of borrowing those of the terminal or agent app.
    await exec(
      "/usr/bin/open",
      ["-a", app, "--args", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
      { timeout: 15000, env: appEnv() },
    );
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        return { version: await this.requireVersion("read"), connected: true, port };
      } catch (e) {
        if (String(e).includes("Unsupported")) throw e;
        cause = e;
      }
    }
    const started = await this.running();
    if (!started) throw new Error("Screen Studio quit right after launch.");
    throw new Error(
      `Screen Studio did not expose a connection on port ${port} (${cause instanceof Error ? cause.message : cause}). Inspect the running app; launch was not retried.`,
    );
  }
  /**
   * Quits Screen Studio the way Cmd+Q does, which also closes the automation
   * port. The app asks about unsaved changes itself. Refuses while recording.
   */
  async quit() {
    if (!(await this.running())) return { quit: false, note: "Screen Studio is not running." };
    if (await this.state().catch(() => null))
      throw new Error("A recording is active; finish or cancel it first.");
    await exec("/usr/bin/osascript", ["-e", 'tell application id "com.timpler.screenstudio" to quit'], {
      timeout: 30000,
    });
    for (let i = 0; i < 40; i++) {
      if (!(await this.running())) return { quit: true };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { quit: false, note: "Screen Studio is still open; it may be asking about unsaved changes." };
  }
  private async distModuleUrl(chunk: string) {
    await this.running();
    const base = this.runningAppPath ?? this.appPath;
    return pathToFileURL(join(base, "Contents/Resources/app.asar/dist", chunk)).href;
  }
  async state() {
    await this.requireVersion("read");
    const url = await this.distModuleUrl(NATIVE_CLIENT_CHUNK);
    return this.evaluate(
      `const nc = (await import(${j(url)}))[${j(NATIVE_CLIENT_EXPORT)}];
       if (!nc.recording.current && !window.__ssmcpRecordingSubscribed) {
         window.__ssmcpRecordingWarmup ??= (async () => {
           for (let i = 0; i < 10; i++) {
             if (nc.recording.current) break;
             await new Promise((r) => setTimeout(r, 25));
           }
           window.__ssmcpRecordingSubscribed = true;
         })().finally(() => {
           window.__ssmcpRecordingWarmup = null;
         });
         await window.__ssmcpRecordingWarmup;
       }
       return nc.recording.current;`,
    );
  }
  async sources() {
    await this.requireVersion("read");
    const ncUrl = await this.distModuleUrl(NATIVE_CLIENT_CHUNK);
    const inputsUrl = await this.distModuleUrl(INPUTS_CHUNK);
    return this.evaluate(
      `const nc = (await import(${j(ncUrl)}))[${j(NATIVE_CLIENT_EXPORT)}];
       const inputs = (await import(${j(inputsUrl)}))[${j(INPUTS_EXPORT)}];
       const [devices, windows] = await Promise.all([inputs.waitForReady(), nc.windows.listCapturableWindows()]);
       return { devices, windows };`,
    );
  }
  async start(input: {
    windowId?: number;
    displayId?: number;
    area?: { x: number; y: number; width: number; height: number };
    name: string;
    microphoneDeviceId?: string;
    cameraDeviceId?: string;
    externalDeviceId?: string;
    systemAudio?: boolean;
    hideDesktopIcons?: boolean;
  }) {
    return this.lock(async () => {
      await this.requireVersion();
      if (await this.state()) throw new Error("A recording is already active. Inspect it before continuing.");
      const targetsCount = [input.windowId, input.displayId, input.externalDeviceId].filter(
        (v) => v !== undefined,
      ).length;
      if (targetsCount !== 1) throw new Error("Select exactly one window, display, or external device.");
      const sources = await this.sources();
      if (input.windowId !== undefined && !sources.windows.some((w: any) => w.id === input.windowId))
        throw new Error("Recording window is no longer available.");
      if (
        input.displayId !== undefined &&
        !sources.devices.displays.some((d: any) => (d.displayId ?? d.displayID) === input.displayId)
      )
        throw new Error("Display is no longer available.");
      if (
        input.externalDeviceId !== undefined &&
        !(sources.devices.externalDevices ?? []).some(
          (d: any) => (d.deviceId ?? d.id) === input.externalDeviceId,
        )
      )
        throw new Error("External capture device is no longer available.");
      const config = {
        windowId: input.windowId ?? null,
        displayId: input.displayId ?? null,
        bounds: input.area ?? null,
        microphoneDeviceId: input.microphoneDeviceId ?? null,
        cameraDeviceId: input.cameraDeviceId ?? null,
        externalDeviceId: input.externalDeviceId ?? null,
        recordSystemAudio: input.systemAudio ? { type: "all" } : null,
        enableScreenCaptureKit: true,
        hideDesktopIcons: input.hideDesktopIcons ?? false,
        name: input.name,
      };
      const ncUrl = await this.distModuleUrl(NATIVE_CLIENT_CHUNK);
      const started = await this.evaluate(
        `const nc = (await import(${j(ncUrl)}))[${j(NATIVE_CLIENT_EXPORT)}];
         const prepared = await bridge.client.mutation("capture.prepareRecording", { config: ${j(config)}, defaultConfig: {} });
         if (!prepared) throw new Error("Screen Studio did not prepare the recording.");
         return nc.recording.start(prepared);`,
        60000,
      );
      return { started, state: await this.state() };
    });
  }
  async recordingAction(
    action: "pause" | "resume" | "finish" | "addMarker" | "restart" | "cancel",
    expectedRecordingPath?: string,
  ) {
    return this.lock(async () => {
      await this.requireVersion();
      const state = await this.state();
      if (!state) throw new Error("No recording is active.");
      if (expectedRecordingPath && state.outputDirectory !== expectedRecordingPath)
        throw new Error("The active recording is not the expected recording; it was left untouched.");
      const type = state.phase ?? state.type ?? state.recordingState?.type;
      if (action === "pause" && type !== "recording")
        throw new Error("Recording must be running before pausing.");
      if (action === "resume" && type !== "paused")
        throw new Error("Recording must be paused before resuming.");
      const recordingPath = typeof state.outputDirectory === "string" ? state.outputDirectory : undefined;
      const ncUrl = await this.distModuleUrl(NATIVE_CLIENT_CHUNK);
      let result: any;
      try {
        result = await this.evaluate(
          `const nc = (await import(${j(ncUrl)}))[${j(NATIVE_CLIENT_EXPORT)}];
           if (${j(action)} !== "finish") return await nc.recording[${j(action)}]();
           const recordingPath = ${j(recordingPath ?? null)};
           let res;
           try {
             res = await nc.recording.finish();
           } catch (e) {
             if (e instanceof Error && e.name === "SwiftServiceRestartedError" && recordingPath) {
               const recovered = await bridge.client.mutation("capture.recover.tryToRecoverRecording", { path: recordingPath });
               return recovered
                 ? { error: "The recorder stopped unexpectedly.", ...recovered, type: "recovered-from-error" }
                 : { type: "finalization-failed", recordingPath, error: "The recorder process ended while finishing and could not auto-recover." };
             }
             throw e;
           }
           if (res?.finalizationError) return { type: "finalization-failed", recordingPath, error: res.finalizationError };
           try {
             const created = await bridge.client.mutation("capture.createProjectFromRecording", { recording: res });
             return res?.endProblem
               ? { type: "recovered-from-error", error: res.endProblem.message, ...created }
               : { type: "success", ...created };
           } catch (e) {
             return { type: "finalization-failed", recordingPath, error: e?.message ?? String(e) };
           }`,
          120000,
        );
      } catch (e: any) {
        if (action !== "finish") throw e;
        const msg = e instanceof Error ? e.message : String(e);
        const hint = recordingPath
          ? ` Recording folder: ${recordingPath}. Do not retry finish blindly; inspect screenstudio_record_state and use screenstudio_record_recover (list/recover).`
          : " Do not retry finish blindly; inspect screenstudio_record_state and screenstudio_record_recover.";
        throw new Error(`${msg}${hint}`);
      }
      if (action === "finish") {
        if ((result?.type !== "success" && result?.type !== "recovered-from-error") || !result.projectPath) {
          const recPath = result?.recordingPath ?? recordingPath;
          const hint = recPath
            ? ` Inspect or recover it with screenstudio_record_recover (action: "list" or "recover", recordingPath: ${recPath}) rather than retrying finish.`
            : " Inspect unfinished recordings with screenstudio_record_recover.";
          throw new Error(`Recording did not produce a project: ${j(result)}.${hint}`);
        }
        await this.path(result.projectPath);
        if (result.type === "recovered-from-error") {
          return {
            ...result,
            recovered: true,
            warning: result.error ?? "Recording ended with an error and was recovered.",
          };
        }
        return result;
      }
      return { result, state: await this.state() };
    });
  }
  async path(path: string) {
    if (!isAbsolute(path) || !path.endsWith(".screenstudio"))
      throw new Error("Use an absolute .screenstudio project path.");
    const p = await realpath(path).catch(() => {
      throw new Error(`No Screen Studio project at ${path}.`);
    });
    if (!(await stat(p)).isDirectory()) throw new Error("Project must be a directory.");
    return p;
  }
  async readProject(path: string) {
    await this.requireVersion("read");
    const projectPath = await this.path(path);
    await assertProjectBundle(projectPath);
    const data = await this.call("query", "project.readProject", {
      projectPath,
    });
    if (data.projectData?.version !== PROJECT_SCHEMA) throw new Error("Project schema is unsupported.");
    return { projectPath, project: data.projectData };
  }
  private async checkDestination(source: string, destination: string) {
    if (!isAbsolute(destination) || !destination.endsWith(".screenstudio"))
      throw new Error("Destination must be an absolute .screenstudio path.");
    const resolved = resolve(destination);
    if (await lstat(resolved).catch(() => null)) throw new Error(`Destination already exists: ${resolved}.`);
    const canonSource = await canonicalPath(source);
    const canonical = await canonicalPath(resolved);
    if (canonical === canonSource || canonical.startsWith(canonSource + "/"))
      throw new Error("Destination cannot be inside the source project.");
    return resolved;
  }
  async duplicate(path: string, destination: string) {
    return this.lock(async () => {
      const source = await this.path(path);
      await assertProjectBundle(source);
      const dest = await this.checkDestination(source, destination);
      await cp(source, dest, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      return this.readProject(dest);
    });
  }
  async exportStart(
    path: string,
    outputPath: string,
    options: ExportOptions,
    live?: (projectPath: string) => Promise<any | null>,
    expectedEditFingerprint?: string,
  ) {
    return this.lock(async () => {
      await this.requireVersion();
      validateExportOptions(options);
      const targets = this.checkOutput(outputPath, options);
      await Promise.all(targets.map((t) => assertOutputWritable(t)));
      const p = await this.readProject(path);
      // Render what the editor shows, including unsaved edits. A failed lookup must abort the
      // export rather than quietly render the saved copy.
      const current = live ? await live(p.projectPath) : null;
      if (current) p.project = current;
      if (expectedEditFingerprint && projectEditFingerprint(p.project) !== expectedEditFingerprint)
        throw new Error(
          "Project changed after the reviewed edit; inspect and repeat privacy review before exporting.",
        );
      return this.render(p, targets, options, current ? "live" : "disk");
    });
  }
  /**
   * Renders the given project data instead of the editor's or the saved project, for a
   * variant (another aspect, captions, zooms) that must not touch the editor's state.
   */
  async startRender(
    path: string,
    outputPath: string,
    options: ExportOptions,
    projectData: any,
    source: "live" | "disk",
  ) {
    return this.lock(async () => {
      await this.requireVersion();
      validateExportOptions(options);
      const targets = this.checkOutput(outputPath, options);
      await Promise.all(targets.map((t) => assertOutputWritable(t)));
      const p = await this.readProject(path);
      if (projectData?.version !== PROJECT_SCHEMA || !Array.isArray(projectData.scenes))
        throw new Error("Project data to render has an unsupported schema.");
      return this.render({ projectPath: p.projectPath, project: projectData }, targets, options, source);
    });
  }
  private checkOutput(outputPath: string, options: Pick<ExportOptions, "format" | "mp4Codec">) {
    const ext = exportExtension(options.format);
    if (!isAbsolute(outputPath) || !outputPath.endsWith("." + ext))
      throw new Error(
        options.format === "prores"
          ? "Output must be an absolute path ending in .mov for prores exports."
          : "Output must be an absolute path with matching extension.",
      );
    const resolved = resolve(outputPath);
    const targets =
      options.format === "mp4" && options.mp4Codec === "both"
        ? Object.values(dualMp4Paths(resolved))
        : [resolved];
    for (const job of this.jobs.values()) {
      if (job.completed || !RUNNING.includes(job.status)) continue;
      const busy = new Set(job.outputPaths ?? [job.outputPath]);
      if (targets.some((t) => busy.has(t)))
        throw new Error("Another export is already writing to this output; choose a new destination.");
    }
    return targets;
  }
  private async render(
    p: { projectPath: string; project: any },
    targets: string[],
    options: ExportOptions,
    source: "live" | "disk",
  ) {
    const { keepRender, mp4Codec, proResProfile, gifDisableLoop, ...render } = options;
    const jobId = randomUUID();
    const config: Record<string, unknown> = {
      ...render,
      target: "file",
      qa: true,
      projectPath: p.projectPath,
      projectData: p.project,
      ...(options.format === "mp4" && { mp4Codec: mp4Codec ?? "h264" }),
      ...(options.format === "prores" && proResProfile !== undefined && { proResProfile }),
      ...(options.format === "gif" && gifDisableLoop !== undefined && { gifDisableLoop }),
    };
    this.jobs.set(jobId, {
      projectPath: await canonicalPath(p.projectPath),
      editFingerprint: projectEditFingerprint(p.project),
      outputPath: targets[0],
      ...(targets.length > 1 && { outputPaths: targets }),
      format: options.format,
      ...(options.format === "mp4" && mp4Codec && { mp4Codec }),
      source,
      keepRender,
      status: "starting",
    });
    await this.saveJob(jobId);
    await withSession(await this.port(), (c) =>
      c.evaluate(
        `window.__screenstudioMcpJobs??=Object.create(null);const job={status:'starting',createdAt:Date.now()};window.__screenstudioMcpJobs[${j(jobId)}]=job;bridge.client.mutation('export.start',{config:${j(config)},onStarted:id=>{job.exportId=id;job.status='rendering';}}).then(result=>{job.result=result;job.status=result.status;}).catch(error=>{job.status='failed';job.error=String(error);});return {jobId:${j(jobId)}};`,
      ),
    );
    return {
      jobId,
      status: "starting",
      outputPath: targets[0],
      ...(targets.length > 1 && { outputPaths: targets }),
      source,
      ...(source === "disk" && {
        note: "No open editor has this project, so the saved project is rendered; unsaved edits are not included.",
      }),
    };
  }
  /**
   * Polls a job until it stops running (completed, failed, cancelled or delivery_failed).
   * Each poll takes the lock on its own, so recording and other exports are never held up.
   */
  async waitForExport(
    jobId: string,
    o: { pollMs?: number; timeoutMs?: number; signal?: AbortSignal; onPoll?: () => void } = {},
  ) {
    const pollMs = o.pollMs ?? 1000;
    const until = Date.now() + (o.timeoutMs ?? 20 * 60000);
    for (;;) {
      if (o.signal?.aborted) throw new Error(`Export ${jobId} was cancelled.`);
      o.onPoll?.();
      const status = await this.exportStatus(jobId);
      if (!RUNNING.includes(status.status)) return status;
      if (Date.now() >= until)
        throw new Error(
          `Export ${jobId} is still ${status.status} after ${Math.round((o.timeoutMs ?? 20 * 60000) / 1000)}s. Poll screenstudio_export_status with this job.`,
        );
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  /**
   * Delivers exports that finished after the call that started them ended (an
   * agent that stopped before its render was done). Runs once at startup.
   */
  async deliverPending() {
    if (!(await this.isRunning())) return;
    for (const name of await readdir(this.stateDir).catch(() => [] as string[])) {
      const m = /^export-([0-9a-f-]{36})\.json$/.exec(name);
      if (!m) continue;
      const saved = JSON.parse(await readFile(join(this.stateDir, name), "utf8").catch(() => "{}"));
      if (!saved.completed) await this.exportStatus(m[1]).catch(() => {});
    }
  }
  async findExport(projectPath: string, outputPath: string) {
    const project = await canonicalPath(projectPath);
    const output = await canonicalPath(outputPath);
    const matches: { jobId: string; editFingerprint?: string }[] = [];
    for (const name of await readdir(this.stateDir).catch(() => [] as string[])) {
      const m = /^export-([0-9a-f-]{36})\.json$/.exec(name);
      if (!m) continue;
      const saved: ExportJob = JSON.parse(await readFile(join(this.stateDir, name), "utf8"));
      if (
        saved.projectPath &&
        (await canonicalPath(saved.projectPath)) === project &&
        (await canonicalPath(saved.outputPath)) === output
      )
        matches.push({ jobId: m[1], editFingerprint: saved.editFingerprint });
    }
    if (matches.length > 1)
      throw new Error("More than one export matches this destination; inspect the saved jobs.");
    return { found: matches.length === 1, ...(matches[0] ?? {}) };
  }
  async exportStatus(jobId: string) {
    return this.lock(() => this.deliverExport(jobId));
  }
  private async deliverExport(jobId: string) {
    const local = await this.getJob(jobId);
    if (local.completed) return local.completed;
    const job = await withSession(await this.port(), (c) =>
      c.evaluate<any>(
        `const job=window.__screenstudioMcpJobs?.[${j(jobId)}];if(!job)throw new Error('Export state was lost. Inspect the app and temporary exports before retrying.');return {...job};`,
      ),
    );
    local.status = job.status;
    if (job.status !== "completed") return { jobId, ...job, source: local.source };
    if (local.format === "mp4" && local.mp4Codec === "both") {
      return this.deliverDualExport(jobId, job, local);
    }
    if (!local.delivered) {
      const dir = await this.call<string>("query", "export.getTempQaExportsPath");
      const ext = exportExtension(local.format);
      const candidates = (await readdir(dir)).filter((f) => f.endsWith(`-${job.exportId}.${ext}`));
      if (candidates.length !== 1) throw new Error("Completed export file could not be uniquely located.");
      const rendered = join(dir, candidates[0]);
      try {
        await deliverFile(rendered, local.outputPath, jobId);
      } catch (e: any) {
        // Terminal: retrying cannot fix a taken or unwritable destination, and the render is kept.
        local.completed = {
          jobId,
          status: "delivery_failed",
          error: e instanceof Error ? e.message : String(e),
          renderedPath: rendered,
          outputPath: local.outputPath,
          source: local.source,
        };
        await this.saveJob(jobId);
        return local.completed;
      }
      local.delivered = true;
      local.renderedPath = rendered;
      await this.saveJob(jobId);
      await rm(partialPath(local.outputPath, jobId), { force: true });
    }
    const media = await this.probe(local.outputPath);
    local.completed = {
      jobId,
      status: "completed",
      outputPath: local.outputPath,
      source: local.source,
      media,
    };
    await this.saveJob(jobId);
    if (!local.keepRender && local.renderedPath)
      await rm(local.renderedPath, { force: true }).catch(() => {});
    return local.completed;
  }
  private async deliverDualExport(jobId: string, job: any, local: ExportJob) {
    const dir = await this.call<string>("query", "export.getTempQaExportsPath");
    const entries = await readdir(dir);
    const pairs: Array<readonly ["h264" | "h265", string]> = [
      ["h264", local.outputPaths?.[0] ?? local.outputPath],
      ["h265", local.outputPaths?.[1] ?? local.outputPath.replace(/-h264\.mp4$/, "-h265.mp4")],
    ];
    local.deliveredCodecs ??= {};
    const errors: Record<string, string> = {};
    const renderedPaths: string[] = [];
    const deliveredRenders: string[] = [];
    const findCodecFile = (codec: "h264" | "h265") => {
      const tagged = entries.filter((f) => f.endsWith(`-${job.exportId}-${codec}.mp4`));
      // Screen Studio writes the primary H.264 file without a codec suffix when rendering both codecs.
      if (tagged.length > 0 || codec !== "h264") return tagged;
      return entries.filter((f) => f.endsWith(`-${job.exportId}.mp4`));
    };
    for (const [codec, out] of pairs) {
      const prior = local.deliveredCodecs[codec];
      if (prior) {
        renderedPaths.push(prior.renderedPath);
        deliveredRenders.push(prior.renderedPath);
        await rm(partialPath(prior.outputPath, `${jobId}-${codec}`), { force: true }).catch(() => {});
        continue;
      }
      const matches = findCodecFile(codec);
      if (matches.length !== 1) {
        errors[codec] = `Completed ${codec} export file could not be uniquely located.`;
        continue;
      }
      const rendered = join(dir, matches[0]);
      renderedPaths.push(rendered);
      try {
        await deliverFile(rendered, out, `${jobId}-${codec}`);
        local.deliveredCodecs[codec] = { outputPath: out, renderedPath: rendered };
        deliveredRenders.push(rendered);
        // Persist delivery before deleting the cross-volume partial link so retries never hit EEXIST.
        await this.saveJob(jobId);
        await rm(partialPath(out, `${jobId}-${codec}`), { force: true });
      } catch (e: any) {
        errors[codec] = e instanceof Error ? e.message : String(e);
      }
    }
    const deliveredCodecs = pairs.map(([c]) => c).filter((c) => local.deliveredCodecs?.[c] !== undefined);
    if (!deliveredCodecs.length) {
      local.completed = {
        jobId,
        status: "delivery_failed",
        error: Object.values(errors).join("; "),
        renderedPaths,
        outputPaths: pairs.map(([, out]) => out),
        source: local.source,
      };
      await this.saveJob(jobId);
      return local.completed;
    }
    const files: Record<string, any> = {};
    const probeErrors: Record<string, string> = {};
    let primaryOut: string | undefined;
    let primaryMedia: any;
    for (const codec of deliveredCodecs) {
      const out = local.deliveredCodecs[codec]!.outputPath;
      try {
        const media = await this.probe(out);
        files[codec] = { outputPath: out, media };
        if (!primaryOut) {
          primaryOut = out;
          primaryMedia = media;
        }
      } catch (e: any) {
        const msg = e instanceof Error ? e.message : String(e);
        probeErrors[codec] = msg;
        files[codec] = { outputPath: out };
        errors[codec] = `Delivered, but media inspection failed: ${msg}`;
      }
    }
    if (Object.keys(probeErrors).length === deliveredCodecs.length) {
      throw new Error(Object.values(probeErrors).join("; "));
    }
    const outputPaths = deliveredCodecs.map((c) => local.deliveredCodecs![c]!.outputPath);
    if (!primaryOut) primaryOut = outputPaths[0];
    const keptRenderPaths = local.keepRender
      ? renderedPaths
      : renderedPaths.filter((p) => !deliveredRenders.includes(p));
    local.delivered = true;
    local.completed = {
      jobId,
      status: "completed",
      outputPath: primaryOut,
      outputPaths,
      files,
      source: local.source,
      ...(primaryMedia !== undefined && { media: primaryMedia }),
      ...(keptRenderPaths.length > 0 && { renderedPaths: keptRenderPaths }),
      ...(Object.keys(errors).length > 0 && { warnings: errors }),
    };
    await this.saveJob(jobId);
    // A render whose delivery failed is kept so its file is not lost; its path is in renderedPaths.
    if (!local.keepRender) for (const p of deliveredRenders) await rm(p, { force: true }).catch(() => {});
    return local.completed;
  }
  async exportCancel(jobId: string) {
    await this.requireVersion();
    await this.getJob(jobId);
    const job = await withSession(await this.port(), (c) =>
      c.evaluate<any>(`return window.__screenstudioMcpJobs?.[${j(jobId)}]??null;`),
    );
    if (!job?.exportId) throw new Error("Export has not started. Inspect its status before cancelling.");
    await this.call("mutation", "export.cancel", { exportId: job.exportId });
    return this.exportStatus(jobId);
  }
  async probe(path: string) {
    const media = await probe(path);
    if (!media.streams.some((s: any) => s.width && s.height) || Number(media.format.duration) <= 0)
      throw new Error("Export file has no playable video.");
    return media;
  }
  async preview(jobId: string, timeMs: number) {
    const job = await this.exportStatus(jobId);
    if (job.status !== "completed")
      throw new Error("Wait for the canonical export to complete before previewing.");
    const video = await videoTiming(job.outputPath);
    const seconds = previewSeconds(timeMs, video);
    const output = await this.statePath(`${jobId}-${Math.floor(timeMs)}.png`);
    await rm(output, { force: true });
    await frameAt(job.outputPath, seconds, output);
    const data = await readFile(output).catch(() => {
      throw new Error(
        `No video frame at ${seconds.toFixed(3)}s; the video ends at ${video.endSec.toFixed(3)}s.`,
      );
    });
    return { path: output, data };
  }
  async supportedMicrophonePresets(): Promise<string[]> {
    await this.requireVersion("read");
    return this.call<string[]>("query", "media.supportedMicrophoneAudioPresets");
  }
  async recentProjects() {
    await this.requireVersion("read");
    return this.subscription<Array<{ path: string; lastOpenedAt?: number; [k: string]: unknown }>>(
      "recentProjects.list",
    );
  }
  async userAudioTracks() {
    await this.requireVersion("read");
    return this.subscription<any[]>("backgroundAudio.userLibraryTracks");
  }
  private async resolveListedPath(
    entries: Array<{ path?: unknown }>,
    rawPath: string,
  ): Promise<string | null> {
    const wanted = await realpath(rawPath).catch(() => resolve(rawPath));
    for (const entry of entries) {
      const p = entry?.path;
      if (typeof p !== "string") continue;
      const candidate = await realpath(p).catch(() => resolve(p));
      if (candidate === wanted) return p;
    }
    return null;
  }
  async luts(action: "list" | "add" | "remove", input?: { sourcePath?: string; lutPath?: string }) {
    if (action === "list") {
      await this.requireVersion("read");
      return this.subscription<Array<{ name: string; path: string }>>("luts.userLibrary");
    }
    return this.lock(async () => {
      await this.requireVersion();
      if (action === "add") {
        if (!input?.sourcePath || !isAbsolute(input.sourcePath))
          throw new Error("sourcePath must be an absolute path to a .cube LUT file.");
        const sourcePath = resolve(input.sourcePath);
        if (!sourcePath.toLowerCase().endsWith(".cube"))
          throw new Error("LUT file must use the .cube extension.");
        if (!(await stat(sourcePath).catch(() => null))?.isFile())
          throw new Error(`No file found at ${sourcePath}.`);
        return this.call("mutation", "luts.addToLibrary", { sourcePath });
      }
      if (!input?.lutPath || !isAbsolute(input.lutPath))
        throw new Error("lutPath must be the absolute library LUT path to remove.");
      const library = await this.subscription<Array<{ name: string; path: string }>>("luts.userLibrary");
      const target = await this.resolveListedPath(library, input.lutPath);
      if (!target) throw new Error(`No user library LUT at ${resolve(input.lutPath)}. List user LUTs first.`);
      const res = await this.call("mutation", "luts.removeFromLibrary", { lutPath: target });
      return res && typeof res === "object" ? res : { removed: true, lutPath: target };
    });
  }
  async importVideo(videoPath: string) {
    return this.lock(async () => {
      await this.requireVersion();
      if (!isAbsolute(videoPath)) throw new Error("videoPath must be an absolute file path.");
      const resolved = resolve(videoPath);
      if (!(await stat(resolved).catch(() => null))?.isFile())
        throw new Error(`No video file at ${resolved}.`);
      const res = await this.call<any>("mutation", "import.createProjectFromVideo", {
        videoPath: resolved,
      });
      if (!res?.projectPath)
        throw new Error("Screen Studio did not return a projectPath for the imported video.");
      return res;
    });
  }
  async unfinishedRecordings() {
    await this.requireVersion("read");
    return this.call<Array<{ path: string; [k: string]: unknown }>>(
      "query",
      "capture.recover.unfinishedRecordings",
    ).catch((e) => {
      if (/subscription|not supported for query|unsupported method/i.test(String(e)))
        return this.subscription("capture.recover.unfinishedRecordings");
      throw e;
    });
  }
  async recoverRecording(recordingPath: string) {
    return this.lock(async () => {
      await this.requireVersion();
      if (!isAbsolute(recordingPath)) throw new Error("recordingPath must be an absolute folder path.");
      const path = resolve(recordingPath);
      if (!(await stat(path).catch(() => null))?.isDirectory())
        throw new Error(`No unfinished recording directory at ${path}.`);
      const pending = await this.unfinishedRecordings();
      const entry = await this.resolveListedPath(pending, path);
      if (!entry)
        throw new Error(`No unfinished recording matching ${path}. Run list first to get an active path.`);
      const res = await this.call<unknown>("mutation", "capture.recover.tryToRecoverRecording", {
        path: entry,
      });
      if (!res) throw new Error(`Screen Studio could not recover the recording at ${entry}.`);
      return res;
    });
  }
  async discardUnfinishedRecording(recordingPath: string) {
    return this.lock(async () => {
      await this.requireVersion();
      if (!isAbsolute(recordingPath)) throw new Error("recordingPath must be an absolute folder path.");
      const path = resolve(recordingPath);
      if (!(await stat(path).catch(() => null))?.isDirectory())
        throw new Error(`No unfinished recording directory at ${path}.`);
      const pending = await this.unfinishedRecordings();
      const entry = await this.resolveListedPath(pending, path);
      if (!entry)
        throw new Error(`No unfinished recording matching ${path}. Run list first to get an active path.`);
      const res = await this.call("mutation", "capture.recover.discardUnfinishedRecording", { path: entry });
      return res && typeof res === "object" ? res : { discarded: true, path: entry };
    });
  }
  async copyFileToProject(projectPath: string, sourcePath: string) {
    return this.lock(async () => {
      await this.requireVersion();
      const project = await this.path(projectPath);
      await assertProjectBundle(project);
      if (!isAbsolute(sourcePath)) throw new Error("sourcePath must be an absolute file path.");
      const source = resolve(sourcePath);
      if (!(await stat(source).catch(() => null))?.isFile())
        throw new Error(`No source file found at ${source}.`);
      return this.call<string>("mutation", "project.copyFileToProject", {
        projectPath: project,
        sourcePath: source,
      });
    });
  }
  async removeAssetFromProject(
    projectPath: string,
    assetFile: string,
    ensureUnused?: (resolvedProject: string, diskData: any) => Promise<void>,
  ) {
    if (!assetFile || assetFile !== basename(assetFile) || assetFile.startsWith("."))
      throw new Error("assetFile must be a bare asset file name from the project's assets, not a path.");
    return this.projectLock(projectPath, () =>
      this.lock(async () => {
        await this.requireVersion();
        const project = await this.path(projectPath);
        const diskData = await assertProjectBundle(project);
        if (ensureUnused) {
          await ensureUnused(project, diskData);
        } else {
          const refs = findAssetReferences(diskData, assetFile);
          if (refs.length)
            throw new Error(
              `Asset "${assetFile}" is still referenced by ${refs.join(", ")}. Clear those settings before removing it.`,
            );
        }
        return this.call("mutation", "project.removeAssetFromProject", {
          projectPath: project,
          assetFile,
        });
      }),
    );
  }
  async moveProject(
    projectPath: string,
    destinationPath: string,
    ensureClosed?: (resolvedSource: string) => Promise<void>,
  ) {
    return this.projectLock(projectPath, () =>
      this.lock(async () => {
        await this.requireVersion();
        const source = await this.path(projectPath);
        await assertProjectBundle(source);
        const dest = await this.checkDestination(source, destinationPath);
        await ensureClosed?.(source);
        await this.call("mutation", "project.moveProject", { projectPath: source, destinationPath: dest });
        return { projectPath: dest, movedFrom: source };
      }),
    );
  }
  async copyProject(projectPath: string, destinationPath: string) {
    return this.lock(async () => {
      await this.requireVersion();
      const source = await this.path(projectPath);
      await assertProjectBundle(source);
      const dest = await this.checkDestination(source, destinationPath);
      await this.call("mutation", "project.copyProject", { projectPath: source, destinationPath: dest });
      return { projectPath: dest, copiedFrom: source };
    });
  }
  async removeProject(projectPath: string, ensureClosed?: (resolvedSource: string) => Promise<void>) {
    return this.projectLock(projectPath, () =>
      this.lock(async () => {
        await this.requireVersion();
        const linkInfo = await lstat(projectPath).catch(() => null);
        if (linkInfo?.isSymbolicLink())
          throw new Error(
            "Refusing to remove a symlinked project path directly; pass the real .screenstudio bundle.",
          );
        const source = await this.path(projectPath);
        if (!source.endsWith(".screenstudio"))
          throw new Error(`Not a Screen Studio project (${source} does not end with .screenstudio).`);
        const raw = await readFile(join(source, "project.json"), "utf8").catch(() => null);
        if (raw === null) throw new Error(`Not a Screen Studio project (missing project.json in ${source}).`);
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error(`Not a Screen Studio project (corrupted project.json in ${source}).`);
        }
        const data = parsed?.json ?? parsed;
        if (
          !data ||
          typeof data !== "object" ||
          typeof data.version !== "string" ||
          ((!data.config || typeof data.config !== "object") && !Array.isArray(data.scenes))
        ) {
          throw new Error(`Not a Screen Studio project (unrecognized project.json structure in ${source}).`);
        }
        await ensureClosed?.(source);
        await this.call("mutation", "project.removeProject", { projectPath: source });
        return { removed: true, projectPath: source };
      }),
    );
  }
  async extractRawRecordingFiles(projectPath: string, outputFolderPath: string) {
    return this.lock(async () => {
      await this.requireVersion();
      const source = await this.path(projectPath);
      await assertProjectBundle(source);
      if (!isAbsolute(outputFolderPath)) throw new Error("outputFolderPath must be an absolute directory.");
      const out = resolve(outputFolderPath);
      if (!(await stat(out).catch(() => null))?.isDirectory())
        throw new Error(`Output folder does not exist: ${out}.`);
      const canonSource = await canonicalPath(source);
      const canonOut = await canonicalPath(out);
      if (canonOut === canonSource || canonOut.startsWith(`${canonSource}/`))
        throw new Error("Output folder cannot be inside the .screenstudio project bundle.");
      await access(out, constants.W_OK).catch(() => {
        throw new Error(`Output folder is not writable: ${out}.`);
      });
      await this.call("mutation", "project.extractRawRecordingFiles", {
        projectPath: source,
        outputFolderPath: out,
      });
      return { projectPath: source, outputFolderPath: out };
    });
  }
  async windowAction(windowId: number, action: "focus" | "resize", size?: { width: number; height: number }) {
    return this.lock(async () => {
      await this.requireVersion();
      const { windows } = await this.sources();
      const win = windows.find((w: any) => w.id === windowId);
      if (!win) throw new Error(`Window ${windowId} is not currently available.`);
      const ncUrl = await this.distModuleUrl(NATIVE_CLIENT_CHUNK);
      if (action === "resize") {
        if (!size || !(size.width > 0 && size.height > 0))
          throw new Error("Resize requires positive width and height.");
        await this.evaluate(
          `const nc = (await import(${j(ncUrl)}))[${j(NATIVE_CLIENT_EXPORT)}]; await nc.windows.resizeWindow(${windowId}, ${Math.round(size.width)}, ${Math.round(size.height)}); return true;`,
        );
        return { windowId, action, width: Math.round(size.width), height: Math.round(size.height) };
      }
      await this.evaluate(
        `const nc = (await import(${j(ncUrl)}))[${j(NATIVE_CLIENT_EXPORT)}]; await nc.windows.bringWindowToFront(${windowId}); return true;`,
      );
      return { windowId, action };
    });
  }
}

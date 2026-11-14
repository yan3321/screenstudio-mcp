import { test, after } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const originalExecFile = childProcess.execFile;
let capture;
// Exercise the public frame path without capturing the person's desktop or launching tools.
const refused = () => {
  throw new Error("Unexpected child process in frame fixture.");
};
refused[promisify.custom] = async (command, args) => {
  assert.ok(capture, "frame fixture must own every subprocess");
  if (command === "/usr/sbin/screencapture") {
    capture.calls++;
    capture.onCapture?.();
    await writeFile(args.at(-1), capture.png);
  } else {
    assert.equal(command, capture.ffmpeg);
    await writeFile(args.at(-1), await readFile(args[args.indexOf("-i") + 1]));
  }
  return { stdout: "", stderr: "" };
};
childProcess.execFile = refused;
syncBuiltinESMExports();
const { Editor } = await import("../dist/studio/editor/editor.js");
after(() => {
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
});

async function fixture(t, kind) {
  const root = await mkdtemp(join(tmpdir(), "ss-preview-observer-"));
  const previous = process.env.SCREENSTUDIO_FFMPEG;
  process.env.SCREENSTUDIO_FFMPEG = join(root, "ffmpeg");
  const path = join(root, "owned.screenstudio");
  const windowId = 43;
  const canvas = { width: 100, getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 80 }) };
  const body = { querySelectorAll: () => [] };
  const document = {
    body,
    title: "Owned",
    querySelectorAll: (selector) => (selector === "canvas" ? [canvas] : []),
  };
  const context = {
    project: { path, name: "Owned", editGeneration: 2, playbackDurationMs: 3000 },
    playback: {
      isDestroyed: false,
      isPlaying: false,
      playbackTimeMs: 0,
      pause() {},
      goTo(ms) {
        this.playbackTimeMs = ms;
      },
    },
    view: {
      targetWindow: { document, outerWidth: 100, outerHeight: 100, innerHeight: 80, devicePixelRatio: 1 },
    },
    exportManager: {},
  };
  body.__reactFiberFixture = { memoizedProps: { context } };
  const barrier = { kind, saveId: randomUUID(), since: Date.now() };
  const window = {
    $$focused: context,
    lastActiveWindow: context.view.targetWindow,
    __ssmcpBusy: { [path]: barrier },
  };
  capture = {
    calls: 0,
    ffmpeg: process.env.SCREENSTUDIO_FFMPEG,
    png: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  };
  t.after(async () => {
    capture = undefined;
    if (previous === undefined) delete process.env.SCREENSTUDIO_FFMPEG;
    else process.env.SCREENSTUDIO_FFMPEG = previous;
    await rm(root, { recursive: true, force: true });
  });
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const studio = {
    path: async (p) => p,
    requireVersion: async () => "4.1.0-5005",
    stateDir: root,
    statePath: async (name) => join(root, name),
    evaluate: (code) => new AsyncFunction("window", code)(window),
  };
  const editor = new Editor(studio, { findWindowByTitle: async () => windowId });
  return { editor, path, window, barrier, context, capture };
}

test("public Editor.frames permits stable pending-save previews without releasing quarantine", async (t) => {
  const m = await fixture(t, "pendingWrite");
  const frames = await m.editor.frames(m.path, [1500]);
  assert.equal(frames[0].playheadMs, 1500);
  assert.deepEqual(frames[0].data, m.capture.png);
  assert.equal(m.capture.calls, 1);
  assert.equal(m.window.__ssmcpBusy[m.path], m.barrier);
  assert.equal(m.context.view.targetWindow.document.title, "Owned");
});

test("public Editor.frames still refuses a running paced edit before capture", async (t) => {
  const m = await fixture(t, "edit");
  await assert.rejects(m.editor.frames(m.path, [1500]), /edit is still running/);
  assert.equal(m.capture.calls, 0);
});

test("public Editor.frames refuses a changed project after the screenshot", async (t) => {
  const m = await fixture(t, "pendingWrite");
  m.capture.onCapture = () => {
    m.context.project.editGeneration++;
  };
  await assert.rejects(m.editor.frames(m.path, [1500]), /project changed during capture/);
  assert.equal(m.capture.calls, 1);
});

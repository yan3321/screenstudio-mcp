import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  Desktop,
  DesktopSession,
  HELPER_PATH,
  HOLD,
  desktopAction,
  desktopSessionAction,
  helperArgs,
  helperTimeoutMs,
} from "../dist/studio/desktop.js";

const runHelper = promisify(execFile);

test("desktop schemas and helper args preserve compatibility and support fine timing + down/up", () => {
  assert.deepEqual(helperArgs({ type: "click", x: 10, y: 20 }), ["10", "20"]);
  assert.deepEqual(helperArgs({ type: "click", x: 10, y: 20, settleMs: 0 }), ["10", "20", "0"]);
  assert.deepEqual(helperArgs({ type: "click", x: 10, y: 20, durationMs: 250 }), ["10", "20", "-1", "250"]);
  assert.deepEqual(helperArgs({ type: "click", x: 10, y: 20, settleMs: 0, durationMs: 300 }), [
    "10",
    "20",
    "0",
    "300",
  ]);
  assert.deepEqual(helperArgs({ type: "move", x: 5, y: 6 }), ["5", "6"]);
  assert.deepEqual(helperArgs({ type: "move", x: 5, y: 6, durationMs: 450 }), ["5", "6", "450"]);
  assert.deepEqual(helperArgs({ type: "down", x: 30, y: 40 }), ["30", "40"]);
  assert.deepEqual(helperArgs({ type: "up", x: 30, y: 40 }), ["30", "40"]);
  assert.deepEqual(helperArgs({ type: "type", text: "abc" }), ["abc"]);
  assert.deepEqual(helperArgs({ type: "type", text: "abc", perCharMs: 25 }), ["abc", "25"]);

  assert.ok(desktopSessionAction.safeParse({ type: "down", x: 1, y: 2 }).success);
  assert.ok(desktopSessionAction.safeParse({ type: "up", x: 1, y: 2 }).success);
  assert.ok(desktopAction.safeParse({ type: "click", x: 1, y: 2, settleMs: 0, durationMs: 120 }).success);
  assert.ok(!desktopAction.safeParse({ type: "click", x: -1, y: 2 }).success);

  assert.ok(!desktopAction.safeParse({ type: "down", x: 1, y: 2 }).success);
  assert.equal(helperTimeoutMs({ type: "down", x: 0, y: 0 }), 80000);
  assert.ok(helperTimeoutMs({ type: "type", text: "a".repeat(2000), perCharMs: 120 }) > 2000 * 120);
});

if (process.platform === "darwin") {
  test("native desktop-helper resolves layout keys for typing and handles persistent --stdio sessions", async (t) => {
    const typeA = await runHelper(HELPER_PATH, ["resolve-type-key", "A", "com.apple.keylayout.US"]);
    assert.deepEqual(JSON.parse(typeA.stdout), { resolved: true, keyCode: 0, modifiers: ["shift"] });

    const typeAt = await runHelper(HELPER_PATH, ["resolve-type-key", "@", "com.apple.keylayout.US"]);
    assert.deepEqual(JSON.parse(typeAt.stdout), { resolved: true, keyCode: 19, modifiers: ["shift"] });

    const typeEnter = await runHelper(HELPER_PATH, ["resolve-type-key", "\n", "com.apple.keylayout.US"]);
    assert.deepEqual(JSON.parse(typeEnter.stdout), { resolved: true, keyCode: 36, modifiers: [] });

    const typeEmoji = await runHelper(HELPER_PATH, ["resolve-type-key", "🚀", "com.apple.keylayout.US"]);
    assert.deepEqual(JSON.parse(typeEmoji.stdout), { resolved: false });

    const desktop = new Desktop();
    const hidden = await desktop.hideApp("com.example.nonexistent-demo-kit-app");
    assert.equal(hidden.hidden, false);
    assert.equal(hidden.matchedCount, 0);

    const session = await DesktopSession.open(99999999);
    t.after(() => session.close());

    const res = await session.hideApp("com.example.nonexistent-demo-kit-app");
    assert.equal(res.hidden, false);
    assert.equal(res.matchedCount, 0);

    await assert.rejects(session.bounds(), /Target window is no longer on screen/);
    await assert.rejects(session.hideApp("com.example.nonexistent-demo-kit-app"), /closed/);

    await session.close();
  });
}

// This executable only returns fixture JSON. It never imports Cocoa or sends input.
async function timingHelper(t) {
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "ss-key-timing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "helper.cjs");
  await writeFile(
    path,
    `#!${process.execPath}
const { createInterface } = require('node:readline');
const state = { pid: 123, bounds: { x: 0, y: 0, width: 800, height: 600 } };
function answer(request) {
  if (request.action === 'inspect' || request.action === 'bounds') return { ok: true, result: state };
  if (request.action !== 'type' && request.action !== 'key') throw Error('Unexpected fixture action');
  const partial = request.text === 'Aé👩‍💻!';
  const onsetsMs = request.action === 'key' ? [1700000000321.125]
    : request.text === '' ? []
    : partial ? [1700000000321.125, 1700000000368.875]
    : [1700000000321.125, 1700000000368.875, 1700000000579.25];
  const timing = { clock: 'unix-ms', onsetsMs, endAtMs: onsetsMs.length ? onsetsMs.at(-1) + 18.5 : null };
  return partial ? { ok: false, error: 'Focus lost after two graphemes', result: timing }
    : { ok: true, result: { action: request.action, windowId: 123, performed: true, atMs: 1700000000000, ...timing } };
}
if (process.argv[2] === '--stdio') {
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    console.log(JSON.stringify({ id: request.id, ...answer(request) }));
  });
} else {
  const response = answer({ action: process.argv[2], text: process.argv[4] });
  console.log(JSON.stringify(response.result));
  if (!response.ok) { console.error(response.error); process.exitCode = 1; }
}
`,
  );
  await chmod(path, 0o700);
  return path;
}

const typedTiming = {
  clock: "unix-ms",
  onsetsMs: [1700000000321.125, 1700000000368.875, 1700000000579.25],
  endAtMs: 1700000000597.75,
};
const partialTiming = {
  clock: "unix-ms",
  onsetsMs: typedTiming.onsetsMs.slice(0, 2),
  endAtMs: 1700000000387.375,
};
const keyTiming = {
  clock: "unix-ms",
  onsetsMs: typedTiming.onsetsMs.slice(0, 1),
  endAtMs: 1700000000339.625,
};
function timingOf(result) {
  const { clock, onsetsMs, endAtMs } = result;
  return { clock, onsetsMs, endAtMs };
}

test("perform preserves completed typing timing and the failing step through SDK and MCP errors", async () => {
  const { DesktopInputError } = await import("../dist/studio/desktop.js");
  const { register } = await import("../dist/mcp/tools/desktop.js");
  const desktop = new Desktop();
  const steps = [
    { action: { type: "type", text: "first" }, holdMs: 0 },
    { action: { type: "type", text: "second" }, holdMs: 0 },
  ];
  const completedSteps = [{ type: "type", holdMs: 0, ...typedTiming }];
  const tools = new Map();
  register({ registerTool: (name, _config, handler) => tools.set(name, handler) }, { studio: {}, desktop });
  for (const failure of [
    new DesktopInputError("Focus lost after one key", keyTiming),
    new Error("Helper disconnected"),
  ]) {
    desktop.run = async (action, _windowId, args) => {
      if (action === "inspect") return { pid: 123, bounds: { x: 0, y: 0, width: 800, height: 600 } };
      assert.equal(action, "type");
      if (args[0] === "first") return typedTiming;
      throw failure;
    };
    const timing = {
      ...(failure instanceof DesktopInputError ? keyTiming : {}),
      completedSteps,
      failedStepIndex: 1,
    };
    const token = async () => (await desktop.inspect(123)).observationToken;
    await assert.rejects(desktop.perform(await token(), steps), (error) => {
      assert.ok(error instanceof DesktopInputError);
      assert.match(error.message, /Step 2 \(type\) failed after 1 completed/);
      assert.deepEqual(error.timing, timing);
      return true;
    });
    const response = await tools.get("screenstudio_desktop_perform")(
      { observationToken: await token(), steps, pace: 1 },
      {},
    );
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /Step 2 \(type\) failed after 1 completed/);
    assert.deepEqual(JSON.parse(response.content[1].text), timing);
  }
});

if (process.platform === "darwin") {
  test("persistent typing preserves uneven measured grapheme and shortcut timing, including partial failure", async (t) => {
    const { DesktopInputError } = await import("../dist/studio/desktop.js");
    const session = await DesktopSession.open(123, 1, await timingHelper(t));
    t.after(() => session.close());
    // A, combining e + acute, and a ZWJ emoji are three graphemes, not six codepoints.
    const typed = await session.send({ type: "type", text: "Ae\u0301👩‍💻", perCharMs: 25 });
    assert.deepEqual(timingOf(typed), typedTiming);
    assert.equal(typed.onsetsMs.length, 3);
    assert.ok(typed.onsetsMs[0] > typed.atMs);
    const key = await session.send({ type: "key", key: "k", modifiers: ["command"] });
    assert.deepEqual(timingOf(key), keyTiming);
    const empty = await session.send({ type: "type", text: "" });
    assert.deepEqual(timingOf(empty), { clock: "unix-ms", onsetsMs: [], endAtMs: null });
    await assert.rejects(session.send({ type: "type", text: "Ae\u0301👩‍💻!" }), (error) => {
      assert.ok(error instanceof DesktopInputError);
      assert.match(error.message, /Focus lost/);
      assert.deepEqual(error.timing, partialTiming);
      return true;
    });
    await assert.rejects(session.bounds(), /closed/);
  });

  test("one-shot SDK and MCP action/perform results retain native timing and partial error receipts", async (t) => {
    const { z } = await import("zod");
    const { DesktopInputError } = await import("../dist/studio/desktop.js");
    const { register } = await import("../dist/mcp/tools/desktop.js");
    const desktop = new Desktop(await timingHelper(t));
    const tools = new Map();
    register(
      {
        registerTool(name, config, handler) {
          tools.set(name, async (args) => handler(z.object(config.inputSchema).parse(args), {}));
        },
      },
      { studio: {}, desktop },
    );
    const token = async () => (await desktop.inspect(123)).observationToken;
    const action = { type: "type", text: "Ae\u0301👩‍💻", perCharMs: 25 };
    const direct = await desktop.action(await token(), action);
    assert.equal(direct.performed, true);
    assert.equal(direct.atMs, 1700000000000);
    assert.deepEqual(timingOf(direct), typedTiming);
    const call = (name, args) => tools.get(`screenstudio_desktop_${name}`)(args);
    for (const [input, expected] of [
      [action, typedTiming],
      [{ type: "key", key: "k", modifiers: ["command"] }, keyTiming],
      [
        { type: "type", text: "" },
        { clock: "unix-ms", onsetsMs: [], endAtMs: null },
      ],
    ]) {
      const response = await call("action", { observationToken: await token(), action: input });
      assert.equal(response.isError, undefined);
      assert.deepEqual(timingOf(JSON.parse(response.content[0].text)), expected);
    }
    const beat = await call("perform", {
      observationToken: await token(),
      steps: [{ action, holdMs: 0 }],
    });
    const performed = JSON.parse(beat.content[0].text);
    assert.equal(performed.performed, 1);
    assert.deepEqual(performed.steps, [{ type: "type", holdMs: 0, ...typedTiming }]);
    const failing = { type: "type", text: "Ae\u0301👩‍💻!" };
    await assert.rejects(desktop.action(await token(), failing), (error) => {
      assert.ok(error instanceof DesktopInputError);
      assert.deepEqual(error.timing, partialTiming);
      return true;
    });
    for (const name of ["action", "perform"]) {
      const response = await call(name, {
        observationToken: await token(),
        ...(name === "action" ? { action: failing } : { steps: [{ action: failing, holdMs: 0 }] }),
      });
      assert.equal(response.isError, true);
      assert.match(response.content[0].text, /Focus lost after two graphemes/);
      assert.deepEqual(JSON.parse(response.content[1].text), {
        ...partialTiming,
        ...(name === "perform" && { completedSteps: [], failedStepIndex: 0 }),
      });
    }
  });
}

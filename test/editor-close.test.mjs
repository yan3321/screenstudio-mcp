import assert from "node:assert/strict";
import test from "node:test";
import { closeSavedScript, closeWithoutSaveScript } from "../dist/studio/editor/save.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test("closing an editor replies before the window closes and holds the barrier until then", async () => {
  const path = "/fixture.screenstudio";
  const closed = [];
  const targetWindow = { onbeforeunload: () => "stay", close: () => closed.push("closed") };
  const context = { project: { editGeneration: 1, isDirty: false }, view: { targetWindow } };
  const busy = {};
  const ss = { edit: () => context, get: () => context, busy: () => busy };
  const timers = [];
  const result = await new AsyncFunction("__ss", "setTimeout", closeWithoutSaveScript(path))(ss, (fn) =>
    timers.push(fn),
  );
  assert.equal(result, true);
  assert.deepEqual(closed, []);
  assert.ok(busy[path]);
  assert.equal(timers.length, 1);
  timers[0]();
  assert.deepEqual(closed, ["closed"]);
  assert.equal(targetWindow.onbeforeunload, null);
  assert.equal(busy[path], undefined);
});

test("a dirty editor is left open and its barrier released", async () => {
  const path = "/fixture.screenstudio";
  const context = {
    project: { editGeneration: 1, isDirty: true },
    view: { targetWindow: { close: () => assert.fail("must not close") } },
  };
  const busy = {};
  const ss = { edit: () => context, get: () => context, busy: () => busy };
  await assert.rejects(
    new AsyncFunction("__ss", "setTimeout", closeWithoutSaveScript(path))(ss, () => assert.fail("no timer")),
    /unsaved edits/,
  );
  assert.equal(busy[path], undefined);
});

test("a saved close holds the barrier again until the window closes", async () => {
  const path = "/fixture.screenstudio";
  const closed = [];
  const project = { editGeneration: 1, isDirty: false, serialize: () => ({ json: {} }) };
  const context = { project, view: { targetWindow: { close: () => closed.push("closed") } } };
  const busy = {};
  const ss = { edit: () => context, get: () => context, busy: () => busy };
  const save = async (c, data, generation, barrier) => {
    barrier.kind = "pendingWrite";
    delete busy[path];
    return { saved: true };
  };
  const timers = [];
  const script = closeSavedScript(path, "save-1");
  const result = await new AsyncFunction("__ss", "__ssSave", "setTimeout", script)(ss, save, (fn) =>
    timers.push(fn),
  );
  assert.deepEqual(result, { saved: true });
  assert.equal(busy[path].kind, "edit");
  timers[0]();
  assert.deepEqual(closed, ["closed"]);
  assert.equal(busy[path], undefined);
});

test("an editor changed by hand after the reply is left open", async () => {
  const path = "/fixture.screenstudio";
  const project = { editGeneration: 1, isDirty: false };
  const context = { project, view: { targetWindow: { close: () => assert.fail("must not close") } } };
  const busy = {};
  const ss = { edit: () => context, get: () => context, busy: () => busy };
  const timers = [];
  await new AsyncFunction("__ss", "setTimeout", closeWithoutSaveScript(path))(ss, (fn) => timers.push(fn));
  project.editGeneration = 2;
  timers[0]();
  assert.equal(busy[path], undefined);
});

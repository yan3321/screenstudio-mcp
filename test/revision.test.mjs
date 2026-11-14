import test, { after } from "node:test";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Studio } from "../dist/studio/service.js";
import assert from "node:assert/strict";
import {
  canonicalProjectJSON,
  editProjectValue,
  keyedEditRevisionFingerprint,
  keyedRevisionFingerprint,
  projectJSONValue,
  publicSnapshot,
  revisionFingerprint,
} from "../dist/studio/editor/revision.js";
import { register as registerEditor } from "../dist/mcp/tools/editor.js";
import { projectEditFingerprint } from "../dist/studio/project.js";
import { Editor } from "../dist/studio/editor/editor.js";

const temporaryStates = new Set();
after(() => {
  for (const directory of temporaryStates) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  return {
    version: "4.0.0",
    lastSavedAt: "old",
    scenes: [
      {
        id: "scene",
        name: "Fixture",
        customNativeField: { keep: true },
        slices: [
          {
            id: "slice",
            sourceStartMs: 0.125,
            sourceEndMs: 3000.875,
            timeScale: 0.5,
            volume: 0.7,
            systemAudioVolume: 0.4,
            hideCursor: true,
            disableSmoothMouseMovement: true,
          },
        ],
        zooms: [
          {
            id: "zoom",
            sourceStartMs: 1000.125,
            sourceEndMs: 2000.875,
            type: "manual",
            zoom: 1.7,
            manualTargetPoint: { x: 0.2, y: 0.8 },
            presentation: "loupe",
            loupeOptions: { radius01: 0.18 },
          },
        ],
        layouts: [],
        masks: [],
        voiceOvers: [],
      },
    ],
    config: {
      animations: { screenMovementSpring: {}, mouseMovementSpring: {}, motionBlurAmount: 1 },
      zooms: { startAnimationEarly: true },
      cursor: { size: 48 },
      output: { paddingRatio01: 0.08 },
      styles: { background: { type: "color", color: "#111111" }, screenBorderRadius: 12 },
      processing: { sensitiveDataCustomPhrases: ["private-fixture"] },
    },
  };
}

function editorModel(data, options = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "sdk-revision-test-"));
  temporaryStates.add(stateDir);
  let serializations = 0;
  const payloads = [];
  const context = {
    project: {
      path: "/owned.screenstudio",
      name: "Fixture",
      editGeneration: Object.hasOwn(options, "generation") ? options.generation : 7,
      isDirty: options.dirty ?? false,
      playbackDurationMs: 6000,
      sourceDurationMs: 3001,
      history: { canUndo: true, canRedo: false },
      serialize: () => {
        serializations++;
        return structuredClone(data);
      },
    },
    playback: { isDestroyed: false, playbackTimeMs: 0, isPlaying: false },
    view: { targetWindow: { document: null, focus: () => assert.fail("must not focus") } },
    exportManager: {},
  };
  const body = { __reactFiberFixture: { memoizedProps: { context } }, querySelectorAll: () => [] };
  const document = { body, querySelectorAll: () => [] };
  context.view.targetWindow.document = document;
  const window = {
    $$focused: context,
    lastActiveWindow: context.view.targetWindow,
    __ssmcpBusy: options.busy ? { "/owned.screenstudio": { since: 0 } } : {},
  };
  const calls = [];
  const editor = new Editor({
    path: async (path) => path,
    requireVersion: async (mode) => {
      calls.push(mode);
      return "4.1.0-5005";
    },
    statePath: async (name) => join(stateDir, name),
    evaluate: async (code) => {
      const result = new Function("window", code)(window);
      payloads.push(result);
      return result;
    },
  });
  editor.saveNow = async () => assert.fail("snapshot must not save");
  return { editor, calls, stateDir, payloads, serializations: () => serializations };
}

test("versioned fingerprint sorts object keys, preserves array order and keeps legacy hashing unchanged", () => {
  const first = { scenes: [{ id: "a" }, { id: "b" }], config: { cursor: { size: 48, hide: false } } };
  const reordered = { config: { cursor: { hide: false, size: 48 } }, scenes: [{ id: "a" }, { id: "b" }] };
  assert.deepEqual(revisionFingerprint(first), revisionFingerprint(reordered));
  assert.notEqual(projectEditFingerprint(first), projectEditFingerprint(reordered));
  assert.notDeepEqual(
    revisionFingerprint(first),
    revisionFingerprint({ ...first, scenes: [...first.scenes].reverse() }),
  );
});

test("only the top-level save timestamp is excluded and input data remains unchanged", () => {
  const data = fixture();
  const before = structuredClone(data);
  assert.deepEqual(revisionFingerprint(data), revisionFingerprint({ ...data, lastSavedAt: "new" }));
  assert.notDeepEqual(
    revisionFingerprint(data),
    revisionFingerprint({ ...data, config: { ...data.config, lastSavedAt: "different-setting" } }),
  );
  assert.deepEqual(data, before);
});

test("exact snapshot preserves native precision, unknown scene content and per-clip fields in one serialization", async () => {
  const data = fixture();
  const model = editorModel(data);
  const snapshot = await model.editor.snapshot("/owned.screenstudio");
  assert.equal(model.serializations(), 1);
  assert.deepEqual(model.calls, ["read"]);
  assert.deepEqual(snapshot.project.scenes, data.scenes);
  assert.equal(snapshot.editGeneration, 7);
  assert.equal(snapshot.editRunning, false);
  assert.equal(snapshot.unsavedChanges, false);
  assert.equal(snapshot.revisionFingerprint.algorithm, "hmac-sha256");
  assert.notEqual(snapshot.revisionFingerprint.sha256, revisionFingerprint(data).sha256);
  assert.equal(snapshot.legacyExportFence.status, "unavailable");
  assert.equal(snapshot.appVersion, "4.1.0-5005");
  assert.equal(snapshot.schema, "4.0.0");
});

test("public snapshot redacts phrases without mutating native data or excluding them from the private fingerprint", () => {
  const data = fixture();
  const before = structuredClone(data);
  const snapshot = publicSnapshot(data);
  assert.equal(JSON.stringify(snapshot).includes("private-fixture"), false);
  assert.deepEqual(snapshot.redactedPaths, ["config.processing.sensitiveDataCustomPhrases"]);
  assert.deepEqual(data, before);
  const changed = structuredClone(data);
  changed.config.processing.sensitiveDataCustomPhrases = ["different-private-fixture"];
  assert.deepEqual(publicSnapshot(changed), snapshot);
  assert.notDeepEqual(revisionFingerprint(changed), revisionFingerprint(data));
});

test("raw state and state-with-config each bind their fields and fingerprint to one serialization", async () => {
  const data = fixture();
  const first = editorModel(data);
  const raw = await first.editor.raw("/owned.screenstudio");
  assert.equal(first.serializations(), 1);
  assert.equal(Object.hasOwn(first.payloads[0], "scenes"), false);
  assert.equal(Object.hasOwn(first.payloads[0], "config"), false);
  assert.equal(raw.editFingerprint, projectEditFingerprint(data));
  const second = editorModel(data);
  const state = await second.editor.stateWithConfig("/owned.screenstudio");
  assert.equal(second.serializations(), 1);
  assert.equal(state.config.cursor.size, 48);
  assert.equal(state.editFingerprint, raw.editFingerprint);
});

test("private phrase guesses cannot reconstruct a snapshot fence and private authority survives SDK instances", async () => {
  const data = fixture();
  const model = editorModel(data);
  const first = await model.editor.snapshot("/owned.screenstudio");
  const second = await model.editor.snapshot("/owned.screenstudio");
  assert.deepEqual(first.revisionFingerprint, second.revisionFingerprint);
  const guessed = structuredClone(first.project);
  guessed.config.processing.sensitiveDataCustomPhrases = ["private-fixture"];
  assert.notEqual(revisionFingerprint(guessed).sha256, first.revisionFingerprint.sha256);
  assert.equal(first.legacyExportFence.status, "unavailable");
  assert.equal(JSON.stringify(first).includes(projectEditFingerprint(data)), false);
  const key = join(model.stateDir, "revision-integrity.key");
  const fromAnotherInstance = await keyedEditRevisionFingerprint(data, key);
  assert.deepEqual(fromAnotherInstance, first.revisionFingerprint);
  if (process.platform !== "win32") assert.equal(statSync(key).mode & 0o077, 0);
});

test("an invalid existing integrity key fails without rotation or data disclosure", async () => {
  const model = editorModel(fixture());
  const key = join(model.stateDir, "revision-integrity.key");
  writeFileSync(key, "bad-key", { mode: 0o600 });
  await assert.rejects(model.editor.snapshot("/owned.screenstudio"), /integrity key is invalid/);
  assert.equal(readFileSync(key, "utf8"), "bad-key");
});

test("concurrent first-use snapshots share one private integrity authority", async () => {
  const model = editorModel(fixture());
  const key = join(model.stateDir, "revision-integrity.key");
  const results = await Promise.all(
    Array.from({ length: 12 }, () => keyedRevisionFingerprint(fixture(), key)),
  );
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(readFileSync(key).length, 32);
  if (process.platform !== "win32") assert.equal(statSync(key).mode & 0o077, 0);
});

test("edit identity excludes only the observed view position and retains exact snapshot content", async () => {
  const data = fixture();
  data.data = { "last-playback-position-source-time-ms": 10, unrelated: "preserve" };
  const before = structuredClone(data);
  const moved = structuredClone(data);
  moved.data["last-playback-position-source-time-ms"] = 200;
  const model = editorModel(data);
  const snapshot = await model.editor.snapshot("/owned.screenstudio");
  const key = join(model.stateDir, "revision-integrity.key");
  assert.equal(snapshot.revisionFingerprint.version, 3);
  assert.equal(snapshot.revisionBasis, "native-edit");
  assert.deepEqual(snapshot.project.data, data.data);
  assert.deepEqual(snapshot.revisionFingerprint, await keyedEditRevisionFingerprint(moved, key));
  assert.notDeepEqual(await keyedRevisionFingerprint(data, key), await keyedRevisionFingerprint(moved, key));
  moved.data.unrelated = "changed";
  assert.notDeepEqual(snapshot.revisionFingerprint, await keyedEditRevisionFingerprint(moved, key));
  moved.data.unrelated = "preserve";
  moved.config.cursor.size = 49;
  assert.notDeepEqual(snapshot.revisionFingerprint, await keyedEditRevisionFingerprint(moved, key));
  assert.deepEqual(data, before);
});

test("edit identity preserves an empty or unknown data shape instead of omitting the entire container", () => {
  assert.deepEqual(editProjectValue({ data: { "last-playback-position-source-time-ms": 20 } }), { data: {} });
  assert.deepEqual(editProjectValue({ data: [20] }), { data: [20] });
  assert.deepEqual(editProjectValue({ data: null }), { data: null });
});

test("an integrity-key symlink is refused without changing its target", async () => {
  const model = editorModel(fixture());
  const target = join(model.stateDir, "other-private-file");
  writeFileSync(target, Buffer.alloc(32), { mode: 0o600 });
  symlinkSync(target, join(model.stateDir, "revision-integrity.key"));
  await assert.rejects(model.editor.snapshot("/owned.screenstudio"), /private regular file/);
  assert.deepEqual(readFileSync(target), Buffer.alloc(32));
});

test("unredacted snapshots supply the legacy export fence from that exact capture", async () => {
  const data = fixture();
  delete data.config.processing.sensitiveDataCustomPhrases;
  const model = editorModel(data);
  const snapshot = await model.editor.snapshot("/owned.screenstudio");
  assert.deepEqual(snapshot.legacyExportFence, {
    status: "available",
    editFingerprint: projectEditFingerprint(data),
  });
  assert.equal(snapshot.revisionFingerprint.algorithm, "hmac-sha256");
  assert.equal(model.serializations(), 1);
});

test("exact duplicate private phrase values are redacted elsewhere and the native source remains intact", () => {
  const data = fixture();
  data.scenes[0].name = "private-fixture";
  data.scenes[0].customNativeField.label = "private-fixture";
  const snapshot = publicSnapshot(data);
  assert.equal(JSON.stringify(snapshot).includes("private-fixture"), false);
  assert.equal(snapshot.project.scenes[0].name, "[redacted]");
  assert.deepEqual(snapshot.redactedPaths, ["config.processing.sensitiveDataCustomPhrases"]);
  assert.equal(snapshot.redactedValueCount, 2);
  assert.equal(snapshot.projectExact, false);
  assert.equal(data.scenes[0].name, "private-fixture");
});

test("non-finite native values are refused while documented JSON normalization stays explicit", async () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const data = fixture();
    data.scenes[0].slices[0].sourceEndMs = value;
    await assert.rejects(editorModel(data).editor.snapshot("/owned.screenstudio"), /non-finite/);
    assert.throws(() => revisionFingerprint(data), /non-finite/);
  }
  const normalized = projectJSONValue({ missing: undefined, zero: -0, scenes: [] });
  assert.deepEqual(normalized, { zero: 0, scenes: [] });
  assert.equal(Object.is(normalized.zero, -0), false);
});

test("missing generation and unsupported native shapes fail before issuing a fence", async () => {
  await assert.rejects(
    editorModel(fixture(), { generation: undefined }).editor.snapshot("/owned.screenstudio"),
    /shape is unsupported/,
  );
  const data = fixture();
  delete data.scenes;
  await assert.rejects(editorModel(data).editor.snapshot("/owned.screenstudio"), /shape is unsupported/);
});

test("busy and dirty observations are reported without changing the project", async () => {
  const data = fixture();
  const snapshot = await editorModel(data, { busy: true, dirty: true }).editor.snapshot(
    "/owned.screenstudio",
  );
  assert.equal(snapshot.editRunning, true);
  assert.equal(snapshot.unsavedChanges, true);
});

test("the snapshot tool boundary is read-only and never emits the private phrase or its legacy hash", async () => {
  const model = editorModel(fixture());
  const tools = new Map();
  registerEditor(
    { registerTool: (name, metadata, handler) => tools.set(name, { metadata, handler }) },
    { editor: model.editor },
  );
  const tool = tools.get("screenstudio_editor_snapshot");
  assert.equal(tool.metadata.annotations.readOnlyHint, true);
  const result = await tool.handler({ projectPath: "/owned.screenstudio" });
  assert.equal(result.isError, undefined);
  const json = result.content.at(-1).text;
  assert.equal(json.includes("private-fixture"), false);
  assert.equal(json.includes(projectEditFingerprint(fixture())), false);
  assert.equal(JSON.parse(json).revisionFingerprint.algorithm, "hmac-sha256");
});

test("an unsupported major build rejects before project evaluation and an untested 4.x build remains observable", async () => {
  const studio = new Studio();
  const stateDir = mkdtempSync(join(tmpdir(), "sdk-revision-build-"));
  temporaryStates.add(stateDir);
  studio.statePath = async (name) => join(stateDir, name);
  studio.path = async (path) => path;
  studio.version = async () => "3.0.0";
  let evaluated = 0;
  const data = fixture();
  delete data.config.processing.sensitiveDataCustomPhrases;
  studio.evaluate = async () => {
    evaluated++;
    return { project: data, editGeneration: 1, editRunning: false, unsavedChanges: false };
  };
  const editor = new Editor(studio);
  await assert.rejects(editor.snapshot("/owned.screenstudio"), /Unsupported Screen Studio build/);
  assert.equal(evaluated, 0);
  studio.version = async () => "4.2.0-untested";
  const snapshot = await editor.snapshot("/owned.screenstudio");
  assert.equal(snapshot.appVersion, "4.2.0-untested");
  assert.equal(snapshot.revisionFingerprint.version, 2);
  assert.equal(snapshot.revisionBasis, "serialized-content");
  assert.equal(evaluated, 1);
});

test("the SDK V2 opaque hash has a fixed Unicode, fractional-number and numeric-key vector", () => {
  const data = {
    version: "4.0.0",
    config: { "\ue000": "bmp", "\u{10000}": "astral", 10: 1e-7, 2: -0 },
    scenes: [{ id: "α" }],
    lastSavedAt: "irrelevant",
  };
  assert.equal(
    revisionFingerprint(data).sha256,
    "00d6ce878198b5223a64edfaaadb2288c6cdca100b59d509fbd9dd2f7a9b6c7a",
  );
});

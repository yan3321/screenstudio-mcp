import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Editor } from "../dist/studio/editor/editor.js";
import { sameRevisionFingerprint } from "../dist/studio/editor/transaction.js";
import { CommandNotSentError } from "../dist/cdp/client.js";
import { PRELUDE, previewSeekScript } from "../dist/studio/editor/page.js";
import { music, narrate } from "../dist/studio/narration.js";

const directories = new Set();
after(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function model(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sdk-transaction-"));
  directories.add(directory);
  const projectPath = options.realBundle ? join(directory, "Owned.screenstudio") : "/owned.screenstudio";
  const data = {
    version: "4.0.0",
    lastSavedAt: "old",
    data: { "last-playback-position-source-time-ms": 0 },
    config: {
      cursor: { size: 48, hide: false },
      processing: { sensitiveDataCustomPhrases: ["private-fixture"] },
    },
    scenes: [
      {
        id: "scene",
        slices: [{ id: "slice", sourceStartMs: 0, sourceEndMs: 3000, timeScale: 1 }],
        zooms: [],
        layouts: [],
        masks: [],
        voiceOvers: [],
      },
    ],
  };
  if (options.realBundle) {
    mkdirSync(projectPath);
    writeFileSync(join(projectPath, "project.json"), JSON.stringify(data));
  }
  let writes = 0,
    marks = 0,
    lost = false;
  const saved = [];
  const merge = (into, patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (options.ignoreHide && key === "hide") continue;
      if (value && typeof value === "object" && !Array.isArray(value)) merge((into[key] ??= {}), value);
      else into[key] = value;
    }
  };
  const context = {
    project: {
      path: projectPath,
      name: "Owned",
      editGeneration: 1,
      isDirty: false,
      history: { canUndo: false, canRedo: false },
      sourceDurationMs: 3000,
      playbackDurationMs: 3000,
      serialize: () => structuredClone(data),
      scenes: [{ id: "scene" }],
      projectConfig: {
        update: (patch) => {
          writes++;
          merge(data.config, patch);
          context.project.editGeneration++;
          context.project.isDirty = true;
          options.afterUpdate?.(data, context);
        },
      },
      markAsJustSaved: () => {
        marks++;
        context.project.isDirty = false;
        options.afterMark?.(data, context);
      },
    },
    playback: {
      isDestroyed: false,
      pause() {},
      goTo(ms) {
        this.playbackTimeMs = ms;
      },
      playbackTimeMs: 0,
    },
    view: { targetWindow: { document: null } },
    exportManager: {},
  };
  const body = { __reactFiberFixture: { memoizedProps: { context } }, querySelectorAll: () => [] };
  context.view.targetWindow.document = { body };
  const window = { $$focused: context, lastActiveWindow: context.view.targetWindow };
  const crypto = {
    ...webcrypto,
    subtle: {
      digest: async (...args) => {
        await options.duringDigest?.(data, context);
        return webcrypto.subtle.digest(...args);
      },
    },
    getRandomValues: (array) => webcrypto.getRandomValues(array),
  };
  const bridge = {
    client: {
      mutation: (route, input) => {
        assert.equal(route, "project.updateProject");
        saved.push(structuredClone(input.data));
        if (options.dispatchThrows) throw new Error("private-fixture");
        return (async () => {
          if (options.saveFails) throw new Error("private-fixture");
          await options.duringSave?.(data, context);
          return options.nativeResult;
        })();
      },
    },
  };
  const studio = {
    stateDir: directory,
    path: async (p) => p,
    statePath: async (name) => join(directory, name),
    requireVersion: async () => "4.1.0-5005",
    isRunning: async () => true,
    evaluate: async (code) => {
      if (code.includes("try { return await __ssSave(c, data, generation, barrier,"))
        options.beforeSaveEvaluation?.(window);
      const transaction = code.includes("const receipts = window.__ssmcpRevisionReceipts");
      if (transaction) {
        assert.equal(
          readdirSync(directory).some((name) => name.endsWith(".intent.json")),
          true,
        );
      }
      if (transaction) options.beforeRenderer?.(data, context);
      const result = await new AsyncFunction("window", "crypto", "TextEncoder", "bridge", "setTimeout", code)(
        window,
        crypto,
        TextEncoder,
        bridge,
        (callback, ms, ...args) =>
          setTimeout(callback, ms === 45000 ? (options.saveTimeoutMs ?? ms) : ms, ...args),
      );
      if (transaction && options.loseResponse && !lost) {
        lost = true;
        throw new Error("transport disconnected");
      }
      return structuredClone(result);
    },
  };
  return {
    editor: new Editor(studio),
    studio,
    data,
    window,
    context,
    body,
    directory,
    saved,
    writes: () => writes,
    marks: () => marks,
  };
}
const ops = [{ op: "config", changes: { "cursor.size": 49 } }];

async function request(m, extra = {}) {
  return {
    mutationId: randomUUID(),
    expectedFingerprint: (await m.editor.snapshot("/owned.screenstudio")).revisionFingerprint,
    save: false,
    ...extra,
  };
}

test("fenced batch returns exact keyed pre/post receipts without private project data", async () => {
  const m = model();
  const q = await request(m);
  const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.equal(result.status, "applied");
  assert.equal(result.phase, "complete");
  assert.equal(result.saved, false);
  assert.deepEqual(result.beforeFingerprint, q.expectedFingerprint);
  assert.deepEqual(
    result.afterFingerprint,
    (await m.editor.snapshot("/owned.screenstudio")).revisionFingerprint,
  );
  assert.notDeepEqual(result.beforeFingerprint, result.afterFingerprint);
  assert.equal(m.writes(), 1);
  assert.equal(m.saved.length, 0);
  const receipt = readFileSync(join(m.directory, `mutation-${q.mutationId}.json`), "utf8");
  assert.equal(receipt.includes("private-fixture"), false);
  const evidence = JSON.parse(receipt);
  assert.equal(Object.hasOwn(evidence, "before"), false);
  assert.equal(Object.hasOwn(evidence, "after"), false);
  assert.equal(Object.hasOwn(evidence, "config"), false);
  assert.equal(
    readdirSync(m.directory).some((n) => n.endsWith(".tmp")),
    false,
  );
});

test("equal-generation content edit during preparation refuses before any op", async () => {
  const m = model({
    beforeRenderer: (data) => {
      data.config.cursor.hide = true;
    },
  });
  const q = await request(m);
  const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.equal(result.status, "notApplied");
  assert.equal(result.reason, "baseMismatch");
  assert.equal(m.writes(), 0);
  assert.equal(m.data.config.cursor.hide, true);
});

test("content change during WebCrypto await refuses despite unchanged generation", async () => {
  const m = model({
    duringDigest: (data) => {
      data.config.cursor.hide = true;
    },
  });
  const q = await request(m);
  const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.equal(result.status, "notApplied");
  assert.equal(m.writes(), 0);
});

test("navigation while preparing is allowed and full post content is captured synchronously", async () => {
  const m = model({
    beforeRenderer: (data) => {
      data.data["last-playback-position-source-time-ms"] = 800;
    },
  });
  const q = await request(m);
  const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.equal(result.status, "applied");
  assert.equal(m.writes(), 1);
  assert.deepEqual(result.beforeFingerprint, q.expectedFingerprint);
});

test("microtask manual change is not blessed into the batch post fingerprint", async () => {
  const m = model({
    afterUpdate: (data) =>
      queueMicrotask(() => {
        data.config.cursor.hide = true;
      }),
  });
  const q = await request(m);
  const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.equal(result.status, "applied");
  assert.equal(m.data.config.cursor.hide, true);
  const current = (await m.editor.snapshot("/owned.screenstudio")).revisionFingerprint;
  assert.notDeepEqual(result.afterFingerprint, current);
  const next = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, {
    ...q,
    mutationId: randomUUID(),
    expectedFingerprint: result.afterFingerprint,
  });
  assert.equal(next.status, "notApplied");
  assert.equal(m.writes(), 1);
});

test("save writes captured post only and preserves equal-generation manual changes as dirty", async () => {
  const m = model({
    duringSave: (data) => {
      data.config.cursor.hide = true;
    },
  });
  const q = await request(m, { save: true });
  const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.equal(result.saved, true);
  assert.equal(m.saved[0].config.cursor.hide, false);
  assert.equal(m.saved[0].config.cursor.size, 49);
  assert.equal(m.data.config.cursor.hide, true);
  assert.equal(m.marks(), 0);
  assert.equal(m.context.project.isDirty, true);
  assert.notDeepEqual(
    result.afterFingerprint,
    (await m.editor.snapshot("/owned.screenstudio")).revisionFingerprint,
  );
});

test("save failure retains a terminal mutation receipt and never replays the edit", async () => {
  const m = model({ saveFails: true });
  const q = await request(m, { save: true });
  const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.equal(result.status, "applied");
  assert.equal(result.saved, false);
  assert.equal(result.saveFailed, true);
  assert.equal(JSON.stringify(result).includes("private-fixture"), false);
  assert.deepEqual(await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q), result);
  assert.equal(m.writes(), 1);
});

test("lost response is recovered from the renderer receipt by a new SDK instance", async () => {
  const m = model({ loseResponse: true });
  const q = await request(m);
  await assert.rejects(
    m.editor.applyRevision("/owned.screenstudio", undefined, ops, q),
    /transport disconnected/,
  );
  assert.equal(m.writes(), 1);
  assert.equal(
    readdirSync(m.directory).some((n) => n === `mutation-${q.mutationId}.json`),
    false,
  );
  const next = new Editor(m.studio);
  const lookup = await next.mutationReceipt("/owned.screenstudio", q.mutationId);
  assert.equal(lookup.found, true);
  assert.equal(lookup.receipt.status, "applied");
  assert.deepEqual(await next.applyRevision("/owned.screenstudio", undefined, ops, q), lookup.receipt);
  assert.equal(m.writes(), 1);
});

test("durable receipt survives renderer loss and a reused ID cannot change its request", async () => {
  const m = model();
  const q = await request(m);
  const first = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  delete m.window.__ssmcpRevisionReceipts;
  m.studio.evaluate = async () => assert.fail("terminal receipt must be available offline");
  const next = new Editor(m.studio);
  assert.deepEqual((await next.mutationReceipt("/owned.screenstudio", q.mutationId)).receipt, first);
  assert.deepEqual(await next.applyRevision("/owned.screenstudio", undefined, ops, q), first);
  await assert.rejects(
    next.applyRevision(
      "/owned.screenstudio",
      undefined,
      [{ op: "config", changes: { "cursor.size": 50 } }],
      q,
    ),
    /different request/,
  );
  assert.equal(m.writes(), 1);
});

test("partial operations stay live with a bound post receipt and no save or automatic restore", async () => {
  const m = model({ ignoreHide: true });
  const q = await request(m, { save: true });
  const result = await m.editor.applyRevision(
    "/owned.screenstudio",
    undefined,
    [...ops, { op: "config", changes: { "cursor.hide": true } }],
    q,
  );
  assert.equal(result.status, "partial");
  assert.equal(result.failedAt, 1);
  assert.equal(m.data.config.cursor.size, 49);
  assert.equal(m.saved.length, 0);
  assert.equal(result.saved, false);
  assert.deepEqual(
    result.afterFingerprint,
    (await m.editor.snapshot("/owned.screenstudio")).revisionFingerprint,
  );
});

test("fingerprint version, authority and algorithm are part of the precondition", async () => {
  const m = model();
  const q = await request(m);
  for (const patch of [{ version: 2 }, { keyId: "0".repeat(16) }, { algorithm: "sha256" }]) {
    const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, {
      ...q,
      mutationId: randomUUID(),
      expectedFingerprint: { ...q.expectedFingerprint, ...patch },
    });
    assert.equal(result.status, "notApplied");
  }
  assert.equal(m.writes(), 0);
  assert.equal(
    sameRevisionFingerprint(q.expectedFingerprint, { ...q.expectedFingerprint, version: 2 }),
    false,
  );
});

test("another SDK observes a pending same-ID mutation without replaying it", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const m = model({ duringDigest: () => gate });
  const q = await request(m);
  const first = m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  const deadline = Date.now() + 2000;
  while (!m.window.__ssmcpRevisionReceipts?.[q.mutationId]) {
    assert.ok(Date.now() < deadline, "first mutation must reach its renderer reservation");
    await new Promise((resolve) => setImmediate(resolve));
  }
  try {
    const other = new Editor(m.studio);
    const pending = await other.applyRevision("/owned.screenstudio", undefined, ops, q);
    assert.equal(pending.phase, "preparing");
    assert.equal(m.writes(), 0);
    await assert.rejects(
      other.applyRevision("/owned.screenstudio", undefined, ops, { ...q, save: true }),
      /different request/,
    );
  } finally {
    release();
  }
  const result = await first;
  assert.equal(result.phase, "complete");
  assert.equal(result.status, "applied");
  assert.equal(m.writes(), 1);
});

test("lost response plus renderer loss stays unresolved even when content returns to the original base", async () => {
  const m = model({ loseResponse: true });
  const q = await request(m);
  await assert.rejects(
    m.editor.applyRevision("/owned.screenstudio", undefined, ops, q),
    /transport disconnected/,
  );
  delete m.window.__ssmcpRevisionReceipts;
  m.data.config.cursor.size = 48;
  const next = new Editor(m.studio);
  const lookup = await next.mutationReceipt("/owned.screenstudio", q.mutationId);
  assert.equal(lookup.found, true);
  assert.equal(lookup.receipt.phase, "unresolved");
  assert.equal(lookup.receipt.status, "unknown");
  assert.equal(Object.hasOwn(lookup.receipt, "beforeFingerprint"), false);
  const retry = await next.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.deepEqual(retry, lookup.receipt);
  assert.equal(m.writes(), 1);
  await assert.rejects(
    next.applyRevision(
      "/owned.screenstudio",
      undefined,
      [{ op: "config", changes: { "cursor.size": 50 } }],
      q,
    ),
    /different request/,
  );
  const intent = readFileSync(join(m.directory, `mutation-${q.mutationId}.intent.json`), "utf8");
  assert.equal(intent.includes("private-fixture"), false);
  assert.equal(Object.hasOwn(JSON.parse(intent), "ops"), false);
});

test("closed and reopened context during hashing is refused before any edit or save", async () => {
  let m;
  m = model({
    duringDigest: (_data, context) => {
      const replacement = {
        ...context,
        project: {
          ...context.project,
          serialize: () => ({
            ...structuredClone(m.data),
            config: { ...m.data.config, cursor: { size: 50, hide: false } },
          }),
        },
      };
      m.body.__reactFiberFixture.memoizedProps.context = replacement;
      m.window.$$focused = replacement;
    },
  });
  const q = await request(m, { save: true });
  const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.equal(result.status, "notApplied");
  assert.equal(m.writes(), 0);
  assert.equal(m.saved.length, 0);
});

test("replacing the project model on the same context during hashing is also refused", async () => {
  const m = model({
    duringDigest: (_data, context) => {
      context.project = { ...context.project };
    },
  });
  const q = await request(m);
  const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.equal(result.status, "notApplied");
  assert.equal(m.writes(), 0);
});

test("renderer busy refusal is terminal and does not disturb the other writer", async () => {
  let m;
  const other = { since: 1 };
  m = model({
    beforeRenderer: () => {
      m.window.__ssmcpBusy = { "/owned.screenstudio": other };
    },
  });
  const q = await request(m);
  const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.equal(result.status, "notApplied");
  assert.equal(result.reason, "editorBusy");
  assert.equal(result.phase, "complete");
  assert.equal(m.window.__ssmcpBusy["/owned.screenstudio"], other);
  assert.equal(m.writes(), 0);
  delete m.window.__ssmcpBusy["/owned.screenstudio"];
  assert.deepEqual(await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q), result);
  assert.equal(m.writes(), 0);
});

test("closing the project before dispatch yields a terminal refusal without an invented before snapshot", async () => {
  let m;
  m = model({
    beforeRenderer: () => {
      m.body.__reactFiberFixture.memoizedProps.context = null;
    },
  });
  const q = await request(m);
  const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.equal(result.status, "notApplied");
  assert.equal(result.reason, "projectNotOpen");
  assert.equal(Object.hasOwn(result, "beforeFingerprint"), false);
  assert.deepEqual((await m.editor.mutationReceipt("/owned.screenstudio", q.mutationId)).receipt, result);
  assert.equal(m.writes(), 0);
});

test("known pre-send connection failure persists notDispatched instead of an unresolved intent", async () => {
  const m = model();
  const q = await request(m);
  const original = m.studio.evaluate;
  m.studio.evaluate = async (code) => {
    if (code.includes("const receipts = window.__ssmcpRevisionReceipts"))
      throw new CommandNotSentError(new Error("connection refused"));
    return original(code);
  };
  const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.equal(result.status, "notApplied");
  assert.equal(result.reason, "notDispatched");
  assert.deepEqual(await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q), result);
  assert.equal(m.writes(), 0);
});

test("transient lookup failure is retryable and never confused with an absent receipt", async () => {
  const m = model({ loseResponse: true });
  const q = await request(m);
  await assert.rejects(
    m.editor.applyRevision("/owned.screenstudio", undefined, ops, q),
    /transport disconnected/,
  );
  const original = m.studio.evaluate;
  m.studio.evaluate = async () => {
    throw new Error("temporary connection failure");
  };
  const lookup = await m.editor.mutationReceipt("/owned.screenstudio", q.mutationId);
  assert.equal(lookup.receipt.phase, "awaitingReceipt");
  assert.equal(lookup.receipt.reason, "rendererUnavailable");
  assert.equal(lookup.receipt.retryable, true);
  assert.deepEqual(await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q), lookup.receipt);
  m.studio.evaluate = original;
  const found = await m.editor.mutationReceipt("/owned.screenstudio", q.mutationId);
  assert.equal(found.receipt.status, "applied");
  assert.equal(m.writes(), 1);
});

test("acknowledged renderer entries retain no private project serializations", async () => {
  const m = model();
  const q = await request(m);
  const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  const raw = m.window.__ssmcpRevisionReceipts[q.mutationId];
  assert.equal(raw.persisted, true);
  assert.equal(Object.hasOwn(raw, "before"), false);
  assert.equal(Object.hasOwn(raw, "after"), false);
  assert.equal(JSON.stringify(raw).includes("private-fixture"), false);
  assert.deepEqual((await m.editor.mutationReceipt("/owned.screenstudio", q.mutationId)).receipt, result);
});

test("concurrent recovery lookups publish identical immutable evidence", async () => {
  const m = model({ loseResponse: true });
  const q = await request(m);
  await assert.rejects(
    m.editor.applyRevision("/owned.screenstudio", undefined, ops, q),
    /transport disconnected/,
  );
  const [a, b] = await Promise.all([
    new Editor(m.studio).mutationReceipt("/owned.screenstudio", q.mutationId),
    new Editor(m.studio).mutationReceipt("/owned.screenstudio", q.mutationId),
  ]);
  assert.deepEqual(a, b);
  assert.equal(a.receipt.status, "applied");
  assert.equal(m.writes(), 1);
});

test("native revision writes refuse untested builds even when general write access allows them", async () => {
  const m = model();
  m.studio.requireVersion = async () => "4.2.0-untested";
  const q = await request(m);
  await assert.rejects(
    m.editor.applyRevision("/owned.screenstudio", undefined, ops, q),
    /require the tested/,
  );
  assert.equal(
    readdirSync(m.directory).some((n) => n.endsWith(".intent.json")),
    false,
  );
  assert.equal(m.writes(), 0);
});

test("uppercase UUIDs resolve to one lowercase reservation and renderer identity", async () => {
  const m = model();
  const q = await request(m);
  q.mutationId = q.mutationId.toUpperCase();
  const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.equal(result.mutationId, q.mutationId.toLowerCase());
  assert.deepEqual(
    await m.editor.applyRevision("/owned.screenstudio", undefined, ops, {
      ...q,
      mutationId: q.mutationId.toLowerCase(),
    }),
    result,
  );
  assert.deepEqual((await m.editor.mutationReceipt("/owned.screenstudio", q.mutationId)).receipt, result);
  assert.equal(m.writes(), 1);
});

test("the saved captured object preserves native Date values while receipt identities stay JSON-normalized", async () => {
  const m = model();
  m.data.createdAt = new Date("2026-01-02T03:04:05Z");
  const q = await request(m, { save: true });
  const r = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.equal(r.saved, true);
  assert.ok(m.saved[0].createdAt instanceof Date);
  assert.equal(m.saved[0].createdAt.toISOString(), "2026-01-02T03:04:05.000Z");
  assert.deepEqual(r.afterFingerprint, (await m.editor.snapshot("/owned.screenstudio")).revisionFingerprint);
});

test("an empty guarded batch provides an exact fenced save without replaying an earlier edit", async () => {
  const m = model();
  const q = await request(m, { save: true });
  const r = await m.editor.applyRevision("/owned.screenstudio", undefined, [], q);
  assert.equal(r.status, "applied");
  assert.equal(r.saved, true);
  assert.equal(m.writes(), 0);
  assert.deepEqual(r.beforeFingerprint, r.afterFingerprint);
  assert.equal(m.saved.length, 1);
});

test("startup recovery persists owned completed renderer receipts and compacts their private payloads", async () => {
  const m = model({ loseResponse: true });
  const q = await request(m);
  await assert.rejects(
    m.editor.applyRevision("/owned.screenstudio", undefined, ops, q),
    /transport disconnected/,
  );
  m.studio.isRunning = async () => true;
  const recovered = await new Editor(m.studio).recoverMutationReceipts();
  assert.equal(recovered.recovered, 1);
  assert.equal(m.window.__ssmcpRevisionReceipts[q.mutationId].persisted, true);
  assert.equal(
    (await new Editor(m.studio).mutationReceipt("/owned.screenstudio", q.mutationId)).receipt.status,
    "applied",
  );
  assert.equal(m.writes(), 1);
});

test("checkpoint-only voiceover replacement support does not block a synchronous clear", async () => {
  const m = model();
  m.data.scenes[0].voiceOvers = [{ id: "voice", sourceStartMs: 0, sourceEndMs: 500 }];
  m.context.project.scenes[0].voiceOvers = {
    removeAll: () => {
      m.data.scenes[0].voiceOvers = [];
      m.context.project.editGeneration++;
    },
  };
  const q = await request(m);
  const r = await m.editor.applyRevision(
    "/owned.screenstudio",
    undefined,
    [{ op: "clearTrack", track: "voiceOvers" }],
    q,
  );
  assert.equal(r.status, "applied");
  assert.deepEqual(m.data.scenes[0].voiceOvers, []);
});

test("an already busy snapshot is refused without dispatching or disturbing the renderer", async () => {
  const m = model();
  const other = { since: 1 };
  m.window.__ssmcpBusy = { "/owned.screenstudio": other };
  const q = await request(m);
  let dispatches = 0;
  const original = m.studio.evaluate;
  m.studio.evaluate = async (code) => {
    if (code.includes("const receipts = window.__ssmcpRevisionReceipts")) dispatches++;
    return original(code);
  };
  const r = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.equal(r.status, "notApplied");
  assert.equal(r.reason, "editorBusy");
  assert.equal(dispatches, 0);
  assert.equal(m.writes(), 0);
  assert.equal(m.window.__ssmcpBusy["/owned.screenstudio"], other);
  assert.deepEqual(await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q), r);
});

test("a lookup rereads durable evidence when another recovery compacts between disk and renderer reads", async () => {
  const m = model({ loseResponse: true });
  const q = await request(m);
  await assert.rejects(
    m.editor.applyRevision("/owned.screenstudio", undefined, ops, q),
    /transport disconnected/,
  );
  const original = m.studio.evaluate;
  let interleaved = false;
  m.studio.evaluate = async (code) => {
    if (!interleaved && code.includes("return window.__ssmcpRevisionReceipts?.[")) {
      interleaved = true;
      const other = new Editor({ ...m.studio, evaluate: original });
      const recovered = await other.mutationReceipt("/owned.screenstudio", q.mutationId);
      assert.equal(recovered.receipt.status, "applied");
      assert.equal(m.window.__ssmcpRevisionReceipts[q.mutationId].persisted, true);
    }
    return original(code);
  };
  const result = await new Editor(m.studio).mutationReceipt("/owned.screenstudio", q.mutationId);
  assert.equal(interleaved, true);
  assert.equal(result.found, true);
  assert.equal(result.receipt.status, "applied");
  assert.equal(result.receipt.phase, "complete");
  assert.equal(m.writes(), 1);
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const eventTurn = () => new Promise((resolve) => setImmediate(resolve));

test("a hung fenced save returns a frozen unknown receipt and keeps cross-SDK edits blocked until late completion", async () => {
  const gate = deferred();
  const m = model({ saveTimeoutMs: 5, duringSave: () => gate.promise });
  const q = await request(m, { save: true });
  try {
    const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
    assert.equal(result.saveOutcome, "unknown");
    assert.equal(result.saveReason, "deadline");
    assert.match(result.instanceId, /^[a-f0-9]{32}$/);
    assert.equal(typeof result.startedAtMs, "number");
    assert.equal(result.saved, false);
    assert.equal((await m.editor.snapshot("/owned.screenstudio")).writeQuarantine.phase, "pending");
    const other = new Editor(m.studio);
    await assert.rejects(other.save("/owned.screenstudio"), /unresolved outcome/);
    assert.equal(m.saved.length, 1);
    gate.resolve();
    await eventTurn();
    assert.equal((await m.editor.snapshot("/owned.screenstudio")).writeQuarantine, null);
    assert.equal(m.window.__ssmcpPendingWrites[q.mutationId].phase, "fulfilled");
    assert.equal(m.marks(), 1);
    assert.deepEqual((await other.mutationReceipt("/owned.screenstudio", q.mutationId)).receipt, result);
    assert.deepEqual(await other.applyRevision("/owned.screenstudio", undefined, ops, q), result);
    assert.equal(m.writes(), 1);
    assert.equal(JSON.stringify(m.window.__ssmcpPendingWrites).includes("private-fixture"), false);
  } finally {
    gate.resolve();
    await eventTurn();
  }
});

test("a rejected native save is unknown and does not release the pending-write barrier", async () => {
  const m = model({ saveFails: true });
  const q = await request(m, { save: true });
  const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.equal(result.saveOutcome, "unknown");
  assert.equal(result.saveReason, "nativeRejected");
  assert.equal((await m.editor.snapshot("/owned.screenstudio")).writeQuarantine.phase, "rejected");
  await assert.rejects(m.editor.history("/owned.screenstudio", "undo", 1), /unresolved outcome/);
  assert.equal(m.marks(), 0);
});

test("a legacy save uses the same bounded guard and both close modes leave its editor open", async () => {
  const gate = deferred();
  const m = model({ realBundle: true, saveTimeoutMs: 5, duringSave: () => gate.promise });
  const path = m.context.project.path;
  let closed = false;
  m.context.view.targetWindow.close = () => {
    closed = true;
  };
  try {
    const result = await m.editor.save(path);
    assert.equal(result.saveOutcome, "unknown");
    for (const save of [false, true])
      await assert.rejects(new Editor(m.studio).close(path, { save }), /unresolved outcome/);
    assert.equal(closed, false);
    assert.equal(m.saved.length, 1);
    gate.resolve();
    await eventTurn();
    assert.equal((await m.editor.snapshot(path)).writeQuarantine, null);
    assert.equal(result.saved, false);
  } finally {
    gate.resolve();
    await eventTurn();
  }
});

test("late completion preserves equal-generation manual edits as dirty", async () => {
  const gate = deferred();
  const m = model({ saveTimeoutMs: 5, duringSave: () => gate.promise });
  try {
    await m.editor.save("/owned.screenstudio");
    m.data.config.cursor.size = 72;
    m.context.project.isDirty = true;
    gate.resolve();
    await eventTurn();
    assert.equal(m.marks(), 0);
    assert.equal(m.context.project.isDirty, true);
    assert.equal(m.window.__ssmcpBusy["/owned.screenstudio"], undefined);
  } finally {
    gate.resolve();
    await eventTurn();
  }
});

test("late completion cannot clean a replacement context or release another barrier", async () => {
  const gate = deferred();
  const m = model({ saveTimeoutMs: 5, duringSave: () => gate.promise });
  try {
    await m.editor.save("/owned.screenstudio");
    const replacement = { ...m.context, project: { ...m.context.project } };
    m.body.__reactFiberFixture.memoizedProps.context = replacement;
    const other = { since: Date.now(), kind: "edit", mutationId: "other" };
    m.window.__ssmcpBusy["/owned.screenstudio"] = other;
    gate.resolve();
    await eventTurn();
    assert.equal(m.marks(), 0);
    assert.equal(m.window.__ssmcpBusy["/owned.screenstudio"], other);
  } finally {
    gate.resolve();
    await eventTurn();
  }
});

test("pending save allows live inspection and stable preview but still refuses content changes", async () => {
  const gate = deferred();
  const m = model({ saveTimeoutMs: 5, duringSave: () => gate.promise });
  m.context.view.targetWindow.document.querySelectorAll = () => [];
  try {
    await m.editor.save("/owned.screenstudio");
    assert.deepEqual(await m.editor.liveProject("/owned.screenstudio"), m.data);
    const preview = await m.studio.evaluate(PRELUDE + previewSeekScript("/owned.screenstudio", 1500));
    assert.equal(preview.playheadMs, 1500);
    await assert.rejects(m.editor.seek("/owned.screenstudio", { playbackMs: 0 }), /unresolved outcome/);
    await assert.rejects(m.editor.history("/owned.screenstudio", "undo", 1), /unresolved outcome/);
    assert.equal(m.saved.length, 1);
  } finally {
    gate.resolve();
    await eventTurn();
  }
});

test("save and close preserves manual edits made while a successful save is pending", async () => {
  const gate = deferred();
  const m = model({ realBundle: true, duringSave: () => gate.promise });
  const path = m.context.project.path;
  let closed = false;
  m.context.view.targetWindow.close = () => {
    closed = true;
  };
  const closing = m.editor.close(path, { save: true });
  const refused = assert.rejects(closing, /changed while saving/);
  try {
    while (!m.saved.length) await eventTurn();
    m.data.config.cursor.size = 81;
    m.context.project.isDirty = true;
    gate.resolve();
    await refused;
    assert.equal(closed, false);
    assert.equal(m.context.project.isDirty, true);
    assert.equal(m.saved[0].config.cursor.size, 48);
    assert.equal(m.data.config.cursor.size, 81);
  } finally {
    gate.resolve();
    await refused;
  }
});

test("save and close rechecks exact content after the save helper resumes even at equal generation and clean flag", async () => {
  const m = model({
    realBundle: true,
    afterMark: (data) =>
      queueMicrotask(() => {
        data.config.cursor.size = 82;
      }),
  });
  let closed = false;
  m.context.view.targetWindow.close = () => {
    closed = true;
  };
  await assert.rejects(m.editor.close(m.context.project.path, { save: true }), /changed while saving/);
  assert.equal(closed, false);
  assert.equal(m.marks(), 1);
  assert.equal(m.context.project.isDirty, false);
  assert.equal(m.context.project.editGeneration, 1);
  assert.equal(m.saved[0].config.cursor.size, 48);
});

test("save and close closes the same clean editor after authoritative completion", async () => {
  const m = model({ realBundle: true });
  m.context.project.isDirty = true;
  m.context.view.targetWindow.close = () => {
    m.context.playback.isDestroyed = true;
  };
  assert.deepEqual(await m.editor.close(m.context.project.path, { save: true }), {
    closed: true,
    projectPath: m.context.project.path,
    saved: true,
  });
  assert.equal(m.saved.length, 1);
  assert.equal(m.marks(), 1);
});

test("save observations expose late completion separately from the frozen mutation receipt", async () => {
  const gate = deferred();
  const m = model({ saveTimeoutMs: 5, duringSave: () => gate.promise });
  const q = await request(m, { save: true });
  try {
    const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
    const pending = await m.editor.saveObservation("/owned.screenstudio", result.saveId.toUpperCase());
    assert.equal(pending.observation.phase, "pending");
    m.data.config.cursor.size = 77;
    gate.resolve();
    await eventTurn();
    const late = await m.editor.saveObservation("/owned.screenstudio", result.saveId);
    assert.equal(late.observation.phase, "fulfilled");
    assert.equal(late.observation.diverged, true);
    assert.equal(late.observation.cleanMarked, false);
    assert.equal(late.observation.instanceId, pending.observation.instanceId);
    assert.deepEqual((await m.editor.mutationReceipt("/owned.screenstudio", q.mutationId)).receipt, result);
    assert.equal(JSON.stringify(late).includes("private-fixture"), false);
    await assert.rejects(m.editor.saveObservation("/another.screenstudio", result.saveId), /another project/);
    delete m.window.__ssmcpPendingWrites;
    delete m.window.__ssmcpRendererInstance;
    const missing = await m.editor.saveObservation("/owned.screenstudio", result.saveId, result.instanceId);
    assert.equal(missing.found, false);
    assert.equal(missing.rendererReplaced, true);
  } finally {
    gate.resolve();
    await eventTurn();
  }
});

test("a synchronous native dispatch throw is unknown and retains quarantine", async () => {
  const m = model({ dispatchThrows: true });
  const result = await m.editor.save("/owned.screenstudio");
  assert.equal(result.saveOutcome, "unknown");
  assert.equal(result.saveReason, "dispatchThrew");
  const observation = await m.editor.saveObservation("/owned.screenstudio", result.saveId);
  assert.equal(observation.observation.dispatchThrew, true);
  assert.equal(observation.observation.phase, "rejected");
  await assert.rejects(m.editor.save("/owned.screenstudio"), /unresolved outcome/);
});

test("late rejection updates its observation but never releases the write barrier", async () => {
  const gate = deferred();
  const m = model({
    saveTimeoutMs: 5,
    duringSave: async () => {
      await gate.promise;
      throw new Error("private-fixture");
    },
  });
  try {
    const result = await m.editor.save("/owned.screenstudio");
    gate.resolve();
    await eventTurn();
    const observation = await m.editor.saveObservation("/owned.screenstudio", result.saveId);
    assert.equal(observation.observation.phase, "rejected");
    assert.equal((await m.editor.snapshot("/owned.screenstudio")).writeQuarantine.phase, "rejected");
    assert.equal(result.saveReason, "deadline");
  } finally {
    gate.resolve();
    await eventTurn();
  }
});

test("pending writes refuse narration, music, legacy apply and fresh mutation IDs before side effects", async () => {
  const gate = deferred();
  const m = model({ saveTimeoutMs: 5, duringSave: () => gate.promise });
  try {
    await m.editor.save("/owned.screenstudio");
    await assert.rejects(
      music(m.studio, m.editor, "/owned.screenstudio", {
        track: "unread",
        volume: 1,
        duckUnderSpeech: true,
        duckTo: 0.3,
      }),
      /unresolved outcome/,
    );
    await assert.rejects(
      narrate(m.studio, m.editor, "/owned.screenstudio", {
        lines: [{ sourceMs: 0, text: "Synthetic fixture." }],
      }),
      /unresolved outcome/,
    );
    await assert.rejects(m.editor.apply("/owned.screenstudio", undefined, ops), /unresolved outcome/);
    const q = await request(m);
    await assert.rejects(
      m.editor.applyRevision("/owned.screenstudio", undefined, ops, q),
      /no new mutation intent/,
    );
    assert.equal(
      readdirSync(m.directory).some((name) => name.startsWith("editor-") || name.endsWith(".intent.json")),
      false,
    );
    assert.equal(m.saved.length, 1);
    assert.equal(m.writes(), 0);
  } finally {
    gate.resolve();
    await eventTurn();
  }
});

test("a save-helper preparation refusal preserves the captured applied receipt", async () => {
  const m = model();
  const q = await request(m, { save: true });
  m.window.__ssmcpPendingWrites = {
    [q.mutationId]: { phase: "pending", projectPath: "/other.screenstudio" },
  };
  const result = await m.editor.applyRevision("/owned.screenstudio", undefined, ops, q);
  assert.equal(result.status, "applied");
  assert.equal(result.saveOutcome, "notSent");
  assert.equal(result.saveReason, "saveHelperFailed");
  assert.equal(m.saved.length, 0);
  assert.equal(m.writes(), 1);
  assert.ok(result.afterFingerprint);
  assert.equal(m.window.__ssmcpPendingWrites[q.mutationId].projectPath, "/other.screenstudio");
});

test("guarded save refuses changed content and foreign barriers before native dispatch", async () => {
  const m = model();
  for (const foreign of [false, true]) {
    const result = await m.studio.evaluate(
      PRELUDE +
        `
      const c = __ss.get('/owned.screenstudio');
      const data = structuredClone(c.project.serialize());
      const b = { since: Date.now(), kind: 'edit' };
      const owner = ${foreign} ? { since: Date.now(), kind: 'edit' } : b;
      __ss.busy()['/owned.screenstudio'] = owner;
      if (!${foreign}) data.config.cursor.size = 99;
      const result = await __ssSave(c, data, c.project.editGeneration, b, '${randomUUID()}', 5);
      return { ...result, ownerPreserved: __ss.busy()['/owned.screenstudio'] === owner };
    `,
    );
    assert.equal(result.saveOutcome, "notSent");
    assert.equal(result.ownerPreserved, true);
  }
  assert.equal(m.saved.length, 0);
});

test("aborting a legacy apply during its save cannot cancel the pending native write", async () => {
  const gate = deferred();
  const controller = new AbortController();
  const m = model({
    saveTimeoutMs: 5,
    duringSave: async () => {
      controller.abort();
      await gate.promise;
    },
  });
  try {
    const result = await m.editor.apply("/owned.screenstudio", undefined, ops, undefined, {
      save: true,
      signal: controller.signal,
    });
    assert.equal(result.saveOutcome, "unknown");
    const b = m.window.__ssmcpBusy["/owned.screenstudio"];
    assert.equal(b.kind, "pendingWrite");
    assert.equal(b.cancel, undefined);
    assert.equal(m.writes(), 1);
    assert.equal(m.saved.length, 1);
  } finally {
    gate.resolve();
    await eventTurn();
  }
});

test("legacy apply preserves its checkpoint and applied results when the trailing save evaluation fails", async () => {
  for (const notSent of [false, true]) {
    const failure = notSent
      ? new CommandNotSentError(new Error("connection unavailable"))
      : new Error("reply lost");
    const m = model({
      beforeSaveEvaluation: () => {
        throw failure;
      },
    });
    const result = await m.editor.apply("/owned.screenstudio", undefined, ops, undefined, { save: true });
    assert.equal(result.saved, false);
    assert.equal(result.saveOutcome, notSent ? "notSent" : "unknown");
    assert.equal(result.saveReason, "saveCallFailed");
    assert.ok(result.saveId);
    assert.ok(result.results.length > 0);
    assert.ok(readdirSync(m.directory).includes(`editor-${result.checkpointId}.json`));
    assert.equal(m.writes(), 1);
    assert.equal(m.saved.length, 0);
  }
});

test("legacy apply preserves its checkpoint when a foreign barrier arrives before its trailing save", async () => {
  const foreign = { kind: "pendingWrite", since: Date.now(), saveId: randomUUID() };
  const m = model({
    beforeSaveEvaluation: (window) => {
      window.__ssmcpBusy["/owned.screenstudio"] = foreign;
    },
  });
  const result = await m.editor.apply("/owned.screenstudio", undefined, ops, undefined, { save: true });
  assert.equal(result.saved, false);
  assert.equal(result.saveOutcome, "notSent");
  assert.equal(result.saveReason, "rendererRefused");
  assert.equal(result.writeQuarantine.saveId, foreign.saveId);
  assert.ok(result.checkpointId);
  assert.ok(result.results.length > 0);
  assert.equal(m.saved.length, 0);
  assert.equal(m.window.__ssmcpBusy["/owned.screenstudio"], foreign);
});

test("close without save refuses dirty work unless an exact snapshot explicitly authorizes discard", async () => {
  const m = model({ realBundle: true });
  const path = m.context.project.path;
  m.context.project.isDirty = true;
  let closed = false;
  m.context.view.targetWindow.close = () => {
    closed = true;
    m.context.playback.isDestroyed = true;
  };
  await assert.rejects(m.editor.close(path, { save: false }), /unsaved edits/);
  assert.equal(closed, false);
  const expectedFingerprint = (await m.editor.snapshot(path)).revisionFingerprint;
  m.data.config.cursor.size = 81;
  await assert.rejects(m.editor.close(path, { save: false, expectedFingerprint }), /changed since/);
  assert.equal(closed, false);
  assert.equal(m.marks(), 0);
  const current = (await m.editor.snapshot(path)).revisionFingerprint;
  const result = await m.editor.close(path, { save: false, expectedFingerprint: current });
  assert.equal(result.closed, true);
  assert.equal(result.saved, false);
  assert.equal(closed, true);
  assert.equal(m.saved.length, 0);
});

test("fenced discard refuses a same-generation manual change during renderer hashing", async () => {
  const options = { realBundle: true };
  const m = model(options);
  const path = m.context.project.path;
  m.context.project.isDirty = true;
  let closed = false;
  m.context.view.targetWindow.close = () => {
    closed = true;
  };
  const expectedFingerprint = (await m.editor.snapshot(path)).revisionFingerprint;
  options.duringDigest = (data) => {
    data.config.cursor.size = 83;
  };
  await assert.rejects(m.editor.close(path, { save: false, expectedFingerprint }), /changed since/);
  assert.equal(closed, false);
  assert.equal(m.marks(), 0);
  assert.equal(m.context.project.isDirty, true);
});

test("clean close without save uses the write build gate and never marks unrelated work clean", async () => {
  const m = model({ realBundle: true });
  let kind;
  m.studio.requireVersion = async (value) => {
    kind = value;
    throw new Error("Unsupported Screen Studio build");
  };
  await assert.rejects(m.editor.close(m.context.project.path, { save: false }), /Unsupported/);
  assert.equal(kind, "write");
  assert.equal(m.marks(), 0);
});

test("an unexpected resolved native result never marks the project clean or releases quarantine", async () => {
  for (const nativeResult of [null, { error: "private-fixture" }]) {
    const m = model({ nativeResult });
    const result = await m.editor.save("/owned.screenstudio");
    assert.equal(result.saved, false);
    assert.equal(result.saveOutcome, "unknown");
    assert.equal(result.saveReason, "unexpectedNativeResult");
    assert.match(result.instanceId, /^[a-f0-9]{32}$/);
    assert.equal(m.marks(), 0);
    const observation = await m.editor.saveObservation("/owned.screenstudio", result.saveId);
    assert.equal(observation.observation.phase, "unconfirmed");
    assert.equal(JSON.stringify(observation).includes("private-fixture"), false);
    assert.equal((await m.editor.snapshot("/owned.screenstudio")).writeQuarantine.phase, "unconfirmed");
  }
});

test("direct save retains its preallocated recovery ID after a transport failure", async () => {
  for (const notSent of [false, true]) {
    const failure = notSent
      ? new CommandNotSentError(new Error("connection unavailable"))
      : new Error("reply lost");
    const m = model({
      beforeSaveEvaluation: () => {
        throw failure;
      },
    });
    const result = await m.editor.save("/owned.screenstudio");
    assert.equal(result.saved, false);
    assert.equal(result.saveOutcome, notSent ? "notSent" : "unknown");
    assert.equal(result.saveReason, "saveCallFailed");
    assert.match(result.saveId, /^[a-f0-9-]{36}$/);
    assert.equal(m.saved.length, 0);
  }
});

test("an unconfirmed close save retains its request ID and originating observation", async () => {
  const m = model({ realBundle: true, saveFails: true });
  let closed = false;
  m.context.view.targetWindow.close = () => {
    closed = true;
  };
  let failure;
  try {
    await m.editor.close(m.context.project.path, { save: true });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure?.saveId);
  assert.ok(failure.message.includes(failure.saveId));
  const observed = await m.editor.saveObservation(m.context.project.path, failure.saveId);
  assert.equal(observed.observation.phase, "rejected");
  assert.ok(failure.message.includes(observed.observation.instanceId));
  assert.equal(closed, false);
});

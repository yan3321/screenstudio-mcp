import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTranscript, readTranscript } from "../dist/studio/transcript.js";

test("a recording without generated captions returns an empty transcript", async () => {
  const studio = {
    evaluate: (body) =>
      new (async () => {}).constructor("bridge", body)({
        client: { query: async () => null },
      }),
  };
  const result = await readTranscript(studio, new URL("fixtures/window-recording", import.meta.url).pathname);
  assert.deepEqual(result, { sessions: [], words: [] });
});

test("generateTranscript with no mic audio preserves accurate editor sync status", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "ss-transcript-empty-test-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const projectPath = new URL("fixtures/window-recording", import.meta.url).pathname;
  for (const open of [false, true]) {
    const studio = {
      appPath: "/Applications/Screen Studio.app",
      stateDir,
      requireVersion: async () => "4.1.0-5005",
      call: async () => null,
      evaluate: async (expr) => {
        if (expr.includes("captions.getTranscript") && expr.includes("m.transcriptPromise")) {
          assert.match(expr, /m\.transcriptData \|\| true/);
          return open ? "updated" : "not-open";
        }
        return [];
      },
    };
    const res = await generateTranscript(studio, projectPath, { type: "system", locale: "en_US" });
    assert.deepEqual(res.sessions, []);
    assert.deepEqual(res.words, []);
    assert.equal(res.editor, open ? "updated" : "not-open");
    assert.match(res.note, /No microphone audio/);
  }
});

test("generateTranscript surfaces captions.getTranscript failures instead of reporting updated", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "ss-transcript-empty-test-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const projectPath = new URL("fixtures/window-recording", import.meta.url).pathname;
  const studio = {
    appPath: "/Applications/Screen Studio.app",
    stateDir,
    requireVersion: async () => "4.1.0-5005",
    call: async () => null,
    evaluate: async (expr) => {
      if (expr.includes("captions.getTranscript") && expr.includes("m.transcriptPromise")) {
        assert.ok(!expr.includes("q.promise.catch("));
        throw new Error("getTranscript RPC failed");
      }
      return [];
    },
  };
  await assert.rejects(
    generateTranscript(studio, projectPath, { type: "system", locale: "en_US" }),
    /getTranscript RPC failed/,
  );
});

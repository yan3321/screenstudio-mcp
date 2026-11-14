import { test, after } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const helper = fileURLToPath(new URL("../native/desktop-helper", import.meta.url));
const original = childProcess.execFile;
let executable;
const refused = () => {
  throw new Error("No host processes in privacy outcome fixture.");
};
refused[promisify.custom] = async (command, args) => {
  if (command === helper && args[0] === "ocr") {
    return {
      stdout: args
        .slice(1)
        .map((_, image) =>
          JSON.stringify({
            image,
            text: "fixture@example.test",
            confidence: 1,
            box: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
            words: [],
          }),
        )
        .join("\n"),
      stderr: "",
    };
  }
  assert.equal(command, executable);
  if (!args.includes("-frames:v")) throw new Error("Preview omitted by fixture after mask application.");
  await writeFile(args.at(-1), "owned synthetic frame");
  return { stdout: "", stderr: "" };
};
childProcess.execFile = refused;
syncBuiltinESMExports();
const { register } = await import("../dist/mcp/tools/privacy.js");
after(() => {
  childProcess.execFile = original;
  syncBuiltinESMExports();
});

test(
  "privacy application distinguishes pre-op refusal, partial edit and unconfirmed save",
  { skip: process.platform !== "darwin" || !existsSync(helper) },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ss-privacy-outcome-"));
    const previous = process.env.SCREENSTUDIO_FFMPEG;
    executable = process.env.SCREENSTUDIO_FFMPEG = join(root, "ffmpeg");
    t.after(async () => {
      if (previous === undefined) delete process.env.SCREENSTUDIO_FFMPEG;
      else process.env.SCREENSTUDIO_FFMPEG = previous;
      await rm(root, { recursive: true, force: true });
    });
    const analysis = {
      sourceDurationMs: 1000,
      sessions: [{ startMs: 0, endMs: 1000, video: join(root, "source.mp4") }],
      screen: { changes: [] },
      typing: [],
    };
    for (const outcome of ["refused", "partial", "unsaved"]) {
      let handler,
        count = 0;
      const editor = {
        apply: async (_path, _scene, ops) => {
          count++;
          assert.ok(ops.length > 0);
          if (outcome === "refused") throw new Error("Unresolved native save");
          if (outcome === "partial")
            throw Object.assign(new Error("Transport lost"), { checkpointId: "owned-checkpoint" });
          return {
            results: [],
            checkpointId: "owned-checkpoint",
            saved: false,
            saveOutcome: "unknown",
            saveId: "00000000-0000-4000-8000-000000000001",
          };
        },
      };
      register(
        {
          registerTool: (_name, _schema, fn) => {
            handler = fn;
          },
        },
        {
          studio: { statePath: async (name) => join(root, name) },
          editor,
          analysisFor: async () => analysis,
          timeline: async () => ({ scene: { masks: [] } }),
        },
      );
      const response = await handler(
        { projectPath: "/owned.screenstudio", everyMs: 1000, maxFrames: 10, apply: true },
        {},
      );
      assert.equal(response.isError, undefined);
      const result = JSON.parse(response.content.at(-1).text);
      assert.equal(count, 1);
      if (outcome === "refused") {
        assert.equal(result.applied.refused, true);
        assert.equal(result.applied.partial, false);
        assert.equal(result.applied.checkpointId, undefined);
        assert.ok(!result.notes.some((note) => /some ops landed/.test(note)));
      } else if (outcome === "partial") {
        assert.equal(result.applied.partial, true);
        assert.equal(result.applied.checkpointId, "owned-checkpoint");
      } else {
        assert.equal(result.applied.saved, false);
        assert.equal(result.applied.partial, undefined);
        assert.ok(result.notes.some((note) => /save was not confirmed/.test(note)));
      }
    }
  },
);

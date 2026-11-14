import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, chmod, copyFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFrames } from "../dist/studio/redact.js";
import { micLevels } from "../dist/studio/audio.js";
import { attachBackgroundAudio } from "../dist/studio/narration.js";
import { CommandNotSentError } from "../dist/cdp/client.js";
const exists = (p) =>
  stat(p).then(
    () => true,
    () => false,
  );
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "owned child must reach its fixture checkpoint");
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function workers(t, count) {
  const root = await mkdtemp(join(tmpdir(), "ss-media-workers-"));
  const executable = join(root, "ffmpeg");
  const source = `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(root)};const args=process.argv.slice(2);const input=args[args.indexOf('-i')+1];const n=Number(path.basename(input).match(/input-(\\d+)/)[1]);fs.writeFileSync(path.join(root,'start-'+n),'started');const later=()=>new Promise(r=>setTimeout(r,5));(async()=>{while(!Array.from({length:${count}},(_,i)=>fs.existsSync(path.join(root,'start-'+i))).every(Boolean))await later();if(n===0){fs.writeFileSync(path.join(root,'failed-0'),'failed');process.stderr.write('fixture decoder failed');process.exit(9);}while(!fs.existsSync(path.join(root,'release')))await later();if(args.includes('-frames:v'))fs.writeFileSync(args.at(-1),'owned-frame');else process.stdout.write('frame:0 pts:0 pts_time:0\\nlavfi.astats.1.RMS_level=-20\\n');fs.writeFileSync(path.join(root,'done-'+n),'complete');})();`;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  const previous = process.env.SCREENSTUDIO_FFMPEG;
  process.env.SCREENSTUDIO_FFMPEG = executable;
  t.after(async () => {
    await writeFile(join(root, "release"), "release");
    for (let i = 1; i < count; i++)
      if (await exists(join(root, "start-" + i))) await until(() => exists(join(root, "done-" + i)));
    if (previous === undefined) delete process.env.SCREENSTUDIO_FFMPEG;
    else process.env.SCREENSTUDIO_FFMPEG = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test(
  "privacy extraction drains sibling decoders before the caller can remove their directory",
  { timeout: 8000 },
  async (t) => {
    const root = await workers(t, 4);
    let settled = false;
    const operation = extractFrames(
      [0, 1000, 2000, 3000],
      (ms) => ({ video: join(root, `input-${ms / 1000}.mp4`), localMs: ms }),
      join(root, "frames"),
    ).then(
      () => {
        settled = true;
        return null;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    await until(() => exists(join(root, "failed-0")));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      settled,
      false,
      "one failed decoder must not return while its siblings still use owned files",
    );
    await writeFile(join(root, "release"), "release");
    const error = await operation;
    assert.match(error.message, /fixture decoder failed/);
    for (let i = 1; i < 4; i++) assert.equal(await exists(join(root, "done-" + i)), true);
  },
);

test(
  "microphone analysis drains sibling ffmpeg reads before reporting the first failure",
  { timeout: 8000 },
  async (t) => {
    const root = await workers(t, 2);
    const project = join(root, "owned.screenstudio");
    await mkdir(join(project, "recording"), { recursive: true });
    await writeFile(
      join(project, "recording/metadata.json"),
      JSON.stringify({
        recorders: [
          {
            type: "display",
            sessions: [
              { durationMs: 5000, outputFilename: "video0.mp4" },
              { durationMs: 5000, outputFilename: "video1.mp4" },
            ],
          },
          {
            type: "microphone",
            sessions: [{ outputFilename: "input-0.m4a" }, { outputFilename: "input-1.m4a" }],
          },
        ],
      }),
    );
    let settled = false;
    const operation = micLevels(project).then((result) => {
      settled = true;
      return result;
    });
    await until(() => exists(join(root, "failed-0")));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(settled, false);
    await writeFile(join(root, "release"), "release");
    const result = await operation;
    assert.match(result.unavailable, /fixture decoder failed/);
    assert.equal(await exists(join(root, "done-1")), true);
  },
);

async function stagedAudio(t) {
  const root = await mkdtemp(join(tmpdir(), "ss-audio-attachment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "owned.screenstudio");
  await mkdir(join(project, "assets"), { recursive: true });
  const file = join(root, "staged.m4a");
  await writeFile(file, "cached synthetic audio");
  return { root, project, file };
}

test("an unconfirmed native audio copy retains the exact staged input", async (t) => {
  const { project, file } = await stagedAudio(t);
  const studio = {
    call: async () => {
      throw new Error("native response lost");
    },
  };
  await assert.rejects(
    attachBackgroundAudio(
      studio,
      {
        requireEditable: async () => {},
        setAudio: () => assert.fail("no config without a copy acknowledgement"),
      },
      project,
      file,
      1,
    ),
    /Retained the staged mix/,
  );
  assert.equal(await readFile(file, "utf8"), "cached synthetic audio");
});

test("a known pre-dispatch audio failure can remove its unconsumed staged input", async (t) => {
  const { project, file } = await stagedAudio(t);
  const studio = {
    call: async () => {
      throw new CommandNotSentError(new Error("no connection"));
    },
  };
  await assert.rejects(
    attachBackgroundAudio(studio, { requireEditable: async () => {} }, project, file, 1),
    CommandNotSentError,
  );
  assert.equal(await exists(file), false);
});

test("a completed native copy with unconfirmed configuration retains staging and names the project asset", async (t) => {
  const { project, file } = await stagedAudio(t);
  const asset = join(project, "assets/copied.m4a");
  const studio = {
    call: async () => {
      await copyFile(file, asset);
      return "copied.m4a";
    },
  };
  await assert.rejects(
    attachBackgroundAudio(
      studio,
      {
        requireEditable: async () => {},
        setAudio: async () => {
          throw new Error("config response lost");
        },
      },
      project,
      file,
      1,
    ),
    /copied as copied.m4a.*Retained the staged mix/,
  );
  assert.equal(await exists(file), true);
  assert.equal(await readFile(asset, "utf8"), "cached synthetic audio");
});

test("replacing audio preserves older tracks that other SDK undo history can still reference", async (t) => {
  const { project, file } = await stagedAudio(t);
  const old = join(project, "assets/narration-1-fixture.m4a");
  await writeFile(old, "keep for undo");
  const then = new Date(Date.now() - 7200000);
  await utimes(old, then, then);
  await writeFile(join(project, "project.json"), "{}");
  const studio = { stateDir: join(project, "own-sdk-state"), call: async () => "new.m4a" };
  const editor = { requireEditable: async () => {}, liveProject: async () => ({}), setAudio: async () => {} };
  await attachBackgroundAudio(studio, editor, project, file, 1);
  assert.equal(await readFile(old, "utf8"), "keep for undo");
});

test("an audio attachment refuses an already quarantined project before copying any asset", async (t) => {
  const { project, file } = await stagedAudio(t);
  const editor = {
    requireEditable: async () => {
      throw new Error("Unresolved native write");
    },
  };
  const studio = { call: async () => assert.fail("no copy while quarantined") };
  await assert.rejects(attachBackgroundAudio(studio, editor, project, file, 1), /Unresolved native write/);
  assert.equal(await exists(file), true);
});

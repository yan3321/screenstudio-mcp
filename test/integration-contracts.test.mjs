import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { frameAt, ffmpeg } from "../dist/studio/media.js";
import { describeScene } from "../dist/studio/editor/describe.js";
import { Studio } from "../dist/studio/service.js";
import { DesktopSession, HELPER_PATH } from "../dist/studio/desktop.js";
import { register as recordingTools } from "../dist/mcp/tools/recording.js";
import { projectEditFingerprint } from "../dist/studio/project.js";

test("edit identity survives saving but detects changed masks and output settings", () => {
  const project = {
    lastSavedAt: "old",
    config: { padding: 0.08 },
    scenes: [{ masks: [{ isDisabled: false }] }],
  };
  assert.equal(projectEditFingerprint(project), projectEditFingerprint({ ...project, lastSavedAt: "new" }));
  assert.notEqual(
    projectEditFingerprint(project),
    projectEditFingerprint({ ...project, scenes: [{ masks: [{ isDisabled: true }] }] }),
  );
  assert.notEqual(
    projectEditFingerprint(project),
    projectEditFingerprint({ ...project, config: { padding: 0.1 } }),
  );
});

test("export creation fences the exact privacy-reviewed live project", async () => {
  const studio = new Studio();
  studio.requireVersion = async () => {};
  studio.checkOutput = () => [];
  const reviewed = { scenes: [{ masks: [{ isDisabled: false }] }] };
  const edited = { scenes: [{ masks: [{ isDisabled: true }] }] };
  studio.readProject = async () => ({ projectPath: "/owned.screenstudio", project: reviewed });
  let renders = 0;
  studio.render = async () => {
    renders++;
    return { jobId: "owned" };
  };
  const hash = createHash("sha256").update(JSON.stringify(reviewed)).digest("hex");
  const options = { format: "mp4", height: 1080, fps: 60, quality: "studio" };
  await assert.rejects(
    studio.exportStart("/owned.screenstudio", "/tmp/owned.mp4", options, async () => edited, hash),
    /Project changed/,
  );
  assert.equal(renders, 0);
  await studio.exportStart("/owned.screenstudio", "/tmp/owned.mp4", options, async () => reviewed, hash);
  assert.equal(renders, 1);
});

test("exact source slices preserve fractional origins and slow playback rates", () => {
  const source = [{ id: "slice-1", sourceStartMs: 1000.25, sourceEndMs: 11000.75, timeScale: 3 }];
  const scene = describeScene({ slices: source, zooms: [] });
  assert.deepEqual(scene.sourceSlices, source);
  assert.equal(scene.slices[0].speed, 0.33);
  assert.equal(
    (scene.sourceSlices[0].sourceEndMs - scene.sourceSlices[0].sourceStartMs) *
      scene.sourceSlices[0].timeScale,
    30001.5,
  );
});
test("export lookup finds only the exact saved project and output after response loss", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ss-find-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const studio = new Studio();
  Object.defineProperty(studio, "stateDir", { value: dir });
  const id = randomUUID(),
    project = join(dir, "a.screenstudio"),
    output = join(dir, "temp.mp4");
  await writeFile(
    join(dir, `export-${id}.json`),
    JSON.stringify({ projectPath: project, outputPath: output, editFingerprint: "abc" }),
  );
  assert.deepEqual(await studio.findExport(project, output), {
    found: true,
    jobId: id,
    editFingerprint: "abc",
  });
  assert.deepEqual(await studio.findExport(join(dir, "other.screenstudio"), output), { found: false });
});
test("hiding failure after a successful recording start preserves success and identity", async () => {
  const tools = new Map();
  recordingTools(
    { registerTool: (name, _schema, fn) => tools.set(name, fn) },
    {
      studio: { start: async () => ({ started: true, state: { outputDirectory: "/owned" } }) },
      desktop: {
        hideApp: async () => {
          throw new Error("helper missing");
        },
      },
    },
  );
  const response = await tools.get("screenstudio_record_start")({
    windowId: 123,
    name: "take",
    hideApp: true,
  });
  const result = JSON.parse(response.content[0].text);
  assert.equal(result.started, true);
  assert.equal(result.state.outputDirectory, "/owned");
  assert.equal(result.appHidden, false);
  assert.match(result.hideError, /helper missing/);
});
if (process.platform === "darwin") {
  test("session timeout rejects only after helper exit and does not accept a late response", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "ss-timeout-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const script = join(dir, "helper"),
      stopped = join(dir, "stopped"),
      ready = join(dir, "ready");
    await writeFile(
      script,
      `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready'); process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'released');setTimeout(()=>process.exit(0),30)});process.stdin.resume();setInterval(()=>{},1000);\n`,
    );
    await chmod(script, 0o700);
    const session = await DesktopSession.open(123, 1, script);
    t.after(() => session.close());
    // Let the fake install its signal handler before intentionally expiring a request.
    for (let i = 0; ; i++) {
      try {
        await readFile(ready);
        break;
      } catch (e) {
        if (i === 100) throw e;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    await assert.rejects(session.request({ action: "wait" }, 25), /timed out/);
    assert.equal(await readFile(stopped, "utf8"), "released");
    await assert.rejects(session.bounds(), /closed/);
  });
  test("helper rejects one-shot split buttons and preserves invalid request ids", async () => {
    const one = spawn(HELPER_PATH, ["down", "99999999", "1", "1"]);
    let error = "";
    one.stderr.on("data", (b) => (error += b));
    await new Promise((r) => one.on("close", r));
    assert.match(error, /persistent/);
    const proc = spawn(HELPER_PATH, ["--stdio"]);
    let output = "";
    proc.stdout.on("data", (b) => (output += b));
    proc.stdin.end(JSON.stringify({ id: 41 }) + "\n");
    await new Promise((r) => proc.on("close", r));
    assert.equal(JSON.parse(output).id, 41);
    assert.equal(JSON.parse(output).ok, false);
  });
}

test("HLS with absolute fragment timestamps supports clip-relative frame reads", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ss-hls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.SCREENSTUDIO_STATE_DIR;
  process.env.SCREENSTUDIO_STATE_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.SCREENSTUDIO_STATE_DIR;
    else process.env.SCREENSTUDIO_STATE_DIR = previous;
  });
  const playlist = join(dir, "input.m3u8"),
    frame = join(dir, "frame.png");
  await ffmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=10",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-g",
    "5",
    "-output_ts_offset",
    "100",
    "-f",
    "hls",
    "-hls_time",
    "0.5",
    "-hls_segment_type",
    "fmp4",
    "-hls_playlist_type",
    "vod",
    playlist,
  ]);
  await frameAt(playlist, 1.5, frame);
  assert.ok((await readFile(frame)).length > 100);
  await assert.rejects(frameAt(playlist, 20, frame), /No frame/);
});

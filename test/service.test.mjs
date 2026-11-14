// Studio launch decisions, export delivery and preview timing, against a fake app.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { makeLoop } from "../dist/studio/deliver.js";
import {
  Studio,
  appEnv,
  assertOutputWritable,
  configuredPort,
  deliverFile,
  launchPort,
  mainProcess,
  partialPath,
  previewSeconds,
  runningAppError,
} from "../dist/studio/service.js";

const APP = "/Applications/Screen Studio.app";

test("SCREENSTUDIO_PORT is validated, and blank means unset", () => {
  assert.equal(configuredPort({}), null);
  assert.equal(configuredPort({ SCREENSTUDIO_PORT: "  " }), null);
  assert.equal(configuredPort({ SCREENSTUDIO_PORT: " 9333 " }), 9333);
  assert.throws(() => configuredPort({ SCREENSTUDIO_PORT: "abc" }), /SCREENSTUDIO_PORT/);
  assert.throws(() => configuredPort({ SCREENSTUDIO_PORT: "80" }), /SCREENSTUDIO_PORT/);
});

test("the main process is found with or without its debugging port", () => {
  const helper = `${APP}/Contents/Frameworks/Screen Studio Helper.app/Contents/MacOS/Screen Studio Helper --type=renderer`;
  assert.equal(mainProcess(`/usr/bin/zsh\n${helper}\n`, APP), null);
  assert.deepEqual(mainProcess(`${helper}\n${APP}/Contents/MacOS/Screen Studio\n`, APP), { port: null });
  assert.deepEqual(
    mainProcess(`${APP}/Contents/MacOS/Screen Studio --remote-debugging-port=9333 --x\n`, APP),
    { port: 9333 },
  );
});

test("launch explains a running app instead of always asking to quit it", () => {
  const busy = new Error("Screen Studio's renderer did not respond (no answer within 10s).");
  assert.match(runningAppError({ port: null }, null, busy), /quit it \(Cmd\+Q\)/);
  const stalled = runningAppError({ port: 9222 }, null, busy);
  assert.match(stalled, /automation on port 9222 but did not respond/);
  assert.match(stalled, /no answer within 10s/);
  assert.doesNotMatch(stalled, /Cmd\+Q/);
  assert.match(runningAppError({ port: 9222 }, 9333, busy), /SCREENSTUDIO_PORT is 9333/);
  assert.match(
    runningAppError({ port: 9222 }, null, new Error("Screen Studio editor renderer was not found.")),
    /another app may hold it/,
  );
});

test("the spawned app never inherits run-as-node or node options", () => {
  const env = appEnv({ PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect" });
  assert.deepEqual(env, { PATH: "/usr/bin" });
});

test("a configured port that is taken is refused before launching", async (t) => {
  const server = createTcpServer().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const taken = server.address().port;
  await assert.rejects(launchPort(taken), new RegExp(`Port ${taken} is in use`));
  const probe = createTcpServer().listen(0, "127.0.0.1");
  await new Promise((r) => probe.once("listening", r));
  const free = probe.address().port;
  await new Promise((r) => probe.close(r));
  assert.equal(await launchPort(free), free);
});

test("preview times in the last frame interval land on the last frame", () => {
  const video = { endSec: 2, frameSec: 1 / 30 };
  assert.equal(previewSeconds(1000, video), 1);
  assert.ok(previewSeconds(1990, video) < 2 - 1 / 30);
  assert.ok(previewSeconds(2000, video) > 2 - 2 / 30);
  assert.throws(() => previewSeconds(2001, video), /outside/);
  assert.throws(() => previewSeconds(-1, video), /outside/);
  assert.equal(previewSeconds(0, { endSec: 0.01, frameSec: 1 / 30 }), 0);
});

test("delivery never replaces an existing file and recognises its own earlier link", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-deliver-"));
  const src = join(dir, "QA-1.mp4");
  await writeFile(src, "render");
  const out = join(dir, "out.mp4");
  await deliverFile(src, out, "job");
  await deliverFile(src, out, "job");
  assert.equal(await readFile(out, "utf8"), "render");
  const other = join(dir, "other.mp4");
  await writeFile(other, "someone else");
  await assert.rejects(deliverFile(src, other, "job"), /EEXIST/);
  assert.equal(await readFile(other, "utf8"), "someone else");
  assert.equal(partialPath(out, "job"), `${out}.partial-job`);
});

test("export destinations are checked before rendering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-out-"));
  await assert.rejects(assertOutputWritable(join(dir, "missing", "a.mp4")), /does not exist/);
  await writeFile(join(dir, "a.mp4"), "");
  await assert.rejects(assertOutputWritable(join(dir, "a.mp4")), /already exists/);
  await assertOutputWritable(join(dir, "b.mp4"));
});

/** A fake Screen Studio: one editor renderer answering bridge calls from `state`. */
async function fakeApp(t, extraAnswer) {
  const root = await mkdtemp(join(tmpdir(), "ss-app-"));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const state = { qaDir: join(root, "qa"), exportId: "e1", status: "rendering", calls: [], ipcCalls: [] };
  await mkdir(state.qaDir);
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify([
        {
          id: "editor",
          type: "page",
          url: "file:///Applications/Screen%20Studio.app/Contents/Resources/app.asar/dist/index.html",
          webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/editor`,
        },
      ]),
    );
  });
  const answer = (expression) => {
    if (extraAnswer) {
      const handled = extraAnswer(expression, state);
      if (handled !== undefined) return handled;
    }
    if (expression.includes("IS_RENDER_WORKER")) return { studio: true, worker: false };
    if (expression.includes('"app.version"')) return "4.1.0-5005";
    if (expression.includes('"project.readProject"')) {
      state.ipcCalls.push("project.readProject");
      return { projectData: { version: "4.0.0", config: {}, scenes: [] } };
    }
    if (expression.includes("export.getTempQaExportsPath")) return state.qaDir;
    if (expression.includes("__screenstudioMcpJobs??=")) {
      state.calls.push(expression);
      return { started: true };
    }
    if (expression.includes("__screenstudioMcpJobs?.["))
      return { status: state.status, exportId: state.exportId };
    throw new Error(`Unexpected evaluation: ${expression.slice(0, 80)}`);
  };
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) =>
    ws.on("message", (bytes) => {
      const msg = JSON.parse(bytes.toString());
      try {
        ws.send(
          JSON.stringify({
            id: msg.id,
            result: { result: { value: JSON.stringify(answer(msg.params.expression)) } },
          }),
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        ws.send(
          JSON.stringify({
            id: msg.id,
            result: { exceptionDetails: { exception: { description: message }, text: message } },
          }),
        );
      }
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const ffprobe = join(root, "ffprobe");
  await writeFile(
    ffprobe,
    `#!/bin/sh\necho '{"format":{"duration":"2"},"streams":[{"width":2,"height":2}]}'\n`,
  );
  await chmod(ffprobe, 0o755);
  const saved = { ...process.env };
  process.env.SCREENSTUDIO_PORT = String(server.address().port);
  process.env.SCREENSTUDIO_STATE_DIR = join(root, "state");
  process.env.SCREENSTUDIO_FFPROBE = ffprobe;
  t.after(() => {
    process.env = saved;
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
  });
  const project = join(root, "demo.screenstudio");
  await mkdir(project);
  await writeFile(
    join(project, "project.json"),
    JSON.stringify({ json: { version: "4.0.0", config: {}, scenes: [] } }),
  );
  const out = join(root, "out");
  await mkdir(out);
  const render = async (suffix = ".mp4") => {
    state.status = "completed";
    const file = join(state.qaDir, `QA-demo-${state.exportId}${suffix}`);
    await writeFile(file, "rendered video");
    return file;
  };
  const studio = new Studio();
  // This fixture owns its fake endpoint; never inspect the user's running app population.
  studio.running = async () => ({ port: server.address().port });
  return { root, state, studio, project, out, render };
}

const options = { height: 240, fps: 24, format: "mp4", quality: "studio" };

test("a failed live-editor lookup aborts the export instead of rendering the saved project", async (t) => {
  const app = await fakeApp(t);
  const live = async () => {
    throw new Error("Runtime.evaluate timed out");
  };
  await assert.rejects(
    app.studio.exportStart(app.project, join(app.out, "a.mp4"), options, live),
    /timed out/,
  );
  assert.equal(app.state.calls.length, 0);
});

test("exports say which project they render and move the render out of the temp folder", async (t) => {
  const app = await fakeApp(t);
  const disk = await app.studio.exportStart(app.project, join(app.out, "a.mp4"), options, async () => null);
  assert.equal(disk.source, "disk");
  assert.match(disk.note, /unsaved edits are not included/);
  assert.doesNotMatch(app.state.calls[0], /"outputPath"/);
  assert.equal((await app.studio.exportStatus(disk.jobId)).source, "disk");
  const rendered = await app.render();
  const done = await app.studio.exportStatus(disk.jobId);
  assert.equal(done.status, "completed");
  assert.equal(await readFile(join(app.out, "a.mp4"), "utf8"), "rendered video");
  await assert.rejects(stat(rendered), /ENOENT/);
  assert.deepEqual(await app.studio.exportStatus(disk.jobId), done);

  app.state.exportId = "e2";
  app.state.status = "rendering";
  const kept = await app.studio.exportStart(
    app.project,
    join(app.out, "b.mp4"),
    { ...options, keepRender: true },
    async () => ({ version: "4.0.0", live: true }),
  );
  assert.equal(kept.source, "live");
  assert.equal(kept.note, undefined);
  assert.match(app.state.calls[1], /"live":true/);
  const keptRender = await app.render();
  assert.equal((await app.studio.exportStatus(kept.jobId)).status, "completed");
  await stat(keptRender);
});

test("an output path in use or taken before delivery ends the job with the render's location", async (t) => {
  const app = await fakeApp(t);
  const target = join(app.out, "a.mp4");
  const job = await app.studio.exportStart(app.project, target, options);
  await assert.rejects(app.studio.exportStart(app.project, target, options), /already writing/);
  await assert.rejects(
    app.studio.exportStart(app.project, join(app.out, "nope", "a.mp4"), options),
    /does not exist/,
  );
  await writeFile(target, "someone else's file");
  const rendered = await app.render();
  const failed = await app.studio.exportStatus(job.jobId);
  assert.equal(failed.status, "delivery_failed");
  assert.equal(failed.renderedPath, rendered);
  assert.match(failed.error, /EEXIST/);
  assert.equal(await readFile(target, "utf8"), "someone else's file");
  await stat(rendered);
  assert.deepEqual(await app.studio.exportStatus(job.jobId), failed);
  assert.deepEqual(
    (await readdir(app.out)).sort(),
    ["a.mp4"],
    "no partial copies are left beside the output",
  );
});

test("readProject and duplicate reject broken bundles and symlink destinations before calling app IPC", async (t) => {
  const app = await fakeApp(t);
  const broken = join(app.root, "broken.screenstudio");
  await mkdir(broken);
  const dupTarget = join(app.root, "dup.screenstudio");
  await assert.rejects(app.studio.readProject(broken), /missing project\.json/);
  await assert.rejects(app.studio.duplicate(broken, dupTarget), /missing project\.json/);
  await writeFile(join(broken, "project.json"), "{bad json");
  await assert.rejects(app.studio.readProject(broken), /Corrupted project\.json/);
  await writeFile(join(broken, "project.json"), JSON.stringify({ json: { version: "3.0.0" } }));
  await assert.rejects(app.studio.readProject(broken), /unsupported/);
  await writeFile(join(broken, "project.json"), JSON.stringify({ json: { version: "4.0.0" } }));
  await assert.rejects(app.studio.readProject(broken), /missing config or scenes/);
  await assert.rejects(app.studio.duplicate(broken, dupTarget), /missing config or scenes/);
  await writeFile(
    join(broken, "project.json"),
    JSON.stringify({ json: { version: "4.0.0", config: {}, scenes: [{ type: "recording", slices: [] }] } }),
  );
  await assert.rejects(app.studio.readProject(broken), /missing recording folder/);
  await assert.rejects(app.studio.duplicate(broken, dupTarget), /missing recording folder/);

  // Symlink parent pointing into source project and dangling symlink destination must be refused.
  const aliasParent = join(app.root, "alias-parent");
  await symlink(app.project, aliasParent);
  await assert.rejects(
    app.studio.duplicate(app.project, join(aliasParent, "inside.screenstudio")),
    /inside the source project/,
  );
  const dangling = join(app.root, "dangling.screenstudio");
  await symlink(join(app.root, "nonexistent-target"), dangling);
  await assert.rejects(app.studio.duplicate(app.project, dangling), /Destination already exists/);
  assert.equal(app.state.ipcCalls.length, 0);
  assert.equal(app.state.calls.length, 0);
});

test("exports validate format options and deliver ProRes .mov and dual H.264/HEVC MP4 cleanly", async (t) => {
  const app = await fakeApp(t);
  await assert.rejects(
    app.studio.exportStart(app.project, join(app.out, "bad.mp4"), {
      height: 720,
      fps: 30,
      format: "prores",
      quality: "studio",
    }),
    /ending in \.mov/,
  );
  await assert.rejects(
    app.studio.exportStart(app.project, join(app.out, "bad.gif"), {
      height: 480,
      fps: 60,
      format: "gif",
      quality: "studio",
    }),
    /gif exports support fps/,
  );

  // ProRes delivery (.mov)
  app.state.exportId = "prores1";
  const prores = await app.studio.exportStart(app.project, join(app.out, "master.mov"), {
    height: 720,
    fps: 30,
    format: "prores",
    quality: "studio",
    proResProfile: "422-lt",
  });
  await app.render(".mov");
  const proresDone = await app.studio.exportStatus(prores.jobId);
  assert.equal(proresDone.status, "completed");
  assert.equal(proresDone.outputPath, join(app.out, "master.mov"));

  // Dual H.264 + H.265 partial resilience: h264 succeeds even when h265 is missing
  app.state.exportId = "dual1";
  app.state.status = "rendering";
  const dual = await app.studio.exportStart(app.project, join(app.out, "dual.mp4"), {
    height: 720,
    fps: 30,
    format: "mp4",
    quality: "studio",
    mp4Codec: "both",
  });
  assert.deepEqual(dual.outputPaths, [join(app.out, "dual-h264.mp4"), join(app.out, "dual-h265.mp4")]);
  await app.render("-h264.mp4");
  const dualDone = await app.studio.exportStatus(dual.jobId);
  assert.equal(dualDone.status, "completed");
  assert.equal(dualDone.outputPath, join(app.out, "dual-h264.mp4"));
  assert.ok(dualDone.files.h264);
  assert.match(dualDone.warnings.h265, /could not be uniquely located/);

  // Dual H.264 + H.265 full success (Screen Studio writes H.264 without a -h264 suffix)
  app.state.exportId = "dual2";
  app.state.status = "rendering";
  const dualOk = await app.studio.exportStart(app.project, join(app.out, "both.mp4"), {
    height: 720,
    fps: 30,
    format: "mp4",
    quality: "studio",
    mp4Codec: "both",
  });
  await app.render(".mp4");
  await app.render("-h265.mp4");
  const bothDone = await app.studio.exportStatus(dualOk.jobId);
  assert.equal(bothDone.status, "completed");
  assert.equal(bothDone.outputPaths.length, 2);
  assert.deepEqual(bothDone.outputPaths, [join(app.out, "both-h264.mp4"), join(app.out, "both-h265.mp4")]);
  assert.equal(bothDone.warnings, undefined);

  // A codec whose destination is taken mid-render keeps its render instead of deleting it.
  app.state.exportId = "dual3";
  app.state.status = "rendering";
  const dualTaken = await app.studio.exportStart(app.project, join(app.out, "taken.mp4"), {
    height: 720,
    fps: 30,
    format: "mp4",
    quality: "studio",
    mp4Codec: "both",
  });
  await writeFile(join(app.out, "taken-h265.mp4"), "someone else's file");
  await app.render(".mp4");
  await app.render("-h265.mp4");
  const takenDone = await app.studio.exportStatus(dualTaken.jobId);
  assert.equal(takenDone.status, "completed");
  assert.deepEqual(takenDone.outputPaths, [join(app.out, "taken-h264.mp4")]);
  assert.deepEqual(takenDone.renderedPaths, [join(app.state.qaDir, "QA-demo-dual3-h265.mp4")]);
  assert.ok(takenDone.warnings.h265);
  assert.ok(
    (await readdir(app.state.qaDir)).some((f) => f.endsWith("dual3-h265.mp4")),
    "the undelivered HEVC render is kept",
  );
  assert.ok(
    !(await readdir(app.state.qaDir)).some((f) => f.endsWith("dual3.mp4")),
    "the delivered H.264 render is cleaned up",
  );
});

test("removeAssetFromProject refuses paths and referenced assets before calling the app", async (t) => {
  const app = await fakeApp(t);
  for (const bad of ["../project.json", "assets/x.png", ".hidden", ""])
    await assert.rejects(app.studio.removeAssetFromProject(app.project, bad), /bare asset file name/);

  await writeFile(
    join(app.project, "project.json"),
    JSON.stringify({
      json: {
        version: "4.0.0",
        config: {
          styles: { background: { type: "image", image: "used-bg.png" } },
          audio: { backgroundAudioFileName: "used-song.mp3" },
          camera: { lut: "used-lut.cube" },
        },
        scenes: [{ slices: [], voiceOvers: [{ audioFileName: "used-vo.mp3" }] }],
      },
    }),
  );
  for (const [asset, field] of [
    ["used-bg.png", /styles\.background\.image/],
    ["used-song.mp3", /audio\.backgroundAudioFileName/],
    ["used-lut.cube", /camera\.lut/],
    ["used-vo.mp3", /scenes\[0\]\.voiceOvers\[0\]\.audioFileName/],
  ]) {
    await assert.rejects(app.studio.removeAssetFromProject(app.project, asset), field);
  }
  assert.ok(!app.state.calls.some((c) => JSON.stringify(c).includes("removeAssetFromProject")));
});

test("makeLoop preserves mp4 and gif outputs when webm or seam fails", async (t) => {
  const app = await fakeApp(t);
  const ffmpeg = join(app.root, "ffmpeg");
  // Fail on .webm to simulate encoder failure; succeed on .gif and .png outputs.
  await writeFile(
    ffmpeg,
    [
      "#!/bin/sh",
      'eval "out=\\${$#}"',
      'case "$out" in',
      "  -*) exit 0 ;;",
      "  *.webm) echo 'webm encoder unavailable' >&2; exit 1 ;;",
      '  *.png) echo "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" | base64 -d > "$out" ;;',
      '  *.gif|*.mp4) printf "GIF89a" > "$out" ;;',
      "esac",
      "",
    ].join("\n"),
  );
  await chmod(ffmpeg, 0o755);
  process.env.SCREENSTUDIO_FFMPEG = ffmpeg;

  const loopLive = {
    version: "4.0.0",
    config: { output: { aspectRatio: "auto" }, crop: { rect01: { x: 0, y: 0, width: 1, height: 1 } } },
    scenes: [{ id: "s1", slices: [{ sourceStartMs: 0, sourceEndMs: 2000, timeScale: 1 }], zooms: [] }],
  };
  const fakeEditor = {
    open: async () => {},
    raw: async () => loopLive,
    apply: async () => ({}),
    save: async () => ({ saved: true, saveOutcome: "fulfilled" }),
    liveProject: async () => loopLive,
  };
  const analysis = {
    projectPath: app.project,
    sourceDurationMs: 6000,
    capture: { kind: "window", widthPt: 1440, heightPt: 900 },
    sessions: [{ startMs: 0, endMs: 6000, video: "" }],
    clicks: [{ atMs: 3000, endMs: 3080, x: 0.5, y: 0.5, drag: false, button: "left" }],
    typing: [],
    shortcuts: [],
    movement: [],
    screen: { changes: [], active: [] },
    idle: [
      { startMs: 0, endMs: 2800 },
      { startMs: 3300, endMs: 6000 },
    ],
  };

  await t.test("an unconfirmed loop save refuses rendering", async () => {
    let copy;
    const startRender = app.studio.startRender;
    app.studio.startRender = async () => assert.fail("no render with an unknown save");
    try {
      await assert.rejects(
        makeLoop(
          app.studio,
          {
            ...fakeEditor,
            open: async (path) => {
              copy = path;
            },
            save: async () => ({
              saved: false,
              saveOutcome: "unknown",
              saveId: "00000000-0000-4000-8000-000000000001",
            }),
          },
          app.project,
          analysis,
          {
            outputDir: app.out,
            targetMs: 4000,
            formats: ["mp4"],
            maxGifBytes: 8_000_000,
            apply: true,
            show: false,
          },
        ),
        (error) => {
          assert.match(error.message, /not confirmed saved/);
          assert.ok(error.message.includes(copy));
          assert.ok(error.message.includes("00000000-0000-4000-8000-000000000001"));
          return true;
        },
      );
    } finally {
      app.studio.startRender = startRender;
      if (copy) await rm(copy, { recursive: true, force: true });
    }
  });

  let stopped = false;
  const waiter = (async () => {
    while (!stopped && app.state.calls.length === 0) await new Promise((r) => setTimeout(r, 10));
    if (!stopped) await app.render(".mp4");
  })();
  let res;
  try {
    res = await makeLoop(app.studio, fakeEditor, app.project, analysis, {
      outputDir: app.out,
      targetMs: 4000,
      formats: ["mp4", "webm", "gif"],
      maxGifBytes: 8_000_000,
      apply: true,
      show: false,
    });
  } finally {
    stopped = true;
    await waiter;
  }
  await rm(res.project, { recursive: true, force: true });
  assert.ok(res.files.mp4);
  assert.ok(res.files.gif);
  assert.equal(res.files.webm, undefined);
  assert.ok(res.warnings?.some((w) => /WebM loop transcode failed/.test(w)));
});

test("luts, recovery, and project removal validate target containment and project markers", async (t) => {
  let activePending = [];
  let activeLuts = [];
  let recoverReturn = { projectPath: "/tmp/rec.screenstudio" };
  let appVersion = "4.1.0-5005";
  const mutations = [];
  const app = await fakeApp(t, (expr) => {
    if (expr.includes('"app.version"')) return appVersion;
    if (expr.includes('"luts.userLibrary"')) return activeLuts;
    if (expr.includes('"luts.removeFromLibrary"')) {
      mutations.push(expr);
      return null;
    }
    if (expr.includes('"capture.recover.unfinishedRecordings"')) return activePending;
    if (expr.includes('"capture.recover.tryToRecoverRecording"')) {
      mutations.push(expr);
      return recoverReturn;
    }
    if (expr.includes('"capture.recover.discardUnfinishedRecording"')) {
      mutations.push(expr);
      return null;
    }
    if (expr.includes('"project.removeProject"')) {
      mutations.push(expr);
      return null;
    }
    if (expr.includes("listCapturableWindows")) {
      return {
        displays: [{ displayId: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } }],
        cameras: [],
        microphones: [],
        externalDevices: [],
      };
    }
    return undefined;
  });

  const lutInLib = join(app.root, "lib.cube");
  const lutOutside = join(app.root, "outside.cube");
  await writeFile(lutInLib, "");
  await writeFile(lutOutside, "");
  activeLuts = [{ name: "lib", path: lutInLib }];
  await assert.rejects(app.studio.luts("remove", { lutPath: lutOutside }), /No user library LUT/);
  assert.deepEqual(await app.studio.luts("remove", { lutPath: lutInLib }), {
    removed: true,
    lutPath: lutInLib,
  });

  const pendingDir = join(app.root, "pending-rec");
  const arbitraryDir = join(app.root, "not-a-recording");
  await mkdir(pendingDir);
  await mkdir(arbitraryDir);
  activePending = [{ path: pendingDir }];
  await assert.rejects(app.studio.recoverRecording(arbitraryDir), /No unfinished recording matching/);
  await assert.rejects(
    app.studio.discardUnfinishedRecording(arbitraryDir),
    /No unfinished recording matching/,
  );
  assert.deepEqual(await app.studio.discardUnfinishedRecording(pendingDir), {
    discarded: true,
    path: pendingDir,
  });
  recoverReturn = false;
  await assert.rejects(app.studio.recoverRecording(pendingDir), /could not recover/);

  const fakeProj = join(app.root, "empty.screenstudio");
  await mkdir(fakeProj);
  await assert.rejects(app.studio.removeProject(fakeProj), /missing project\.json/);
  assert.ok(!mutations.some((m) => m.includes("removeProject")));

  appVersion = "4.9.9-9999";
  await assert.rejects(app.studio.windowAction(1, "focus"), /Unsupported Screen Studio build/);
  await assert.rejects(
    app.studio.extractRawRecordingFiles(app.project, app.out),
    /Unsupported Screen Studio build/,
  );
  await assert.rejects(
    app.studio.exportStart(app.project, join(app.out, "wrong-build.mp4"), options),
    /Unsupported Screen Studio build/,
  );
  await assert.rejects(
    app.studio.startRender(
      app.project,
      join(app.out, "wrong-build-render.mp4"),
      options,
      { version: "4.0.0", config: {}, scenes: [] },
      "disk",
    ),
    /Unsupported Screen Studio build/,
  );

  // removeProject rejects symlinks and non-Screen-Studio project.json markers; ensureClosed runs inside lock.
  appVersion = "4.1.0-5005";
  const unrelatedDir = join(app.root, "unrelated-folder");
  await mkdir(unrelatedDir);
  await writeFile(join(unrelatedDir, "project.json"), JSON.stringify({ name: "unrelated" }));
  const sneakyLink = join(app.root, "sneaky.screenstudio");
  await symlink(unrelatedDir, sneakyLink);
  await assert.rejects(app.studio.removeProject(sneakyLink), /symlinked project path/);

  const decoyDir = join(app.root, "decoy.screenstudio");
  await mkdir(decoyDir);
  await writeFile(join(decoyDir, "project.json"), JSON.stringify({ name: "not screen studio" }));
  await assert.rejects(app.studio.removeProject(decoyDir), /unrecognized project\.json/);

  let closedChecks = 0;
  await assert.rejects(
    app.studio.removeProject(app.project, async () => {
      closedChecks += 1;
      throw new Error("The project is open in a Screen Studio editor.");
    }),
    /open in a Screen Studio editor/,
  );
  assert.equal(closedChecks, 1);

  const moveAlias = join(app.root, "move-alias");
  await symlink(app.project, moveAlias);
  await assert.rejects(
    app.studio.moveProject(app.project, join(moveAlias, "child.screenstudio")),
    /inside the source project/,
  );
  assert.ok(!mutations.some((m) => m.includes("removeProject")));
});

test("dual-codec export lookup recovers the requested destination and both delivered paths", async (t) => {
  const app = await fakeApp(t);
  for (const method of ["exportStart", "startRender"]) {
    app.state.exportId = method;
    app.state.status = "rendering";
    const output = join(app.out, `${method}.mp4`);
    const options = { height: 720, fps: 30, format: "mp4", quality: "studio", mp4Codec: "both" };
    const job =
      method === "exportStart"
        ? await app.studio.exportStart(app.project, output, options)
        : await app.studio.startRender(
            app.project,
            output,
            options,
            { version: "4.0.0", config: {}, scenes: [] },
            "disk",
          );
    const recovered = new Studio();
    const found = await recovered.findExport(app.project, output);
    assert.equal(found.found, true);
    assert.equal(found.jobId, job.jobId);
    await app.render(".mp4");
    await app.render("-h265.mp4");
    const delivered = await app.studio.exportStatus(job.jobId);
    assert.equal(delivered.status, "completed");
    for (const path of [output, ...delivered.outputPaths]) {
      assert.deepEqual(await recovered.findExport(app.project, path), found);
    }
    assert.deepEqual(await recovered.findExport(app.project, join(app.out, "unrelated.mp4")), {
      found: false,
    });
  }
});

test("recordingAction finish preserves recovered-from-error projects and dual delivery recovers across probe restarts", async (t) => {
  const recoveredProj = join(await mkdtemp(join(tmpdir(), "ss-rec-proj-")), "rec.screenstudio");
  t.after(() => rm(join(recoveredProj, ".."), { recursive: true, force: true }).catch(() => {}));
  await mkdir(recoveredProj, { recursive: true });
  await writeFile(
    join(recoveredProj, "project.json"),
    JSON.stringify({ json: { version: "4.0.0", config: {}, scenes: [] } }),
  );

  let mode = "recovered";
  const app = await fakeApp(t, (expr) => {
    if (expr.includes("nc.recording.current")) return { phase: "recording" };
    if (expr.includes("capture.createProjectFromRecording")) {
      if (mode === "recovered") {
        return {
          type: "recovered-from-error",
          error: "Microphone disconnected before stop",
          projectPath: recoveredProj,
        };
      }
      return { type: "success", projectPath: recoveredProj };
    }
    return undefined;
  });

  const finished = await app.studio.recordingAction("finish");
  assert.equal(finished.type, "recovered-from-error");
  assert.equal(finished.recovered, true);
  assert.equal(finished.projectPath, recoveredProj);
  assert.match(finished.warning, /Microphone disconnected/);

  // Dual delivery: persist each delivered codec before probing so transient probe failure retries cleanly
  // without re-delivering (even if QA renders differ in inode on restart), and one probe failure preserves output.
  app.state.exportId = "dual-probe";
  app.state.status = "rendering";
  const job = await app.studio.exportStart(app.project, join(app.out, "retry.mp4"), {
    height: 720,
    fps: 30,
    format: "mp4",
    quality: "studio",
    mp4Codec: "both",
  });
  const r1 = await app.render(".mp4");
  const r2 = await app.render("-h265.mp4");

  const origProbe = app.studio.probe.bind(app.studio);
  app.studio.probe = async () => {
    throw new Error("transient ffprobe failure");
  };
  await assert.rejects(app.studio.exportStatus(job.jobId), /transient ffprobe failure/);
  // Recreate QA files with brand-new inodes to simulate restart / cross-volume state where hard-link sameFile is false:
  await writeFile(r1, "rewritten render h264");
  await writeFile(r2, "rewritten render h265");

  const restarted = new Studio();
  restarted.probe = async (p) => {
    if (p.endsWith("-h265.mp4")) throw new Error("h265 ffprobe failed");
    return origProbe(p);
  };
  const finalStatus = await restarted.exportStatus(job.jobId);
  assert.equal(finalStatus.status, "completed");
  assert.deepEqual(finalStatus.outputPaths, [
    join(app.out, "retry-h264.mp4"),
    join(app.out, "retry-h265.mp4"),
  ]);
  assert.equal(finalStatus.files.h265.outputPath, join(app.out, "retry-h265.mp4"));
  assert.match(finalStatus.warnings.h265, /media inspection failed/);
});

test("extractRawRecordingFiles refuses output inside the project bundle and unfinishedRecordings propagates real errors", async (t) => {
  let unfinishedBehavior = "throw-disconnect";
  let subCalled = false;
  const app = await fakeApp(t, (expr) => {
    if (expr.includes('"capture.recover.unfinishedRecordings"') && expr.includes("bridge.client.query")) {
      if (unfinishedBehavior === "throw-disconnect") throw new Error("CDP socket closed");
      if (unfinishedBehavior === "throw-sub-only")
        throw new Error("Unsupported method: this procedure is a subscription");
    }
    if (expr.includes("bridge.client.subscription") && expr.includes("unfinishedRecordings")) {
      subCalled = true;
      return [{ path: "/tmp/sub-rec" }];
    }
    return undefined;
  });

  // Real transport errors surface immediately without falling back to subscription.
  await assert.rejects(app.studio.unfinishedRecordings(), /CDP socket closed/);
  assert.equal(subCalled, false);

  // Query-unsupported errors fall back to subscription cleanly.
  unfinishedBehavior = "throw-sub-only";
  assert.deepEqual(await app.studio.unfinishedRecordings(), [{ path: "/tmp/sub-rec" }]);
  assert.equal(subCalled, true);

  // Output folder inside bundle (directly or via symlink) is refused before calling Screen Studio.
  const nested = join(app.project, "recording");
  await mkdir(nested, { recursive: true });
  await assert.rejects(
    app.studio.extractRawRecordingFiles(app.project, app.project),
    /inside the \.screenstudio/,
  );
  await assert.rejects(app.studio.extractRawRecordingFiles(app.project, nested), /inside the \.screenstudio/);
  const linkOut = join(app.root, "bundle-link");
  await symlink(app.project, linkOut);
  await assert.rejects(
    app.studio.extractRawRecordingFiles(app.project, linkOut),
    /inside the \.screenstudio/,
  );
});

test("state polls cold subscription and recordingAction finish recovers SwiftServiceRestartedError", async (t) => {
  const recoveredProj = join(await mkdtemp(join(tmpdir(), "ss-rec-restart-")), "rec.screenstudio");
  t.after(() => rm(join(recoveredProj, ".."), { recursive: true, force: true }).catch(() => {}));
  await mkdir(recoveredProj, { recursive: true });
  await writeFile(
    join(recoveredProj, "project.json"),
    JSON.stringify({ json: { version: "4.0.0", config: {}, scenes: [] } }),
  );

  let mode = "swift-restart";
  const recDir = join(recoveredProj, "..", "unfinished-rec-123");
  await mkdir(recDir, { recursive: true });

  const app = await fakeApp(t, (expr) => {
    if (expr.includes("nc.recording.current")) {
      assert.match(expr, /for \(let i = 0; i < 10; i\+\+\)/);
      return { phase: "recording", outputDirectory: recDir };
    }
    if (expr.includes("SwiftServiceRestartedError")) {
      if (mode === "swift-restart") {
        return {
          error: "The recorder stopped unexpectedly.",
          projectPath: recoveredProj,
          type: "recovered-from-error",
        };
      }
      if (mode === "create-project-failed") {
        return {
          type: "finalization-failed",
          recordingPath: recDir,
          error: "Disk full during project creation",
        };
      }
      if (mode === "eval-timeout") {
        throw new Error("Evaluation timed out after 120s");
      }
      if (mode === "recovered-no-path") {
        return {
          error: "The recorder stopped unexpectedly.",
          type: "recovered-from-error",
        };
      }
    }
    return undefined;
  });

  // SwiftServiceRestartedError auto-recovers just like Screen Studio's finishAndCreateProject.
  const recovered = await app.studio.recordingAction("finish");
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.projectPath, recoveredProj);
  assert.match(recovered.warning, /recorder stopped unexpectedly/);

  // tryToRecoverRecording returning truthy without projectPath rejects with recordingPath hint.
  mode = "recovered-no-path";
  await assert.rejects(
    app.studio.recordingAction("finish"),
    (err) => err.message.includes(recDir) && err.message.includes("screenstudio_record_recover"),
  );

  // createProjectFromRecording failure after finish exposes recordingPath + recovery hint.
  mode = "create-project-failed";
  await assert.rejects(
    app.studio.recordingAction("finish"),
    (err) => err.message.includes(recDir) && err.message.includes("screenstudio_record_recover"),
  );

  // Even a post-state timeout includes recordingPath and warns not to retry finish blindly.
  mode = "eval-timeout";
  await assert.rejects(
    app.studio.recordingAction("finish"),
    (err) => err.message.includes(recDir) && err.message.includes("Do not retry finish blindly"),
  );
});

test("checkDestination and projectLock handle symlinked paths and state warmup is shared", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ss-symlink-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const realDir = join(dir, "real");
  const proj = join(realDir, "demo.screenstudio");
  await mkdir(proj, { recursive: true });
  await writeFile(
    join(proj, "project.json"),
    JSON.stringify({ json: { version: "4.0.0", config: {}, scenes: [] } }),
  );
  const linkInsideProj = join(dir, "link-to-proj");
  await symlink(proj, linkInsideProj);
  const linkToRealDir = join(dir, "link-to-real");
  await symlink(realDir, linkToRealDir);

  let statePolls = 0;
  const app = await fakeApp(t, (expr) => {
    if (expr.includes("nc.recording.current")) {
      statePolls++;
      assert.match(expr, /window\.__ssmcpRecordingWarmup/);
      return null;
    }
    return undefined;
  });

  // Symlinked destination pointing inside source bundle must be blocked.
  await assert.rejects(
    app.studio.duplicate(proj, join(linkInsideProj, "nested.screenstudio")),
    /inside the source project/i,
  );
  await assert.rejects(
    app.studio.copyProject(proj, join(linkInsideProj, "nested-copy.screenstudio")),
    /inside the source project/i,
  );

  // projectLock must serialize missing/non-existent paths across symlinked parent directories.
  const order = [];
  let entered, releaseFirst, resolvedSecond;
  const firstEntered = new Promise((r) => (entered = r));
  const holdFirst = new Promise((r) => (releaseFirst = r));
  const secondResolved = new Promise((r) => (resolvedSecond = r));
  const missingReal = join(realDir, "missing.screenstudio");
  const missingAlias = join(linkToRealDir, "missing.screenstudio");
  const p1 = app.studio.projectLock(missingReal, async () => {
    order.push("p1-start");
    entered();
    await holdFirst;
    order.push("p1-end");
  });
  await firstEntered;
  const locks = app.studio.projectLocks;
  const originalGet = locks.get.bind(locks);
  locks.get = (key) => {
    resolvedSecond();
    return originalGet(key);
  };
  const p2 = app.studio.projectLock(missingAlias, async () => {
    order.push("p2-start");
    order.push("p2-end");
  });
  try {
    await secondResolved;
    await new Promise(setImmediate);
    assert.deepEqual(order, ["p1-start"]);
  } finally {
    releaseFirst();
    await Promise.all([p1, p2]);
    locks.get = originalGet;
  }
  assert.deepEqual(order, ["p1-start", "p1-end", "p2-start", "p2-end"]);

  assert.equal(await app.studio.state(), null);
  assert.equal(statePolls, 1);
});

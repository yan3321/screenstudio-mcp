import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { register as registerApp } from "../dist/mcp/tools/app.js";
import { register as registerDesktop } from "../dist/mcp/tools/desktop.js";
import { register as registerEditor } from "../dist/mcp/tools/editor.js";
import { register as registerProject } from "../dist/mcp/tools/project.js";
import { register as registerRecording } from "../dist/mcp/tools/recording.js";
import { configPartial } from "../dist/studio/editor/ops.js";
import { Editor } from "../dist/studio/editor/editor.js";
import { APP_BUILD } from "../dist/studio/compat.js";
import { generateTranscript } from "../dist/studio/transcript.js";
import { findAssetReferences, validateKnownConfig } from "../dist/studio/project.js";

test("known config preflight rejects bad structured values without echoing inputs", () => {
  const result = validateKnownConfig({
    "cursor.size": 999,
    "animations.screenMovementSpring": { stiffness: 170 },
    "captions.font": "private-example",
  });
  assert.equal(result.valid, false);
  assert.equal(result.errors.length >= 3, true);
  assert.equal(JSON.stringify(result).includes("private-example"), false);
  assert.equal(
    validateKnownConfig({ "cursor.size": 48, "cursor.clickEffect": { type: "circle" } }).valid,
    true,
  );
  assert.deepEqual(validateKnownConfig({ "unknown.option": {} }).deferred, ["unknown.option"]);
  assert.equal(validateKnownConfig({ styles: { shadow: { intensity: 0.5 } } }).valid, false);
});

test("config preflight is read-only and defers live-only fields without a project", async () => {
  let reads = 0;
  const call = collectTools((server) =>
    registerEditor(server, {
      editor: {
        raw: async () => {
          reads++;
          return { config: { custom: { value: 1 } }, editFingerprint: "snapshot" };
        },
      },
    }),
  );
  const known = await call("screenstudio_config_validate", { changes: { "cursor.size": 48 } });
  assert.equal(known.valid, true);
  assert.equal(known.forBuild, APP_BUILD);
  assert.equal(reads, 0);
  const deferred = await call("screenstudio_config_validate", { changes: { "custom.value": 2 } });
  assert.deepEqual(deferred.deferred, ["custom.value"]);
  assert.equal(deferred.valid, false);
  const live = await call("screenstudio_config_validate", {
    changes: { "custom.value": 2 },
    projectPath: "/demo.screenstudio",
  });
  assert.equal(live.valid, true);
  assert.equal(reads, 1);
  assert.equal(live.editFingerprint, "snapshot");
});

test("config preflight rejects overlapping union edits before reading an editor", async () => {
  const call = collectTools((server) =>
    registerEditor(server, {
      editor: {
        raw: async () => {
          throw new Error("must not read");
        },
      },
    }),
  );
  const result = await call("screenstudio_config_validate", {
    changes: { "cursor.clickEffect": { type: "circle" }, "cursor.clickEffect.pullSize01": 0.3 },
    projectPath: "/demo.screenstudio",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "overlapping_keys"));
});

test("live preflight validates joint constraints after combining sibling edits", async () => {
  const call = collectTools((server) =>
    registerEditor(server, {
      editor: {
        raw: async () => ({
          config: {
            styles: {
              background: {
                gradient: {
                  start: { x: 0, y: 0 },
                  end: { x: 1, y: 1 },
                  stops: [
                    { at: 0.2, color: "#000000" },
                    { at: 0.8, color: "#ffffff" },
                  ],
                },
              },
            },
          },
        }),
      },
    }),
  );
  const single = await call("screenstudio_config_validate", {
    changes: { "styles.background.gradient.stops.0.at": 0.7 },
    projectPath: "/demo.screenstudio",
  });
  assert.equal(single.valid, true);
  const result = await call("screenstudio_config_validate", {
    changes: { "styles.background.gradient.stops.0.at": 0.7, "styles.background.gradient.stops.1.at": 0.3 },
    projectPath: "/demo.screenstudio",
  });
  assert.equal(result.valid, false);
});

test("config writes validate combined constraints without inspecting untouched siblings", () => {
  const gradient = {
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
    stops: [
      { at: 0.2, color: "#000000" },
      { at: 0.8, color: "#ffffff" },
    ],
  };
  const config = { styles: { background: { color: "#000000", blur: 999, gradient } } };
  assert.doesNotThrow(() => configPartial(config, { "styles.background.color": "#ffffff" }));
  assert.throws(() =>
    configPartial(config, {
      "styles.background.gradient.stops.0.at": 0.7,
      "styles.background.gradient.stops.1.at": 0.3,
    }),
  );
});

test("known config diagnostics redact record keys and enforce batch limits", () => {
  for (const secret of ["private-combo", "x".repeat(101)]) {
    const result = validateKnownConfig({ "captions.hiddenShortcuts": { [secret]: "yes" } });
    assert.equal(result.valid, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.equal(validateKnownConfig({}).valid, false);
  assert.equal(
    validateKnownConfig(Object.fromEntries(Array.from({ length: 81 }, (_, i) => [`custom.field${i}`, i])))
      .valid,
    false,
  );
});

test("preset validation reads package structure without calling the app", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preset-preflight-"));
  try {
    const source = join(dir, "example.screenstudiopreset");
    await mkdir(source);
    await writeFile(join(source, "meta.json"), "{}");
    const call = collectTools((server) => registerApp(server, { studio: {}, editor: {} }));
    assert.equal((await call("screenstudio_preset_validate", { sourcePath: source })).valid, true);
    await rm(join(source, "meta.json"));
    await assert.rejects(call("screenstudio_preset_validate", { sourcePath: source }), /missing meta.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function collectTools(...registrars) {
  const tools = new Map();
  const server = {
    registerTool(name, config, handler) {
      tools.set(name, async (rawArgs = {}) => {
        const parsed = await z.object(config.inputSchema).parseAsync(rawArgs);
        return handler(parsed, {});
      });
    },
  };
  for (const reg of registrars) reg(server);
  return async (name, args = {}) => {
    const fn = tools.get(name);
    assert.ok(fn, `Missing tool ${name}`);
    const res = await fn(args);
    if (res?.isError) throw new Error(res.content?.[0]?.text ?? "Tool error");
    return JSON.parse(res.content[0].text);
  };
}

async function makeProjectBundle(dir, name = "demo.screenstudio", config = {}) {
  const proj = join(dir, name);
  await mkdir(join(proj, "recording"), { recursive: true });
  await writeFile(
    join(proj, "project.json"),
    JSON.stringify({
      json: {
        version: "4.0.0",
        config: {
          styles: { background: { type: "gradient" } },
          audio: { volume: 1 },
          camera: { lut: null },
          ...config,
        },
        scenes: [{ id: "s1", slices: [] }],
      },
    }),
  );
  return proj;
}

test("project copy reports unsaved source changes across symlink paths without saving", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ss-copy-dirty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = await makeProjectBundle(root);
  const alias = join(root, "alias.screenstudio");
  await symlink(projectPath, alias);
  const destinationPath = join(root, "copy.screenstudio");
  const copied = { projectPath: destinationPath, copiedFrom: projectPath };
  let openEditors = [{ projectPath: alias, dirty: true }];
  const calls = [];
  const call = collectTools((server) =>
    registerProject(server, {
      studio: {
        copyProject: async (source, destination) => {
          calls.push({ source, destination });
          return copied;
        },
      },
      editor: {
        list: async () => openEditors,
        save: async () => assert.fail("Copy must not save the source"),
      },
    }),
  );
  const args = { action: "copy", projectPath, destinationPath };
  assert.deepEqual(await call("screenstudio_project_manage", args), {
    ...copied,
    sourceHasUnsavedChanges: true,
  });
  for (const editors of [
    [{ projectPath: alias, dirty: false }],
    [{ projectPath: destinationPath, dirty: true }],
    [],
  ]) {
    openEditors = editors;
    assert.deepEqual(await call("screenstudio_project_manage", args), copied);
  }
  assert.deepEqual(calls, Array(4).fill({ source: projectPath, destination: destinationPath }));
});

test("project tools: symlink-aware open detection, import partial recovery, asset validation & live reference guard", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ss-proj-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const realProj = await makeProjectBundle(root, "real.screenstudio");
  const symlinkProj = join(root, "alias.screenstudio");
  await symlink(realProj, symlinkProj);

  const imgFile = join(root, "wall.png");
  const txtFile = join(root, "bad.txt");
  const mp3File = join(root, "song.mp3");
  await writeFile(imgFile, "png-bytes");
  await writeFile(txtFile, "not-an-asset");
  await writeFile(mp3File, "mp3-bytes");

  let openEditors = [{ projectPath: symlinkProj, name: "real" }];
  let liveData = null;
  let savedData = { config: { styles: { background: { type: "gradient" } } }, scenes: [] };
  let openShouldThrow = false;
  let copiedFiles = [];
  let removedFiles = [];
  let configUpdates = [];
  let movedCount = 0;

  const studio = {
    path: async (p) => {
      const { realpath } = await import("node:fs/promises");
      const { resolve } = await import("node:path");
      return realpath(p).catch(() => resolve(p));
    },
    recentProjects: async () => [{ path: realProj, lastOpenedAt: 100 }],
    importVideo: async (v) => ({ projectPath: realProj, source: v }),
    moveProject: async (src, _dest, ensureClosed) => {
      await ensureClosed(await studio.path(src));
      movedCount += 1;
      return { moved: true };
    },
    copyProject: async () => ({ copied: true }),
    extractRawRecordingFiles: async () => ({ extracted: true }),
    removeProject: async (src, ensureClosed) => {
      await ensureClosed(await studio.path(src));
      return { removed: true };
    },
    copyFileToProject: async (_p, src) => {
      copiedFiles.push(src);
      return "copied-" + src.split("/").pop();
    },
    removeAssetFromProject: async (projectPath, assetFile, ensureUnused) => {
      const resolved = await studio.path(projectPath);
      const { readProject } = await import("../dist/studio/service.js");
      void readProject;
      await ensureUnused(resolved, savedData);
      removedFiles.push(assetFile);
    },
    readProject: async () => ({
      project: { config: { styles: { background: { type: "gradient" } } }, scenes: [] },
    }),
    luts: async () => [],
  };

  const editor = {
    list: async () => openEditors,
    open: async (p) => {
      if (openShouldThrow) throw new Error("Editor window timed out");
      return { projectPath: p };
    },
    liveProject: async () => liveData,
    updateConfig: async (p, partial) => {
      configUpdates.push({ p, partial });
    },
  };

  const call = collectTools((server) => registerProject(server, { studio, editor }));

  // 1. screenstudio_projects detects open: true across symlink mismatch
  const listed = await call("screenstudio_projects", { limit: 10 });
  assert.equal(listed.projects.length, 1);
  assert.equal(listed.projects[0].open, true);

  // 2. screenstudio_project_import preserves projectPath even if open: true fails
  openShouldThrow = true;
  const imported = await call("screenstudio_project_import", { videoPath: mp3File, open: true });
  assert.equal(imported.projectPath, realProj);
  assert.equal(imported.opened, false);
  assert.match(imported.openError, /Editor window timed out/);

  // 3. screenstudio_project_manage refuses move/remove across symlink open check
  await assert.rejects(
    call("screenstudio_project_manage", {
      action: "move",
      projectPath: realProj,
      destinationPath: join(root, "dest.screenstudio"),
    }),
    /open in a Screen Studio editor/,
  );
  assert.equal(movedCount, 0);

  // 4. screenstudio_project_asset validates extension BEFORE copying into bundle
  await assert.rejects(
    call("screenstudio_project_asset", {
      action: "addImage",
      projectPath: realProj,
      sourcePath: txtFile,
    }),
    /addImage expects a file ending in/,
  );
  await assert.rejects(
    call("screenstudio_project_asset", {
      action: "addLut",
      projectPath: realProj,
      sourcePath: mp3File,
    }),
    /addLut expects a file ending in \.cube/,
  );
  assert.equal(copiedFiles.length, 0);

  // 5. Valid addImage applies using the open editor's live background object across symlink
  liveData = { config: { styles: { background: { type: "color", blur: 12 } } } };
  const addedImg = await call("screenstudio_project_asset", {
    action: "addImage",
    projectPath: realProj,
    sourcePath: imgFile,
  });
  assert.equal(addedImg.applied, true);
  assert.equal(configUpdates[0].p, symlinkProj);
  assert.deepEqual(configUpdates[0].partial.styles.background, {
    type: "image",
    blur: 12,
    image: "copied-wall.png",
  });

  // 6. removeAsset rejects when referenced in unsaved live editor state even if disk doesn't reference it
  liveData = { config: { audio: { backgroundAudioFileName: "copied-song.mp3" } }, scenes: [] };
  await assert.rejects(
    call("screenstudio_project_asset", {
      action: "removeAsset",
      projectPath: realProj,
      assetFile: "copied-song.mp3",
    }),
    /still referenced by audio\.backgroundAudioFileName/,
  );
  assert.equal(removedFiles.length, 0);

  // Cleared live but still referenced by the saved project: discarding the edit would bring the reference back
  liveData = { config: { audio: { backgroundAudioFileName: null } }, scenes: [] };
  savedData = { config: { audio: { backgroundAudioFileName: "copied-song.mp3" } }, scenes: [] };
  await assert.rejects(
    call("screenstudio_project_asset", {
      action: "removeAsset",
      projectPath: realProj,
      assetFile: "copied-song.mp3",
    }),
    /still referenced by audio\.backgroundAudioFileName/,
  );
  assert.equal(removedFiles.length, 0);

  // Once unreferenced in both, removal proceeds
  savedData = { config: { audio: { backgroundAudioFileName: null } }, scenes: [] };
  const removed = await call("screenstudio_project_asset", {
    action: "removeAsset",
    projectPath: realProj,
    assetFile: "copied-song.mp3",
  });
  assert.equal(removed.removed, true);
  assert.deepEqual(removedFiles, ["copied-song.mp3"]);
});

test("screenstudio_presets serializes mutations with studio.lock, checks symlinked open editors, and Editor.updateConfig enforces version", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ss-presets-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const realProj = await makeProjectBundle(root, "p.screenstudio");
  const symlinkProj = join(root, "p-link.screenstudio");
  await symlink(realProj, symlinkProj);

  let lockDepth = 0;
  let maxConcurrency = 0;
  let versionReads = 0;
  let versionWrites = 0;
  let currentBuild = APP_BUILD;
  const openEditors = [{ projectPath: symlinkProj }];

  let tail = Promise.resolve();
  const studio = {
    path: async (p) => {
      const { realpath } = await import("node:fs/promises");
      const { resolve } = await import("node:path");
      return realpath(p).catch(() => resolve(p));
    },
    requireVersion: async (kind = "write") => {
      if (kind === "read") versionReads += 1;
      else versionWrites += 1;
      if (currentBuild !== APP_BUILD) throw new Error(`Unsupported Screen Studio build ${currentBuild}`);
      return currentBuild;
    },
    lock: async (fn) => {
      const prev = tail;
      let rel;
      tail = new Promise((r) => (rel = r));
      await prev;
      lockDepth += 1;
      maxConcurrency = Math.max(maxConcurrency, lockDepth);
      try {
        await new Promise((r) => setTimeout(r, 15));
        return await fn();
      } finally {
        lockDepth -= 1;
        rel();
      }
    },
    projectLock: async (_p, fn) => fn(),
    call: async (_kind, route, _input) => {
      if (route === "presets.all") return [{ id: "pre-1", path: "/presets/One.screenstudiopreset" }];
      return { ok: true, route };
    },
    readProject: async () => ({ project: { config: {} } }),
    evaluate: async () => true,
  };
  const editor = {
    list: async () => openEditors,
    liveProject: async () => null,
  };

  const call = collectTools((server) => registerApp(server, { studio, editor }));

  // list works under read check even on another 4.x build
  await call("screenstudio_presets", { action: "list" });
  assert.equal(versionReads, 1);

  // Concurrent preset mutations serialize through studio.lock (never overlapping)
  await Promise.all([
    call("screenstudio_presets", { action: "rename", presetPath: "pre-1", name: "A" }),
    call("screenstudio_presets", { action: "rename", presetPath: "pre-1", name: "B" }),
  ]);
  assert.equal(maxConcurrency, 1);
  assert.ok(versionWrites >= 2);

  // apply blocks when open editor uses a symlinked project path
  await assert.rejects(
    call("screenstudio_presets", {
      action: "apply",
      presetPath: "pre-1",
      projectPath: realProj,
    }),
    /open in a Screen Studio editor/,
  );

  // Editor.updateConfig enforces requireVersion before touching editor
  currentBuild = "4.99.0-9999";
  let runCalled = false;
  const realEditor = new Editor(
    {
      ...studio,
      evaluate: async () => {
        runCalled = true;
        return true;
      },
    },
    {},
  );
  await assert.rejects(
    realEditor.updateConfig(realProj, { audio: { volume: 0.5 } }),
    /Unsupported Screen Studio build/,
  );
  assert.equal(runCalled, false);
});

test("generateTranscript staleEditor message tells caller about screenstudio_transcript_read without regenerating", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "ss-transcript-stale-test-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const projectPath = new URL("fixtures/window-recording", import.meta.url).pathname;
  const studio = {
    appPath: "/Applications/Screen Studio.app",
    stateDir,
    requireVersion: async () => APP_BUILD,
    call: async () => null,
    evaluate: async (expr) => {
      if (expr.includes("captions.getTranscript") && expr.includes("m.transcriptPromise")) {
        throw new Error("reload failed");
      }
      return [];
    },
  };
  await assert.rejects(
    generateTranscript(studio, projectPath, { type: "system", locale: "en_US" }),
    /screenstudio_transcript_read/,
  );
});

test("findAssetReferences finds nested config/scene refs and ignores transcript text", () => {
  const proj = {
    config: {
      styles: { background: { image: "wall.png" }, extraBrand: { logo: "assets/logo.png" } },
      audio: { backgroundAudioFileName: "bgm.mp3" },
      camera: { lut: "film.cube" },
      cursor: { customPointerPath: "/Users/me/proj.screenstudio/assets/cursor.svg" },
      sensitiveDataCustomPhrases: ["wall.png"],
    },
    scenes: [
      {
        voiceOvers: [{ audioFileName: "vo.wav" }, { path: "assets/vo2.wav" }],
        overlays: [{ src: "badge.png" }],
        transcript: { words: [{ text: "wall.png" }] },
      },
    ],
  };

  assert.deepEqual(findAssetReferences(proj, "wall.png"), ["styles.background.image"]);
  assert.deepEqual(findAssetReferences(proj, "logo.png"), ["styles.extraBrand.logo"]);
  assert.deepEqual(findAssetReferences(proj, "cursor.svg"), ["cursor.customPointerPath"]);
  assert.deepEqual(findAssetReferences(proj, "vo.wav"), ["scenes[0].voiceOvers[0].audioFileName"]);
  assert.deepEqual(findAssetReferences(proj, "vo2.wav"), ["scenes[0].voiceOvers[1].path"]);
  assert.deepEqual(findAssetReferences(proj, "badge.png"), ["scenes[0].overlays[0].src"]);
  assert.deepEqual(findAssetReferences(proj, "mylogo.png"), []);
});

test("screenstudio_presets create/sync fail closed on editor.list error and do not deadlock under real lock", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ss-preset-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const proj = await makeProjectBundle(dir, "demo.screenstudio", {
    styles: { background: { type: "wallpaper" } },
  });

  let locked = false;
  let editorListFails = true;
  const calls = [];
  const studio = {
    appPath: "/Applications/Screen Studio.app",
    stateDir: dir,
    requireVersion: async () => APP_BUILD,
    path: async (p) => p,
    lock: async (fn) => {
      if (locked) throw new Error("Deadlock: re-entrant studio.lock");
      locked = true;
      try {
        return await fn();
      } finally {
        locked = false;
      }
    },
    projectLock: async (_p, fn) => fn(),
    readProject: async (p) => ({
      projectPath: p,
      project: { version: "4.0.0", config: { styles: { background: { type: "wallpaper" } } }, scenes: [] },
    }),
    call: async (kind, method, input) => {
      calls.push({ kind, method, input });
      if (method === "presets.all")
        return [{ id: "p1", name: "Preset 1", path: "/tmp/p1.screenstudiopreset" }];
      return { created: true, method };
    },
  };
  const editor = {
    list: async () => {
      if (editorListFails) throw new Error("renderer list lookup failed");
      return [];
    },
    liveProject: async () => null,
  };

  const call = collectTools((server) => registerApp(server, { studio, editor }));
  await assert.rejects(
    call("screenstudio_presets", { action: "create", projectPath: proj, name: "My Preset" }),
    /renderer list lookup failed/,
  );
  await assert.rejects(
    call("screenstudio_presets", { action: "sync", presetPath: "p1", projectPath: proj }),
    /renderer list lookup failed/,
  );
  assert.equal(
    calls.some((c) => c.method === "presets.create" || c.method === "presets.sync"),
    false,
  );

  // With editor.list() succeeding (closed project -> readProject), create succeeds without deadlocking studio.lock.
  editorListFails = false;
  await call("screenstudio_presets", { action: "create", projectPath: proj, name: "Closed Preset" });
  const created = calls.find((c) => c.method === "presets.create");
  assert.ok(created);
  assert.equal(created.input.presetName, "Closed Preset");
});

test("editor close, preset closeOpenEditor, inspectRaw, record_start hideApp, and window bounds/hideScreenStudio", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ss-new-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const proj = await makeProjectBundle(dir, "raw.screenstudio");
  await writeFile(join(proj, "recording", "video.mp4"), "fake-mp4");
  await writeFile(join(proj, "recording", "mouseclicks-0.json"), "[]");
  await writeFile(
    join(proj, "recording", "metadata.json"),
    JSON.stringify({
      recorders: [
        {
          type: "window",
          id: "screen",
          sessions: [
            {
              outputFilename: "video.mp4",
              durationMs: 2500,
              processTimeStartMs: 123456,
              unixStartMs: 1700000000000,
              unixEndMs: 1700000002500,
              bounds: { x: 10, y: 20, width: 1280, height: 720 },
            },
          ],
        },
        {
          type: "input",
          sessions: [{ processTimeStartMs: 123400, mouseClicksFilename: "mouseclicks-0.json" }],
        },
      ],
    }),
  );

  let openProjects = [proj];
  const calls = [];
  const studio = {
    appPath: "/Applications/Screen Studio.app",
    stateDir: dir,
    requireVersion: async () => APP_BUILD,
    path: async (p) => p,
    lock: async (fn) => fn(),
    projectLock: async (_p, fn) => fn(),
    call: async (_kind, method, input) => {
      calls.push({ method, input });
      if (method === "presets.all")
        return [{ id: "p1", name: "Preset 1", path: "/tmp/p1.screenstudiopreset" }];
      if (method === "presets.apply") return { applied: true };
      return {};
    },
    start: async (input) => {
      calls.push({ method: "studio.start", input });
      return { started: true };
    },
    windowAction: async (windowId, action) => {
      calls.push({ method: "studio.windowAction", windowId, action });
      return { windowId, action };
    },
    evaluate: async (script) => {
      calls.push({ method: "evaluate", script });
      if (script.includes(".close()")) openProjects = openProjects.filter((x) => !script.includes(x));
      if (script.includes("return __ss.contexts().map")) {
        return openProjects.map((p) => ({ projectPath: p, name: "raw", dirty: false, focused: true }));
      }
      return { saved: true, unsavedChanges: false };
    },
  };
  const desktop = {
    hideApp: async () => {
      calls.push({ method: "desktop.hideApp" });
      return { bundleId: "com.timpler.screenstudio", hidden: true, matchedCount: 1 };
    },
    bounds: async (windowId) => ({
      windowId,
      bounds: { x: 0, y: 25, width: 1280, height: 720 },
      backingScaleFactor: 2,
    }),
  };

  const realEditor = new Editor(studio, desktop);
  const call = collectTools(
    (s) => registerApp(s, { studio, editor: realEditor }),
    (s) => registerEditor(s, { studio, editor: realEditor }),
    (s) => registerProject(s, { studio, editor: realEditor }),
    (s) => registerRecording(s, { studio, desktop }),
    (s) => registerDesktop(s, { studio, desktop }),
  );

  // presets apply refuses while open unless closeOpenEditor is true
  await assert.rejects(
    call("screenstudio_presets", { action: "apply", presetPath: "p1", projectPath: proj }),
    /open in a Screen Studio editor/,
  );

  const applied = await call("screenstudio_presets", {
    action: "apply",
    presetPath: "p1",
    projectPath: proj,
    closeOpenEditor: true,
  });
  assert.equal(applied.applied, true);
  assert.deepEqual(openProjects, []);

  // Re-closing an already closed project reports alreadyClosed
  const secondClose = await call("screenstudio_editor_close", { projectPath: proj });
  assert.equal(secondClose.alreadyClosed, true);

  // inspectRaw exposes raw metadata including processTimeStartMs
  const raw = await call("screenstudio_project_manage", { action: "inspectRaw", projectPath: proj });
  assert.equal(raw.durationMs, 2500);
  assert.equal(raw.sessions[0].processStart, 123456);
  assert.equal(raw.inputRecorder.sessions[0].processTimeStartMs, 123400);

  // record_start hideApp delegates to desktop.hideApp after start
  const rec = await call("screenstudio_record_start", { windowId: 42, name: "demo", hideApp: true });
  assert.equal(rec.started, true);
  assert.equal(rec.appHidden, true);

  // window bounds & hideScreenStudio
  const b = await call("screenstudio_window", { action: "bounds", windowId: 42 });
  assert.equal(b.backingScaleFactor, 2);
  const h = await call("screenstudio_window", { action: "hideScreenStudio" });
  assert.equal(h.hidden, true);
  await assert.rejects(call("screenstudio_window", { action: "bounds" }), /windowId is required/);
});

test("editor_apply preserves recovery evidence when post-apply live inspection is unavailable", async () => {
  const applied = {
    results: [{ op: "config", groups: ["cursor"] }],
    checkpointId: "owned-checkpoint",
    saved: false,
    saveOutcome: "unknown",
    saveId: "00000000-0000-4000-8000-000000000001",
  };
  for (const diskFallback of [false, true]) {
    const call = collectTools((server) =>
      registerEditor(server, {
        studio: {},
        editor: { apply: async () => applied },
        timeline: async () => {
          if (!diskFallback) throw new Error("Renderer unavailable");
          return { live: false };
        },
      }),
    );
    const result = await call("screenstudio_editor_apply", {
      projectPath: "/owned.screenstudio",
      ops: [{ op: "config", changes: { "cursor.size": 49 } }],
    });
    for (const [key, value] of Object.entries(applied)) assert.deepEqual(result[key], value);
    assert.equal(result.inspection.status, "unavailable");
    assert.equal(result.pacing, undefined);
    assert.equal(result.timeline, undefined);
  }
});

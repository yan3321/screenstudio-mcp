// The MCP surface: config validation, argument shapes, tool annotations,
// status features and the native helper's keyboard layout lookup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { offlineTransport } from "./support/stdio.mjs";
import { inspectProjectBundle, validateConfigChange } from "../dist/studio/project.js";
import { configPartial, editOp } from "../dist/studio/editor/ops.js";
import { desktopAction, helperArgs, helperTimeoutMs } from "../dist/studio/desktop.js";
import { span } from "../dist/mcp/tool.js";
import { assertPresetSource, features, findPresetPath, presetPaths } from "../dist/mcp/tools/app.js";
import { defaultExportFps } from "../dist/mcp/tools/export.js";
import { validateExportOptions } from "../dist/studio/service.js";

const config = () => ({
  animations: {
    screenMovementSpring: { stiffness: 200, damping: 45, mass: 2.5, clamp: true, precision: 0.002 },
    motionBlurAmount: 0.5,
  },
  captions: { hiddenShortcuts: {} },
  styles: {
    screenBorderRadius: 14,
    screenInset: { size: 0, origin01: { x: 0, y: 0 }, alpha: 0.5, color: "#000000" },
    shadow: { intensity: 0.5, distance: 25, angle: 45, blur: 20, isDirectional: true },
    background: {
      type: "system",
      color: "#4776e6",
      gradient: {
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
        stops: [
          { color: "#4776e6", at: 0 },
          { color: "#8e54e9", at: 1 },
        ],
      },
      systemName: "Sunset/sunset-4.jpg",
      image: null,
      blur: 0,
    },
  },
});

test("camera crop can be initialized when the optional field is absent", () => {
  const c = { camera: { hide: false } };
  const crop = { x: 0.23, y: 0, width: 0.56, height: 1 };
  assert.deepEqual(validateConfigChange(c, "camera.crop01", crop), crop);
  assert.deepEqual(configPartial(c, { "camera.crop01": crop }), { camera: { crop01: crop } });
  assert.throws(() => validateConfigChange(c, "camera.crop01", { ...crop, width: 2 }));
  assert.throws(() => validateConfigChange(c, "camera.unknown", true), /Unknown config field/);
});

test("a whole config group is refused instead of landing under an undefined field", () => {
  assert.throws(
    () => validateConfigChange(config(), "styles", { screenBorderRadius: 10 }),
    /one field inside/,
  );
  assert.throws(() => configPartial(config(), { animations: { screenMovementSpring: { stiffness: -5 } } }));
});

test("a parent key is merged field by field and every nested rule still applies", () => {
  const c = config();
  assert.throws(() => validateConfigChange(c, "styles.shadow", { intensity: 99 }));
  assert.throws(() => validateConfigChange(c, "styles.shadow", { distance: -1e9 }));
  assert.throws(() => validateConfigChange(c, "styles.background", { type: "plaid" }));
  assert.throws(() => validateConfigChange(c, "styles.shadow", { glow: 1 }), /Unknown config field/);
  assert.throws(() => validateConfigChange(c, "styles.shadow", 3), /expects object/);
  const shadow = validateConfigChange(c, "styles.shadow", { intensity: 0.4 });
  assert.deepEqual(shadow, { ...c.styles.shadow, intensity: 0.4 });
  // An empty object changes nothing rather than emptying the group.
  assert.deepEqual(validateConfigChange(c, "styles.background", {}), c.styles.background);
  const p = configPartial(c, { "styles.shadow": { distance: 40 } });
  assert.equal(p.styles.shadow.distance, 40);
  assert.equal(p.styles.shadow.isDirectional, true);
});

test("fields inside a ruled object are checked by that object's rule", () => {
  const c = config();
  assert.throws(() => validateConfigChange(c, "animations.screenMovementSpring.stiffness", -5));
  assert.equal(validateConfigChange(c, "animations.screenMovementSpring.stiffness", 300), 300);
  assert.throws(() =>
    validateConfigChange(c, "styles.background.gradient.stops", [
      { color: "red", at: 0 },
      { color: "#000000", at: 1 },
    ]),
  );
  const p = configPartial(c, { "styles.background.gradient.end": { x: 1, y: 0 } });
  assert.deepEqual(p.styles.background.gradient.end, { x: 1, y: 0 });
  assert.equal(p.styles.background.gradient.stops.length, 2);
});

test("background gradients, inset origins and hidden shortcuts have exact rules", () => {
  const c = config();
  const gradient = {
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
    stops: [
      { color: "#ff7a59", at: 0 },
      { color: "#7b2ff7", at: 1 },
    ],
  };
  assert.deepEqual(validateConfigChange(c, "styles.background.gradient", gradient), gradient);
  assert.throws(() => validateConfigChange(c, "styles.background.gradient", {}));
  assert.throws(
    () =>
      validateConfigChange(c, "styles.background.gradient", {
        ...gradient,
        stops: [...gradient.stops].reverse(),
      }),
    /in order/,
  );
  assert.throws(() =>
    validateConfigChange(c, "styles.background.gradient", { ...gradient, stops: [gradient.stops[0]] }),
  );
  assert.throws(() => validateConfigChange(c, "styles.screenInset.origin01", { x: 2, y: 0 }));
  assert.deepEqual(validateConfigChange(c, "captions.hiddenShortcuts", { "cmd+tab": true }), {
    "cmd+tab": true,
  });
  assert.throws(() => validateConfigChange(c, "captions.hiddenShortcuts", { "cmd+tab": "yes" }));
});

test("4.1.0-5005 optional fields and expanded editor ops validate safely", () => {
  const base = {
    ...config(),
    camera: { hide: false, background: { blurAmount01: 0 } },
    processing: { improveRecordingQuality01: 0.5 },
  };
  // Group exists, optional leaf is omitted in serialized config until set:
  assert.equal(validateConfigChange(base, "camera.delayAdjustmentMs", -120), -120);
  assert.equal(validateConfigChange(base, "camera.background.edgeInsetPx", 12), 12);
  assert.equal(validateConfigChange(base, "processing.autoMaskSensitiveData", true), true);
  assert.equal(validateConfigChange(base, "processing.sensitiveDataExpandPx", 18), 18);
  assert.deepEqual(validateConfigChange(base, "processing.sensitiveDataCustomPhrases", ["secret-key"]), [
    "secret-key",
  ]);
  assert.equal(validateConfigChange(base, "processing.autoMaskFaces", true), true);
  // Switching from an image backdrop that omitted gradient/color/systemName/blur still works:
  const imgConfig = { styles: { background: { type: "image", image: "bg.png" } } };
  assert.equal(validateConfigChange(imgConfig, "styles.background.type", "gradient"), "gradient");
  assert.equal(validateConfigChange(imgConfig, "styles.background.color", "#112233"), "#112233");
  // Missing parent group or unknown keys remain rejected:
  assert.throws(() => validateConfigChange(config(), "camera.delayAdjustmentMs", 0), /Unknown config field/);
  assert.throws(() => validateConfigChange(base, "processing.unknownFlag", true), /Unknown config field/);
  assert.throws(() => validateConfigChange(base, "camera.nonExistent", 1), /Unknown config field/);

  // Expanded layout options, zoom instant on updateZoom, and slice audio volumes:
  assert.ok(
    editOp.safeParse({
      op: "addLayout",
      startMs: 0,
      endMs: 2000,
      type: "camera-overlay",
      options: { cameraOverlay: { overlayCameraSizeRatio01: 0.35, overlayZoomedCameraScale: 0.8 } },
    }).success,
  );
  assert.ok(
    editOp.safeParse({
      op: "updateZoom",
      zoomId: "z1",
      instant: true,
    }).success,
  );
  assert.ok(
    editOp.safeParse({
      op: "setSlices",
      slices: [{ startMs: 0, endMs: 1000, speed: 1, systemAudioVolume: 0.6, externalDeviceAudioVolume: 0.5 }],
    }).success,
  );
});

test("a null field with no known shape takes plain values only", () => {
  assert.throws(
    () => validateConfigChange(config(), "styles.background.image", { path: "/x.png" }),
    /no known shape/,
  );
  assert.equal(validateConfigChange(config(), "styles.background.image", null), null);
});

test("keep and drop spans must end after they start", () => {
  assert.ok(span.safeParse({ startMs: 0, endMs: 1000 }).success);
  assert.ok(!span.safeParse({ startMs: 12000, endMs: 8000 }).success);
  assert.ok(!span.safeParse({ startMs: 5000, endMs: 5000 }).success);
});

test("scroll can aim at a point in the window, and typing gets time for its length", () => {
  assert.deepEqual(helperArgs({ type: "scroll", lines: -3 }), ["-3"]);
  assert.deepEqual(helperArgs({ type: "scroll", lines: 5, x: 200, y: 300 }), ["5", "200", "300"]);
  assert.ok(desktopAction.safeParse({ type: "scroll", lines: 5, x: 200, y: 300 }).success);
  assert.ok(!desktopAction.safeParse({ type: "scroll", lines: 5, x: 200 }).success);
  assert.equal(helperTimeoutMs({ type: "click", x: 1, y: 1 }, 3), 80000);
  assert.equal(helperTimeoutMs({ type: "type", text: "hi" }, 1), 80000);
  const long = { type: "type", text: "x".repeat(2000) };
  // Worst case per character is about 25ms + 190ms x pace.
  for (const pace of [0.5, 1, 3]) assert.ok(helperTimeoutMs(long, pace) > 2000 * (25 + 190 * pace));
});

test("status reports the editing features this server has", () => {
  assert.equal(features.maskEditing, true);
  assert.equal(features.layoutTimelineEditing, true);
  assert.equal(features.transcriptGeneration, true);
  assert.equal(features.voiceoverGeneration, false);
});

test("a preset can only be applied by a path or id the presets list returned", () => {
  const listing = [{ id: "id-1", name: "/outside/victim", path: "/p/brand.json" }, { path: "/p/dark.json" }];
  const paths = presetPaths(listing);
  assert.ok(paths.has("/p/brand.json") && paths.has("/p/dark.json"));
  assert.ok(!paths.has("/p/other.json"));
  assert.ok(!paths.has("/outside/victim"));
  assert.ok(!paths.has("path"));
  assert.equal(findPresetPath(listing, "/p/brand.json"), "/p/brand.json");
  assert.equal(findPresetPath(listing, "id-1"), "/p/brand.json");
  assert.equal(findPresetPath(listing, "/outside/victim"), undefined);
  assert.equal(findPresetPath(listing, "path"), undefined);
});

test("tools that discard work or go online say so", async (t) => {
  const client = new Client({ name: "annotations", version: "1" });
  await client.connect(await offlineTransport(t));
  try {
    const { tools } = await client.listTools();
    const hints = (name) => tools.find((t) => t.name === name).annotations;
    assert.equal(hints("screenstudio_record_control").destructiveHint, true);
    assert.equal(hints("screenstudio_record_recover").destructiveHint, true);
    assert.equal(hints("screenstudio_project_manage").destructiveHint, true);
    assert.equal(hints("screenstudio_project_asset").destructiveHint, true);
    assert.equal(hints("screenstudio_presets").destructiveHint, true);
    assert.equal(hints("screenstudio_luts").destructiveHint, true);
    assert.equal(hints("screenstudio_narrate").openWorldHint, true);
    assert.equal(hints("screenstudio_transcript_generate").openWorldHint, true);
    assert.equal(hints("screenstudio_music").destructiveHint, false);
  } finally {
    await client.close();
  }
});

const helper = new URL("../native/desktop-helper", import.meta.url).pathname;
const nativeReady =
  process.platform === "darwin" &&
  (await access(helper).then(
    () => true,
    () => false,
  ));

test("shortcuts follow the keyboard layout, not US key positions", { skip: !nativeReady }, async () => {
  const run = promisify(execFile);
  const resolve = async (...args) => JSON.parse((await run(helper, ["resolve-key", ...args])).stdout);
  // On AZERTY the US "a" and "z" positions are Q and W: Cmd+A by position would quit the app.
  assert.deepEqual(await resolve("a", "command", "com.apple.keylayout.French"), {
    keyCode: 12,
    modifiers: ["command"],
  });
  assert.equal((await resolve("z", "command", "com.apple.keylayout.French")).keyCode, 13);
  // Digits need Shift on AZERTY.
  assert.deepEqual(await resolve("1", "", "com.apple.keylayout.French"), {
    keyCode: 18,
    modifiers: ["shift"],
  });
  // QWERTZ swaps z and y, so undo would become redo.
  assert.equal((await resolve("z", "command", "com.apple.keylayout.German")).keyCode, 16);
  assert.equal((await resolve("z", "command", "com.apple.keylayout.US")).keyCode, 6);
  assert.equal((await resolve("return")).keyCode, 36);
  await assert.rejects(
    run(helper, ["resolve-key", "z", "", "com.apple.keylayout.Russian"]),
    /not on the current/,
  );
});

test("preset import accepts .screenstudiopreset packages and files while rejecting incomplete inputs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ss-preset-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const bundle = join(dir, "Valid.screenstudiopreset");
  await mkdir(bundle);
  await writeFile(join(bundle, "meta.json"), JSON.stringify({ version: "4.0.0" }));
  assert.equal(await assertPresetSource(bundle), bundle);

  const file = join(dir, "Legacy.screenstudiopreset");
  await writeFile(file, "{}");
  assert.equal(await assertPresetSource(file), file);

  const emptyBundle = join(dir, "Empty.screenstudiopreset");
  await mkdir(emptyBundle);
  await assert.rejects(assertPresetSource(emptyBundle), /missing meta\.json/);
  await assert.rejects(assertPresetSource("relative.screenstudiopreset"), /absolute/);
  await assert.rejects(assertPresetSource(join(dir, "wrong.json")), /\.screenstudiopreset/);
  await assert.rejects(assertPresetSource(join(dir, "Missing.screenstudiopreset")), /No preset found/);
});

test("export defaults and bundle inspector enforce format-specific fps and minimum project structure", async (t) => {
  for (const format of ["mp4", "prores", "gif"]) {
    assert.doesNotThrow(() =>
      validateExportOptions({
        height: 1080,
        fps: defaultExportFps(format),
        format,
        quality: "studio",
      }),
    );
  }

  const dir = await mkdtemp(join(tmpdir(), "ss-bundle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "project.json"), JSON.stringify({ json: { version: "4.0.0" } }));
  assert.equal((await inspectProjectBundle(dir)).valid, false);
  await writeFile(
    join(dir, "project.json"),
    JSON.stringify({ json: { version: "4.0.0", config: null, scenes: "broken" } }),
  );
  assert.equal((await inspectProjectBundle(dir)).valid, false);
  await writeFile(
    join(dir, "project.json"),
    JSON.stringify({ json: { version: "4.0.0", config: {}, scenes: [{}] } }),
  );
  assert.equal((await inspectProjectBundle(dir)).valid, false);
  await writeFile(
    join(dir, "project.json"),
    JSON.stringify({ json: { version: "4.0.0", config: {}, scenes: [] } }),
  );
  assert.equal((await inspectProjectBundle(dir)).valid, true);
});

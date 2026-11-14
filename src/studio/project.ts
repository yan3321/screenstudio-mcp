import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { PROJECT_SCHEMA } from "./compat.js";
import { num as n, rect01, unit } from "./schemas.js";

export function projectEditFingerprint(project: Record<string, unknown>) {
  const content = { ...project };
  // Saving changes this timestamp even when the rendered project is unchanged.
  delete content.lastSavedAt;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/** Inspects `<projectPath>/project.json` on disk without touching Screen Studio IPC. */
export async function inspectProjectBundle(
  projectPath: string,
): Promise<{ valid: true; data: any } | { valid: false; reason: string }> {
  let raw: string;
  try {
    raw = await readFile(join(projectPath, "project.json"), "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT")
      return {
        valid: false,
        reason: `Incomplete Screen Studio project (missing project.json in ${projectPath}). Use screenstudio_record_recover to check unfinished recordings instead of opening it.`,
      };
    return { valid: false, reason: `Cannot read project.json in ${projectPath}: ${e?.message ?? String(e)}` };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    return { valid: false, reason: `Corrupted project.json in ${projectPath}: ${e?.message ?? String(e)}` };
  }
  const data = parsed?.json ?? parsed;
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { valid: false, reason: `Corrupted project.json in ${projectPath}.` };
  if (data.version !== PROJECT_SCHEMA)
    return { valid: false, reason: `Project schema is unsupported (${String(data.version ?? "unknown")}).` };
  if (
    !data.config ||
    typeof data.config !== "object" ||
    Array.isArray(data.config) ||
    !Array.isArray(data.scenes)
  )
    return {
      valid: false,
      reason: `Incomplete or corrupted project.json in ${projectPath} (missing config or scenes).`,
    };
  for (const scene of data.scenes) {
    if (!scene || typeof scene !== "object" || !Array.isArray(scene.slices)) {
      return {
        valid: false,
        reason: `Incomplete or corrupted project.json in ${projectPath} (invalid scene entry).`,
      };
    }
  }
  if (data.scenes.some((s: any) => s?.type === "recording")) {
    const rec = await stat(join(projectPath, "recording")).catch(() => null);
    if (!rec?.isDirectory())
      return {
        valid: false,
        reason: `Incomplete Screen Studio project (missing recording folder in ${projectPath}). Use screenstudio_record_recover to check unfinished recordings instead of opening it.`,
      };
  }
  return { valid: true, data };
}

/** Refuses incomplete or incompatible `.screenstudio` bundles before Screen Studio IPC can hang on them. */
export async function assertProjectBundle(projectPath: string) {
  const checked = await inspectProjectBundle(projectPath);
  if (!checked.valid) throw new Error(checked.reason);
  return checked.data;
}

const SKIP_ASSET_KEYS = new Set(["transcript", "words", "sensitiveDataCustomPhrases"]);

/** Config or scene fields that actively reference an asset filename inside a project bundle. */
export function findAssetReferences(project: any, assetFile: string): string[] {
  const refs: string[] = [];
  const active = new Set<unknown>();
  const walk = (node: unknown, path: string) => {
    if (typeof node === "string") {
      if (node === assetFile || node.endsWith(`/${assetFile}`)) refs.push(path);
      return;
    }
    if (!node || typeof node !== "object" || active.has(node)) return;
    active.add(node);
    try {
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${path}[${i}]`));
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        if (SKIP_ASSET_KEYS.has(key)) continue;
        walk(value, path ? `${path}.${key}` : key);
      }
    } finally {
      active.delete(node);
    }
  };
  if (project?.config !== undefined) walk(project.config, "");
  if (project?.scenes !== undefined) walk(project.scenes, "scenes");
  return refs;
}

/** Config groups persisted inside Screen Studio `.screenstudiopreset` files. */
export const PRESET_GROUPS = [
  "cursor",
  "captions",
  "audio",
  "camera",
  "animations",
  "processing",
  "zooms",
  "defaultLayout",
  "device",
  "output",
  "styles",
] as const;

export function extractPresetConfig(config: Record<string, unknown>) {
  return Object.fromEntries(PRESET_GROUPS.filter((g) => g in config).map((g) => [g, config[g]]));
}
const color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
const point = z.object({ x: n, y: n }).strict();
const point01 = z.object({ x: unit, y: unit }).strict();
const gradient = z
  .object({
    start: point01,
    end: point01,
    stops: z
      .array(z.object({ color, at: unit }).strict())
      .min(2)
      .max(8)
      .refine((stops) => stops.every((s, i) => i === 0 || s.at >= stops[i - 1].at), {
        message: "Gradient stops must be in order of at.",
      }),
  })
  .strict();
const spring = z
  .object({
    stiffness: n.min(5).max(600),
    damping: n.min(5).max(200),
    mass: n.min(0.1).max(15),
    clamp: z.boolean().default(true),
    precision: n.min(0.0001).max(0.1).default(0.002),
  })
  .strict();

/**
 * Exact rules for settings whose values have known ranges or choices (from the
 * app's own schema). Any other field that exists in the project config can be
 * set too, as long as the value keeps the field's type. Fields inside a ruled
 * object (e.g. styles.background.gradient.stops) are checked by its rule.
 */
export const configFields: Record<string, z.ZodType> = {
  "crop.rect01": rect01,
  "cursor.size": n.min(8).max(256),
  "cursor.hide": z.boolean(),
  "cursor.set": z
    .object({ id: z.string().min(1), variants: z.record(z.string(), z.unknown()).default({}) })
    .strict(),
  "cursor.rotationMode": z.enum(["velocity", "directional"]),
  "cursor.rotateOnXMovementRatio": unit,
  "cursor.baseRotation": n.min(-180).max(180),
  "cursor.useDefaultIfAppHasLowResolution": z.boolean(),
  "cursor.alwaysUseDefault": z.boolean(),
  "cursor.hideNotMovingAfterMs": n.min(0).max(10000).nullable(),
  "cursor.stopMovementInLastPartMs": n.min(0).max(5000),
  "cursor.loopPositionBeforeEndMs": n.min(0).max(5000).nullable(),
  "cursor.removeShakeTreshold": n.min(0).max(2000),
  "cursor.optimizeOriginalTypes": z.boolean(),
  "cursor.followRecordedPositionOnHover": z.boolean(),
  "cursor.clickEffect": z.union([
    z.null(),
    z.object({ type: z.literal("circle") }).strict(),
    z.object({ type: z.literal("ripple"), pullSize01: unit.optional() }).strict(),
  ]),
  "captions.enableTranscript": z.boolean(),
  "captions.enableShortcuts": z.boolean(),
  "captions.showShortcutsWithSingleLetters": z.boolean(),
  "captions.shortcutsSizeRatio": n.min(0.02).max(0.3),
  "captions.showSoundLabels": z.boolean(),
  "captions.font": z.enum(["serif", "sans-serif", "mono"]),
  "captions.sizeRatio": n.min(0.01).max(0.25),
  "captions.color": color,
  "captions.backgroundColor": color,
  "captions.position01": point,
  "captions.hiddenShortcuts": z.record(z.string().min(1).max(100), z.boolean()),
  "captions.wordsReveal": z.enum(["line-by-line", "word-by-word"]),
  "captions.lineGrowth": z.enum(["entire-line", "left-anchored", "centered"]),
  "captions.wordEntrance": z.enum(["appear", "fade-in", "slide-in"]),
  "audio.volume": n.min(0).max(2),
  "audio.muteMicrophone": z.boolean(),
  "audio.microphoneAudioPreset": z.enum(["voice", "loud", "noise-reduction", "podcast", "channel-fix"]),
  "audio.muteSystemAudio": z.boolean(),
  "audio.backgroundAudioVolume": unit,
  "audio.backgroundAudioFileName": z.string().min(1).nullable(),
  "audio.muteBackgroundAudio": z.boolean(),
  "audio.muteExternalDeviceAudio": z.boolean(),
  "audio.clickSoundEffect": z.enum(["apple-magic-mouse", "logitech-mx-master"]).nullable(),
  "audio.clickSoundEffectVolume": unit,
  "camera.hide": z.boolean(),
  "camera.mirror": z.boolean(),
  "camera.aspectRatio": n.min(0.2).max(5),
  "camera.enableFaceTracking": z.boolean(),
  "camera.hideDuringSilenceMs": n.min(0).max(60000).nullable(),
  "camera.lut": z.string().min(1).nullable(),
  "camera.lutIntensity": unit,
  "camera.grain": unit,
  "camera.sharpen01": unit,
  "camera.crop01": rect01,
  "camera.delayAdjustmentMs": n.min(-5000).max(5000),
  "camera.background.blurAmount01": unit,
  "camera.background.edgeFalloff01": unit,
  "camera.background.edgeInsetPx": n.min(0).max(100),
  "processing.improveRecordingQuality01": unit,
  "processing.autoMaskSensitiveData": z.boolean(),
  "processing.sensitiveDataExpandPx": n.min(0).max(100),
  "processing.sensitiveDataCustomPhrases": z.array(z.string().min(1).max(200)).max(200),
  "processing.autoMaskFaces": z.boolean(),
  "zooms.startAnimationEarly": z.boolean(),
  "animations.motionBlurAmount": n.min(0).max(2),
  "animations.screenMovementSpring": spring,
  "animations.mouseMovementSpring": spring,
  "defaultLayout.type": z.enum(["camera-overlay", "split-screen", "cutout-camera"]),
  "defaultLayout.cameraOverlay.overlayCameraPosition01": point,
  "defaultLayout.cameraOverlay.overlayCameraSizeRatio01": unit,
  "defaultLayout.cameraOverlay.overlayCameraPaddingRatio01": unit,
  "defaultLayout.cameraOverlay.overlayCameraAspectRatio": n.min(0.2).max(5),
  "defaultLayout.cameraOverlay.overlayZoomedCameraScale": unit,
  "defaultLayout.splitScreen.splitDirection": z.enum(["auto", "horizontal", "vertical"]),
  "defaultLayout.splitScreen.splitFlip": z.boolean(),
  "defaultLayout.splitScreen.splitScreenRatio01": unit.nullable(),
  "defaultLayout.splitScreen.enablePadding": z.boolean(),
  "defaultLayout.cutoutCamera.cutoutCameraPositionX01": unit,
  "defaultLayout.cutoutCamera.cutoutCameraSizeRatio01": n.min(0.1).max(1.5),
  "defaultLayout.cutoutCamera.cutoutCameraZoomedScale": unit,
  "defaultLayout.cutoutCamera.cutoutCameraAspectRatio": n.min(0.2).max(5).nullable(),
  "styles.screenBorderRadius": n.min(0).max(200),
  "styles.cameraBorderRadiusRatio01": unit,
  "styles.screenInset.size": n.min(0).max(100),
  "styles.screenInset.color": color,
  "styles.screenInset.alpha": unit,
  "styles.screenInset.origin01": point01,
  "styles.background.type": z.enum(["color", "gradient", "system", "image", "unsplash"]),
  "styles.background.color": color,
  "styles.background.gradient": gradient,
  "styles.background.systemName": z.string().regex(/^[\w .&-]+\/[\w .&-]+\.(jpg|jpeg|png|heic)$/),
  "styles.background.blur": n.min(0).max(100),
  "styles.shadow.intensity": unit,
  "styles.shadow.distance": n.min(0).max(200),
  "styles.shadow.angle": n.min(0).max(360),
  "styles.shadow.blur": n.min(0).max(200),
  "styles.shadow.isDirectional": z.boolean(),
  "device.enableMockup": z.boolean(),
  "device.frameKey": z.string().min(1).nullable(),
  "output.paddingRatio01": n.min(0).max(0.4),
  "output.aspectRatio": z.union([z.literal("auto"), n.min(0.2).max(5)]),
  "output.avoidEmptyZoomArea": z.boolean(),
};

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const unknownField = (key: string) =>
  new Error(`Unknown config field: ${key}. Read the editor state for the project's config.`);

// Screen Studio omits these optional fields until set (or zeroed for edgeInsetPx).
// Only known optional fields may be initialized when their parent group exists.
const OPTIONAL_FIELDS: Record<string, readonly string[]> = {
  "camera.crop01": ["camera"],
  "camera.delayAdjustmentMs": ["camera"],
  "camera.background.edgeInsetPx": ["camera", "background"],
  "processing.autoMaskSensitiveData": ["processing"],
  "processing.sensitiveDataExpandPx": ["processing"],
  "processing.sensitiveDataCustomPhrases": ["processing"],
  "processing.autoMaskFaces": ["processing"],
  "styles.background.color": ["styles", "background"],
  "styles.background.gradient": ["styles", "background"],
  "styles.background.systemName": ["styles", "background"],
  "styles.background.blur": ["styles", "background"],
};

function currentValue(config: any, parts: readonly string[], key: string) {
  let target = config;
  for (const part of parts) {
    if (!target || typeof target !== "object" || !Object.hasOwn(target, part)) throw unknownField(key);
    target = target[part];
  }
  return target;
}

/**
 * Validates one dotted config change against the live project config and
 * returns the value to write at that key.
 * - Known fields use exact rules, and a field inside a ruled object (a spring's
 *   stiffness, a gradient's stops) is checked as part of that whole object.
 * - A group of fields (styles.shadow) is merged field by field, so every nested
 *   rule still applies and no field can be added or dropped.
 * - Any other existing field must keep its type. A field that is currently null
 *   and has no rule accepts only plain values, since its object shape is unknown.
 */
export function validateKnownConfig(changes: Record<string, unknown>) {
  const validated: string[] = [];
  const deferred: string[] = [];
  const errors: { key: string; code: string; fields: string[] }[] = [];
  const keys = Object.keys(changes);
  if (!keys.length || keys.length > 80) errors.push({ key: "<batch>", code: "batch_size", fields: [] });
  for (const key of keys)
    if (keys.some((other) => other !== key && key.startsWith(`${other}.`)))
      errors.push({ key, code: "overlapping_keys", fields: [] });
  let visited = 0;
  const check = (key: string, value: unknown, depth = 0) => {
    if (++visited > 1000 || depth > 32) {
      if (!errors.some((error) => error.code === "complexity_limit"))
        errors.push({ key: "<batch>", code: "complexity_limit", fields: [] });
      return;
    }
    if (key.split(".").length < 2 || key.split(".").some((part) => !part || FORBIDDEN.has(part))) {
      errors.push({ key, code: "invalid_key", fields: [] });
      return;
    }
    const rule = Object.hasOwn(configFields, key) ? configFields[key] : undefined;
    if (rule) {
      const parsed = rule.safeParse(value);
      if (parsed.success) validated.push(key);
      else for (const issue of parsed.error.issues) errors.push({ key, code: issue.code, fields: [] });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!Object.keys(value).length) deferred.push(key);
      for (const [field, child] of Object.entries(value)) check(`${key}.${field}`, child, depth + 1);
    } else deferred.push(key);
  };
  for (const [key, value] of Object.entries(changes)) check(key, value);
  return { valid: !errors.length && !deferred.length, validated, deferred, errors };
}

export function validateCombinedConfig(config: unknown, changes: Record<string, unknown>) {
  const owners = new Set<string>();
  const visit = (key: string, value: unknown) => {
    const parts = key.split(".");
    for (let length = parts.length; length >= 2; length--) {
      const owner = parts.slice(0, length).join(".");
      if (Object.hasOwn(configFields, owner)) {
        owners.add(owner);
        return;
      }
    }
    if (value && typeof value === "object" && !Array.isArray(value))
      for (const [field, child] of Object.entries(value)) visit(`${key}.${field}`, child);
  };
  for (const [key, value] of Object.entries(changes)) visit(key, value);
  for (const owner of owners) configFields[owner].parse(currentValue(config, owner.split("."), owner));
}

export function validateConfigChange(config: any, key: string, value: unknown): unknown {
  const parts = key.split(".");
  if (parts.some((p) => !p || FORBIDDEN.has(p))) throw new Error(`Invalid config key: ${key}`);
  if (parts.length < 2) {
    const example =
      Object.keys(configFields).find((k) => k.startsWith(`${key}.`)) ?? "styles.background.color";
    throw new Error(`Set one field inside the ${key} group, like ${example}, not the whole group.`);
  }
  const optionalParent = OPTIONAL_FIELDS[key];
  if (optionalParent) {
    let parent = config;
    for (const part of optionalParent) {
      if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, part)) {
        parent = null;
        break;
      }
      parent = parent[part];
    }
    if (parent && typeof parent === "object" && !Object.hasOwn(parent, parts.at(-1)!))
      return configFields[key].parse(value);
  }
  const current = currentValue(config, parts, key);
  if (Object.hasOwn(configFields, key)) return configFields[key].parse(value);
  for (let i = parts.length - 1; i >= 2; i--) {
    const owner = parts.slice(0, i).join(".");
    if (!Object.hasOwn(configFields, owner)) continue;
    const whole = structuredClone(currentValue(config, parts.slice(0, i), owner));
    let node = whole;
    for (const part of parts.slice(i, -1)) node = node[part];
    node[parts.at(-1)!] = value;
    let parsed: any = configFields[owner].parse(whole);
    for (const part of parts.slice(i)) parsed = parsed[part];
    return parsed;
  }
  if (kind(current) === "object") {
    if (kind(value) !== "object") throw new Error(`${key} expects object, got ${kind(value)}.`);
    const merged = structuredClone(current);
    for (const [field, v] of Object.entries(value as object)) {
      if (field.includes(".")) throw new Error(`Invalid config key: ${key}.${field}`);
      merged[field] = validateConfigChange(config, `${key}.${field}`, v);
    }
    return merged;
  }
  if (current === null && value !== null && typeof value === "object")
    throw new Error(`${key} has no known shape to check an object against. Set it in the app.`);
  if (current !== null && value !== null && kind(current) !== kind(value))
    throw new Error(`${key} expects ${kind(current)}, got ${kind(value)}.`);
  return JSON.parse(JSON.stringify(value));
}

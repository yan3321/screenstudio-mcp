import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../context.js";
import { DESTRUCTIVE, READ, WRITE, path, toolsOn } from "../tool.js";
import { isAbsolute, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { APP_BUILD, capabilities } from "../../studio/compat.js";
import { dependencies } from "../../studio/doctor.js";
import { configFields, extractPresetConfig } from "../../studio/project.js";
import { canonicalPath } from "../../studio/service.js";
import { ASPECTS, LOOKS, STYLES } from "../../studio/styles.js";
import { MUSIC, VOICES } from "../../studio/narration.js";
import { catalog } from "../../studio/assets.js";
import { LAYOUT_TYPES, MASK_TYPES, editOp } from "../../studio/editor/ops.js";
import { recipeList } from "../../studio/recipes.js";
import { listBrands } from "../../studio/brand.js";

const ops = new Set<string>(editOp.options.map((o) => o.shape.op.value));

/** What this server can do, read from its own tools and ops so status never undersells it. */
export const features = {
  ...capabilities.features,
  maskEditing: ops.has("addMask"),
  layoutTimelineEditing: ops.has("addLayout"),
  narration: true,
  musicLibrary: true,
};

/** Validates an imported preset path (on macOS, .screenstudiopreset presets are package directories or legacy files). */
export async function assertPresetSource(sourcePath: string): Promise<string> {
  if (!sourcePath || !isAbsolute(sourcePath))
    throw new Error("import needs an absolute sourcePath to a .screenstudiopreset preset.");
  const presetPath = resolve(sourcePath);
  if (!presetPath.toLowerCase().endsWith(".screenstudiopreset"))
    throw new Error("Preset sourcePath must end with .screenstudiopreset.");
  const info = await stat(presetPath).catch(() => null);
  if (!info || (!info.isFile() && !info.isDirectory())) throw new Error(`No preset found at ${presetPath}.`);
  if (info.isDirectory()) {
    const meta = await stat(join(presetPath, "meta.json")).catch(() => null);
    if (!meta?.isFile()) throw new Error(`Incomplete preset bundle (missing meta.json in ${presetPath}).`);
  }
  return presetPath;
}

function collectPresetEntries(listing: unknown, out: Array<{ path: string; id?: string }> = []) {
  if (Array.isArray(listing)) {
    for (const item of listing) {
      if (typeof item === "string") {
        out.push({ path: item });
      } else if (item && typeof item === "object") {
        const entry = item as Record<string, unknown>;
        if (typeof entry.path === "string") {
          out.push({ path: entry.path, ...(typeof entry.id === "string" && { id: entry.id }) });
        } else {
          collectPresetEntries(entry, out);
        }
      }
    }
  } else if (listing && typeof listing === "object") {
    const obj = listing as Record<string, unknown>;
    if (typeof obj.path === "string") {
      out.push({ path: obj.path, ...(typeof obj.id === "string" && { id: obj.id }) });
    } else {
      for (const v of Object.values(obj)) {
        if (Array.isArray(v) || (v && typeof v === "object")) collectPresetEntries(v, out);
      }
    }
  }
  return out;
}

/** Every preset path returned by Screen Studio's presets listing (never preset names or object keys). */
export function presetPaths(listing: unknown): Set<string> {
  return new Set(collectPresetEntries(listing).map((e) => e.path));
}

export function findPresetPath(listing: unknown, key: string): string | undefined {
  for (const entry of collectPresetEntries(listing)) {
    if (entry.path === key || (entry.id !== undefined && entry.id === key)) return entry.path;
  }
  return undefined;
}

export function register(server: McpServer, { studio, editor }: Context) {
  const tool = toolsOn(server);

  tool(
    "screenstudio_status",
    "Start here. Connection, app version (and whether it is the tested build), open editor windows, recording state, ffmpeg / edge-tts / input helper and the Accessibility and Screen Recording permissions, supported features, the named recipes and the saved brand kits. Works when the app is closed.",
    {},
    READ,
    async () => {
      const out: any = {
        ...capabilities,
        features,
        knownSettings: Object.keys(configFields),
        styles: STYLES,
        looks: Object.keys(LOOKS),
        aspects: Object.keys(ASPECTS),
        music: MUSIC,
        recipes: recipeList(),
        brands: await listBrands(studio.stateDir).then(
          (list) => list.map((b) => b.slug),
          () => [],
        ),
        dependencies: await dependencies(),
      };
      try {
        out.version = await studio.requireVersion("read");
        out.tested = out.version === APP_BUILD;
        out.connected = true;
        out.port = await studio.port().catch(() => null);
        const [editorsRes, recRes] = await Promise.allSettled([editor.list(), studio.state()]);
        out.editors = editorsRes.status === "fulfilled" ? editorsRes.value : [];
        if (editorsRes.status === "rejected")
          out.editorsError =
            editorsRes.reason instanceof Error ? editorsRes.reason.message : String(editorsRes.reason);
        out.recording = recRes.status === "fulfilled" ? recRes.value : null;
        if (recRes.status === "rejected")
          out.recordingError = recRes.reason instanceof Error ? recRes.reason.message : String(recRes.reason);
      } catch (e) {
        out.connected = false;
        out.connection = e instanceof Error ? e.message : String(e);
      }
      return out;
    },
  );

  tool(
    "screenstudio_launch",
    "Launch Screen Studio with a local automation connection (bound to 127.0.0.1). A running app is never killed or restarted.",
    {},
    WRITE,
    () => studio.launch(),
  );

  tool(
    "screenstudio_quit",
    "Quit Screen Studio like Cmd+Q when the work is done, which also closes the local automation connection. The app asks about unsaved changes itself; refuses while recording.",
    {},
    DESTRUCTIVE,
    () => studio.quit(),
  );

  tool(
    "screenstudio_preset_validate",
    "Check a local .screenstudiopreset source before importing or recording. Reads its file/package structure without connecting to the app, importing it, or changing any project.",
    { sourcePath: path },
    READ,
    async (a) => ({ valid: true, sourcePath: await assertPresetSource(a.sourcePath) }),
  );

  tool(
    "screenstudio_presets",
    "Manage Screen Studio presets: list saved presets, create from a project, apply to a project, sync changes back to a preset, rename, import a .screenstudiopreset bundle/file, or delete. apply refuses an open project unless closeOpenEditor:true saves and closes its editor window first.",
    {
      action: z.enum(["list", "apply", "create", "sync", "rename", "import", "delete"]),
      presetPath: z.string().min(1).optional().describe("Preset path or id from presets list."),
      projectPath: path.optional(),
      name: z.string().min(1).max(120).optional().describe("New preset name for create or rename."),
      sourcePath: path.optional().describe("Absolute path to a .screenstudiopreset preset for import."),
      closeOpenEditor: z
        .boolean()
        .default(false)
        .describe("Save and close any open editor for projectPath before applying a preset."),
    },
    DESTRUCTIVE,
    async (a) => {
      if (a.action === "list") {
        await studio.requireVersion("read");
        return studio.call("query", "presets.all");
      }
      await studio.requireVersion();
      if (a.action === "import") {
        const presetPath = await assertPresetSource(a.sourcePath ?? "");
        return studio.lock(async () => {
          const res = await studio.call("mutation", "presets.import", { presetPath });
          return res && typeof res === "object"
            ? { imported: true, sourcePath: presetPath, ...(res as Record<string, unknown>) }
            : { imported: true, sourcePath: presetPath };
        });
      }

      const projectPresetConfig = async (projectPath: string) => {
        const openEditors = await editor.list();
        const canon = await canonicalPath(projectPath);
        let live: any = null;
        for (const e of openEditors) {
          if ((await canonicalPath(e.projectPath)) === canon) {
            live = await editor.liveProject(e.projectPath);
            break;
          }
        }
        const project = live ?? (await studio.readProject(projectPath)).project;
        return extractPresetConfig(project.config ?? {});
      };

      const resolveFrom = (listing: unknown) => {
        if (!a.presetPath) throw new Error(`${a.action} needs presetPath (path or id from list).`);
        const found = findPresetPath(listing, a.presetPath);
        if (!found) throw new Error("Unknown preset. Use a presetPath or id from the presets list.");
        return found;
      };

      if (a.action === "apply") {
        if (!a.projectPath) throw new Error("apply needs projectPath.");
        const projectPath = await studio.path(a.projectPath);
        return studio.projectLock(projectPath, async () => {
          const listing = await studio.call("query", "presets.all");
          const presetPath = resolveFrom(listing);
          const canonProject = await canonicalPath(projectPath);
          for (const entry of await editor.list()) {
            if ((await canonicalPath(entry.projectPath)) === canonProject) {
              if (a.closeOpenEditor) {
                await editor.close(entry.projectPath, { save: true });
              } else {
                throw new Error(
                  "The project is open in a Screen Studio editor. Close its window in Screen Studio first; presets apply was not run (autosave would overwrite it).",
                );
              }
            }
          }
          return studio.lock(async () => {
            for (const entry of await editor.list()) {
              if ((await canonicalPath(entry.projectPath)) === canonProject)
                throw new Error(
                  "The project is open in a Screen Studio editor. Close its window in Screen Studio first; presets apply was not run (autosave would overwrite it).",
                );
            }
            return studio.call("mutation", "presets.apply", { presetPath, projectPath });
          });
        });
      }

      return studio.lock(async () => {
        const listing = await studio.call("query", "presets.all");
        if (a.action === "create") {
          if (!a.projectPath || !a.name) throw new Error("create needs projectPath and name.");
          const projectPath = await studio.path(a.projectPath);
          const config = await projectPresetConfig(projectPath);
          return studio.call("mutation", "presets.create", {
            presetName: a.name,
            projectPath,
            config,
          });
        }
        const presetPath = resolveFrom(listing);
        if (a.action === "rename") {
          if (!a.name) throw new Error("rename needs name.");
          await studio.call("mutation", "presets.rename", { presetPath, newName: a.name });
          return { renamed: true, presetPath, newName: a.name };
        }
        if (a.action === "delete") {
          await studio.call("mutation", "presets.delete", { presetPath });
          return { deleted: true, presetPath };
        }
        if (!a.projectPath) throw new Error(`${a.action} needs projectPath.`);
        const projectPath = await studio.path(a.projectPath);
        const config = await projectPresetConfig(projectPath);
        return studio.call("mutation", "presets.sync", { presetPath, projectPath, config });
      });
    },
  );

  tool(
    "screenstudio_catalog",
    "Everything Screen Studio ships (and user-installed libraries when connected) that settings can point to: wallpapers, cursor sets, device frames, music tracks, custom user LUTs & audio tracks, supported mic presets, narration voices, camera layout types, mask types, looks and output aspects.",
    {},
    READ,
    async () => {
      const [base, connected] = await Promise.all([
        catalog(studio.appPath).catch((e) => ({ error: e instanceof Error ? e.message : String(e) })),
        (async () => {
          if (!(await studio.isRunning())) return {};
          const [lutsRes, tracksRes, micRes] = await Promise.allSettled([
            studio.luts("list"),
            studio.userAudioTracks(),
            studio.supportedMicrophonePresets(),
          ]);
          return {
            ...(lutsRes.status === "fulfilled" ? { userLuts: lutsRes.value } : {}),
            ...(tracksRes.status === "fulfilled" ? { userAudioTracks: tracksRes.value } : {}),
            ...(micRes.status === "fulfilled" ? { supportedMicrophonePresets: micRes.value } : {}),
          };
        })(),
      ]);
      return {
        ...base,
        ...connected,
        voices: VOICES,
        layoutTypes: LAYOUT_TYPES,
        maskTypes: MASK_TYPES,
        looks: LOOKS,
        aspects: Object.keys(ASPECTS),
      };
    },
  );
}

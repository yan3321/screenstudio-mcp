import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { extname } from "node:path";
import { z } from "zod";
import type { Context } from "../context.js";
import { DESTRUCTIVE, READ, WRITE, path, toolsOn } from "../tool.js";
import { assertProjectBundle, findAssetReferences, inspectProjectBundle } from "../../studio/project.js";
import { readRecordingMeta } from "../../studio/recording.js";
import { canonicalPath } from "../../studio/service.js";

const assetConfigPatch = {
  addImage: (assetFile: string) => ({ styles: { background: { type: "image", image: assetFile } } }),
  addAudio: (assetFile: string) => ({
    audio: { backgroundAudioFileName: assetFile, muteBackgroundAudio: false },
  }),
  addLut: (assetFile: string) => ({ camera: { lut: assetFile } }),
} as const;

const ASSET_EXTENSIONS: Record<keyof typeof assetConfigPatch, readonly string[]> = {
  addImage: [".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif", ".tiff", ".tif", ".gif", ".bmp", ".avif"],
  addAudio: [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aiff", ".aif", ".caf"],
  addLut: [".cube"],
};

async function findOpenEditor(
  openEditors: Array<{ projectPath: string; [k: string]: unknown }>,
  projectPath: string,
) {
  const wanted = await canonicalPath(projectPath);
  for (const entry of openEditors) {
    if ((await canonicalPath(entry.projectPath)) === wanted) return entry;
  }
  return null;
}

export function register(server: McpServer, { studio, editor }: Context) {
  const tool = toolsOn(server);

  tool(
    "screenstudio_projects",
    "List Screen Studio's recent projects with on-disk bundle validity and whether each is currently open in an editor window.",
    { limit: z.number().int().min(1).max(100).default(30) },
    READ,
    async (a) => {
      let openError: string | undefined;
      const [recent, openEditors] = await Promise.all([
        studio.recentProjects(),
        editor.list().catch((e: any) => {
          openError = e instanceof Error ? e.message : String(e);
          return null;
        }),
      ]);
      const openPaths = openEditors
        ? new Set(await Promise.all(openEditors.map((e) => canonicalPath(e.projectPath))))
        : null;
      const slice = recent.slice(0, a.limit);
      const projects = await Promise.all(
        slice.map(async (item) => {
          const check = await inspectProjectBundle(item.path);
          return {
            ...item,
            open: openPaths ? openPaths.has(await canonicalPath(item.path)) : null,
            valid: check.valid,
            ...(!check.valid && { reason: check.reason }),
          };
        }),
      );
      return {
        total: recent.length,
        ...(openError !== undefined && { openCheckError: openError }),
        projects,
      };
    },
  );

  tool(
    "screenstudio_project_import",
    "Import any local video file (MP4, MOV, etc.) into a new .screenstudio project, optionally opening it in the editor.",
    {
      videoPath: path,
      open: z.boolean().default(false),
    },
    WRITE,
    async (a) => {
      const created = await studio.importVideo(a.videoPath);
      if (!a.open) return created;
      try {
        const opened = await editor.open(created.projectPath);
        return { ...created, opened: true, editor: opened };
      } catch (e: any) {
        return {
          ...created,
          opened: false,
          openError: e instanceof Error ? e.message : String(e),
          note: "Project was imported, but opening it in the editor failed. Call screenstudio_editor_open with this projectPath instead of re-importing.",
        };
      }
    },
  );

  tool(
    "screenstudio_project_manage",
    "Manage a .screenstudio project bundle via Screen Studio: move/rename to destinationPath, copy to destinationPath, extractRaw recording media into outputFolderPath, inspectRaw recording metadata (sessions, processTimeStartMs, channel files, bounds), or remove (Screen Studio's own Move to Trash). move and remove refuse a project that is open in an editor window.",
    {
      action: z.enum(["move", "copy", "extractRaw", "inspectRaw", "remove"]),
      projectPath: path,
      destinationPath: path.optional(),
      outputFolderPath: path.optional(),
    },
    DESTRUCTIVE,
    async (a) => {
      // An open editor keeps saving to its old path and would re-create a partial bundle there;
      // this callback is invoked inside Studio.projectLock and Studio.lock right before mutating.
      const ensureClosed = async (resolved: string) => {
        const open = await editor.list().catch(() => null);
        if (open === null)
          throw new Error(
            `Cannot confirm the project is closed, so ${a.action} was not run. Check Screen Studio responds (screenstudio_status) and retry.`,
          );
        if (await findOpenEditor(open, resolved))
          throw new Error(
            `The project is open in a Screen Studio editor. Close its window in Screen Studio first; ${a.action} was not run.`,
          );
      };
      if (a.action === "move") {
        if (!a.destinationPath) throw new Error("move needs destinationPath (.screenstudio).");
        return studio.moveProject(a.projectPath, a.destinationPath, ensureClosed);
      }
      if (a.action === "copy") {
        if (!a.destinationPath) throw new Error("copy needs destinationPath (.screenstudio).");
        const source = await findOpenEditor(await editor.list(), a.projectPath);
        const copied = await studio.copyProject(a.projectPath, a.destinationPath);
        return { ...copied, ...(source?.dirty === true && { sourceHasUnsavedChanges: true }) };
      }
      if (a.action === "extractRaw") {
        if (!a.outputFolderPath) throw new Error("extractRaw needs outputFolderPath.");
        return studio.extractRawRecordingFiles(a.projectPath, a.outputFolderPath);
      }
      if (a.action === "inspectRaw") {
        const resolved = await studio.path(a.projectPath);
        await assertProjectBundle(resolved);
        return readRecordingMeta(resolved);
      }
      return studio.removeProject(a.projectPath, ensureClosed);
    },
  );

  tool(
    "screenstudio_project_asset",
    "Add a local image wallpaper (addImage), audio file (addAudio), or 3D LUT .cube file (addLut) into a .screenstudio project's bundle (and apply it live if the project is open in an editor), or remove an unused bundled asset (removeAsset).",
    {
      action: z.enum(["addImage", "addAudio", "addLut", "removeAsset"]),
      projectPath: path,
      sourcePath: path.optional(),
      assetFile: z.string().min(1).optional(),
      applyToProject: z.boolean().default(true),
    },
    DESTRUCTIVE,
    async (a) => {
      const projectPath = await studio.path(a.projectPath);
      if (a.action === "removeAsset") {
        if (!a.assetFile) throw new Error("removeAsset needs assetFile.");
        const assetFile = a.assetFile;
        await studio.removeAssetFromProject(projectPath, assetFile, async (resolved, diskData) => {
          const openEntry = await findOpenEditor(await editor.list(), resolved);
          const liveData = openEntry ? await editor.liveProject(openEntry.projectPath) : null;
          if (openEntry && !liveData)
            throw new Error(
              "The project is open but its live state could not be read; retry, or close the editor first.",
            );
          const refs = [
            ...new Set([
              ...findAssetReferences(diskData, assetFile),
              ...(liveData ? findAssetReferences(liveData, assetFile) : []),
            ]),
          ];
          if (refs.length)
            throw new Error(
              `Asset "${assetFile}" is still referenced by ${refs.join(", ")}. Clear those settings before removing it.`,
            );
        });
        return { removed: true, projectPath, assetFile };
      }
      if (!a.sourcePath) throw new Error(`${a.action} needs sourcePath.`);
      const allowedExts = ASSET_EXTENSIONS[a.action];
      if (!allowedExts.includes(extname(a.sourcePath).toLowerCase()))
        throw new Error(
          `${a.action} expects a file ending in ${allowedExts.join(", ")}; got "${a.sourcePath}".`,
        );
      const assetFile = await studio.copyFileToProject(projectPath, a.sourcePath);
      if (!a.applyToProject) return { projectPath, assetFile, applied: false };
      const patch = assetConfigPatch[a.action](assetFile);
      try {
        const openEntry = await findOpenEditor(await editor.list(), projectPath);
        if (!openEntry) {
          return {
            projectPath,
            assetFile,
            applied: false,
            patch,
            note: "Project is not open in an editor; open it with screenstudio_editor_open to apply this asset live.",
          };
        }
        const live = a.action === "addImage" ? await editor.liveProject(openEntry.projectPath) : null;
        const applyPatch =
          a.action === "addImage" && live?.config?.styles?.background
            ? {
                styles: {
                  background: { ...live.config.styles.background, type: "image", image: assetFile },
                },
              }
            : patch;
        await editor.updateConfig(openEntry.projectPath, applyPatch);
        return { projectPath, assetFile, applied: true, patch };
      } catch (e: any) {
        return {
          projectPath,
          assetFile,
          applied: false,
          partial: true,
          patch,
          error: e instanceof Error ? e.message : String(e),
          note: "Asset was copied into the project bundle, but applying it in the open editor failed. Retry applying or remove the asset with removeAsset.",
        };
      }
    },
  );

  tool(
    "screenstudio_luts",
    "List custom user 3D LUTs (.cube) in Screen Studio's library, add a .cube file to the library, or remove one from the library.",
    {
      action: z.enum(["list", "add", "remove"]).default("list"),
      sourcePath: path.optional().describe("Absolute path to a .cube LUT file when action is add."),
      lutPath: path.optional().describe("Absolute library LUT path from list when action is remove."),
    },
    DESTRUCTIVE,
    (a) => studio.luts(a.action, { sourcePath: a.sourcePath, lutPath: a.lutPath }),
  );
}

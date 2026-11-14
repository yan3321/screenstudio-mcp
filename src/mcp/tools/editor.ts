import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pacingFor, type Context } from "../context.js";
import { DESTRUCTIVE, READ, WRITE, image, path, toolsOn } from "../tool.js";
import { describeScene } from "../../studio/editor/describe.js";
import { SELECTABLE_TRACKS, configPartial, editOp } from "../../studio/editor/ops.js";
import { RECIPE_NAMES } from "../../studio/recipes.js";
import { DEFAULT_STYLE, STYLE_NAMES } from "../../studio/styles.js";
import { recipeForCheck } from "./plan.js";
import { validateConfigChange, validateKnownConfig } from "../../studio/project.js";
import { APP_BUILD } from "../../studio/compat.js";

const nativeFingerprint = z
  .object({
    version: z.number().refine((value): value is 3 => value === 3, { message: "version must be 3." }),
    algorithm: z.literal("hmac-sha256"),
    keyId: z.string().regex(/^[a-f0-9]{16}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export function register(server: McpServer, ctx: Context) {
  const { editor } = ctx;
  const tool = toolsOn(server);

  tool(
    "screenstudio_config_validate",
    "Validate settings without editing or focusing a window. Known ranges and structured values can be checked before recording. Unknown or partial live-only fields are explicitly deferred; provide projectPath for validation against that open project's config. No setting values are echoed.",
    { changes: z.record(z.string(), z.unknown()), projectPath: path.optional() },
    READ,
    async (a) => {
      const result = validateKnownConfig(a.changes);
      if (
        result.errors.some((error) =>
          ["batch_size", "overlapping_keys", "complexity_limit"].includes(error.code),
        )
      )
        return { forBuild: APP_BUILD, ...result };
      if (a.projectPath) {
        const state = await editor.raw(a.projectPath);
        const errors: { key: string; code: string; fields: string[] }[] = [];
        const validated: string[] = [];
        for (const [key, value] of Object.entries(a.changes)) {
          try {
            validateConfigChange(state.config, key, value);
            validated.push(key);
          } catch {
            errors.push({ key, code: "invalid_live_setting", fields: [] });
          }
        }
        if (!errors.length) {
          try {
            configPartial(state.config, a.changes);
          } catch {
            errors.push({ key: "<batch>", code: "invalid_live_patch", fields: [] });
          }
        }
        return {
          forBuild: APP_BUILD,
          valid: !errors.length,
          validated,
          deferred: [],
          errors,
          editFingerprint: state.editFingerprint,
        };
      }
      return { forBuild: APP_BUILD, ...result };
    },
  );

  tool(
    "screenstudio_edit_context",
    "Start editing here: use the focused Screen Studio editor (or the only open editor), without opening or duplicating a project. Returns its live timeline, all settings and editGeneration, plus recording analysis with speech, pauses and actions. If needsTranscript is true and captions or speech cuts are requested, generate the transcript before planning. Pass analyze:false for a quick settings-only adjustment. Re-read after the person changes the edit; pass editGeneration as expectedGeneration to editor_apply.",
    { projectPath: path.optional(), analyze: z.boolean().default(true) },
    READ,
    async (a) => {
      const projectPath = await editor.current(a.projectPath);
      const [state, analysisOutcome] = await Promise.all([
        editor.raw(projectPath),
        a.analyze
          ? ctx.analysisFor(projectPath).then(
              (analysis) => ({ ok: true as const, analysis }),
              (e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
            )
          : Promise.resolve(undefined),
      ]);
      const analysis = analysisOutcome?.ok ? analysisOutcome.analysis : undefined;
      return {
        ...state,
        scenes: state.scenes.map((s: any) => ({ id: s.id, name: s.name, ...describeScene(s) })),
        ...(analysis
          ? {
              needsTranscript: !!analysis.hasMicrophone && !analysis.speech?.length,
              analysis: { ...analysis, sessions: analysis.sessions?.map(({ video: _v, ...s }) => s) },
            }
          : {}),
        ...(analysisOutcome && !analysisOutcome.ok ? { analysisError: analysisOutcome.error } : {}),
      };
    },
  );

  tool("screenstudio_editor_list", "List projects open in Screen Studio editor windows.", {}, READ, () =>
    editor.list(),
  );

  tool(
    "screenstudio_editor_open",
    "Open a project in a Screen Studio editor window (or find it if already open) and return its timeline. The person can watch every edit happen there.",
    { projectPath: path },
    WRITE,
    (a) => editor.open(a.projectPath),
  );

  tool(
    "screenstudio_editor_close",
    "Save (by default) and close an editor, preserving newer manual edits. save:false closes only a clean editor unless expectedFingerprint explicitly authorizes discarding exactly the V3 snapshot content. Changed content or pending writes refuse closing.",
    { projectPath: path, save: z.boolean().default(true), expectedFingerprint: nativeFingerprint.optional() },
    DESTRUCTIVE,
    (a) => editor.close(a.projectPath, { save: a.save, expectedFingerprint: a.expectedFingerprint }),
  );

  tool(
    "screenstudio_editor_state",
    "The open editor's live timeline (slices, zooms, camera layouts, masks in source and playback ms), playhead, undo state, a style summary and, with includeConfig, every project setting (crop, cursor, captions, audio, camera, animations, zooms, defaultLayout, styles, device, output). Any setting shown can be changed with a config op.",
    { projectPath: path, includeConfig: z.boolean().default(false) },
    READ,
    (a) => (a.includeConfig ? editor.stateWithConfig(a.projectPath) : editor.state(a.projectPath)),
  );

  tool(
    "screenstudio_editor_snapshot",
    "Read one JSON-normalized native serialization with exact finite times, per-slice flags, app/schema versions and a versioned opaque SDK fingerprint. On the tested build V3 edit identity excludes the playback-position preference; the full snapshot retains it. Other readable builds use V2 content identity. Private phrase fields and exact matching string values are redacted; revision fingerprints are keyed in private local SDK integrity state. Redacted results expose no legacy unkeyed export hash. A same-capture legacy export fence is included for unredacted projects. Non-finite values are refused. No project edits, focus changes or saves. This observation is not a mutation receipt.",
    { projectPath: path },
    READ,
    (a) => editor.snapshot(a.projectPath),
  );

  tool(
    "screenstudio_editor_mutate",
    "Apply one synchronous batch against a V3 native-edit fingerprint from editor_snapshot. Requires a caller-generated mutationId: retrying that ID returns its original receipt, never reapplies. No paced/show mode. Verifies content inside the renderer before the first edit, captures exact post-state before yielding, and optionally saves that captured state. Returns keyed before/after fingerprints and applied/partial/notApplied/unknown status; no checkpoint restore is automatic. A partial batch remains live. A transport failure is unknown: use editor_receipt with the SAME ID before continuing. Private full snapshots and unkeyed hashes are never returned.",
    {
      projectPath: path,
      sceneId: z.string().optional(),
      mutationId: z.string().uuid(),
      expectedFingerprint: nativeFingerprint,
      ops: z.array(editOp).max(100),
      save: z.boolean().default(true),
    },
    WRITE,
    (a) =>
      editor.applyRevision(a.projectPath, a.sceneId, a.ops, {
        mutationId: a.mutationId,
        expectedFingerprint: a.expectedFingerprint,
        save: a.save,
      }),
  );

  tool(
    "screenstudio_editor_receipt",
    "Look up a native mutation by its original caller-generated ID. Complete sanitized receipts survive an SDK restart; renderer receipts recover a lost response while the app remains open. found:false means no receipt is available, not proof that nothing happened. Inspect/reconcile unknown outcomes before any new mutation ID. This reads evidence, without editing, focusing, or saving the project.",
    { projectPath: path, mutationId: z.string().uuid() },
    READ,
    (a) => editor.mutationReceipt(a.projectPath, a.mutationId),
  );

  tool(
    "screenstudio_editor_apply",
    "Edit the open project live in the editor window. Ops run in order, all times in source ms: setSlices (full ordered list of kept ranges with speed, optional per-clip volume, hideCursor, disableSmoothMouseMovement), addZoom (manual by default: target x/y 0-1 in the cropped frame is required and Screen Studio places it at the middle of the area the camera leaves free, so check the frame; follow:true only when the pointer itself is the subject, like a drag; to move between spots add back-to-back zooms, the next starting where the last ends, never re-aim one; presentation 'loupe' for the glass loupe with optional loupe radius/bevel/chromaticAberration/glassOptics), updateZoom, removeZoom, clearZooms, addLayout (camera layout for a stretch: camera-overlay, cutout-camera, split-screen, fullscreen-camera, screen-only, with options), addMask (sensitive-data blur or highlight, rects 0-1), updateItem/removeItem/clearTrack (layouts, masks, zooms; updateItem on a mask takes fields.rects 0-1 like addMask, or fields.bounds in capture points as editor_state shows them), config (any dotted setting from editor_state includeConfig, e.g. crop.rect01, captions.position01, defaultLayout.type, camera.background.edgeFalloff01, styles.background.systemName, device.frameKey). Timeline ops also include splitAt, cutRange (split both ends and delete the middle), removeSlice, mergeSlices, updateSlice (speed, volume up to 1, system/device audio, hideCursor, disableSmoothMouseMovement), resetCuts, restoreAutoZooms (Screen Studio's own click zooms), duplicateItem, setTrackDisabled, and clearTrack/removeItem for voiceOvers. With show:true every step plays out in the editor window wherever it is, without taking focus: the playhead jumps to each edit, the timeline is split and pieces deleted one by one, new zooms, layouts and masks drop in selected, and each setting changes with its sidebar panel open (stepMs per step, 350 by default; show:false is the default and applies instantly). Stops if the project changes during a paced batch, and reads back config values instead of claiming success for ignored settings. Returns a checkpoint, the new timeline and a pacing and visual-settings check. Cmd+Z in the app also works. Saves after each apply unless save:false. If an op fails, the result has partial:true, failedAt and error; the ops before it stay applied, nothing is saved, and screenstudio_editor_restore with the checkpointId undoes the batch.",
    {
      projectPath: path,
      sceneId: z.string().optional(),
      expectedGeneration: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "editGeneration from editor_state; stops before editing if the person changed the project.",
        ),
      ops: z.array(editOp).min(1).max(100),
      style: z.enum(STYLE_NAMES).optional().describe(`Default ${DEFAULT_STYLE}, or the recipe's.`),
      recipe: z
        .enum(RECIPE_NAMES)
        .optional()
        .describe("The recipe the plan followed, so the pacing check judges by its rules and look."),
      recipeOverrides: z.record(z.string(), z.unknown()).optional(),
      brand: z.string().min(1).max(40).optional(),
      show: z.boolean().default(false),
      stepMs: z.number().int().min(80).max(2000).default(350),
      save: z.boolean().default(true),
    },
    WRITE,
    async (a, extra) => {
      // Resolved before applying, so a wrong recipe or brand changes nothing.
      const { recipe } = await recipeForCheck(ctx, a);
      const applied = await editor.apply(
        a.projectPath,
        a.sceneId,
        a.ops,
        a.show ? { stepMs: a.stepMs } : undefined,
        { save: a.save, signal: extra.signal, expectedGeneration: a.expectedGeneration },
      );
      const partial = "partial" in applied;
      const notes = [
        partial
          ? "Stopped partway: the ops before the failure are live in the editor and nothing was saved. Fix the failing op and apply the rest, or undo the batch with screenstudio_editor_restore and the checkpointId."
          : `Applied ${a.ops.length} op${a.ops.length > 1 ? "s" : ""}${"saved" in applied && applied.saved ? " and saved" : "; not saved"}.${"saveOutcome" in applied && applied.saveOutcome === "unknown" ? " The native save outcome is unknown; inspect its pending write before continuing." : "saveOutcome" in applied && applied.saveOutcome === "notSent" ? " This save was not dispatched; inspect the live editor before saving again." : ""}`,
      ];
      try {
        const t = await ctx.timeline(a.projectPath, a.sceneId);
        if (t.live === false) throw new Error("Live editor unavailable.");
        const style = a.style ?? recipe?.style ?? DEFAULT_STYLE;
        const pacing = pacingFor(
          t,
          ctx.cachedAnalysis(t.projectPath),
          style,
          recipe ? { rules: recipe.rules, recipe } : undefined,
        );
        const errors = pacing.issues.filter((i) => i.severity === "error");
        return {
          ...applied,
          pacing,
          timeline: describeScene(t.scene),
          notes: [
            ...notes,
            `Pacing judged as ${style}${recipe ? ` with recipe ${recipe.name}'s rules and look` : ""}: ${pacing.verdict}${errors.length ? ` (${errors.map((i) => i.code).join(", ")})` : ""}.`,
          ],
        };
      } catch {
        return {
          ...applied,
          inspection: { status: "unavailable" },
          notes: [
            ...notes,
            "Live timeline and pacing inspection are unavailable. The operation results, checkpoint and save evidence are retained; inspect read-only state before continuing.",
          ],
        };
      }
    },
  );

  tool(
    "screenstudio_editor_restore",
    "Put the editor back to the timeline and settings saved in an apply checkpoint.",
    { checkpointId: z.string().uuid() },
    WRITE,
    async (a) => editor.state(await editor.restore(a.checkpointId)),
  );

  tool(
    "screenstudio_editor_history",
    "Step the editor's own undo/redo history, like pressing Cmd+Z.",
    {
      projectPath: path,
      action: z.enum(["undo", "redo"]),
      steps: z.number().int().min(1).max(200).default(1),
    },
    WRITE,
    (a) => editor.history(a.projectPath, a.action, a.steps),
  );

  tool(
    "screenstudio_editor_view",
    "Drive the editor interface: open a sidebar panel (background, cursor, cameraLayout, cameraStyle, captions, transcript, shortcuts, audio, animation, deviceFrame), select a timeline item (zooms, masks, layouts, slices by id), set the visible timeline span in ms, toggle sidebar/timeline/previewOnly, or open/close the crop window, LUT studio, or shortcuts guide. Changes nothing in the project.",
    {
      projectPath: path,
      panel: z
        .enum([
          "background",
          "cursor",
          "cameraLayout",
          "cameraStyle",
          "captions",
          "transcript",
          "shortcuts",
          "audio",
          "animation",
          "deviceFrame",
        ])
        .optional(),
      select: z
        .object({ track: z.enum(SELECTABLE_TRACKS), id: z.string().min(1) })
        .strict()
        .optional(),
      close: z.boolean().optional().describe("Close the selected item's sidebar panel."),
      timelineMs: z.number().min(1000).max(3600000).optional(),
      sidebar: z.boolean().optional(),
      timeline: z.boolean().optional(),
      previewOnly: z.boolean().optional(),
      cropWindow: z.boolean().optional().describe("Open or close the Crop window."),
      lutStudio: z.boolean().optional().describe("Open or close the LUT Studio window."),
      shortcutsGuide: z.boolean().optional().describe("Show or hide the shortcuts guide."),
    },
    WRITE,
    (a) => editor.view(a.projectPath, a),
  );

  tool(
    "screenstudio_editor_save_observation",
    "Inspect a saveId returned by editor_save or editor_mutate. Late native completion is separate from the original immutable receipt. An absent observation is unknown, including after a renderer restart; it never proves a write did not happen.",
    {
      projectPath: path,
      saveId: z.string().uuid(),
      expectedInstanceId: z
        .string()
        .regex(/^[a-f0-9]{32}$/)
        .optional(),
    },
    READ,
    (a) => editor.saveObservation(a.projectPath, a.saveId, a.expectedInstanceId),
  );

  tool(
    "screenstudio_editor_save",
    "Save a captured open project through the native editor. saved:true confirms native completion; saved:false/saveOutcome:unknown retains a write barrier and returns a saveId for editor_save_observation. A deadline or rejected native response never authorizes retry or further edits.",
    { projectPath: path },
    WRITE,
    async (a) => {
      const result = await editor.save(a.projectPath);
      return {
        ...result,
        notes: result.saved
          ? []
          : [
              result.saveOutcome === "unknown"
                ? "Native save outcome is unknown; retain this saveId, inspect editor_save_observation and current writeQuarantine before continuing."
                : `This save was not dispatched (${result.saveReason ?? "notSent"}); inspect the live editor and any existing writeQuarantine before saving again.`,
            ],
      };
    },
  );

  tool(
    "screenstudio_editor_frame",
    "Capture the editor's rendered preview at playback times (up to 6) to check framing, zoom targets and legibility without exporting. The editor window must be on screen.",
    { projectPath: path, playbackMs: z.array(z.number().min(0)).min(1).max(6) },
    READ,
    async (a) => {
      const images = [];
      for (const f of await editor.frames(a.projectPath, a.playbackMs))
        images.push(image(f.data, `Editor preview at ${(f.playheadMs / 1000).toFixed(2)}s`));
      return { images };
    },
  );

  tool(
    "screenstudio_editor_seek",
    "Move the editor playhead to a playback or source time.",
    { projectPath: path, playbackMs: z.number().min(0).optional(), sourceMs: z.number().min(0).optional() },
    WRITE,
    (a) => {
      if ((a.playbackMs === undefined) === (a.sourceMs === undefined))
        throw new Error("Give exactly one of playbackMs or sourceMs.");
      return editor.seek(a.projectPath, a);
    },
  );

  tool(
    "screenstudio_editor_play",
    "Play a range in the editor window so the person can watch it.",
    { projectPath: path, fromMs: z.number().min(0).default(0), toMs: z.number().min(0).optional() },
    WRITE,
    (a) => editor.play(a.projectPath, a.fromMs, a.toMs),
  );
}

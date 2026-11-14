import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../context.js";
import { READ, WRITE, image, path, progressOf, toolsOn } from "../tool.js";
import { exportFrame } from "../../studio/deliver.js";

export function defaultExportFps(format: "mp4" | "prores" | "gif", fps?: number): number {
  return fps ?? (format === "gif" ? 15 : 60);
}

export function register(server: McpServer, ctx: Context) {
  const { studio, editor } = ctx;
  const tool = toolsOn(server);

  tool(
    "screenstudio_export_start",
    "Render what the editor shows (including unsaved edits) to a local MP4 (H.264, HEVC, or both), ProRes (.mov), or GIF without a save dialog. height is the frame's short side (e.g. 1080 renders 1920x1080 at 16:9, 1080x1920 at 9:16). When mp4Codec is 'both', delivers '-h264.mp4' and '-h265.mp4' siblings alongside outputPath. Waits by default (wait:false returns the job immediately for screenstudio_export_status). Existing files are never overwritten.",
    {
      projectPath: path,
      outputPath: path,
      height: z
        .number()
        .int()
        .min(240)
        .max(2160)
        .default(1080)
        .describe("The frame's short side: 1080 is 1920x1080 at 16:9 and 1080x1920 at 9:16."),
      fps: z
        .number()
        .refine((value) => [10, 15, 20, 24, 25, 30, 50, 60].includes(value), {
          message: "fps must be one of: 10, 15, 20, 24, 25, 30, 50, 60.",
        })
        .optional()
        .describe(
          "Frames per second: 10, 15, 20, 24, 25, 30, 50, 60. Defaults to 60 for mp4/prores and 15 for gif.",
        ),
      format: z.enum(["mp4", "prores", "gif"]).default("mp4"),
      quality: z.enum(["studio", "social-media", "web-high", "web-low"]).default("studio"),
      mp4Codec: z.enum(["h264", "h265", "both"]).optional(),
      proResProfile: z.enum(["422-lt", "422", "422-hq", "4444"]).optional(),
      gifDisableLoop: z.boolean().optional(),
      keepRender: z.boolean().default(false),
      wait: z.boolean().default(true),
      expectedEditFingerprint: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    },
    WRITE,
    async (a, extra) => {
      // Screen Studio reads its export height as the frame's real height, so a portrait frame asks for its long side.
      const t = await ctx.timeline(a.projectPath);
      const { height, frame, note } = await exportFrame(
        t.projectPath,
        t.project.config,
        a.height,
        ctx.cachedAnalysis(t.projectPath)?.capture,
      );
      const { wait, fps: requestedFps, expectedEditFingerprint, ...exportOpts } = a;
      const fps = defaultExportFps(a.format, requestedFps);
      const started = await studio.exportStart(
        a.projectPath,
        a.outputPath,
        { ...exportOpts, fps, height },
        (p) => editor.liveProject(p),
        expectedEditFingerprint,
      );
      // Waiting here means an agent never ends its turn with the file still undelivered.
      const progress = progressOf(extra);
      let n = 0;
      const job = wait
        ? await studio.waitForExport(started.jobId, {
            timeoutMs: 30 * 60000,
            signal: extra.signal,
            onPoll: () => progress(++n, 0, "Rendering in Screen Studio"),
          })
        : started;
      return note ? { ...job, ...(frame ? { frame } : {}), note } : job;
    },
  );

  tool(
    "screenstudio_export_find",
    "Find one saved export by its exact project and output path after a lost start response.",
    { projectPath: path, outputPath: path },
    READ,
    (a) => studio.findExport(a.projectPath, a.outputPath),
  );

  tool(
    "screenstudio_export_status",
    "Inspect an export job; when complete, returns the delivered file with encoded media properties.",
    { jobId: z.string().uuid() },
    WRITE,
    (a) => studio.exportStatus(a.jobId),
  );

  tool(
    "screenstudio_export_cancel",
    "Cancel a known export job without deleting the source project.",
    { jobId: z.string().uuid() },
    WRITE,
    (a) => studio.exportCancel(a.jobId),
  );

  tool(
    "screenstudio_export_frame",
    "A frame of the completed render at playback milliseconds.",
    { jobId: z.string().uuid(), timeMs: z.number().finite().min(0) },
    READ,
    async (a) => {
      const v = await studio.preview(a.jobId, a.timeMs);
      return {
        images: [image(v.data, `Render at ${(a.timeMs / 1000).toFixed(2)}s`)],
        text: { path: v.path },
      };
    },
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../context.js";
import { DESTRUCTIVE, READ, WRITE, id, path, toolsOn } from "../tool.js";

export function register(server: McpServer, { studio, desktop }: Context) {
  const tool = toolsOn(server);

  tool(
    "screenstudio_sources",
    "List capturable windows, display IDs, microphones, cameras and external devices.",
    {},
    READ,
    () => studio.sources(),
  );

  tool("screenstudio_record_state", "Inspect the current recording session. Null means idle.", {}, READ, () =>
    studio.state(),
  );

  tool(
    "screenstudio_record_start",
    "Start recording one exact window, a display (optionally with an area in display points), or an external capture device (iOS/external deviceId from screenstudio_sources). Audio and camera default off. Rehearse first; record each beat with screenstudio_desktop_perform.",
    {
      windowId: id.optional(),
      displayId: id.optional(),
      externalDeviceId: z.string().min(1).optional(),
      area: z
        .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
        .strict()
        .optional(),
      name: z.string().min(1).max(100),
      microphoneDeviceId: z.string().optional(),
      cameraDeviceId: z.string().optional(),
      systemAudio: z.boolean().optional(),
      hideDesktopIcons: z.boolean().optional(),
      hideApp: z
        .boolean()
        .default(false)
        .describe(
          "Hide Screen Studio's own windows immediately after starting. This is a point-in-time result; use screenstudio_window settleHidden before native input because startup UI may unhide the app later.",
        ),
    },
    WRITE,
    async (a) => {
      if (a.area && a.windowId !== undefined)
        throw new Error("area needs displayId: it is a region of a display, not of a window.");
      const { hideApp, ...startInput } = a;
      const started = await studio.start(startInput);
      if (!hideApp) return started;
      try {
        const hidden = await desktop.hideApp();
        return { ...started, appHidden: Boolean(hidden?.hidden) };
      } catch (error) {
        return {
          ...started,
          appHidden: false,
          hideError: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  tool(
    "screenstudio_record_control",
    "Pause, resume, add a marker, restart (discard and record again), cancel (discard), or finish and return the saved project. Idle time between beats is cut later by the edit plan, so pausing for short thinking is unnecessary.",
    {
      action: z.enum(["pause", "resume", "addMarker", "finish", "restart", "cancel"]),
      expectedRecordingPath: path.optional(),
    },
    DESTRUCTIVE,
    (a) => studio.recordingAction(a.action, a.expectedRecordingPath),
  );

  tool(
    "screenstudio_record_recover",
    "List unfinished/crashed recordings on disk, recover one into a Screen Studio project, or permanently discard one.",
    {
      action: z.enum(["list", "recover", "discard"]).default("list"),
      recordingPath: path.optional(),
    },
    DESTRUCTIVE,
    (a) => {
      if (a.action === "list") return studio.unfinishedRecordings();
      if (!a.recordingPath) throw new Error(`${a.action} needs recordingPath.`);
      return a.action === "recover"
        ? studio.recoverRecording(a.recordingPath)
        : studio.discardUnfinishedRecording(a.recordingPath);
    },
  );
}

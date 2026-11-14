// Real protocol client: discover schemas, call offline capabilities, and ensure
// malformed recording/edit requests fail without touching the desktop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { offlineTransport } from "./support/stdio.mjs";
test("stdio server advertises editing tools and rejects malformed edits", async (t) => {
  const transport = await offlineTransport(t);
  const client = new Client({ name: "smoke", version: "1" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === "screenstudio://pacing"));
    const { prompts } = await client.listPrompts();
    assert.ok(prompts.some((p) => p.name === "screenstudio_demo"));
    for (const name of [
      "record_start",
      "desktop_perform",
      "analyze",
      "plan_edit",
      "check_pacing",
      "editor_open",
      "editor_apply",
      "editor_frame",
      "editor_save",
      "transcript_generate",
      "transcript_edit",
      "music",
      "catalog",
      "editor_view",
      "presets",
      "projects",
      "project_import",
      "project_manage",
      "project_asset",
      "luts",
      "record_recover",
      "window",
    ])
      assert.ok(
        tools.some((t) => t.name === `screenstudio_${name}`),
        name,
      );
    assert.ok(!tools.some((t) => t.name === "screenstudio_project_edit"));
    const result = await client.callTool({
      name: "screenstudio_status",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content.at(-1).text).connected, false);
    const inspect = await client.callTool({
      name: "screenstudio_desktop_inspect",
      arguments: { windowId: 1 },
    });
    assert.equal(inspect.isError, true);
    assert.match(inspect.content[0].text, /Offline protocol fixture refuses child_process\.execFile/);
    const bad = await client.callTool({
      name: "screenstudio_editor_apply",
      arguments: {
        projectPath: "/tmp/x",
        ops: [{ op: "setSlices", slices: [{ startMs: 0, endMs: 1, speed: 0 }] }],
      },
    });
    assert.equal(bad.isError, true);
  } finally {
    await client.close();
  }
});

test("every registered tool emits only string enum values", async (t) => {
  const client = new Client({ name: "schema-compatibility", version: "1" });
  try {
    await client.connect(await offlineTransport(t));
    let cursor;
    let count = 0;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const tool of page.tools) {
        count++;
        const walk = (value, path) => {
          if (!value || typeof value !== "object") return;
          assert.notEqual(typeof value.const, "number", `${path}.const`);
          if (Array.isArray(value.enum)) {
            assert.ok(
              value.enum.every((entry) => typeof entry === "string"),
              `${path}.enum`,
            );
          }
          for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
        };
        walk(tool.inputSchema, tool.name);
      }
      cursor = page.nextCursor;
    } while (cursor);
    assert.ok(count > 0);
  } finally {
    await client.close();
  }
});

test("fps accepts exactly the supported numbers and rejects others with a clear error", async () => {
  const { z } = await import("zod");
  const { register } = await import("../dist/mcp/tools/export.js");
  let schema;
  let handler;
  const received = [];
  register(
    {
      registerTool(name, config, fn) {
        if (name === "screenstudio_export_start") {
          schema = z.object(config.inputSchema);
          handler = fn;
        }
      },
    },
    {
      timeline: async () => ({ projectPath: "/fixture.screenstudio", project: {}, config: {} }),
      cachedAnalysis: () => undefined,
      editor: {},
      studio: {
        exportStart: async (_project, _output, options) => {
          received.push(options.fps);
          return { jobId: "fixture" };
        },
      },
    },
  );
  const args = { projectPath: "/fixture.screenstudio", outputPath: "/fixture.mp4", wait: false };
  for (const fps of [10, 15, 20, 24, 25, 30, 50, 60]) {
    const result = await handler(schema.parse({ ...args, fps }), {});
    assert.equal(result.isError, undefined, result.content[0].text);
  }
  assert.deepEqual(received, [10, 15, 20, 24, 25, 30, 50, 60]);
  for (const fps of [0, 12, 29.97, 120, -1]) {
    const parsed = schema.safeParse({ ...args, fps });
    assert.equal(parsed.success, false);
    assert.equal(parsed.error.issues[0].message, "fps must be one of: 10, 15, 20, 24, 25, 30, 50, 60.");
  }
  assert.equal(schema.safeParse({ ...args, fps: "30" }).success, false);
});

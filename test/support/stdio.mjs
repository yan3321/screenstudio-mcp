import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function offlineTransport(t) {
  const directory = await mkdtemp(join(tmpdir(), "ss-offline-protocol-"));
  const endpoint = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end("[]");
  });
  await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", fileURLToPath(new URL("./offline-host.mjs", import.meta.url)), "dist/mcp/main.js"],
    stderr: "pipe",
    env: {
      SCREENSTUDIO_PORT: String(endpoint.address().port),
      SCREENSTUDIO_STATE_DIR: join(directory, "state"),
    },
  });
  t.after(async () => {
    await transport.close();
    endpoint.closeAllConnections();
    await new Promise((resolve) => endpoint.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return transport;
}

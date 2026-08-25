import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";
import { callTool, handleMessage } from "../src/mcp-server.js";

test("MCP initialization negotiates current and supported legacy protocol versions", () => {
  const current = handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25" }
  });
  const legacy = handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "2025-03-26" }
  });
  const unknown = handleMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "initialize",
    params: { protocolVersion: "future-unknown" }
  });
  assert.equal(current.result.protocolVersion, "2025-11-25");
  assert.equal(legacy.result.protocolVersion, "2025-03-26");
  assert.equal(unknown.result.protocolVersion, "2025-11-25");
});

test("MCP enforces its complete payload budget", async () => {
  const snapshot = await readFile("examples/baseline.json", "utf8");
  const result = callTool("context.analyze", { snapshot_json: snapshot, max_output_bytes: 256 });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "RESULT_BUDGET_EXCEEDED");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 256);
});

test("MCP bounds wide unknown-field errors without echoing field names", () => {
  const args = { snapshot_json: "{}", max_output_bytes: 256 };
  for (let index = 0; index < 5000; index += 1) args[`invented_${index}`] = index;
  const result = callTool("context.analyze", args);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "UNKNOWN_FIELD");
  assert.equal(result.structuredContent.error.details.fieldCount, 5000);
  assert.equal("fields" in result.structuredContent.error.details, false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 256);
});

test("actual stdio MCP lifecycle exposes closed read-only tools and recovers after invalid input", async (t) => {
  const snapshot = await readFile("examples/baseline.json", "utf8");
  const child = spawn(process.execPath, ["src/mcp-server.js"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => child.kill());

  const responses = [];
  let buffer = "";
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for MCP responses.")), 5000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) responses.push(JSON.parse(line));
        if (responses.length === 4) {
          clearTimeout(timer);
          resolve();
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.on("error", reject);
  });

  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "context.analyze", arguments: { snapshot_json: "{" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "context.analyze", arguments: { snapshot_json: snapshot } } }
  ];
  child.stdin.write(`${messages.map(JSON.stringify).join("\n")}\n`);
  await done;

  assert.equal(responses[0].result.serverInfo.name, "context-surface-analyzer");
  assert.equal(responses[0].result.protocolVersion, "2025-11-25");
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ["context.analyze", "context.diff"]);
  assert.ok(responses[1].result.tools.every((tool) => tool.inputSchema.additionalProperties === false));
  assert.ok(responses[1].result.tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.openWorldHint));
  assert.equal(responses[2].result.structuredContent.error.code, "INVALID_JSON");
  assert.equal(responses[3].result.structuredContent.status, "ok");
});

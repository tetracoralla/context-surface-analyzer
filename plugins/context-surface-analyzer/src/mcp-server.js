#!/usr/bin/env node
import process from "node:process";
import { utf8Bytes } from "./canonical.js";
import { LIMITS } from "./constants.js";
import { executeAnalyze, executeDiff } from "./core.js";
import { ContextSurfaceError, errorResult } from "./errors.js";

const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
]);

const INTEGER_LIMIT_SCHEMA = {
  type: "integer",
  minimum: LIMITS.minResultBytes,
  maximum: LIMITS.hardMaxResultBytes,
  description: "Maximum UTF-8 bytes allowed for the complete tool result."
};

export const TOOL_DEFINITIONS = [
  {
    name: "context.analyze",
    description: "Analyze one explicit Agent tool catalog snapshot for exact bytes, schemas, collisions, duplicates, declared budgets, and labeled token measurements.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["snapshot_json"],
      properties: {
        snapshot_json: {
          type: "string",
          maxLength: LIMITS.maxSnapshotBytes,
          description: "A context-surface.snapshot.v0.1 JSON document."
        },
        max_output_bytes: INTEGER_LIMIT_SCHEMA
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "context.diff",
    description: "Compare two explicit Agent tool catalog snapshots and return exact catalog, tool, schema, collision, and matched token-measurement deltas.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["before_snapshot_json", "after_snapshot_json"],
      properties: {
        before_snapshot_json: {
          type: "string",
          maxLength: LIMITS.maxSnapshotBytes,
          description: "The earlier context-surface.snapshot.v0.1 JSON document."
        },
        after_snapshot_json: {
          type: "string",
          maxLength: LIMITS.maxSnapshotBytes,
          description: "The later context-surface.snapshot.v0.1 JSON document."
        },
        max_output_bytes: INTEGER_LIMIT_SCHEMA
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

function assertCallArguments(value, allowed, required) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextSurfaceError("INVALID_ARGUMENT", "Tool arguments must be an object.");
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ContextSurfaceError("UNKNOWN_FIELD", "Unsupported tool fields.", { fieldCount: unknown.length });
  }
  const missing = required.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new ContextSurfaceError("INVALID_ARGUMENT", "Tool arguments are missing required fields.", { fields: missing });
  }
}

function summarize(name, result) {
  if (name === "context.analyze") {
    return `Analyzed ${result.counts.tools} tools and ${result.counts.schemas} schemas; found ${result.hardNameCollisions.length} hard name collisions.`;
  }
  return `Compared ${result.before.toolCount} to ${result.after.toolCount} tools; ${result.tools.changed.length} uniquely named tools changed.`;
}

function toolSuccess(name, execution) {
  const payload = {
    content: [{ type: "text", text: summarize(name, execution.result) }],
    structuredContent: execution.result,
    isError: false
  };
  const actual = utf8Bytes(JSON.stringify(payload));
  if (actual > execution.limit) {
    throw new ContextSurfaceError("RESULT_BUDGET_EXCEEDED", "Complete MCP tool result exceeds the output byte limit.", {
      actual,
      limit: execution.limit
    });
  }
  return payload;
}

function failurePayload(error) {
  const structuredContent = errorResult(error);
  return {
    content: [{ type: "text", text: `${structuredContent.error.code}: ${structuredContent.error.message}` }],
    structuredContent,
    isError: true
  };
}

function requestedFailureLimit(args) {
  const value = args?.max_output_bytes;
  return Number.isSafeInteger(value) && value >= LIMITS.minResultBytes && value <= LIMITS.hardMaxResultBytes
    ? value
    : LIMITS.defaultResultBytes;
}

function toolFailure(error, limit) {
  const payload = failurePayload(error);
  if (utf8Bytes(JSON.stringify(payload)) <= limit) return payload;
  const bounded = failurePayload(new ContextSurfaceError(
    "RESULT_BUDGET_EXCEEDED",
    "Complete MCP error exceeds the output byte limit.",
    { limit }
  ));
  if (utf8Bytes(JSON.stringify(bounded)) <= limit) return bounded;
  return {
    content: [{ type: "text", text: "RESULT_BUDGET_EXCEEDED" }],
    structuredContent: {
      status: "error",
      error: { code: "RESULT_BUDGET_EXCEEDED", message: "Output limit is too small." }
    },
    isError: true
  };
}

export function callTool(name, args) {
  let failureLimit = requestedFailureLimit(args);
  try {
    if (name === "context.analyze") {
      assertCallArguments(args, ["snapshot_json", "max_output_bytes"], ["snapshot_json"]);
      const execution = executeAnalyze(args.snapshot_json, args.max_output_bytes);
      failureLimit = execution.limit;
      return toolSuccess(name, execution);
    }
    if (name === "context.diff") {
      assertCallArguments(
        args,
        ["before_snapshot_json", "after_snapshot_json", "max_output_bytes"],
        ["before_snapshot_json", "after_snapshot_json"]
      );
      const execution = executeDiff(args.before_snapshot_json, args.after_snapshot_json, args.max_output_bytes);
      failureLimit = execution.limit;
      return toolSuccess(name, execution);
    }
    throw new ContextSurfaceError("UNKNOWN_TOOL", "The requested tool is not available.", { name });
  } catch (error) {
    const errorLimit = Number.isSafeInteger(error?.details?.limit)
      ? Math.min(failureLimit, error.details.limit)
      : failureLimit;
    return toolFailure(error, Math.max(LIMITS.minResultBytes, errorLimit));
  }
}

export function handleMessage(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  if (message.method === "notifications/initialized") return null;
  if (!("id" in message)) return null;
  if (message.method === "initialize") {
    const requestedVersion = message.params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
      ? requestedVersion
      : LATEST_PROTOCOL_VERSION;
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "context-surface-analyzer", version: "0.1.0" }
      }
    };
  }
  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id: message.id, result: { tools: TOOL_DEFINITIONS } };
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    return { jsonrpc: "2.0", id: message.id, result: callTool(name, args) };
  }
  if (message.method === "ping") return { jsonrpc: "2.0", id: message.id, result: {} };
  return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
}

export function startMcpServer(input = process.stdin, output = process.stdout) {
  input.setEncoding("utf8");
  let buffer = "";
  input.on("data", (chunk) => {
    buffer += chunk;
    if (utf8Bytes(buffer) > LIMITS.maxHttpBodyBytes) {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Message too large" } })}\n`);
      input.pause();
      process.exitCode = 1;
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        let response;
        try {
          response = handleMessage(JSON.parse(line));
        } catch {
          response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
        }
        if (response) output.write(`${JSON.stringify(response)}\n`);
      }
      newline = buffer.indexOf("\n");
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) startMcpServer();

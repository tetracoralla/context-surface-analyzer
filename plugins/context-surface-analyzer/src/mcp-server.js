#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { utf8Bytes } from "./canonical.js";
import { LIMITS, PRODUCT_VERSION } from "./constants.js";
import { executeAnalyze, executeDiff } from "./core.js";
import { ContextSurfaceError, errorResult } from "./errors.js";

const LATEST_LEGACY_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_LEGACY_PROTOCOL_VERSIONS = new Set([
  LATEST_LEGACY_PROTOCOL_VERSION,
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
const JSON_RPC_REQUEST_KEYS = new Set(["jsonrpc", "id", "method", "params"]);

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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isValidRequestId(value) {
  if (typeof value === "string") return utf8Bytes(value) <= LIMITS.maxJsonRpcIdBytes;
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isValidRequestEnvelope(message) {
  if (!isRecord(message) || message.jsonrpc !== "2.0") return false;
  if (Object.keys(message).some((key) => !JSON_RPC_REQUEST_KEYS.has(key))) return false;
  if (
    typeof message.method !== "string" ||
    message.method.length === 0 ||
    utf8Bytes(message.method) > LIMITS.maxJsonRpcMethodBytes
  ) return false;
  if ("id" in message && !isValidRequestId(message.id)) return false;
  if ("params" in message && !isRecord(message.params)) return false;
  return true;
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

function failurePayload(error, { compactText = false, omitDetails = false } = {}) {
  const structuredContent = errorResult(error);
  if (omitDetails) delete structuredContent.error.details;
  return {
    content: [{
      type: "text",
      text: compactText
        ? structuredContent.error.code
        : `${structuredContent.error.code}: ${structuredContent.error.message}`
    }],
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
  const compact = failurePayload(error, { compactText: true });
  if (utf8Bytes(JSON.stringify(compact)) <= limit) return compact;
  const withoutDetails = failurePayload(error, { compactText: true, omitDetails: true });
  if (utf8Bytes(JSON.stringify(withoutDetails)) <= limit) return withoutDetails;
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
  if (!isValidRequestEnvelope(message)) return jsonRpcError(null, -32600, "Invalid Request");
  if (!("id" in message)) return null;
  if (message.method.startsWith("notifications/")) {
    return jsonRpcError(message.id, -32600, "Invalid Request");
  }
  if (message.method === "initialize") {
    const requestedVersion = message.params?.protocolVersion;
    if (typeof requestedVersion !== "string") {
      return jsonRpcError(message.id, -32602, "Invalid params");
    }
    const protocolVersion = SUPPORTED_LEGACY_PROTOCOL_VERSIONS.has(requestedVersion)
      ? requestedVersion
      : LATEST_LEGACY_PROTOCOL_VERSION;
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "context-surface-analyzer", version: PRODUCT_VERSION }
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
  return jsonRpcError(message.id, -32601, "Method not found");
}

export function serializeMessage(response) {
  try {
    const json = JSON.stringify(response);
    if (utf8Bytes(json) <= LIMITS.maxMcpResponseBytes) return json;
  } catch {
    // Fall through to one fixed, bounded JSON-RPC error.
  }
  return JSON.stringify(jsonRpcError(null, -32603, "Response exceeds the MCP byte limit"));
}

function writeResponse(output, response) {
  if (!response) return true;
  return output.write(`${serializeMessage(response)}\n`);
}

function processLine(line, output) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return writeResponse(output, jsonRpcError(null, -32700, "Parse error"));
  }
  try {
    return writeResponse(output, handleMessage(message));
  } catch {
    return writeResponse(output, jsonRpcError(null, -32603, "Internal error"));
  }
}

export function startMcpServer(input = process.stdin, output = process.stdout) {
  input.setEncoding("utf8");
  let buffer = "";
  let bufferBytes = 0;
  let discardingOversizedLine = false;
  input.on("data", (chunk) => {
    let outputReady = true;
    const segments = chunk.split("\n");
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const endsLine = index < segments.length - 1;
      if (discardingOversizedLine) {
        if (endsLine) discardingOversizedLine = false;
        continue;
      }

      const segmentBytes = utf8Bytes(segment);
      if (bufferBytes + segmentBytes > LIMITS.maxMcpRequestBytes) {
        buffer = "";
        bufferBytes = 0;
        discardingOversizedLine = !endsLine;
        outputReady = writeResponse(output, jsonRpcError(null, -32700, "Message too large")) && outputReady;
        continue;
      }

      buffer += segment;
      bufferBytes += segmentBytes;
      if (endsLine) {
        outputReady = processLine(buffer, output) && outputReady;
        buffer = "";
        bufferBytes = 0;
      }
    }
    if (!outputReady) {
      input.pause();
      output.once("drain", () => input.resume());
    }
  });
  input.on("end", () => {
    if (!discardingOversizedLine && buffer.length > 0) processLine(buffer, output);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startMcpServer();

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { ChatAdapterError, mapAntigravityError } from "./antigravity-chat-adapter.mjs";
import {
  MAX_CHAT_BODY_BYTES,
  boundedPositiveInteger,
  extractConversationKey,
} from "../antigravity-contract.mjs";

export { MAX_CHAT_BODY_BYTES };

export async function createAntigravityChatServer(options = {}) {
  const adapter = options.adapter;
  if (!adapter || typeof adapter.stream !== "function" || typeof adapter.complete !== "function") {
    throw new TypeError("An Antigravity Chat adapter is required.");
  }
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The Antigravity Chat adapter may listen only on loopback.");
  }
  const maxBodyBytes = boundedPositiveInteger(
    options.maxBodyBytes,
    MAX_CHAT_BODY_BYTES,
    MAX_CHAT_BODY_BYTES,
  );
  const streamHeartbeatMs = boundedPositiveInteger(options.streamHeartbeatMs, 15_000, 60_000);
  const authToken = String(options.authToken || randomBytes(32).toString("base64url"));
  const active = new Set();
  const trafficByModel = new Map();

  function recordTrafficOutcome(modelValue, outcome) {
    const model = safeModelName(modelValue);
    const at = new Date().toISOString();
    const previous = trafficByModel.get(model) ?? {};
    const entry = {
      ...previous,
      state: outcome.result === "success" ? "ok" : "error",
      lastOutcome: { ...outcome, model, at },
      ...(outcome.result === "success"
        ? { lastSuccessAt: at }
        : { lastFailure: { ...outcome, model, at } }),
    };
    trafficByModel.delete(model);
    trafficByModel.set(model, entry);
    while (trafficByModel.size > 32) trafficByModel.delete(trafficByModel.keys().next().value);
  }

  function trafficDiagnostics() {
    return {
      byModel: Object.fromEntries([...trafficByModel].map(([model, entry]) => [model, {
        ...entry,
        lastOutcome: { ...entry.lastOutcome },
        ...(entry.lastFailure ? { lastFailure: { ...entry.lastFailure } } : {}),
      }])),
    };
  }

  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    let finished = false;
    let iterator = null;
    let requestedModel = "";
    active.add(controller);

    const abort = () => {
      if (finished || controller.signal.aborted) return;
      controller.abort(new DOMException("Chat client disconnected.", "AbortError"));
      void iterator?.return?.().catch?.(() => {});
    };
    request.once("aborted", abort);
    response.once("close", abort);

    try {
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (!bearerMatches(request.headers.authorization, authToken)) {
        finished = true;
        sendJson(response, 401, openAiError("Unauthorized.", "authentication_error", "invalid_request_error"));
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        const models = await adapter.models({ signal: controller.signal });
        finished = true;
        sendJson(response, 200, models);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/account") {
        const account = await adapter.account({ signal: controller.signal });
        finished = true;
        sendJson(response, 200, {
          ...account,
          traffic: trafficDiagnostics(),
          cascadeTrace: adapter.getDiagnostics?.().cascadeTrace ?? [],
        });
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        finished = true;
        sendJson(response, 404, openAiError("Route not found.", "not_found", "invalid_request_error"));
        return;
      }

      const body = await readJsonBody(request, maxBodyBytes);
      requestedModel = safeModelName(body?.model);
      const conversationKey = extractConversationKey(request.headers, body);
      const adapterOptions = conversationKey
        ? { signal: controller.signal, conversationKey }
        : { signal: controller.signal };
      if (body?.stream === true) {
        iterator = adapter.stream(body, adapterOptions)[Symbol.asyncIterator]();
        const buffered = [];
        while (true) {
          const item = await iterator.next();
          if (item.done) break;
          buffered.push(item.value);
          if (chatChunkCommitsResponse(item.value)) break;
        }
        if (response.destroyed || controller.signal.aborted) return;
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.flushHeaders?.();
        for (const value of buffered) {
          response.write(`data: ${JSON.stringify(value)}\n\n`);
        }
        while (true) {
          const item = await nextStreamingItemWithHeartbeat(
            iterator,
            response,
            streamHeartbeatMs,
          );
          if (item.done) break;
          if (response.destroyed || controller.signal.aborted) return;
          response.write(`data: ${JSON.stringify(item.value)}\n\n`);
        }
        if (!response.destroyed && !controller.signal.aborted) {
          recordTrafficOutcome(requestedModel, { result: "success", statusCode: 200 });
          response.write("data: [DONE]\n\n");
          finished = true;
          response.end();
        }
        return;
      }

      const completion = await adapter.complete(body, adapterOptions);
      finished = true;
      recordTrafficOutcome(requestedModel, { result: "success", statusCode: 200 });
      sendJson(response, 200, completion);
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      const mapped = error instanceof ChatAdapterError ? error : mapAntigravityError(error);
      if (request.method === "POST" && requestedModel) {
        const category = mapped.statusCode === 429 ? "quota_or_resource_limit" : mapped.code;
        recordTrafficOutcome(requestedModel, {
          result: "failure",
          category,
          statusCode: mapped.statusCode,
          code: safeErrorCode(error, mapped),
          suggestion: trafficSuggestion(mapped.statusCode, category),
        });
      }
      const code = response.headersSent && mapped.code === "unsupported_location"
        ? "invalid_prompt"
        : mapped.code;
      const payload = openAiError(mapped.message, code, mapped.type);
      if (!response.headersSent) {
        finished = true;
        sendJson(response, mapped.statusCode, payload);
      } else {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
        response.write("data: [DONE]\n\n");
        finished = true;
        response.end();
      }
    } finally {
      active.delete(controller);
      request.removeListener("aborted", abort);
      response.removeListener("close", abort);
    }
  });

  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(options.port ?? 0), host, resolve);
  });
  const address = server.address();
  const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;

  async function close() {
    for (const controller of active) {
      if (!controller.signal.aborted) {
        controller.abort(new DOMException("Antigravity Chat server closed.", "AbortError"));
      }
    }
    await adapter.close?.();
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  return {
    url: `http://${displayHost}:${address.port}/v1`,
    authToken,
    host: address.address,
    maxBodyBytes,
    streamHeartbeatMs,
    port: address.port,
    trafficDiagnostics,
    close,
  };
}

function safeModelName(value) {
  const model = String(value ?? "unknown").trim().replace(/[^a-zA-Z0-9_.:/-]/g, "").slice(0, 128);
  return model || "unknown";
}

function safeErrorCode(error, mapped) {
  const candidates = [error?.cause?.code, error?.details?.code, error?.response?.data?.error?.code];
  for (const candidate of candidates) {
    const code = String(candidate ?? "").trim();
    if (/^[a-zA-Z0-9_.-]{1,64}$/.test(code)) return code;
  }
  for (const message of [error?.cause?.message, error?.message]) {
    const match = /\b[A-Z][A-Z0-9_]{2,63}\b/.exec(String(message ?? ""));
    if (match) return match[0];
  }
  if (!(error instanceof ChatAdapterError)) {
    const code = String(error?.code ?? "").trim();
    if (/^[a-zA-Z0-9_.-]{1,64}$/.test(code)) return code;
  }
  return String(mapped?.code ?? "upstream_error");
}

function trafficSuggestion(statusCode, category) {
  if (category === "quota_or_resource_limit") {
    return "Provider returned 429; inspect usage or resource limits, retry later, or choose another configured provider manually. No account or provider was switched.";
  }
  if (statusCode === 401 || statusCode === 403) return "Check the Antigravity signed-in state in its own app.";
  if (statusCode === 504) return "Retry after the Antigravity request timeout has cleared.";
  if (statusCode >= 500) return "Check Antigravity Desktop readiness and retry.";
  return "Review the request and the local provider response.";
}

async function nextStreamingItemWithHeartbeat(iterator, response, heartbeatMs) {
  const timer = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) {
      response.write(": keep-alive\n\n");
    }
  }, heartbeatMs);
  timer.unref?.();
  try {
    return await iterator.next();
  } finally {
    clearInterval(timer);
  }
}

function bearerMatches(header, expected) {
  const match = String(header ?? "").match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const supplied = Buffer.from(match[1], "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

async function readJsonBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    if (!tooLarge) chunks.push(chunk);
  }
  if (tooLarge) {
    throw new ChatAdapterError(`Request body exceeds ${maxBytes} bytes.`, {
      statusCode: 413,
      code: "request_too_large",
      type: "invalid_request_error",
    });
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new ChatAdapterError("Request body must be valid JSON.", {
      cause: error,
      statusCode: 400,
      code: "invalid_json",
      type: "invalid_request_error",
    });
  }
}

function openAiError(message, code, type) {
  return { error: { message: String(message), type: String(type), code: String(code) } };
}

function sendJson(response, statusCode, value) {
  if (response.destroyed) return;
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function chatChunkCommitsResponse(value) {
  const choices = Array.isArray(value?.choices) ? value.choices : [];
  return choices.some((choice) => {
    const delta = choice?.delta;
    return choice?.finish_reason !== null
      || typeof delta?.role === "string"
      || typeof delta?.content === "string"
      || typeof delta?.reasoning_content === "string"
      || Array.isArray(delta?.tool_calls);
  });
}

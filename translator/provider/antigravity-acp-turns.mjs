import { createAntigravityNativeMcpBridge } from "../antigravity-native-mcp-bridge.mjs";
import { normalizeCascadeCalls } from "../antigravity-contract.mjs";

const TOOL_SERVER_NAME = "anticodex";
const TOOL_SERVER_PREFIX = `mcp_${TOOL_SERVER_NAME}_`;

export function createAntigravityAcpTurns(options = {}) {
  const client = options.client;
  if (!client || typeof client.open !== "function") {
    throw new TypeError("An ACP client with open() is required.");
  }
  const workspace = options.workspace;
  const geminiDir = String(options.geminiDir ?? "").trim();
  const agentName = String(options.agentName ?? "").trim();
  const active = new Set();
  const openingControllers = new Set();
  const pendingOpens = new Set();

  async function* start(request = {}) {
    let turn;
    let keepOpen = false;
    try {
      turn = await openTurn(request);
      request.onCascadeCreated?.(turn.continuation);
      yield { type: "ready" };
      startPrompt(turn, promptContent(request), request.signal);
      const outcome = yield* readPromptTurn(turn, request.signal, request);
      keepOpen = outcome === "tool_calls" || turn.retained;
    } finally {
      if (turn && !keepOpen && !turn.retained) await closeTurn(turn);
    }
  }

  async function* resume(continuation, results, request = {}) {
    const turn = requireTurn(continuation);
    let keepOpen = false;
    turn.retained = false;
    turn.continuation.retained = false;
    bindRequestSignal(turn, request.signal);
    try {
      updateTools(turn, request.tools);
      completePendingCalls(turn, results);
      yield { type: "ready" };
      const outcome = yield* readPromptTurn(turn, request.signal, request);
      keepOpen = outcome === "tool_calls" || turn.retained;
    } finally {
      unbindRequestSignal(turn);
      if (!keepOpen && !turn.retained) await closeTurn(turn);
    }
  }

  async function* followUp(continuation, request = {}) {
    const turn = requireTurn(continuation);
    let keepOpen = false;
    try {
      if (turn.closed) throw new AcpTurnError("ACP continuation is closed.", { code: "closed_acp_continuation" });
      if (turn.pendingCalls.size > 0 || !turn.promptFinished) {
        throw new AcpTurnError("ACP continuation is still waiting for Codex tool results.", {
          statusCode: 409,
          code: "pending_acp_tool_results",
        });
      }
      updateTools(turn, request.tools);
      turn.model = requiredString(request.model ?? turn.model, "model");
      turn.continuation.model = turn.model;
      turn.retained = false;
      turn.continuation.retained = false;
      startPrompt(turn, promptContent(request), request.signal);
      yield { type: "ready" };
      const outcome = yield* readPromptTurn(turn, request.signal, request);
      keepOpen = outcome === "tool_calls" || turn.retained;
    } finally {
      if (!keepOpen && !turn.retained) await closeTurn(turn);
    }
  }

  async function cancel(continuation) {
    if (continuation?.turn) await closeTurn(continuation.turn);
  }

  async function close() {
    for (const controller of openingControllers) controller.abort(new Error("ACP turns closed during session startup."));
    await Promise.allSettled([...pendingOpens]);
    await Promise.allSettled([...active].map((turn) => closeTurn(turn)));
  }

  async function openTurn(request) {
    const opening = openTurnInternal(request);
    pendingOpens.add(opening);
    try {
      return await opening;
    } finally {
      pendingOpens.delete(opening);
    }
  }

  async function openTurnInternal(request) {
    const openingController = new AbortController();
    openingControllers.add(openingController);
    const removeRequestAbort = bindSignal(request.signal, openingController);
    let bridge;
    let expectedSessionId = "";
    try {
      const cwd = await resolveWorkspace(workspace, request);
      const model = requiredString(request.model, "model");
      if (openingController.signal.aborted) throw openingController.signal.reason;
      bridge = await createAntigravityNativeMcpBridge({ tools: request.tools ?? [] });
      if (openingController.signal.aborted) throw openingController.signal.reason;
      const openOptions = {
        cwd,
        ...(geminiDir ? { geminiDir } : {}),
        model,
        systemInstructions: trustedSystemInstructions(request.systemSections),
        toolServerUrl: bridge.url,
        toolServerName: TOOL_SERVER_NAME,
        signal: openingController.signal,
        onPermissionRequest: (params) => permissionOptionId(params, expectedSessionId, bridge),
      };
      if (agentName) openOptions.agentName = agentName;
      const session = await client.open(openOptions);
      if (openingController.signal.aborted) {
        await Promise.resolve(session?.close?.()).catch(() => {});
        throw openingController.signal.reason;
      }
      expectedSessionId = String(session?.sessionId ?? "").trim();
      if (!expectedSessionId || typeof session?.prompt !== "function" || typeof session?.close !== "function") {
        throw new AcpTurnError("ACP client returned an incomplete session.", { code: "invalid_acp_session" });
      }
      const turn = createTurnState(session, bridge, model, expectedSessionId);
      active.add(turn);
      turn.onClosed = () => active.delete(turn);
      return turn;
    } catch (error) {
      await bridge?.close().catch(() => {});
      throw error;
    } finally {
      removeRequestAbort();
      openingControllers.delete(openingController);
    }
  }

  return { start, resume, followUp, cancel, close };
}

function createTurnState(session, bridge, model, sessionId) {
  const turn = {
    session,
    sessionId,
    bridge,
    model,
    cascadeId: sessionId,
    lifetime: new AbortController(),
    queue: createEventQueue(),
    registeredToolNames: new Set(bridge.customAgentSpec.customTools),
    pendingCalls: new Map(),
    receivedCallIds: new Set(),
    promptController: null,
    promptFinished: false,
    promptGeneration: 0,
    requestSignalBinding: null,
    closed: false,
    retained: false,
    bridgePump: null,
    continuation: null,
    onClosed: null,
  };
  turn.continuation = {
    cascadeId: sessionId,
    sessionId,
    model,
    retained: false,
    registeredToolNames: turn.registeredToolNames,
    hasToolBridge: true,
    turn,
  };
  turn.bridgePump = pumpBridgeCalls(turn);
  return turn;
}

async function pumpBridgeCalls(turn) {
  while (!turn.closed) {
    try {
      const call = await turn.bridge.waitForCall({
        timeoutMs: turn.bridge.pendingCallTimeoutMs,
        signal: turn.lifetime.signal,
      });
      enqueueBridgeCall(turn, call);
      for (const queued of turn.bridge.takeCalls()) enqueueBridgeCall(turn, queued);
    } catch (error) {
      if (turn.closed || turn.lifetime.signal.aborted) return;
      if (/timed out waiting for native tool call/i.test(String(error?.message ?? ""))) continue;
      turn.queue.push({ type: "error", error });
      return;
    }
  }
}

function enqueueBridgeCall(turn, call) {
  if (!call?.callId || turn.receivedCallIds.has(call.callId)) return;
  turn.receivedCallIds.add(call.callId);
  turn.queue.push({ type: "bridge_call", call });
}

function startPrompt(turn, content, requestSignal) {
  if (turn.closed) throw new AcpTurnError("ACP continuation is closed.", { code: "closed_acp_continuation" });
  if (turn.promptController && !turn.promptFinished) {
    throw new AcpTurnError("ACP session already has a prompt in progress.", { statusCode: 409, code: "acp_prompt_in_progress" });
  }
  const controller = new AbortController();
  turn.promptController = controller;
  turn.promptFinished = false;
  turn.promptGeneration += 1;
  const generation = turn.promptGeneration;
  const promptState = { emittedText: false };
  bindRequestSignal(turn, requestSignal, controller);
  const onText = (value) => {
    const delta = textDelta(value);
    if (!delta) return;
    // The official CLI reports service failures (quota, capacity, account bans) as a reply line
    // that starts with a warning sign. Surface them as errors so Codex shows and retries them
    // instead of saving the failure into the chat as an answer.
    const serviceError = !promptState.emittedText ? officialServiceError(delta) : null;
    if (serviceError) {
      promptState.serviceError = serviceError;
      return;
    }
    promptState.emittedText = true;
    turn.queue.push({ type: "text_delta", delta, generation });
  };
  let result;
  try {
    result = turn.session.prompt({
      text: content,
      signal: controller.signal,
      onText,
      onToolUpdate() {},
    });
  } catch (error) {
    result = Promise.reject(error);
  }
  turn.promptPromise = Promise.resolve(result).then(
    (value) => {
      if (generation !== turn.promptGeneration || turn.closed) return;
      if (promptState.serviceError) {
        turn.promptFinished = true;
        unbindRequestSignal(turn);
        turn.queue.push({ type: "error", error: promptState.serviceError, generation });
        return;
      }
      const finalText = promptResultText(value);
      if (finalText && !promptState.emittedText) turn.queue.push({ type: "text_delta", delta: finalText, generation });
      turn.promptFinished = true;
      unbindRequestSignal(turn);
      turn.queue.push({ type: "prompt_done", result: value, generation });
    },
    (error) => {
      if (generation !== turn.promptGeneration || turn.closed) return;
      turn.promptFinished = true;
      unbindRequestSignal(turn);
      turn.queue.push({ type: "error", error, generation });
    },
  );
}

async function* readPromptTurn(turn, requestSignal, request) {
  const generation = turn.promptGeneration;
  while (true) {
    const event = await turn.queue.next(requestSignal);
    if (event.generation !== undefined && event.generation !== generation) continue;
    if (event.type === "text_delta") {
      yield { type: "text_delta", delta: event.delta };
      continue;
    }
    if (event.type === "bridge_call") {
      const calls = [event.call];
      while (turn.queue.peek()?.type === "bridge_call") calls.push(turn.queue.shift().call);
      for (const call of calls) turn.pendingCalls.set(call.callId, call);
      const normalized = normalizeCascadeCalls(calls.map((call) => ({
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
      })), AcpTurnError);
      unbindRequestSignal(turn);
      turn.retained = true;
      turn.continuation.retained = true;
      yield { type: "tool_calls", calls: normalized, continuation: turn.continuation };
      return "tool_calls";
    }
    if (event.type === "prompt_done") {
      if (turn.pendingCalls.size > 0) {
        throw new AcpTurnError("ACP prompt ended while a Codex tool result was still pending.", {
          statusCode: 502,
          code: "pending_acp_tool_result",
        });
      }
      turn.continuation.model = turn.model;
      const retain = request.retainConversation === true || typeof request.onTurnCompleted === "function";
      turn.retained = retain;
      turn.continuation.retained = retain;
      try {
        if (retain) request.onTurnCompleted?.(turn.continuation);
      } catch (error) {
        turn.retained = false;
        turn.continuation.retained = false;
        throw error;
      }
      yield {
        type: "done",
        result: { cascadeId: turn.cascadeId, sessionId: turn.sessionId, model: turn.model },
      };
      return "done";
    }
    if (event.type === "error") throw event.error ?? new AcpTurnError("ACP prompt failed.");
    if (event.type === "closed") throw new AcpTurnError("ACP turn was closed.", { code: "closed_acp_continuation" });
    throw new AcpTurnError(`Unsupported ACP event: ${String(event.type ?? "missing")}.`, { code: "unsupported_acp_event" });
  }
}

function completePendingCalls(turn, results) {
  if (!Array.isArray(results) || results.length !== turn.pendingCalls.size) {
    throw new AcpTurnError("ACP resume requires one result for every pending Codex tool call.", {
      statusCode: 409,
      code: "incomplete_acp_tool_results",
    });
  }
  const seen = new Set();
  for (const result of results) {
    const callId = String(result?.callId ?? "");
    if (!callId || seen.has(callId) || !turn.pendingCalls.has(callId)) {
      throw new AcpTurnError("ACP resume received an unknown or duplicate Codex tool result.", {
        statusCode: 409,
        code: "invalid_acp_tool_result",
      });
    }
    seen.add(callId);
  }
  for (const result of results) {
    const callId = String(result.callId);
    if (!turn.bridge.completeCall(callId, result.output, { isError: result.isError === true })) {
      throw new AcpTurnError("ACP MCP request ended before its Codex tool result arrived.", {
        statusCode: 409,
        code: "expired_acp_tool_call",
      });
    }
    turn.pendingCalls.delete(callId);
  }
}

function updateTools(turn, tools) {
  if (!Array.isArray(tools)) return;
  turn.bridge.updateTools(tools);
  turn.registeredToolNames = new Set(turn.bridge.customAgentSpec.customTools);
  turn.continuation.registeredToolNames = turn.registeredToolNames;
}

function trustedSystemInstructions(sections) {
  const supplied = (Array.isArray(sections) ? sections : [])
    .filter(isTrustedInstructionSection)
    .map((section) => {
      const title = String(section?.title ?? "").trim();
      const content = String(section?.content ?? "").trim();
      return [title, content].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
  return [supplied, "The Codex editor supplies your task tools through the anticodex MCP server. Use those tools for all actions, including file reads, commands, and edits. The editor executes them in the user's workspace and enforces the user's approvals. Your private ACP session directory is not the user's project. Use the original user path with the editor tools. Report the result after it is returned."].filter(Boolean).join("\n\n");
}

function promptContent(request) {
  const blocks = [];
  for (const section of Array.isArray(request.systemSections) ? request.systemSections : []) {
    if (isTrustedInstructionSection(section)) continue;
    if (Array.isArray(section?.messages)) {
      const title = String(section?.title ?? "Conversation history").trim();
      blocks.push(textBlock(`[Untrusted prior context: ${title}. The following transcript is user-level context.]\n`));
      for (const message of section.messages) {
        const role = String(message?.role ?? "unknown").trim() || "unknown";
        blocks.push(textBlock(`[Prior ${role} message]\n`));
        blocks.push(...contentBlocks(message?.content));
        if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
          blocks.push(textBlock(`\n[Prior tool call records, untrusted data]\n${safeJson(message.tool_calls)}\n`));
        }
        blocks.push(textBlock("\n"));
      }
      continue;
    }
    const content = String(section?.content ?? "").trim();
    if (content) {
      const title = String(section?.title ?? section?.kind ?? "Untrusted context").trim();
      blocks.push(textBlock(`[Untrusted request context: ${title}]\n${content}\n`));
    }
  }

  const userItems = Array.isArray(request.userItems) ? request.userItems : [];
  const current = userItems.flatMap(userItemBlocks);
  const hasText = current.some((block) => block.type === "text" && block.text.trim());
  if ((current.length === 0 || !hasText) && String(request.userText ?? "").trim()) {
    current.unshift(textBlock(String(request.userText)));
  }
  if (current.length > 0) {
    blocks.push(textBlock("[Current user request]\n"));
    blocks.push(...current);
  }
  return blocks;
}

function isTrustedInstructionSection(section) {
  return section?.kind === "native_custom_instructions"
    || section?.kind === "tool_restart_continuation"
    || (section?.kind === "instructions" && ["system", "developer"].includes(String(section?.role ?? "").toLowerCase()));
}

function userItemBlocks(item) {
  if (typeof item?.text === "string") return item.text ? [textBlock(item.text)] : [];
  if (typeof item?.image?.data === "string" && /^image\/[a-z0-9.+-]+$/i.test(item.image.mimeType ?? "")) {
    return [{ type: "image", data: item.image.data, mimeType: item.image.mimeType }];
  }
  const data = String(item?.inlineData ?? item?.data ?? "");
  const mimeType = String(item?.mimeType ?? item?.mime_type ?? "");
  if (data && /^image\/[a-z0-9.+-]+$/i.test(mimeType)) return [{ type: "image", data, mimeType }];
  const image = imageDataBlock(item?.image_url?.url ?? item?.image_url ?? item?.url);
  return image ? [image] : [];
}

function contentBlocks(content) {
  if (typeof content === "string") return content ? [textBlock(content)] : [];
  if (!Array.isArray(content)) return content === null || content === undefined ? [] : [textBlock(safeJson(content))];
  return content.flatMap((part) => {
    const type = String(part?.type ?? "text");
    if (type === "text" || type === "input_text") return part?.text ? [textBlock(String(part.text))] : [];
    if (type === "image" && part?.data && part?.mimeType) {
      return [{ type: "image", data: String(part.data), mimeType: String(part.mimeType) }];
    }
    if (type === "image_url" || type === "input_image") {
      const image = imageDataBlock(part?.image_url?.url ?? part?.image_url ?? part?.url);
      if (image) return [image];
    }
    return [textBlock(`[Untrusted content part ${type}] ${safeJson(part)}`)];
  });
}

function imageDataBlock(value) {
  const match = String(value ?? "").match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) return null;
  return { type: "image", data: match[2].replace(/\s+/g, ""), mimeType: match[1].toLowerCase() };
}

function textBlock(text) {
  return { type: "text", text: String(text ?? "") };
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return "[unserializable content]"; }
}

function textDelta(value) {
  if (typeof value === "string") return value;
  if (typeof value?.delta === "string") return value.delta;
  if (typeof value?.text === "string") return value.text;
  return "";
}

function promptResultText(value) {
  if (typeof value === "string") return value;
  if (typeof value?.text === "string") return value.text;
  return "";
}

function bindRequestSignal(turn, signal, controller = turn.promptController) {
  unbindRequestSignal(turn);
  if (!signal || !controller) return;
  const abort = () => controller.abort(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  turn.requestSignalBinding = { signal, abort };
}

function bindSignal(signal, controller) {
  if (!signal) return () => {};
  const abort = () => controller.abort(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function unbindRequestSignal(turn) {
  if (!turn.requestSignalBinding) return;
  turn.requestSignalBinding.signal.removeEventListener("abort", turn.requestSignalBinding.abort);
  turn.requestSignalBinding = null;
}

async function resolveWorkspace(workspace, request) {
  const value = typeof workspace === "function" ? await workspace(request) : workspace;
  return requiredString(value, "workspace");
}

function requiredString(value, label) {
  const result = String(value ?? "").trim();
  if (!result) throw new AcpTurnError(`ACP ${label} is required.`, { statusCode: 400, code: `missing_acp_${label}` });
  return result;
}

function requireTurn(continuation) {
  const turn = continuation?.turn;
  if (!turn || turn.continuation !== continuation) {
    throw new AcpTurnError("Invalid ACP continuation state.", { statusCode: 409, code: "invalid_acp_continuation" });
  }
  return turn;
}

function createEventQueue() {
  const items = [];
  const waiters = [];
  let closed = false;
  let closeError = null;
  return {
    push(value) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter.signal?.removeEventListener("abort", waiter.abort);
        waiter.resolve(value);
      } else items.push(value);
    },
    peek() { return items[0]; },
    shift() { return items.shift(); },
    next(signal) {
      if (items.length) return Promise.resolve(items.shift());
      if (closed) return closeError ? Promise.reject(closeError) : Promise.resolve({ type: "closed" });
      if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal, abort: null };
        waiter.abort = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        };
        waiters.push(waiter);
        signal?.addEventListener("abort", waiter.abort, { once: true });
      });
    },
    close(error) {
      if (closed) return;
      closed = true;
      closeError = error ?? null;
      for (const waiter of waiters.splice(0)) {
        waiter.signal?.removeEventListener("abort", waiter.abort);
        if (closeError) waiter.reject(closeError);
        else waiter.resolve({ type: "closed" });
      }
    },
  };
}

function permissionOptionId(params, expectedSessionId, bridge) {
  if (params?.method !== "session/request_permission" || !params.params || typeof params.params !== "object") return null;
  const request = params.params;
  const choices = Array.isArray(request.options) ? request.options : [];
  const toolCall = request.toolCall;
  const name = String(toolCall?.name ?? "");
  const toolName = name.startsWith(TOOL_SERVER_PREFIX) ? name.slice(TOOL_SERVER_PREFIX.length) : "";
  const registeredTools = new Set(bridge.tools.map((tool) => String(tool?.name ?? "")));
  const requestSessionId = request.sessionId;
  const authorized = Boolean(expectedSessionId)
    && requestSessionId === expectedSessionId
    && toolCall?.kind === "other"
    && registeredTools.has(toolName);
  const wantedKind = authorized ? "allow_once" : "reject_once";
  return choices.find((choice) => choice?.kind === wantedKind
    && typeof choice.optionId === "string" && choice.optionId.length > 0)?.optionId ?? null;
}

async function closeTurn(turn) {
  if (!turn || turn.closed) return;
  turn.closed = true;
  turn.retained = false;
  turn.continuation.retained = false;
  turn.lifetime.abort(new Error("ACP turn closed."));
  turn.promptController?.abort(new Error("ACP prompt closed."));
  unbindRequestSignal(turn);
  turn.queue.close(new AcpTurnError("ACP turn is closed.", { code: "closed_acp_continuation" }));
  await turn.bridge.close().catch(() => {});
  await Promise.resolve(turn.session.close()).catch(() => {});
  if (turn.bridgePump) await Promise.allSettled([turn.bridgePump]);
  turn.onClosed?.();
}

export function officialServiceError(text) {
  const match = /^\s*\u26a0\uFE0F?\s*(.+?)\s*$/su.exec(String(text ?? ""));
  if (!match) return null;
  const message = match[1];
  const code = /\(code (\d{3})\)/u.exec(message)?.[1];
  let statusCode = code ? Number(code) : 502;
  if (/RESOURCE_EXHAUSTED|quota|rate limit|usage limit/iu.test(message)) statusCode = 429;
  else if (/UNAVAILABLE|No capacity available/iu.test(message)) statusCode = 503;
  else if (/disabled in this account|violation of Terms of Service|not logged in|sign in/iu.test(message)) statusCode = 403;
  const errorCode = statusCode === 429 ? "quota_exceeded"
    : statusCode === 503 ? "upstream_service_error"
      : statusCode === 403 ? "account_unavailable"
        : statusCode === 400 ? "invalid_request_error"
          : "upstream_error";
  const error = new AcpTurnError(message, { statusCode, code: errorCode });
  // Lets the shared error mapping keep 429/503 instead of re-deriving them from the text.
  if ([429, 502, 503, 504].includes(statusCode)) error.acpHttpStatus = statusCode;
  return error;
}

class AcpTurnError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AcpTurnError";
    this.statusCode = options.statusCode ?? 502;
    this.code = options.code ?? "acp_turn_error";
  }
}

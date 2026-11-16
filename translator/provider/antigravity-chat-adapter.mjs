import { randomUUID } from "node:crypto";

import {
  DEFAULT_TOOL_CONTINUATION_TIMEOUT_MS,
  createSessionStore,
  mapAntigravityProviderError,
  normalizeCascadeCalls,
  normalizeReturnedToolName,
  createCascadeTraceStore,
  extractConversationKey,
  isNativeCodexTaskSuggestionsRequest,
  isNativeCodexTitleRequest,
  hasUnregisteredTools,
  matchFollowUpConversation,
  messageSignature,
  toolNameSet,
} from "../antigravity-contract.mjs";

const DEFAULT_SESSION_TTL_MS = DEFAULT_TOOL_CONTINUATION_TIMEOUT_MS;
const DEFAULT_MAX_SESSIONS = 128;

export class ChatAdapterError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ChatAdapterError";
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? "antigravity_adapter_error";
    this.type = options.type ?? "server_error";
  }
}

export function createAntigravityChatAdapter(options = {}) {
  const client = options.client;
  if (!client || typeof client.start !== "function" || typeof client.resume !== "function") {
    throw new TypeError("An Antigravity Cascade client with start() and resume() is required.");
  }

  const now = options.now ?? Date.now;
  const { record: recordCascadeTrace, snapshot: cascadeTraceSnapshot } = createCascadeTraceStore(now);
  const idFactory = options.idFactory ?? (() => `chatcmpl_${randomUUID().replaceAll("-", "")}`);
  const readNativeCustomInstructions = typeof options.nativeCustomInstructions === "function"
    ? options.nativeCustomInstructions
    : () => options.nativeCustomInstructions;
  const sessions = createSessionStore({
    client,
    maxSessions: positiveInteger(options.maxSessions, DEFAULT_MAX_SESSIONS),
    ttlMs: positiveInteger(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS),
    setTimer: options.setTimer ?? setTimeout,
    clearTimer: options.clearTimer ?? clearTimeout,
    createError: (msg, opts) => new ChatAdapterError(msg, opts),
  });


  async function account(requestOptions = {}) {
    if (typeof client.getReadiness !== "function") {
      throw new ChatAdapterError("Antigravity account readiness is unavailable.", {
        statusCode: 503,
        code: "account_readiness_unavailable",
      });
    }
    try {
      const readiness = await client.getReadiness(requestOptions);
      const fingerprint = String(readiness?.accountFingerprint ?? "");
      return {
        object: "antigravity.account",
        provider: "antigravity",
        signedIn: readiness?.signedIn === true,
        identityAvailable: Boolean(fingerprint),
        fingerprint,
        planName: String(readiness?.planName ?? ""),
        tierName: String(readiness?.tierName ?? ""),
      };
    } catch (error) {
      throw mapAntigravityError(error);
    }
  }

  async function models(requestOptions = {}) {
    try {
      const entries = await client.listModels?.(requestOptions) ?? [];
      const created = Math.floor(now() / 1000);
      return {
        object: "list",
        data: entries.map((entry) => ({
          id: String(entry?.id ?? entry?.model ?? ""),
          object: "model",
          created,
          owned_by: "antigravity",
          ...(entry?.displayName ? { display_name: String(entry.displayName) } : {}),
        })).filter((entry) => entry.id),
      };
    } catch (error) {
      throw mapAntigravityError(error);
    }
  }

  async function* stream(body, requestOptions = {}) {
    const canFollowUp = typeof client.followUp === "function";
    const requestedConversationKey = canFollowUp
      ? String(requestOptions.conversationKey || extractConversationKey(null, body) || `auto:${randomUUID()}`).trim()
      : "";
    const prepared = prepareChatRequest(
      body,
      sessions,
      readNativeCustomInstructions(),
      requestedConversationKey,
    );
    const id = idFactory();
    const created = Math.floor(now() / 1000);
    const model = prepared.model;
    const signal = requestOptions.signal;
    const base = { id, object: "chat.completion.chunk", created, model };
    let continuation = null;
    let completedContinuation = null;
    let terminal = false;
    let roleSent = false;
    let nativeHelperText = "";
    let assistantText = "";
    let assistantMessage = null;
    let tracedCascadeId = "";
    const traceAction = prepared.kind === "follow_up" ? "follow_up"
      : prepared.kind === "resume" ? "resume"
        : "start";
    const traceReason = prepared.reason
      ?? (prepared.kind === "follow_up" ? "history_matched" : "no_existing_continuation");
    const recordTrace = (cascadeId) => recordCascadeTrace({
      conversationKey: prepared.conversationKey, cascadeId,
      action: traceAction, reason: traceReason, model,
    });
    const resumedByOwner = prepared.kind === "resume" && prepared.claimMode === "owner";
    const replayedResume = prepared.kind === "resume" && !resumedByOwner;
    const retainConversation = Boolean(prepared.conversationKey)
      && typeof client.followUp === "function"
      && !replayedResume;
    const onTurnCompleted = retainConversation
      ? (value) => { completedContinuation = value; }
      : undefined;
    const replayEvents = [];

    try {
      if (prepared.staleRecord) {
        await sessions.cancelRecord(prepared.staleRecord);
      }
      if (prepared.staleContinuation) {
        await Promise.resolve(client.cancel?.(prepared.staleContinuation)).catch(() => {});
      }

      let events;
      if (prepared.kind === "resume") {
        continuation = prepared.record.continuation;
        tracedCascadeId = String(continuation?.cascadeId ?? "");
        recordTrace(tracedCascadeId);
        events = resumedByOwner
          ? client.resume(continuation, prepared.results, {
            model,
            signal,
            tools: prepared.tools,
            ...(retainConversation ? { retainConversation: true, onTurnCompleted } : {}),
          })
          : sessions.replay(prepared.record);
      } else if (prepared.kind === "follow_up") {
        continuation = prepared.continuation;
        tracedCascadeId = String(continuation?.cascadeId ?? "");
        recordTrace(tracedCascadeId);
        events = client.followUp(continuation, {
          model,
          userText: prepared.userText,
          userItems: prepared.userItems,
          tools: prepared.tools,
          retainConversation: true,
          onTurnCompleted,
          signal,
        });
      } else {
        events = client.start({
          model,
          userText: prepared.userText,
          userItems: prepared.userItems,
          systemSections: prepared.systemSections,
          tools: prepared.tools,
          toolChoice: prepared.toolChoice,
          parallelToolCalls: prepared.parallelToolCalls,
          reasoningEffort: prepared.reasoningEffort,
          ...(retainConversation ? { retainConversation: true, onTurnCompleted } : {}),
          onCascadeCreated: (createdContinuation) => {
            tracedCascadeId = String(createdContinuation?.cascadeId ?? "");
            recordTrace(tracedCascadeId);
          },
          signal,
        });
      }

      for await (const event of events) {
        if (resumedByOwner) replayEvents.push(event);
        if (terminal) {
          throw new ChatAdapterError("Antigravity emitted data after a terminal event.", {
            statusCode: 502,
            code: "multiple_terminal_events",
          });
        }
        if (event?.type === "ready") {
          if (!roleSent) {
            roleSent = true;
            yield chunk(base, { role: "assistant" }, null);
          }
          continue;
        }
        if (event?.type === "text_delta") {
          const delta = String(event.delta ?? "");
          if (delta && !prepared.nativeHelperKind) {
            assistantText += delta;
            assistantMessage = { role: "assistant", content: assistantText };
          }
          if (delta && !roleSent) {
            roleSent = true;
            yield chunk(base, { role: "assistant" }, null);
          }
          if (delta && prepared.nativeHelperKind) nativeHelperText += delta;
          else if (delta) yield chunk(base, { content: delta }, null);
          continue;
        }
        if (event?.type === "reasoning_delta") {
          const delta = String(event.delta ?? "");
          if (delta && !roleSent) {
            roleSent = true;
            yield chunk(base, { role: "assistant" }, null);
          }
          if (delta) yield chunk(base, { reasoning_content: delta }, null);
          continue;
        }
        if (event?.type === "tool_calls") {
          continuation = event.continuation ?? null;
          if (!continuation) {
            throw new ChatAdapterError("Antigravity tool calls are missing opaque Cascade continuation state.", {
              statusCode: 502,
              code: "cascade_continuation_missing",
            });
          }
          const calls = normalizeCascadeCalls(event.calls, ChatAdapterError);
          assistantMessage = {
            role: "assistant",
            content: null,
            tool_calls: calls.map((call) => ({
              id: call.callId,
              type: "function",
              function: { name: call.name, arguments: call.argumentsJson },
            })),
          };
          tracedCascadeId = String(continuation.cascadeId ?? tracedCascadeId);
          recordTrace(tracedCascadeId);
          if (!replayedResume) {
            await sessions.put(continuation, calls, {
              replacingRecord: resumedByOwner ? prepared.record : null,
              registeredToolNames: continuation.registeredToolNames instanceof Set
                ? new Set(continuation.registeredToolNames)
                : prepared.registeredToolNames,
              hasToolBridge: prepared.hasToolBridge,
              conversationKey: prepared.conversationKey,
              baseSignatures: prepared.baseSignatures,
            });
          }
          if (resumedByOwner) sessions.complete(prepared.record, replayEvents);
          if (!roleSent) {
            roleSent = true;
            yield chunk(base, { role: "assistant" }, null);
          }
          yield chunk(base, {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.callId,
              type: "function",
              function: {
                name: call.name,
                arguments: call.argumentsJson,
              },
            })),
          }, null);
          terminal = true;
          yield chunk(base, {}, "tool_calls", event.usage);
          return;
        }
        if (event?.type === "done") {
          tracedCascadeId = String(event.result?.cascadeId ?? continuation?.cascadeId ?? tracedCascadeId);
          recordTrace(tracedCascadeId);
          const retainedTarget = completedContinuation
            ?? (retainConversation && continuation?.retained ? continuation : null);
          if (retainConversation && retainedTarget) {
            await sessions.putConversation(prepared.conversationKey, retainedTarget, {
              registeredToolNames: retainedTarget.registeredToolNames instanceof Set
                ? new Set(retainedTarget.registeredToolNames)
                : prepared.registeredToolNames,
              hasToolBridge: prepared.hasToolBridge,
              baseSignatures: prepared.baseSignatures,
              lastAssistantSignature: assistantMessage ? messageSignature(assistantMessage) : "",
            });
          }
          if (resumedByOwner) sessions.complete(prepared.record, replayEvents);
          const nativeHelperOutput = prepared.nativeHelperKind
            ? normalizeNativeCodexHelperOutput(prepared.nativeHelperKind, nativeHelperText)
            : "";
          if (!roleSent) {
            roleSent = true;
            yield chunk(base, { role: "assistant" }, null);
          }
          if (prepared.nativeHelperKind) {
            yield chunk(base, {
              content: nativeHelperOutput,
            }, null);
          }
          terminal = true;
          yield chunk(base, {}, "stop", event.usage);
          return;
        }
        if (event?.type === "error") throw event.error ?? new Error("Antigravity failed.");
        throw new ChatAdapterError(`Unsupported Antigravity event: ${String(event?.type ?? "missing")}`, {
          statusCode: 502,
          code: "unsupported_cascade_event",
        });
      }
      throw new ChatAdapterError("Antigravity ended without a terminal event.", {
        statusCode: 502,
        code: "cascade_terminal_missing",
      });
    } catch (error) {
      if (resumedByOwner) sessions.fail(prepared.record, error);
      if (continuation && !replayedResume) {
        await Promise.resolve(client.cancel?.(continuation)).catch(() => {});
      }
      if (isAbortError(error) || signal?.aborted) throw signal?.reason ?? error;
      throw mapAntigravityError(error);
    }
  }

  async function complete(body, requestOptions = {}) {
    let id = "";
    let created = 0;
    let model = String(body?.model ?? "");
    let content = "";
    let reasoning = "";
    let toolCalls = [];
    let finishReason = null;
    let usage;

    for await (const item of stream(body, requestOptions)) {
      id = item.id;
      created = item.created;
      model = item.model;
      const choice = item.choices[0];
      if (typeof choice.delta?.content === "string") content += choice.delta.content;
      if (typeof choice.delta?.reasoning_content === "string") reasoning += choice.delta.reasoning_content;
      if (Array.isArray(choice.delta?.tool_calls)) {
        toolCalls = choice.delta.tool_calls.map(({ index: _index, ...call }) => call);
      }
      if (choice.finish_reason !== null) finishReason = choice.finish_reason;
      if (item.usage) usage = item.usage;
    }

    const message = {
      role: "assistant",
      content: content || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
    return {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    };
  }

  return {
    account,
    models,
    stream,
    complete,
    close: () => sessions.close(),
    get sessionCount() {
      return sessions.size;
    },
    get conversationCount() {
      return sessions.conversationSize;
    },
    getDiagnostics() {
      return { cascadeTrace: cascadeTraceSnapshot() };
    },
  };
}

function prepareChatRequest(body, sessions, nativeCustomInstructions, conversationKey = "") {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalidRequest("Chat Completions body must be an object.");
  }
  const model = String(body.model ?? "").trim();
  if (!model) throw invalidRequest("model is required.");
  if (body.n !== undefined && Number(body.n) !== 1) {
    throw invalidRequest("Only n=1 is supported.", "unsupported_choice_count");
  }
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages?.length) throw invalidRequest("messages must be a non-empty array.");
  const requestedTools = normalizeChatTools(body.tools, body.tool_choice);
  const continuation = trailingToolContinuation(messages);
  if (continuation) {
    const hasUserHistory = messages.some((message) => String(message?.role ?? "").toLowerCase() === "user");
    const peeked = sessions.peek(continuation.callIds);
    const needsToolUpgrade = Boolean(
      peeked
      && peeked.state === "pending"
      && hasUserHistory
      && completeToolResultSet(continuation.callIds, continuation.results)
      && hasUnregisteredTools(peeked.registeredToolNames, requestedTools),
    );
    if (needsToolUpgrade) {
      const effectiveKey = String(conversationKey || peeked.conversationKey || "").trim();
      const staleConv = effectiveKey ? sessions.takeConversation(effectiveKey) : null;
      return {
        ...prepareRestartContinuation(
          body,
          messages,
          model,
          requestedTools,
          nativeCustomInstructions,
          effectiveKey,
        ),
        reason: "new_tools_detected",
        staleRecord: peeked,
        staleContinuation: staleConv?.continuation ?? null,
      };
    }
    const claim = sessions.claim(continuation.callIds, continuation.results, {
      allowMissing: hasUserHistory,
    });
    if (claim) {
      return {
        kind: "resume",
        reason: "tool_results_resume",
        model,
        record: claim.record,
        claimMode: claim.mode,
        results: claim.record.calls.map((call) => ({
          callId: call.callId,
          output: continuation.results.get(call.callId),
          isError: false,
        })),
        tools: requestedTools,
        registeredToolNames: claim.record.registeredToolNames,
        hasToolBridge: claim.record.hasToolBridge,
        conversationKey: String(conversationKey || claim.record.conversationKey || "").trim(),
        baseSignatures: claim.record.baseSignatures,
      };
    }
    if (!completeToolResultSet(continuation.callIds, continuation.results)) {
      throw new ChatAdapterError("Every pending tool call result is required before restart recovery.", {
        statusCode: 409,
        code: "incomplete_tool_results",
      });
    }
    const effectiveKey = String(conversationKey || "").trim();
    const staleConv = effectiveKey ? sessions.takeConversation(effectiveKey) : null;
    return {
      ...prepareRestartContinuation(
        body,
        messages,
        model,
        requestedTools,
        nativeCustomInstructions,
        effectiveKey,
      ),
      reason: "pending_continuation_missing",
      staleContinuation: staleConv?.continuation ?? null,
    };
  }

  let currentUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (String(messages[index]?.role ?? "").toLowerCase() === "user") {
      currentUserIndex = index;
      break;
    }
  }
  if (currentUserIndex < 0) throw invalidRequest("A current user message is required.");
  const rawCurrentUser = messages[currentUserIndex];
  const systemSections = [];
  const rawUserContent = normalizeUserContent(rawCurrentUser?.content);
  const suppliedStructuredOutput = normalizeStructuredOutput(body.response_format);
  const nativeTitleHelper = isNativeCodexTitleRequest(rawUserContent.text, suppliedStructuredOutput);
  const nativeTaskSuggestionsHelper = isNativeCodexTaskSuggestionsRequest(rawUserContent.text, suppliedStructuredOutput);
  const nativeTextOnlyHelper = nativeTitleHelper || nativeTaskSuggestionsHelper;
  const trustedNativeInstructions = addNativeCustomInstructions(
    systemSections,
    nativeCustomInstructions,
    !nativeTextOnlyHelper,
  );
  const strippedCurrentUser = stripExactNativeCustomInstructions(rawCurrentUser, trustedNativeInstructions) ?? rawCurrentUser;
  const userContent = strippedCurrentUser === rawCurrentUser
    ? rawUserContent
    : normalizeUserContent(strippedCurrentUser?.content, { allowEmpty: true });
  const userText = userContent.text;
  const structuredOutput = suppliedStructuredOutput
    ?? (body.response_format === undefined || body.response_format === null
      ? nativeTitleHelper
        ? nativeCodexTitleStructuredOutput()
        : nativeTaskSuggestionsHelper
          ? nativeCodexTaskSuggestionsStructuredOutput()
          : null
      : null);
  const tools = nativeTextOnlyHelper ? [] : requestedTools;
  const history = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] ?? {};
    const role = String(message.role ?? "").toLowerCase();
    if (index === currentUserIndex) continue;
    if (role === "system" || role === "developer") {
      const content = messageText(message.content, { allowEmpty: true });
      if (content) systemSections.push({
        kind: "instructions",
        role,
        title: role === "developer" ? "Codex developer instructions" : "Codex system instructions",
        content,
      });
      continue;
    }
    const historyMessage = stripExactNativeCustomInstructions(message, trustedNativeInstructions);
    if (historyMessage) history.push(normalizeHistoryMessage(historyMessage));
  }

  const effectiveConversationKey = !nativeTextOnlyHelper
    ? String(conversationKey || "").trim()
    : "";
  const normalizedCurrentHistoryEntry = normalizeHistoryMessage(strippedCurrentUser);
  const nextBaseSignatures = effectiveConversationKey
    ? [...history.map(messageSignature), messageSignature(normalizedCurrentHistoryEntry)]
    : null;
  let staleContinuation = null;

  if (effectiveConversationKey) {
    const isAutoKey = effectiveConversationKey.startsWith("auto:");
    if (isAutoKey) {
      const matched = sessions.takeMatchingConversation?.({
        tools,
        history,
        userItems: userContent.items,
        structuredOutput,
      });
      if (matched) {
        return {
          kind: "follow_up",
          reason: "history_matched",
          model,
          continuation: matched.entry.continuation,
          registeredToolNames: matched.entry.registeredToolNames,
          hasToolBridge: matched.entry.hasToolBridge,
          conversationKey: matched.entry.key,
          baseSignatures: nextBaseSignatures,
          userText,
          userItems: matched.followUpItems,
          tools,
        };
      }
    } else {
      const existingConversation = sessions.takeConversation(effectiveConversationKey);
      if (existingConversation) {
        const followUpItems = matchFollowUpConversation(existingConversation, {
          tools,
          history,
          userItems: userContent.items,
          structuredOutput,
          allowCompactedHistory: true,
        });
        if (followUpItems) {
          return {
            kind: "follow_up",
            reason: "history_matched",
            model,
            continuation: existingConversation.continuation,
            registeredToolNames: existingConversation.registeredToolNames,
            hasToolBridge: existingConversation.hasToolBridge,
            conversationKey: effectiveConversationKey,
            baseSignatures: nextBaseSignatures,
            userText,
            userItems: followUpItems,
            tools,
          };
        }
        staleContinuation = existingConversation.continuation;
      }
    }
  }

  if (history.length) {
    systemSections.push({
      kind: "chat_history",
      role: "internal",
      title: "Prior Chat Completions messages",
      contentTrust: "untrusted_transcript",
      messages: history,
    });
  }
  if (structuredOutput) systemSections.push(structuredOutput.section);
  return {
    kind: "start",
    model,
    userText,
    userItems: userContent.items,
    systemSections,
    tools,
    registeredToolNames: toolNameSet(tools),
    hasToolBridge: tools.length > 0,
    conversationKey: effectiveConversationKey,
    baseSignatures: nextBaseSignatures,
    staleContinuation,
    reason: staleContinuation
      ? "history_mismatch"
      : effectiveConversationKey
        ? "no_existing_continuation"
        : "no_conversation_key",
    toolChoice: nativeTextOnlyHelper ? "none" : normalizeToolChoice(body.tool_choice),
    parallelToolCalls: nativeTextOnlyHelper ? false : body.parallel_tool_calls !== false,
    reasoningEffort: String(body.reasoning_effort ?? body.reasoning?.effort ?? "").trim(),
    nativeHelperKind: nativeTitleHelper ? "title" : nativeTaskSuggestionsHelper ? "task_suggestions" : "",
  };
}

function normalizeStructuredOutput(responseFormat) {
  if (responseFormat === undefined || responseFormat === null || responseFormat?.type === "text") return null;
  if (!responseFormat || typeof responseFormat !== "object" || Array.isArray(responseFormat)) {
    throw invalidRequest("response_format must be an object.", "invalid_response_format");
  }
  if (responseFormat.type === "json_object") {
    return {
      type: "json_object",
      schemaName: "",
      schema: null,
      section: {
        kind: "structured_output",
        role: "internal",
        title: "Chat Completions structured output contract",
        content: "Return exactly one valid JSON object and no surrounding prose or markdown.",
      },
    };
  }
  if (responseFormat.type !== "json_schema") {
    throw invalidRequest(`Unsupported response_format type: ${String(responseFormat.type || "missing")}`, "unsupported_response_format");
  }
  const definition = responseFormat.json_schema;
  const schema = definition?.schema;
  if (!definition || typeof definition !== "object" || !schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw invalidRequest("response_format.json_schema.schema must be an object.", "invalid_response_format");
  }
  let schemaJson;
  try {
    schemaJson = JSON.stringify(schema);
  } catch (error) {
    throw invalidRequest(`response_format JSON schema is not serializable: ${error instanceof Error ? error.message : String(error)}`, "invalid_response_format");
  }
  return {
    type: "json_schema",
    schemaName: String(definition.name || ""),
    schema,
    section: {
      kind: "structured_output",
      role: "internal",
      title: "Chat Completions structured output contract",
      content: `Return exactly one JSON object matching this schema and no surrounding prose or markdown:\n${schemaJson}`,
    },
  };
}

function nativeCodexTitleStructuredOutput() {
  return normalizeStructuredOutput({
    type: "json_schema",
    json_schema: {
      name: "task_title",
      strict: true,
      schema: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 36 },
          description: { type: "string", maxLength: 100 },
        },
        required: ["title", "description"],
        additionalProperties: false,
      },
    },
  });
}

function nativeCodexTaskSuggestionsStructuredOutput() {
  const properties = {
    title: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    prompt: { type: "string", minLength: 1 },
    appId: { type: "string" },
  };
  return normalizeStructuredOutput({
    type: "json_schema",
    json_schema: {
      name: "task_suggestions",
      strict: true,
      schema: {
        type: "object",
        properties: {
          suggestions: {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              properties,
              required: Object.keys(properties),
              additionalProperties: false,
            },
          },
        },
        required: ["suggestions"],
        additionalProperties: false,
      },
    },
  });
}

function normalizeNativeCodexHelperOutput(kind, value) {
  const text = String(value || "").trim();
  const parsed = parseJsonObject(text);
  if (kind === "task_suggestions") {
    const suggestions = Array.isArray(parsed?.suggestions)
      ? parsed.suggestions.slice(0, 3).flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const normalized = {
          title: compactHelperText(entry.title, 200),
          description: compactHelperText(entry.description, 500),
          prompt: compactHelperText(entry.prompt, 2000),
          appId: compactHelperText(entry.appId, 200),
        };
        return normalized.title && normalized.description && normalized.prompt ? [normalized] : [];
      })
      : [];
    return JSON.stringify({ suggestions });
  }

  const parsedTitle = compactHelperText(parsed?.title, 36);
  const parsedDescription = compactHelperText(parsed?.description, 100);
  if (parsedTitle || parsedDescription) {
    return JSON.stringify({
      title: parsedTitle || parsedDescription,
      description: parsedDescription || parsedTitle,
    });
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const titleLine = lines.find((line) => /^(?:title|标题)\s*[:：]/i.test(line));
  const descriptionLine = lines.find((line) => /^(?:description|描述|摘要)\s*[:：]/i.test(line));
  const unlabeled = lines.filter((line) => !/^(?:title|标题|description|描述|摘要)\s*[:：]/i.test(line));
  const title = compactHelperText(
    titleLine?.replace(/^(?:title|标题)\s*[:：]\s*/i, "") || unlabeled[0] || text,
    36,
  );
  const description = compactHelperText(
    descriptionLine?.replace(/^(?:description|描述|摘要)\s*[:：]\s*/i, "")
      || unlabeled.slice(title ? 1 : 0).join(" ")
      || title,
    100,
  );
  return JSON.stringify({ title, description });
}

function parseJsonObject(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  for (const candidate of [text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    if (!candidate || !candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function compactHelperText(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().replace(/^["'`]+|["'`]+$/g, "");
  return [...text].slice(0, maxLength).join("");
}

function prepareRestartContinuation(body, messages, model, tools, nativeCustomInstructions, conversationKey = "") {
  const systemSections = [];
  const trustedNativeInstructions = addNativeCustomInstructions(systemSections, nativeCustomInstructions);
  const history = [];
  for (const message of messages) {
    const role = String(message?.role ?? "").toLowerCase();
    if (role === "system" || role === "developer") {
      const content = messageText(message?.content, { allowEmpty: true });
      if (content) systemSections.push({
        kind: "instructions",
        role,
        title: role === "developer" ? "Codex developer instructions" : "Codex system instructions",
        content,
      });
      continue;
    }
    const historyMessage = stripExactNativeCustomInstructions(message, trustedNativeInstructions);
    if (historyMessage) history.push(normalizeHistoryMessage(historyMessage));
  }
  systemSections.push({
    kind: "tool_restart_continuation",
    role: "internal",
    title: "Chat tool continuation after local adapter restart",
    content: "The supplied Chat transcript ends with completed tool results. Continue with the next assistant response. A tool call whose completed result is already present must not be requested again solely to reproduce that result.",
  });
  systemSections.push({
    kind: "chat_history",
    role: "internal",
    title: "Prior Chat Completions messages",
    contentTrust: "untrusted_transcript",
    messages: history,
  });
  const effectiveKey = String(conversationKey || "").trim();
  return {
    kind: "start",
    model,
    userText: "Continue the Chat Completions turn after the completed tool results in the supplied transcript.",
    systemSections,
    tools,
    registeredToolNames: toolNameSet(tools),
    hasToolBridge: tools.length > 0,
    conversationKey: effectiveKey,
    baseSignatures: effectiveKey ? history.map(messageSignature) : null,
    reason: "new_tools_detected",
    toolChoice: normalizeToolChoice(body.tool_choice),
    parallelToolCalls: body.parallel_tool_calls !== false,
    reasoningEffort: String(body.reasoning_effort ?? body.reasoning?.effort ?? "").trim(),
  };
}

function addNativeCustomInstructions(systemSections, value, include = true) {
  const content = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (content && include) systemSections.push({
    kind: "native_custom_instructions",
    role: "user",
    title: "Codex native custom instructions (AGENTS.md)",
    content,
  });
  return content;
}

function stripExactNativeCustomInstructions(message, content) {
  if (!content || String(message?.role ?? "").toLowerCase() !== "user") return message;
  if (Array.isArray(message.content) && message.content.some((part) => !["text", "input_text"].includes(part?.type ?? "text"))) return message;
  const text = messageText(message?.content, { allowEmpty: true }).replace(/\r\n?/g, "\n");
  const wrapper = `# AGENTS.md instructions\n\n<INSTRUCTIONS>\n${content}\n</INSTRUCTIONS>`;
  if (text === wrapper) return null;
  const joinedPrefix = `${wrapper}\n`;
  return text.startsWith(joinedPrefix) ? { ...message, content: text.slice(joinedPrefix.length) } : message;
}

function completeToolResultSet(callIds, results) {
  const expected = new Set(callIds);
  return expected.size === results.size && [...expected].every((id) => results.has(id));
}

function trailingToolContinuation(messages) {
  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (String(message?.role ?? "").toLowerCase() === "assistant"
        && Array.isArray(message?.tool_calls)
        && message.tool_calls.length > 0) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return null;
  const tail = messages.slice(assistantIndex + 1);
  if (!tail.length || tail.some((message) => String(message?.role ?? "").toLowerCase() !== "tool")) {
    return null;
  }
  const callIds = messages[assistantIndex].tool_calls.map((call) => String(call?.id ?? "").trim());
  if (callIds.some((id) => !id) || new Set(callIds).size !== callIds.length) {
    throw invalidRequest("Assistant tool calls require unique IDs.", "invalid_tool_call_ids");
  }
  const results = new Map();
  for (const message of tail) {
    const callId = String(message?.tool_call_id ?? "").trim();
    if (!callId || results.has(callId)) {
      throw invalidRequest("Tool results require unique tool_call_id values.", "invalid_tool_results");
    }
    results.set(callId, normalizeToolResultContent(message.content));
  }
  return { callIds, results };
}

function normalizeHistoryMessage(message) {
  const role = String(message?.role ?? "").toLowerCase();
  if (!role) throw invalidRequest("Every message requires a role.");
  const historyContent = role === "tool"
    ? { value: normalizeToolResultContent(message?.content), hasImage: false }
    : normalizeUserContent(message?.content, { allowEmpty: true });
  const normalized = {
    role,
    content: historyContent.hasImage ? historyContent.parts : historyContent.value ?? historyContent.text,
  };
  if (role === "assistant" && Array.isArray(message?.tool_calls)) {
    normalized.tool_calls = message.tool_calls.map((call) => ({
      id: String(call?.id ?? ""),
      type: "function",
      function: {
        name: String(call?.function?.name ?? ""),
        arguments: String(call?.function?.arguments ?? "{}"),
      },
    }));
  }
  if (role === "tool") normalized.tool_call_id = String(message?.tool_call_id ?? "");
  return normalized;
}

function normalizeToolResultContent(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw invalidRequest("Tool result content must be text or text/image parts.", "unsupported_tool_result_content");
  }
  return content.map((part) => {
    const type = String(part?.type ?? "");
    if (type === "text" || type === "input_text") {
      return { type: "text", text: String(part?.text ?? "") };
    }
    if (type === "image_url") {
      const source = typeof part?.image_url === "string" ? part.image_url : part?.image_url?.url;
      const url = String(source ?? "");
      if (!/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+$/i.test(url)) {
        throw invalidRequest(
          "Tool result image_url must be a base64 data image.",
          "unsupported_tool_result_image",
        );
      }
      return {
        type: "image_url",
        image_url: {
          url,
          ...(part?.image_url?.detail ? { detail: String(part.image_url.detail) } : {}),
        },
      };
    }
    throw invalidRequest(`Unsupported tool result content part: ${type || "missing"}`, "unsupported_tool_result_content");
  });
}

function messageText(content, options = {}) {
  if (content === null || content === undefined) {
    if (options.allowEmpty) return "";
    throw invalidRequest("Message content must contain text.", "unsupported_message_content");
  }
  if (typeof content === "string") {
    if (content || options.allowEmpty) return content;
    throw invalidRequest("Message content must contain text.", "unsupported_message_content");
  }
  if (!Array.isArray(content)) {
    throw invalidRequest("Only textual Chat message content is supported.", "unsupported_message_content");
  }
  const text = content.map((part) => {
    const type = String(part?.type ?? "text");
    if (type !== "text" && type !== "input_text") {
      throw invalidRequest(`Unsupported Chat content part: ${type}`, "unsupported_message_content");
    }
    return String(part?.text ?? "");
  }).join("");
  if (text || options.allowEmpty) return text;
  throw invalidRequest("Message content must contain text.", "unsupported_message_content");
}

function normalizeUserContent(content, options = {}) {
  if (typeof content === "string") {
    if (content || options.allowEmpty) return {
      text: content,
      parts: content ? [{ type: "text", text: content }] : [],
      items: content ? [{ text: content }] : [],
      hasImage: false,
      value: content,
    };
    throw invalidRequest("Message content must contain text.", "unsupported_message_content");
  }
  if (content === null || content === undefined) {
    if (options.allowEmpty) return { text: "", parts: [], items: [], hasImage: false, value: "" };
    throw invalidRequest("Message content must contain text or an image.", "unsupported_message_content");
  }
  if (!Array.isArray(content)) throw invalidRequest("Only textual or image Chat message content is supported.", "unsupported_message_content");
  const parts = [];
  const items = [];
  let text = "";
  for (const part of content) {
    const type = String(part?.type ?? "text");
    if (type === "text" || type === "input_text") {
      const value = String(part?.text ?? "");
      text += value;
      if (value) {
        parts.push({ type: "text", text: value });
        items.push({ text: value });
      }
      continue;
    }
    if (type === "image_url" || type === "input_image") {
      const image = normalizeImagePart(part);
      parts.push(image.chatPart);
      items.push(image.cascadeItem);
      continue;
    }
    throw invalidRequest(`Unsupported Chat content part: ${type}`, "unsupported_message_content");
  }
  if (!parts.length && !options.allowEmpty) throw invalidRequest("Message content must contain text or an image.", "unsupported_message_content");
  return { text, parts, items, hasImage: parts.some((part) => part.type === "image_url"), value: text };
}

function normalizeImagePart(part) {
  const source = typeof part?.image_url === "string"
    ? part.image_url
    : part?.image_url?.url ?? part?.url;
  const match = String(source ?? "").match(/^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) throw invalidRequest("Image content must be a base64 data image.", "unsupported_message_image");
  const data = match[2].replace(/\s+/g, "");
  const mimeType = match[1].toLowerCase();
  return {
    chatPart: { type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } },
    cascadeItem: { image: { data, mimeType } },
  };
}

function normalizeChatTools(tools, toolChoice) {
  if (toolChoice === "none") return [];
  const input = tools === undefined ? [] : tools;
  if (!Array.isArray(input)) throw invalidRequest("tools must be an array.", "invalid_tools");
  const names = new Set();
  const normalized = input.map((tool) => {
    if (tool?.type !== "function" || !tool.function || typeof tool.function !== "object") {
      throw invalidRequest("Only function tools are supported.", "unsupported_tool_type");
    }
    const name = normalizeReturnedToolName(tool.function.name);
    if (!name || names.has(name)) throw invalidRequest("Tool names must be non-empty and unique.", "invalid_tools");
    names.add(name);
    return {
      type: "function",
      function: {
        name,
        description: String(tool.function.description ?? ""),
        parameters: tool.function.parameters && typeof tool.function.parameters === "object"
          ? tool.function.parameters
          : { type: "object", properties: {}, additionalProperties: true },
      },
    };
  });
  const forced = typeof toolChoice === "object"
    ? String(toolChoice?.function?.name ?? "").trim()
    : "";
  if (forced) {
    const match = normalized.find((tool) => tool.function.name === forced);
    if (!match) throw invalidRequest(`Forced tool is not defined: ${forced}`, "invalid_tool_choice");
    return [match];
  }
  if (toolChoice === "required") {
    throw invalidRequest("Antigravity does not expose a protocol-level required tool mode.", "unsupported_tool_choice");
  }
  return normalized;
}

function normalizeToolChoice(value) {
  if (value === undefined || value === null || value === "auto") return "auto";
  if (value === "none") return "none";
  if (typeof value === "object") return { type: "function", function: { name: String(value?.function?.name ?? "") } };
  return String(value);
}

function chunk(base, delta, finishReason, usage) {
  return {
    ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

function invalidRequest(message, code = "invalid_request") {
  return new ChatAdapterError(message, { statusCode: 400, code, type: "invalid_request_error" });
}

export function mapAntigravityError(error) {
  return mapAntigravityProviderError(error, ChatAdapterError);
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

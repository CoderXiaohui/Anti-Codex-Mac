export const MAX_CHAT_BODY_BYTES = 128 * 1024 * 1024;
export const MAX_NATIVE_MCP_BODY_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TOOL_CONTINUATION_TIMEOUT_MS = 15 * 60 * 1000;

export function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  const selected = Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(selected, maximum);
}

export function extractConversationKey(headers) {
  for (const name of ["thread-id", "session-id", "x-opencode-session"]) {
    const raw = headers?.[name];
    const value = String(Array.isArray(raw) ? raw[0] : (raw ?? "")).trim();
    if (value && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)) {
      return value;
    }
  }
  return "";
}

export function toolNameSet(tools = []) {
  return new Set(
    (tools ?? [])
      .map((tool) => String(tool?.function?.name ?? tool?.name ?? "").trim())
      .filter(Boolean),
  );
}

export function hasUnregisteredTools(registeredToolNames, requestedTools) {
  if (!Array.isArray(requestedTools) || requestedTools.length === 0) return false;
  if (!(registeredToolNames instanceof Set)) return true;
  for (const tool of requestedTools) {
    const name = String(tool?.function?.name ?? tool?.name ?? "").trim();
    if (name && !registeredToolNames.has(name)) return true;
  }
  return false;
}

export function messageSignature(message) {
  try {
    return JSON.stringify(message);
  } catch {
    return `${String(message?.role ?? "")}:${String(message?.content ?? "")}`;
  }
}

function historyMessageToUserItems(message) {
  const content = message?.content;
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (part?.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/iu.exec(String(url ?? ""));
      return match ? [{ image: { mimeType: match[1], data: match[2].replace(/\s/g, "") } }] : [];
    }
    const text = String(part?.text ?? "");
    return text ? [{ text }] : [];
  });
}

export function matchFollowUpConversation(existingConversation, { tools, history, userItems, structuredOutput }) {
  if (!existingConversation?.continuation || structuredOutput) return null;
  if (tools.length > 0 && !existingConversation.hasToolBridge) return null;
  if (hasUnregisteredTools(existingConversation.registeredToolNames, tools)) return null;

  const base = existingConversation.baseSignatures;
  if (!Array.isArray(base) || base.length === 0 || history.length <= base.length) return null;
  for (let index = 0; index < base.length; index += 1) {
    if (messageSignature(history[index]) !== base[index]) return null;
  }

  const delta = history.slice(base.length);
  let lastModelStepIndex = -1;
  let sawAssistant = false;
  for (let index = 0; index < delta.length; index += 1) {
    const role = String(delta[index]?.role ?? "").toLowerCase();
    if (role === "assistant") {
      sawAssistant = true;
      lastModelStepIndex = index;
    } else if (role === "tool") {
      lastModelStepIndex = index;
    }
  }
  if (!sawAssistant) return null;

  for (let index = 0; index <= lastModelStepIndex; index += 1) {
    const role = String(delta[index]?.role ?? "").toLowerCase();
    if (role !== "assistant" && role !== "tool") return null;
  }

  const leadingUserItems = delta
    .slice(lastModelStepIndex + 1)
    .flatMap(historyMessageToUserItems);
  return [...leadingUserItems, ...(userItems ?? [])];
}

function serializeHistoryMessage(message) {
  return JSON.stringify(message, (_key, value) => {
    const dataImage = typeof value === "string"
      ? /^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,/iu.exec(value)
      : null;
    return dataImage ? `[historical image attached as media: ${dataImage[1].toLowerCase()}]` : value;
  });
}

export function estimatePromptTokens(text) {
  const source = String(text ?? "");
  if (!source) return 0;
  let tokens = 0;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code > 0x7f) tokens += 1.15;
    else if (code === 0x5c || code === 0x22 || code === 0x7b || code === 0x7d || code === 0x5b || code === 0x5d) tokens += 0.65;
    else tokens += 0.38;
  }
  return Math.ceil(tokens);
}

function truncateTextMiddle(text, headChars, tailChars, label = "historical output") {
  const source = String(text ?? "");
  const minLimit = Math.max(128, headChars + tailChars + 96);
  if (source.length <= minLimit) return source;
  const omitted = source.length - headChars - tailChars;
  return `${source.slice(0, headChars)}\n...[truncated ${omitted} chars of ${label} to fit model context budget]...\n${source.slice(source.length - tailChars)}`;
}

function compactSingleHistoryMessage(message, headChars, tailChars) {
  if (!message || typeof message !== "object") return message;
  if (typeof message.content === "string") {
    const compacted = truncateTextMiddle(message.content, headChars, tailChars);
    return compacted === message.content ? message : { ...message, content: compacted };
  }
  if (Array.isArray(message.content)) {
    let changed = false;
    const nextContent = message.content.map((part) => {
      if (typeof part?.text !== "string") return part;
      const compacted = truncateTextMiddle(part.text, headChars, tailChars);
      if (compacted === part.text) return part;
      changed = true;
      return { ...part, text: compacted };
    });
    return changed ? { ...message, content: compactedContent(nextContent) } : message;
  }
  return message;
}

function compactedContent(value) {
  return value;
}

function compactChatHistoryMessages(messages = [], maxHistoryTokens) {
  const rawLines = messages.map(serializeHistoryMessage);
  const totalRawTokens = rawLines.reduce((sum, line) => sum + estimatePromptTokens(line) + 1, 0);
  if (totalRawTokens <= maxHistoryTokens) {
    return { retainedMessages: messages, content: rawLines.join("\n") };
  }

  const recentProtectedCount = Math.min(4, messages.length);
  const recentThresholdIndex = messages.length - recentProtectedCount;
  const singleCapChars = Math.max(512, Math.floor(maxHistoryTokens * 0.6));
  const pass1Messages = messages.map((msg, idx) => (
    idx < recentThresholdIndex
      ? compactSingleHistoryMessage(msg, 1400, 700)
      : compactSingleHistoryMessage(msg, Math.floor(singleCapChars * 0.65), Math.floor(singleCapChars * 0.25))
  ));
  const pass1Lines = pass1Messages.map(serializeHistoryMessage);
  const pass1Tokens = pass1Lines.reduce((sum, line) => sum + estimatePromptTokens(line) + 1, 0);
  if (pass1Tokens <= maxHistoryTokens) {
    return { retainedMessages: pass1Messages, content: pass1Lines.join("\n") };
  }

  const aggressiveCapChars = Math.max(256, Math.floor(maxHistoryTokens * 0.35));
  const candidates = pass1Messages.map((msg) => compactSingleHistoryMessage(
    msg,
    Math.floor(aggressiveCapChars * 0.65),
    Math.floor(aggressiveCapChars * 0.25),
  ));
  const candidateLines = candidates.map(serializeHistoryMessage);
  const candidateTokens = candidateLines.map((line) => estimatePromptTokens(line) + 1);

  const markerReserveTokens = 48;
  let remainingBudget = Math.max(128, maxHistoryTokens - markerReserveTokens);
  const keepHead = candidates.length > 1 && candidateTokens[0] <= Math.floor(remainingBudget * 0.25);
  if (keepHead) remainingBudget -= candidateTokens[0];

  const tailStartMin = keepHead ? 1 : 0;
  let tailStart = candidates.length;
  let usedTailTokens = 0;
  for (let index = candidates.length - 1; index >= tailStartMin; index -= 1) {
    if (usedTailTokens + candidateTokens[index] > remainingBudget && tailStart < candidates.length) {
      break;
    }
    if (usedTailTokens + candidateTokens[index] > remainingBudget) {
      const tightChars = Math.max(128, Math.floor(remainingBudget * 1.2));
      candidates[index] = compactSingleHistoryMessage(
        candidates[index],
        Math.floor(tightChars * 0.6),
        Math.floor(tightChars * 0.25),
      );
      candidateLines[index] = serializeHistoryMessage(candidates[index]);
      candidateTokens[index] = estimatePromptTokens(candidateLines[index]) + 1;
    }
    usedTailTokens += candidateTokens[index];
    tailStart = index;
  }

  while (tailStart < candidates.length - 1 && String(candidates[tailStart]?.role ?? "").toLowerCase() === "tool") {
    tailStart += 1;
  }

  const omittedCount = tailStart - (keepHead ? 1 : 0);
  const retainedMessages = [];
  const retainedLines = [];
  if (keepHead) {
    retainedMessages.push(candidates[0]);
    retainedLines.push(candidateLines[0]);
  }
  if (omittedCount > 0) {
    const notice = {
      role: "user",
      content: `[...${omittedCount} earlier messages omitted to fit model context budget...]`,
    };
    retainedMessages.push(notice);
    retainedLines.push(serializeHistoryMessage(notice));
  }
  for (let index = tailStart; index < candidates.length; index += 1) {
    retainedMessages.push(candidates[index]);
    retainedLines.push(candidateLines[index]);
  }
  return { retainedMessages, content: retainedLines.join("\n") };
}

export function renderBoundedSystemPromptSections(sections = [], budgetContext = null) {
  const maxMessageTokens = Number(budgetContext?.maxMessageTokens ?? 0);
  let maxHistoryTokens = Infinity;
  let maxTotalPromptTokens = Infinity;

  if (Number.isSafeInteger(maxMessageTokens) && maxMessageTokens > 0) {
    const rawOutput = Number(budgetContext?.model?.maxOutputTokens ?? 0);
    const outputReserve = Number.isSafeInteger(rawOutput) && rawOutput > 0
      ? Math.min(rawOutput, Math.floor(maxMessageTokens * 0.45))
      : Math.min(65_536, Math.floor(maxMessageTokens * 0.2));
    const availableInput = Math.max(2_048, maxMessageTokens - outputReserve);
    maxTotalPromptTokens = Math.max(1_024, Math.min(200_000, Math.floor(availableInput * 0.65)));
    const toolTokens = Math.min(
      Math.floor(maxTotalPromptTokens * 0.35),
      estimatePromptTokens(JSON.stringify(budgetContext?.tools ?? [])),
    );
    const nonHistoryTokens = sections
      .filter((section) => section?.kind !== "chat_history")
      .reduce((sum, section) => sum + estimatePromptTokens(section?.content), 0) + 1_024;
    maxHistoryTokens = Math.max(
      512,
      Math.min(150_000, maxTotalPromptTokens - toolTokens - Math.min(nonHistoryTokens, Math.floor(maxTotalPromptTokens * 0.45))),
    );
  }

  const rendered = sections.flatMap((section) => {
    let content = String(section?.content ?? "");
    if (section?.kind === "chat_history") {
      const messages = section.messages ?? [];
      if (Number.isFinite(maxHistoryTokens)) {
        const compacted = compactChatHistoryMessages(messages, maxHistoryTokens);
        section.retainedMessages = compacted.retainedMessages;
        content = compacted.content;
      } else {
        content = messages.map(serializeHistoryMessage).join("\n");
      }
    }
    if (!content) return [];
    return [{
      title: String(section?.title ?? "Codex instructions"),
      content,
      metadata: {
        isInternal: true,
        ...(section?.contentTrust ? { contentTrust: section.contentTrust } : {}),
      },
    }];
  });

  if (Number.isFinite(maxTotalPromptTokens)) {
    let currentTokens = rendered.reduce((sum, item) => sum + estimatePromptTokens(item.content), 0);
    if (currentTokens > maxTotalPromptTokens) {
      for (let index = rendered.length - 1; index >= 0 && currentTokens > maxTotalPromptTokens; index -= 1) {
        const item = rendered[index];
        const itemTokens = estimatePromptTokens(item.content);
        if (itemTokens <= 512) continue;
        const excess = currentTokens - maxTotalPromptTokens;
        const targetTokens = Math.max(512, itemTokens - excess - 64);
        const approxChars = Math.max(512, Math.floor(targetTokens * 1.8));
        item.content = truncateTextMiddle(
          item.content,
          Math.floor(approxChars * 0.65),
          Math.floor(approxChars * 0.25),
          "system instructions",
        );
        currentTokens = rendered.reduce((sum, entry) => sum + estimatePromptTokens(entry.content), 0);
      }
    }
  }
  return rendered;
}

export function createSessionStore({ client, maxSessions, ttlMs, setTimer, clearTimer, createError }) {
  const records = new Map();
  const byCallId = new Map();
  const conversations = new Map();
  let sequence = 0;

  function remove(record) {
    if (!record || !records.delete(record.id)) return false;
    clearTimer(record.timer);
    for (const call of record.calls) byCallId.delete(call.callId);
    return true;
  }

  async function cancel(record) {
    const shouldCancel = record?.state !== "completed";
    if (record?.state === "claimed") {
      record.replayDeferred?.reject(createError("The opaque Cascade continuation expired before completion.", {
        statusCode: 409,
        code: "cascade_session_expired",
      }));
    }
    if (!remove(record)) return;
    if (shouldCancel) await Promise.resolve(client.cancel?.(record.continuation)).catch(() => {});
  }

  async function cancelConversation(key) {
    const entry = conversations.get(key);
    if (!entry) return;
    conversations.delete(key);
    clearTimer(entry.timer);
    await Promise.resolve(client.cancel?.(entry.continuation)).catch(() => {});
  }

  function takeConversation(key) {
    const normalized = String(key ?? "").trim();
    if (!normalized) return null;
    const entry = conversations.get(normalized);
    if (!entry) return null;
    conversations.delete(normalized);
    clearTimer(entry.timer);
    return entry;
  }

  async function putConversation(key, continuation, metadata = {}) {
    const normalized = String(key ?? "").trim();
    if (!normalized || !continuation) return;
    const existing = conversations.get(normalized);
    if (existing) {
      conversations.delete(normalized);
      clearTimer(existing.timer);
      if (existing.continuation !== continuation) {
        await Promise.resolve(client.cancel?.(existing.continuation)).catch(() => {});
      }
    }
    while (conversations.size >= maxSessions) {
      const oldestKey = conversations.keys().next().value;
      if (oldestKey === undefined) break;
      await cancelConversation(oldestKey);
    }
    const entry = {
      key: normalized,
      continuation,
      registeredToolNames: metadata.registeredToolNames instanceof Set
        ? new Set(metadata.registeredToolNames)
        : new Set(),
      hasToolBridge: metadata.hasToolBridge === true,
      baseSignatures: Array.isArray(metadata.baseSignatures) ? [...metadata.baseSignatures] : [],
      timer: null,
    };
    entry.timer = setTimer(() => void cancelConversation(normalized), ttlMs);
    entry.timer?.unref?.();
    conversations.set(normalized, entry);
  }

  async function put(continuation, calls, options = {}) {
    for (const call of calls) {
      if (byCallId.has(call.callId)) {
        throw createError(`Duplicate pending tool call ID: ${call.callId}`, {
          statusCode: 409,
          code: "duplicate_tool_call_id",
        });
      }
    }
    const replacingRecord = options.replacingRecord || null;
    const activeRecords = () => [...records.values()]
      .filter((record) => record.state !== "completed" && record !== replacingRecord);
    while (activeRecords().length >= maxSessions) {
      await cancel(activeRecords()[0]);
    }
    const completedRecords = [...records.values()].filter((record) => record.state === "completed");
    while (completedRecords.length >= maxSessions) {
      remove(completedRecords.shift());
    }
    const record = {
      id: ++sequence,
      continuation,
      calls,
      registeredToolNames: options.registeredToolNames instanceof Set
        ? new Set(options.registeredToolNames)
        : new Set(),
      hasToolBridge: options.hasToolBridge === true,
      conversationKey: String(options.conversationKey ?? "").trim(),
      baseSignatures: Array.isArray(options.baseSignatures) ? [...options.baseSignatures] : null,
      timer: null,
      state: "pending",
      claimedResults: null,
      replayDeferred: null,
      replayEvents: null,
    };
    record.timer = setTimer(() => cancel(record), ttlMs);
    record.timer?.unref?.();
    records.set(record.id, record);
    for (const call of calls) byCallId.set(call.callId, record);
  }

  function peek(callIds) {
    return callIds.map((id) => byCallId.get(id)).find(Boolean) ?? null;
  }

  function claim(callIds, results, options = {}) {
    const record = callIds.map((id) => byCallId.get(id)).find(Boolean);
    if (!record) {
      if (options.allowMissing === true) return null;
      throw createError("The opaque Cascade continuation is missing or expired.", {
        statusCode: 409,
        code: "cascade_session_missing",
      });
    }
    const expected = new Set(record.calls.map((call) => call.callId));
    const supplied = new Set(results.keys());
    const complete = expected.size === supplied.size
      && [...expected].every((id) => supplied.has(id))
      && callIds.length === expected.size
      && callIds.every((id) => expected.has(id));
    if (!complete) {
      throw createError("Every pending tool call result from the same Cascade is required.", {
        statusCode: 409,
        code: "incomplete_tool_results",
      });
    }
    if (record.state === "pending") {
      record.state = "claimed";
      record.claimedResults = new Map(results);
      record.replayDeferred = createDeferred();
      record.replayDeferred.promise.catch(() => {});
      return { mode: "owner", record };
    }
    const sameResults = record.claimedResults instanceof Map
      && record.claimedResults.size === results.size
      && [...record.claimedResults].every(([id, value]) => toolResultEqual(results.get(id), value));
    if (!sameResults) {
      throw createError("The same tool call IDs were continued with different results.", {
        statusCode: 409,
        code: "conflicting_tool_results",
      });
    }
    return { mode: record.state === "completed" ? "replay" : "wait", record };
  }

  function complete(record, events) {
    if (!record || record.state !== "claimed" || !records.has(record.id)) return false;
    record.state = "completed";
    record.replayEvents = [...events];
    clearTimer(record.timer);
    record.timer = setTimer(() => remove(record), ttlMs);
    record.timer?.unref?.();
    record.replayDeferred.resolve(record.replayEvents);
    const completedRecords = [...records.values()].filter((item) => item.state === "completed");
    while (completedRecords.length > maxSessions) remove(completedRecords.shift());
    return true;
  }

  function fail(record, error) {
    if (!record || record.state !== "claimed" || !records.has(record.id)) return false;
    record.replayDeferred.reject(error);
    return remove(record);
  }

  async function* replay(record) {
    if (!record || !records.has(record.id)) {
      throw createError("The opaque Cascade continuation replay is missing or expired.", {
        statusCode: 409,
        code: "cascade_session_missing",
      });
    }
    const events = record.state === "completed"
      ? record.replayEvents
      : await record.replayDeferred.promise;
    for (const event of events || []) yield event;
  }

  async function close() {
    for (const record of [...records.values()]) {
      if (record.state === "completed") remove(record);
      else await cancel(record);
    }
    for (const key of [...conversations.keys()]) {
      await cancelConversation(key);
    }
  }

  return {
    put,
    peek,
    cancelRecord: cancel,
    takeConversation,
    putConversation,
    claim,
    complete,
    fail,
    replay,
    close,
    get size() {
      return [...records.values()].filter((record) => record.state !== "completed").length;
    },
    get conversationSize() {
      return conversations.size;
    },
  };
}

function toolResultEqual(left, right) {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const NATIVE_CODEX_TITLE_PROMPT_PREFIX = "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.";
const NATIVE_CODEX_TASK_SUGGESTIONS_PROMPT_PREFIX = "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project:";
export function isNativeCodexTitleRequest(userText, structuredOutput) {
  const text = String(userText || "");
  const promptPrefixMatches = text.startsWith(NATIVE_CODEX_TITLE_PROMPT_PREFIX)
    && /Do NOT respond to the user, answer questions, or attempt to solve the problem; just write a title/i.test(text);
  if (!promptPrefixMatches) return false;
  const currentPromptContractMatches = [
    "Generate a concise UI title (up to 36 characters) for this task.",
    "Fill the structured title field with plain text.",
    "Fill the structured description field with a compact, search-oriented summary (up to 100 characters).",
    "User prompt:",
  ].every((marker) => text.includes(marker));
  if (currentPromptContractMatches) return true;

  const properties = structuredOutput?.schema?.properties;
  return structuredOutput?.type === "json_schema"
    && properties && typeof properties === "object"
    && Object.hasOwn(properties, "title")
    && Object.hasOwn(properties, "description");
}

export function isNativeCodexTaskSuggestionsRequest(userText, structuredOutput) {
  const text = String(userText || "");
  const promptPrefixMatches = text.startsWith(NATIVE_CODEX_TASK_SUGGESTIONS_PROMPT_PREFIX)
    && /Return 0 to 3 fresh suggestions\./i.test(text);
  if (!promptPrefixMatches) return false;
  const currentPromptContractMatches = [
    "# Response format",
    "Each suggestion must include:",
    "- prompt: the user message to send",
    "- appId: the single most relevant app id",
    "- write the prompt as something that should launch as a new Codex task in this project",
  ].every((marker) => text.includes(marker));
  if (currentPromptContractMatches) return true;

  const suggestions = structuredOutput?.schema?.properties?.suggestions;
  const itemProperties = suggestions?.items?.properties;
  return structuredOutput?.type === "json_schema"
    && suggestions?.type === "array"
    && Number(suggestions?.maxItems) === 3
    && itemProperties && typeof itemProperties === "object"
    && ["title", "description", "prompt", "appId"].every((name) => Object.hasOwn(itemProperties, name));
}

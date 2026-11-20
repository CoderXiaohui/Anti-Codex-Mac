import { spawn as spawnChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateBridgeUrl } from "./antigravity-acp-mcp-stdio.mjs";

const DEFAULT_OPEN_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 300_000;
const DEFAULT_PERMISSION_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;
const DEFAULT_CANCEL_GRACE_MS = 5_000;
const CLIENT_INFO = Object.freeze({ name: "anti-codex-acp-client", version: "1.0.0" });
const MCP_NAME = "anticodex";
const STDIO_MCP_SCRIPT = fileURLToPath(new URL("./antigravity-acp-mcp-stdio.mjs", import.meta.url));
const EXCLUDED_ACP_ENV_NAMES = new Set([
  "ANTICODEX_ACP_MCP_URL", "UPSTREAM_API_KEY",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI", "AGY_ADC_AUTH",
  "GOOGLE_CLOUD_ACCESS_TOKEN", "CLOUDSDK_AUTH_ACCESS_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY", "COHERE_API_KEY", "GROQ_API_KEY",
  "TOGETHER_API_KEY", "FIREWORKS_API_KEY", "CEREBRAS_API_KEY", "SAMBANOVA_API_KEY", "PERPLEXITY_API_KEY",
  "NVIDIA_API_KEY", "VOYAGE_API_KEY", "AI21_API_KEY", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_KEY",
  "HUGGINGFACEHUB_API_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HF_TOKEN", "REPLICATE_API_KEY", "REPLICATE_API_TOKEN",
  "FAL_API_KEY", "FAL_KEY", "RUNPOD_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_DEFAULT_PROFILE",
]);

export function resolveAntigravityAcpExecutable(env = process.env) {
  const candidates = [];
  if (process.platform === "win32") {
    if (typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim()) {
      candidates.push(join(env.LOCALAPPDATA, "agy", "bin", "agy.exe"));
    }
    if (typeof env.USERPROFILE === "string" && env.USERPROFILE.trim()) {
      candidates.push(join(env.USERPROFILE, "AppData", "Local", "agy", "bin", "agy.exe"));
    }
  } else if (typeof env.HOME === "string" && env.HOME.trim()) {
    candidates.push(join(env.HOME, ".local", "bin", "agy"));
  }

  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || !isRegularFile(candidate)) continue;
    return resolve(candidate);
  }
  return null;
}

export function createAntigravityAcpClient(options = {}) {
  const spawn = typeof options.spawn === "function" ? options.spawn : spawnChildProcess;
  const executablePath = options.executablePath ?? resolveAntigravityAcpExecutable(options.env ?? process.env);
  const openTimeoutMs = positiveTimeout(options.openTimeoutMs, DEFAULT_OPEN_TIMEOUT_MS);
  const requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const promptTimeoutMs = positiveTimeout(options.promptTimeoutMs, DEFAULT_PROMPT_TIMEOUT_MS);
  const permissionTimeoutMs = positiveTimeout(options.permissionTimeoutMs, DEFAULT_PERMISSION_TIMEOUT_MS);
  const closeTimeoutMs = positiveTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
  const cancelGraceMs = positiveTimeout(options.cancelGraceMs, DEFAULT_CANCEL_GRACE_MS);

  return Object.freeze({
    async open({
      cwd,
      model,
      geminiDir,
      signal,
      systemInstructions,
      toolServerUrl,
      agentName,
      onPermissionRequest,
    } = {}) {
      if (!isAbsolute(executablePath ?? "")) {
        throw new Error("Antigravity CLI executable was not found at its official install path.");
      }
      if (typeof cwd !== "string" || !cwd.trim() || !isAbsolute(cwd)) {
        throw new TypeError("cwd must be an absolute path.");
      }
      if (typeof model !== "string" || !model.trim()) {
        throw new TypeError("An exact Antigravity model identifier is required.");
      }
      if (geminiDir !== undefined && (typeof geminiDir !== "string" || !isAbsolute(geminiDir))) {
        throw new TypeError("geminiDir must be an absolute path.");
      }
      if (systemInstructions !== undefined && typeof systemInstructions !== "string") {
        throw new TypeError("systemInstructions must be a string.");
      }
      if (onPermissionRequest !== undefined && typeof onPermissionRequest !== "function") {
        throw new TypeError("onPermissionRequest must be a function.");
      }

      const mcpServer = toolServerUrl === undefined ? null : createFixedMcpServer(toolServerUrl);
      const safeAgentName = validateAgentName(agentName);
      if (signal?.aborted) throw createAbortError();

      const args = ["acp"];
      if (geminiDir) args.push("--gemini-dir", resolve(geminiDir));
      args.push("--sandbox");
      if (safeAgentName) args.push("--agent", safeAgentName);

      let child;
      try {
        child = spawn(executablePath, args, {
          cwd: resolve(cwd),
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
          env: createAcpEnvironment(options.env ?? process.env),
        });
      } catch (error) {
        throw asError(error, "Failed to start Antigravity ACP.");
      }

      const transport = createJsonRpcTransport(child, {
        requestTimeoutMs,
        promptTimeoutMs,
        permissionTimeoutMs,
        closeTimeoutMs,
        cancelGraceMs,
        onPermissionRequest,
      });

      let sessionId = null;
      let agentCapabilities = {};
      try {
        const initialize = await withAbort(
          transport.request("initialize", {
            protocolVersion: 1,
            clientInfo: CLIENT_INFO,
            clientCapabilities: {},
          }, { timeoutMs: openTimeoutMs }),
          signal,
          () => transport.forceClose(createAbortError()),
        );
        if (initialize?.protocolVersion !== 1) {
          throw new Error("Antigravity ACP did not negotiate protocol version 1.");
        }
        agentCapabilities = initialize.agentCapabilities ?? {};
        transport.setAgentCapabilities(agentCapabilities);

        const instructions = systemInstructions?.trim() ? systemInstructions : undefined;
        if (instructions && !supportsAntigravitySystemPromptAppend(agentCapabilities)) {
          throw new Error("Antigravity ACP did not advertise systemPrompt.append support.");
        }

        const sessionParams = {
          cwd: resolve(cwd),
          mcpServers: mcpServer ? [mcpServer] : [],
        };
        const antigravityMeta = {};
        if (instructions) {
          antigravityMeta.systemPrompt = { append: instructions };
        }
        if (mcpServer) {
          antigravityMeta.eagerMcpServers = [MCP_NAME];
        }
        if (Object.keys(antigravityMeta).length > 0) {
          sessionParams._meta = {
            antigravity: antigravityMeta,
          };
        }

        const sessionResult = await withAbort(
          transport.request("session/new", sessionParams, { timeoutMs: openTimeoutMs }),
          signal,
          () => transport.forceClose(createAbortError()),
        );
        if (typeof sessionResult?.sessionId !== "string" || !sessionResult.sessionId) {
          throw new Error("Antigravity ACP session/new returned no sessionId.");
        }
        sessionId = sessionResult.sessionId;
        transport.setSessionId(sessionId);

        await selectExactModel({
          transport,
          sessionId,
          model,
          configOptions: sessionResult.configOptions,
          signal,
          openTimeoutMs,
        });

        let closePromise;
        const session = {
          sessionId,
          prompt: (promptOptions = {}) => transport.prompt(sessionId, promptOptions),
          keepAlive: () => transport.keepAlive(),
          close: () => {
            if (!closePromise) {
              closePromise = transport.closeSession({
                sessionId,
                canClose: supportsCapability(agentCapabilities.sessionCapabilities?.close),
              });
            }
            return closePromise;
          },
        };
        return Object.freeze(session);
      } catch (error) {
        await transport.closeSession({
          sessionId,
          canClose: supportsCapability(agentCapabilities.sessionCapabilities?.close),
        });
        throw error;
      }
    },
  });
}

function createJsonRpcTransport(child, options) {
  const pending = new Map();
  const pendingPermissions = new Map();
  let nextRequestId = 1;
  let stdoutBuffer = "";
  let closed = false;
  let closing = false;
  let closePromise;
  let closeReason = null;
  let processExited = false;
  let sessionId = null;
  let agentCapabilities = {};
  let activePrompt = null;
  let resolveExit;
  const exitPromise = new Promise((resolveExitPromise) => {
    resolveExit = resolveExitPromise;
  });

  const markClosed = (reason) => {
    if (closed) return;
    closed = true;
    closeReason = asError(reason, "Antigravity ACP process closed.");
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.onFailure?.(closeReason);
      if (!entry.settled) {
        entry.settled = true;
        entry.reject(closeReason);
      }
    }
    for (const [id, permission] of pendingPermissions) {
      clearTimeout(permission.timer);
      pendingPermissions.delete(id);
    }
  };

  const finishProcessExit = (code, signal) => {
    if (processExited) return;
    processExited = true;
    resolveExit({ code, signal });
    markClosed(new Error(`Antigravity ACP process exited (${signal || (code ?? "unknown")}).`));
  };

  const write = (message) => {
    if (closed || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      throw closeReason ?? new Error("Antigravity ACP stdin is closed.");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const notify = (method, params) => {
    try {
      write({ jsonrpc: "2.0", method, params });
      return true;
    } catch {
      return false;
    }
  };

  const respond = (id, result) => write({ jsonrpc: "2.0", id, result });

  const respondError = (id, code, message) => write({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  const request = (method, params, requestOptions = {}) => new Promise((resolve, reject) => {
    if (closed) {
      reject(closeReason ?? new Error("Antigravity ACP process is closed."));
      return;
    }
    const id = nextRequestId++;
    const entry = {
      resolve,
      reject,
      settled: false,
      onResponse: requestOptions.onResponse,
      onFailure: requestOptions.onFailure,
      onTimeout: requestOptions.onTimeout,
      timer: null,
    };
    const timeoutMs = positiveTimeout(requestOptions.timeoutMs, options.requestTimeoutMs);
    const onTimer = () => {
      if (pending.get(id) !== entry) return;
      pending.delete(id);
      const error = new Error(`Antigravity ACP ${method} timed out after ${timeoutMs}ms.`);
      entry.onTimeout?.(error);
      entry.onFailure?.(error);
      if (!entry.settled) {
        entry.settled = true;
        reject(error);
      }
    };
    entry.timer = setTimeout(onTimer, timeoutMs);
    // A prompt can legitimately run for a long time (several tool calls, approvals), so callers
    // can restart the timer whenever the agent shows progress.
    requestOptions.onStart?.(() => {
      if (pending.get(id) !== entry) return;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(onTimer, timeoutMs);
    });
    pending.set(id, entry);
    try {
      write({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.onFailure?.(error);
      if (!entry.settled) {
        entry.settled = true;
        reject(error);
      }
    }
  });

  const settleResponse = (message) => {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      const error = new Error(message.error.message || "Antigravity ACP request failed.");
      error.code = message.error.code;
      error.data = message.error.data;
      const httpStatus = explicitHttpStatusFromRpcData(message.error.data);
      if (httpStatus !== null) error.acpHttpStatus = httpStatus;
      entry.onFailure?.(error);
      if (!entry.settled) {
        entry.settled = true;
        entry.reject(error);
      }
      return;
    }
    entry.onResponse?.(message.result);
    if (!entry.settled) {
      entry.settled = true;
      entry.resolve(message.result ?? {});
    }
  };

  const cancelPermission = (id, outcome = { outcome: "cancelled" }) => {
    const permission = pendingPermissions.get(id);
    if (!permission) return false;
    pendingPermissions.delete(id);
    clearTimeout(permission.timer);
    permission.respond(outcome);
    return true;
  };

  const cancelPermissionsForSession = (targetSessionId) => {
    for (const [id, permission] of pendingPermissions) {
      if (permission.sessionId === targetSessionId) cancelPermission(id);
    }
  };

  const cancelPrompt = (state, reason = createAbortError()) => {
    if (!state || state.done || state.cancelled) return;
    state.cancelled = true;
    notify("session/cancel", { sessionId: state.sessionId });
    cancelPermissionsForSession(state.sessionId);
    state.rejectLocal?.(reason);
    state.cancelTimer = setTimeout(() => {
      forceClose(new Error("Antigravity ACP did not acknowledge prompt cancellation."));
    }, options.cancelGraceMs);
  };

  const deliverCallback = (state, callback, ...args) => {
    if (typeof callback !== "function" || !state || state.cancelled || state.done) return;
    try {
      const result = callback(...args);
      if (result && typeof result.then === "function") {
        result.catch((error) => cancelPrompt(state, asError(error, "ACP callback failed.")));
      }
    } catch (error) {
      cancelPrompt(state, asError(error, "ACP callback failed."));
    }
  };

  const handlePermissionRequest = (message) => {
    const params = message.params ?? {};
    let responded = false;
    let timer = null;
    const respondOnce = (outcome) => {
      if (responded) return;
      responded = true;
      clearTimeout(timer);
      pendingPermissions.delete(message.id);
      try {
        respond(message.id, { outcome });
      } catch {
        // The process may have exited while an approval callback was open.
      }
    };

    if (!activePrompt || activePrompt.done || activePrompt.cancelled || params.sessionId !== sessionId || closed) {
      respondOnce({ outcome: "cancelled" });
      return;
    }

    const state = activePrompt?.sessionId === params.sessionId ? activePrompt : null;
    pendingPermissions.set(message.id, {
      sessionId: params.sessionId,
      respond: respondOnce,
      timer: null,
    });
    timer = setTimeout(() => respondOnce({ outcome: "cancelled" }), options.permissionTimeoutMs);
    pendingPermissions.get(message.id).timer = timer;

    const requestForCallback = {
      jsonrpc: message.jsonrpc,
      id: message.id,
      method: message.method,
      params: structuredClone(params),
    };
    Promise.resolve()
      .then(() => options.onPermissionRequest?.(requestForCallback) ?? "deny")
      .then((decision) => {
        if (responded) return;
        if (state?.cancelled || state?.done) {
          respondOnce({ outcome: "cancelled" });
          return;
        }
        const available = Array.isArray(params.options) ? params.options : [];
        const requestedOptionId = typeof decision === "string"
          ? decision
          : decision && typeof decision === "object" ? decision.optionId : null;
        if (decision === "allow-once" || typeof requestedOptionId === "string") {
          const option = available.find((candidate) => (
            candidate?.kind === "allow_once"
            && typeof candidate.optionId === "string"
            && (decision === "allow-once" || candidate.optionId === requestedOptionId)
          ));
          respondOnce(option
            ? { outcome: "selected", optionId: option.optionId }
            : chooseDenyOutcome(available));
          return;
        }
        respondOnce(chooseDenyOutcome(available));
      })
      .catch(() => {
        if (!responded) respondOnce(chooseDenyOutcome(params.options));
      });
  };

  const handleUpdate = (message) => {
    const params = message.params ?? {};
    if (params.sessionId !== sessionId) return;
    const update = params.update;
    if (!update || typeof update !== "object") return;
    const state = activePrompt?.sessionId === params.sessionId ? activePrompt : null;
    if (!state) return;
    // Any progress from the agent proves the turn is alive; restart its idle timer.
    state.touch?.();
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      deliverCallback(state, state.onText, update.content.text, update);
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      deliverCallback(state, state.onToolUpdate, update);
    }
  };

  const handleMessage = (message) => {
    if (!message || message.jsonrpc !== "2.0") {
      forceClose(new Error("Antigravity ACP sent an invalid JSON-RPC message."));
      return;
    }
    if (typeof message.method === "string") {
      if (message.method === "session/update") {
        handleUpdate(message);
      } else if (message.method === "session/request_permission" && message.id !== undefined) {
        handlePermissionRequest(message);
      } else if (message.id !== undefined) {
        try {
          respondError(message.id, -32601, "Client method is not available.");
        } catch (error) {
          forceClose(error);
        }
      }
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      settleResponse(message);
    }
  };

  const failPendingOnStreamError = (error) => forceClose(asError(error, "Antigravity ACP stream failed."));

  child.stdout?.setEncoding?.("utf8");
  child.stdout?.on("data", (chunk) => {
    stdoutBuffer += String(chunk);
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) {
        try {
          handleMessage(JSON.parse(line));
        } catch (error) {
          forceClose(asError(error, "Antigravity ACP returned invalid JSON."));
        }
      }
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stdout?.on("end", () => {
    const tail = stdoutBuffer.trim();
    stdoutBuffer = "";
    if (!tail) return;
    try {
      handleMessage(JSON.parse(tail));
    } catch (error) {
      forceClose(asError(error, "Antigravity ACP returned invalid JSON."));
    }
  });
  child.stdout?.on("error", failPendingOnStreamError);
  child.stdin?.on("error", failPendingOnStreamError);
  child.stderr?.resume?.();
  child.once("error", failPendingOnStreamError);
  child.once("exit", finishProcessExit);
  child.once("close", finishProcessExit);

  function forceClose(error = new Error("Antigravity ACP client closed.")) {
    if (!closed) {
      for (const id of pendingPermissions.keys()) cancelPermission(id);
      markClosed(error);
      try {
        child.kill?.("SIGTERM");
      } catch {}
    }
  }

  function setSessionId(value) {
    sessionId = value;
  }

  function setAgentCapabilities(value) {
    agentCapabilities = value ?? {};
  }

  async function closeSession({ sessionId: closingSessionId, canClose }) {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      if (activePrompt && !activePrompt.done) {
        cancelPrompt(activePrompt, new Error("Antigravity ACP session closed."));
      }
      cancelPermissionsForSession(closingSessionId);
      if (!closed && closingSessionId && canClose) {
        try {
          await request("session/close", { sessionId: closingSessionId }, { timeoutMs: options.closeTimeoutMs });
        } catch {}
      }
      if (!processExited && !closed) {
        try {
          child.stdin?.end?.();
        } catch {}
      }
      if (!processExited) {
        await Promise.race([exitPromise, sleep(options.closeTimeoutMs)]);
      }
      if (!processExited) {
        try {
          child.kill?.("SIGTERM");
        } catch {}
        await Promise.race([exitPromise, sleep(options.closeTimeoutMs)]);
      }
      if (!processExited) {
        try {
          child.kill?.("SIGKILL");
        } catch {}
        await Promise.race([exitPromise, sleep(options.closeTimeoutMs)]);
      }
      if (!closed) markClosed(new Error("Antigravity ACP session closed."));
    })();
    return closePromise;
  }

  function prompt(targetSessionId, { text, signal, onText, onToolUpdate } = {}) {
    if (closed || closing) return Promise.reject(closeReason ?? new Error("Antigravity ACP session is closed."));
    if (targetSessionId !== sessionId) return Promise.reject(new Error("Unknown Antigravity ACP sessionId."));
    if (activePrompt && !activePrompt.done) return Promise.reject(new Error("An Antigravity ACP prompt is already active."));
    if (signal?.aborted) return Promise.reject(createAbortError());
    const content = normalizePromptContent(text);

    let resolveCaller;
    let rejectCaller;
    const callerPromise = new Promise((resolve, reject) => {
      resolveCaller = resolve;
      rejectCaller = reject;
    });
    const state = {
      sessionId: targetSessionId,
      signal,
      onText,
      onToolUpdate,
      cancelled: false,
      done: false,
      localSettled: false,
      resolveLocal: (value) => {
        if (state.localSettled) return;
        state.localSettled = true;
        resolveCaller(value);
      },
      rejectLocal: (error) => {
        if (state.localSettled) return;
        state.localSettled = true;
        rejectCaller(error);
      },
      cancelTimer: null,
    };
    activePrompt = state;

    const requestPromise = request("session/prompt", {
      sessionId: targetSessionId,
      prompt: content,
    }, {
      timeoutMs: options.promptTimeoutMs,
      onStart: (touch) => { state.touch = touch; },
      onResponse: () => finishPrompt(state),
      onFailure: () => finishPrompt(state),
      onTimeout: (error) => {
        cancelPrompt(state, error);
        forceClose(error);
      },
    });
    requestPromise.then(
      (result) => state.resolveLocal(result),
      (error) => state.rejectLocal(error),
    );

    if (signal) {
      state.abortHandler = () => cancelPrompt(state, createAbortError());
      signal.addEventListener("abort", state.abortHandler, { once: true });
      if (signal.aborted) state.abortHandler();
    }
    return callerPromise;
  }

  function finishPrompt(state) {
    if (state.done) return;
    state.done = true;
    clearTimeout(state.cancelTimer);
    if (activePrompt === state) activePrompt = null;
    if (state.signal && state.abortHandler) state.signal.removeEventListener("abort", state.abortHandler);
  }

  return {
    request,
    prompt,
    keepAlive: () => { if (activePrompt && !activePrompt.done) activePrompt.touch?.(); },
    notify,
    setSessionId,
    setAgentCapabilities,
    closeSession,
    forceClose,
    get closed() { return closed; },
  };
}

function chooseDenyOutcome(options) {
  const reject = Array.isArray(options)
    ? options.find((option) => option?.kind === "reject_once" && typeof option.optionId === "string")
    : null;
  return reject
    ? { outcome: "selected", optionId: reject.optionId }
    : { outcome: "cancelled" };
}

function supportsAntigravitySystemPromptAppend(agentCapabilities) {
  return agentCapabilities?._meta?.antigravity?.systemPrompt?.append === true;
}

function supportsCapability(value) {
  return value === true || (value !== null && typeof value === "object");
}

function createFixedMcpServer(rawUrl) {
  const endpoint = validateBridgeUrl(rawUrl);
  return {
    name: MCP_NAME,
    command: process.execPath,
    args: [STDIO_MCP_SCRIPT],
    env: [{ name: "ANTICODEX_ACP_MCP_URL", value: endpoint }],
    _meta: { antigravity: { forceAllToolsEager: true } },
  };
}

async function selectExactModel({ transport, sessionId, model, configOptions, signal, openTimeoutMs }) {
  let options = Array.isArray(configOptions) ? configOptions : [];
  if (options.length === 0) {
    throw new Error("Antigravity ACP did not publish model configOptions.");
  }

  const modelOption = findConfigOption(options, (option) => option.id === "model" || option.category === "model");
  if (!modelOption) throw new Error("Antigravity ACP did not publish a model config option.");
  const direct = getSelectOptions(modelOption).find((option) => option.value === model);
  const parsed = parseModelEffort(model);
  if (direct) {
    options = await setConfigOptionIfNeeded({
      transport,
      sessionId,
      options,
      configOption: modelOption,
      value: direct.value,
      signal,
      openTimeoutMs,
    });
    return options;
  }

  if (!parsed) {
    throw modelUnavailableError(model);
  }
  const baseModel = getSelectOptions(modelOption).find((option) => option.value === parsed.base);
  if (!baseModel) {
    throw modelUnavailableError(model);
  }
  options = await setConfigOptionIfNeeded({
    transport,
    sessionId,
    options,
    configOption: modelOption,
    value: baseModel.value,
    signal,
    openTimeoutMs,
  });

  const effortOption = findConfigOption(options, (option) => (
    option.id === "thinking_level"
    || option.id === "thought_level"
    || option.id === "effort"
    || option.category === "thought_level"
  ));
  if (!effortOption) {
    throw new Error(`Antigravity ACP does not advertise the thinking level required by ${model}.`);
  }
  const requestedEffort = normalizeEffort(parsed.effort);
  const effort = getSelectOptions(effortOption).find((option) => (
    normalizeEffort(option.value) === requestedEffort
    || normalizeEffort(option.name) === requestedEffort
  ));
  if (!effort) {
    throw new Error(`Antigravity ACP does not advertise the thinking level required by ${model}.`);
  }
  return setConfigOptionIfNeeded({
    transport,
    sessionId,
    options,
    configOption: effortOption,
    value: effort.value,
    signal,
    openTimeoutMs,
  });
}

async function setConfigOptionIfNeeded({ transport, sessionId, options, configOption, value, signal, openTimeoutMs }) {
  if (configOption.currentValue === value) return options;
  const result = await withAbort(
    transport.request("session/set_config_option", {
      sessionId,
      configId: configOption.id,
      value,
    }, { timeoutMs: openTimeoutMs }),
    signal,
    () => transport.forceClose(createAbortError()),
  );
  const updated = Array.isArray(result?.configOptions) ? result.configOptions : null;
  const refreshedOption = updated?.find((option) => option.id === configOption.id);
  if (!refreshedOption || refreshedOption.currentValue !== value) {
    throw new Error(`Antigravity ACP did not confirm ${configOption.id}=${value}.`);
  }
  return updated;
}

function findConfigOption(configOptions, predicate) {
  return configOptions.find((option) => option && typeof option === "object" && predicate(option));
}

function getSelectOptions(configOption) {
  if (!Array.isArray(configOption?.options)) return [];
  const flattened = [];
  for (const option of configOption.options) {
    if (Array.isArray(option?.options)) flattened.push(...option.options);
    else if (option && typeof option === "object") flattened.push(option);
  }
  return flattened.filter((option) => typeof option.value === "string");
}

function parseModelEffort(model) {
  const match = /^(.*)-(low|medium|high|xhigh|max|extra)$/i.exec(model);
  if (!match || !match[1]) return null;
  return { base: match[1], effort: match[2] };
}

function normalizeEffort(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase().replace(/[\s_-]/g, "");
  return normalized === "extra" ? "xhigh" : normalized;
}

function modelUnavailableError(model) {
  // The signed-in account decides which models the CLI offers (a free account lacks the newer ones).
  const error = new Error(`The signed-in Antigravity account cannot use ${model}. Choose another model or switch accounts.`);
  error.statusCode = 400;
  error.code = "model_not_available";
  return error;
}

function explicitHttpStatusFromRpcData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const fieldNames = new Set([
    "httpstatus",
    "http_status",
    "httpstatuscode",
    "http_status_code",
    "statuscode",
    "status_code",
    "status",
  ]);
  const containers = [data, data.error, data.response, data.upstream]
    .filter((value) => value && typeof value === "object" && !Array.isArray(value));
  for (const container of containers) {
    for (const [name, rawValue] of Object.entries(container)) {
      const normalizedName = name.toLowerCase();
      if (!fieldNames.has(normalizedName)) continue;
      const value = typeof rawValue === "number"
        ? rawValue
        : normalizedName === "status"
          ? null
        : typeof rawValue === "string" && /^(429|502|503|504)$/u.test(rawValue.trim())
          ? Number(rawValue.trim())
          : null;
      if ([429, 502, 503, 504].includes(value)) return value;
    }
  }
  return null;
}

function normalizePromptContent(input) {
  if (typeof input === "string") return [{ type: "text", text: input }];
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError("prompt text must be a string or non-empty text/image content block array.");
  }
  const blocks = input.map((block) => {
    if (!block || typeof block !== "object") throw new TypeError("Invalid ACP prompt content block.");
    if (block.type === "text" && typeof block.text === "string") return structuredClone(block);
    if (block.type === "image"
      && typeof block.data === "string"
      && typeof block.mimeType === "string"
      && !("uri" in block)) return structuredClone(block);
    throw new TypeError("ACP prompt accepts only text blocks and embedded image blocks.");
  });
  return blocks;
}

function validateAgentName(agentName) {
  if (agentName === undefined || agentName === null || agentName === "") return null;
  if (typeof agentName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(agentName)) {
    throw new TypeError("agentName must be a simple trusted Antigravity agent name.");
  }
  return agentName;
}

function withAbort(promise, signal, onAbort) {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(createAbortError());
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const abort = () => {
      onAbort?.();
      rejectPromise(createAbortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        rejectPromise(error);
      },
    );
  });
}

function positiveTimeout(value, fallback) {
  const timeout = Number(value ?? fallback);
  if (!Number.isFinite(timeout) || timeout <= 0) return fallback;
  return Math.min(timeout, 2_147_483_647);
}

function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function createAcpEnvironment(sourceEnvironment) {
  const environment = { ...sourceEnvironment };
  for (const name of Object.keys(environment)) {
    if (EXCLUDED_ACP_ENV_NAMES.has(name.toUpperCase())) delete environment[name];
  }
  return environment;
}

function createAbortError() {
  const error = new Error("Antigravity ACP operation was aborted.");
  error.name = "AbortError";
  return error;
}

function asError(error, fallback) {
  return error instanceof Error ? error : new Error(fallback);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

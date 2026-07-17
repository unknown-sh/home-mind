import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { IMemoryStore } from "../memory/interface.js";
import type { IConversationStore } from "../memory/types.js";
import { HomeAssistantClient } from "../ha/client.js";
import { DeviceScanner } from "../ha/device-scanner.js";
import { TopologyScanner } from "../ha/topology-scanner.js";
import { buildSystemPromptText } from "./prompts.js";
import { TOOL_DEFINITIONS, toOpenAITools } from "./tool-definitions.js";
import { handleToolCall, extractAndStoreFacts } from "./tool-handler.js";
import {
  buildEnvironmentSnapshot,
  isEnvironmentReadQuery,
} from "./voice-fast-path.js";
import type {
  ChatRequest,
  ChatResponse,
  ChatError,
  StreamCallback,
  IChatEngine,
  IFactExtractor,
} from "./interface.js";

type FunctionToolCall = OpenAI.ChatCompletionMessageFunctionToolCall;

const OPENAI_TOOLS = toOpenAITools(TOOL_DEFINITIONS);

export class OpenAIChatEngine implements IChatEngine {
  private client: OpenAI;
  private memory: IMemoryStore;
  private conversations: IConversationStore;
  private extractor: IFactExtractor;
  private ha: HomeAssistantClient;
  private scanner: DeviceScanner;
  private topology: TopologyScanner;
  private config: Config;

  constructor(
    config: Config,
    memory: IMemoryStore,
    conversations: IConversationStore,
    extractor: IFactExtractor,
    ha: HomeAssistantClient,
    scanner: DeviceScanner,
    topology: TopologyScanner
  ) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl,
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/hoornet/home-mind",
        "X-Title": "Home Mind",
      },
    });
    this.memory = memory;
    this.conversations = conversations;
    this.extractor = extractor;
    this.ha = ha;
    this.scanner = scanner;
    this.topology = topology;
  }

  async chat(
    request: ChatRequest,
    onChunk?: StreamCallback
  ): Promise<ChatResponse> {
    const { message, userId, conversationId, isVoice = false, customPrompt } = request;
    const toolsUsed: string[] = [];
    const traceId = request.traceId ?? randomUUID();
    const chatStartedAt = performance.now();
    let phase = 0;
    let fastPath = "none";

    // 1. Load user's memory
    const facts = await this.memory.getFactsWithinTokenLimit(
      userId,
      this.config.memoryTokenLimit,
      message
    );
    const factContents = facts.map((f) => f.content);
    if (this.config.logLevel === "debug") {
      const approxTokens = Math.ceil(factContents.join(" ").length / 4);
      console.debug(
        `[recall] userId=${userId} factCount=${factContents.length} tokens=${approxTokens}`
      );
    }

    // 2. Refresh device profiles and home layout if stale, then build system prompt
    await Promise.all([this.scanner.refreshIfStale(), this.topology.refreshIfStale()]);
    const deviceCheatSheet = this.scanner.hasProfiles()
      ? this.scanner.formatCheatSheet()
      : undefined;
    const homeLayout = this.topology.hasLayout() ? this.topology.formatSection() : undefined;
    const systemPrompt = buildSystemPromptText(factContents, isVoice, customPrompt, deviceCheatSheet, homeLayout);

    // 3. Load conversation history
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    if (conversationId) {
      const history = await this.conversations.getConversationHistory(conversationId, 10);
      for (const msg of history) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // 4. For common current-environment voice questions, fetch the configured
    // authoritative states locally and let the model phrase one direct answer.
    let toolsEnabled = true;
    if (
      isVoice &&
      this.config.voiceEnvironmentEntityIds.length > 0 &&
      isEnvironmentReadQuery(message)
    ) {
      const prefetchStartedAt = performance.now();
      const prefetchController = new AbortController();
      const prefetchTimeout = setTimeout(
        () => prefetchController.abort(),
        this.config.voiceEnvironmentPrefetchTimeoutMs
      );
      const prefetched = await Promise.allSettled(
        this.config.voiceEnvironmentEntityIds.map((entityId) =>
          this.ha.getState(entityId, prefetchController.signal)
        )
      ).finally(() => clearTimeout(prefetchTimeout));
      const states = prefetched
        .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<HomeAssistantClient["getState"]>>> => result.status === "fulfilled")
        .map((result) => result.value);
      if (states.length === this.config.voiceEnvironmentEntityIds.length) {
        // Keep all system instructions ahead of persisted conversation history.
        // Some OpenAI-compatible providers reject or weaken system messages that
        // appear after assistant/user turns.
        messages.splice(1, 0, {
          role: "system",
          content: buildEnvironmentSnapshot(states),
        });
        toolsEnabled = false;
        fastPath = "environment_prefetch";
        toolsUsed.push("prefetch_environment");
      }
      this.logTelemetry({
        event: "home_mind_prefetch",
        trace_id: traceId,
        requested_entities: this.config.voiceEnvironmentEntityIds.length,
        fetched_entities: states.length,
        failed_entities: prefetched.length - states.length,
        duration_ms: Math.round(performance.now() - prefetchStartedAt),
        timed_out: prefetchController.signal.aborted,
      });
    }

    // 5. Add current user message
    messages.push({ role: "user", content: message });

    if (conversationId) {
      this.conversations.storeMessage(conversationId, userId, "user", message);
    }

    // 6. Stream and handle a bounded tool-call loop.
    let result = await this.streamCompletion(messages, isVoice, onChunk, {
      traceId,
      phase: ++phase,
      toolsEnabled,
    });
    let responseToolsEnabled = toolsEnabled;
    let toolRounds = 0;
    let toolLimitReached = false;

    while (result.finishReason === "tool_calls" && result.toolCalls.length > 0) {
      if (
        !responseToolsEnabled ||
        toolRounds >= this.config.openaiMaxToolRounds
      ) {
        toolLimitReached = true;
        this.logTelemetry({
          event: "home_mind_tool_limit",
          trace_id: traceId,
          phase,
          tool_rounds: toolRounds,
          rejected_tools: result.toolCalls.map(
            (toolCall) => toolCall.function.name
          ),
        });
        result = {
          // Never surface success-looking text that accompanied a rejected
          // mutation. A non-compliant provider may emit both content and a
          // tool call despite tool_choice:none.
          text: "",
          finishReason: "tool_limit",
          toolCalls: [],
        };
        break;
      }
      toolRounds += 1;
      // Add assistant message with tool calls
      messages.push({
        role: "assistant",
        content: result.text || null,
        tool_calls: result.toolCalls,
      });

      // Execute all tool calls in parallel
      const toolPromises = result.toolCalls.map(async (tc: FunctionToolCall) => {
        toolsUsed.push(tc.function.name);
        const args = JSON.parse(tc.function.arguments);
        const toolStartedAt = performance.now();
        const toolResult = await handleToolCall(this.ha, tc.function.name, args);
        const serialized = JSON.stringify(toolResult);
        this.logTelemetry({
          event: "home_mind_tool",
          trace_id: traceId,
          phase,
          tool: tc.function.name,
          duration_ms: Math.round(performance.now() - toolStartedAt),
          result_bytes: Buffer.byteLength(serialized),
        });
        return {
          role: "tool" as const,
          tool_call_id: tc.id,
          content: serialized,
        };
      });

      const toolResults = await Promise.all(toolPromises);
      messages.push(...toolResults);

      const mutationCompleted = result.toolCalls.some(
        (toolCall) => toolCall.function.name === "call_service"
      );
      const allowAnotherToolRound =
        !mutationCompleted &&
        toolRounds < this.config.openaiMaxToolRounds;

      result = await this.streamCompletion(messages, isVoice, onChunk, {
        traceId,
        phase: ++phase,
        toolsEnabled: allowAnotherToolRound,
      });
      responseToolsEnabled = allowAnotherToolRound;
    }

    const responseText = result.text;

    // 7. Store assistant response
    if (conversationId && responseText) {
      this.conversations.storeMessage(conversationId, userId, "assistant", responseText);
    }

    // 8. Extract and store facts (fire-and-forget)
    extractAndStoreFacts(
      this.memory,
      this.extractor,
      userId,
      message,
      responseText
    ).catch((err) => console.error("Fact extraction failed:", err));

    // 9. If the model produced no usable response, attach a structured error
    // so the HA integration can surface a useful hint instead of the generic
    // "I received your request but got no response." fallback. The `finish_reason`
    // from the final stream tells us which diagnostic applies.
    const error = toolLimitReached
      ? this.classifyEmptyResponse("tool_limit")
      : responseText === "" && result.toolCalls.length === 0
        ? this.classifyEmptyResponse(result.finishReason)
        : undefined;

    this.logTelemetry({
      event: "home_mind_chat",
      trace_id: traceId,
      duration_ms: Math.round(performance.now() - chatStartedAt),
      phases: phase,
      tool_rounds: toolRounds,
      tools: toolsUsed,
      fast_path: fastPath,
      voice: isVoice,
    });

    return {
      response: responseText,
      toolsUsed,
      factsLearned: 0,
      ...(error ? { error } : {}),
    };
  }

  private classifyEmptyResponse(finishReason: string | null): ChatError {
    if (finishReason === "length") {
      return {
        code: "MAX_TOKENS_TRUNCATED",
        hint:
          "Response was cut off at max_tokens before the model finished. " +
          "If you're seeing this often, the conversation prompt may be too large " +
          "for the model's output budget — try a model with more output tokens.",
      };
    }
    if (finishReason === "content_filter") {
      return {
        code: "CONTENT_FILTERED",
        hint:
          "The provider blocked the response (content filter). " +
          "If this happens on benign smart-home commands, try a different model.",
      };
    }
    if (finishReason === "tool_limit") {
      return {
        code: "TOOL_ROUND_LIMIT",
        hint:
          "The provider returned tool calls after tools were disabled or after the configured tool-round limit. No rejected tool calls were executed.",
      };
    }
    return {
      code: "EMPTY_CONTENT",
      hint:
        "The model returned no text and no tool calls. " +
        "If you're routing through an OpenAI-compatible shim/proxy, verify it streams " +
        "OpenAI-format SSE chunks. For local models, ensure the model emits a final " +
        "answer rather than just thinking. For the fact extractor specifically, set " +
        "OPENAI_RESPONSE_FORMAT=json_object on picky providers (e.g. some Ollama models).",
    };
  }

  private async streamCompletion(
    messages: OpenAI.ChatCompletionMessageParam[],
    isVoice: boolean,
    onChunk: StreamCallback | undefined,
    options: { traceId: string; phase: number; toolsEnabled: boolean }
  ): Promise<{
    text: string;
    finishReason: string | null;
    toolCalls: FunctionToolCall[];
  }> {
    const request: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.config.llmModel,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(isVoice
        ? this.config.llmProvider === "ollama"
          ? { max_tokens: this.config.openaiVoiceMaxTokens }
          : { max_completion_tokens: this.config.openaiVoiceMaxTokens }
        : { max_tokens: 2048 }),
      ...(options.toolsEnabled
        ? { tools: OPENAI_TOOLS }
        : { tool_choice: "none" as const }),
      ...(this.config.openaiServiceTier
        ? { service_tier: this.config.openaiServiceTier }
        : {}),
      ...(this.config.openaiReasoningEffort
        ? { reasoning_effort: this.config.openaiReasoningEffort }
        : {}),
    };
    const startedAt = performance.now();
    const pending = this.client.chat.completions.create(request);
    const response = typeof (pending as { withResponse?: unknown }).withResponse === "function"
      ? await (pending as unknown as { withResponse: () => Promise<{ data: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>; request_id?: string }> }).withResponse()
      : { data: await pending, request_id: undefined };
    const stream = response.data;
    const openaiBaseHostname = this.config.openaiBaseUrl
      ? new URL(this.config.openaiBaseUrl).hostname.toLowerCase()
      : undefined;
    const bufferToolDisabledOutput =
      !options.toolsEnabled &&
      (this.config.llmProvider === "ollama" ||
        (openaiBaseHostname !== undefined &&
          openaiBaseHostname !== "api.openai.com"));

    let text = "";
    let finishReason: string | null = null;
    let firstDeltaMs: number | undefined;
    let usage: OpenAI.CompletionUsage | undefined;
    const bufferedChunks: string[] = [];

    // Accumulate tool calls from streamed deltas, indexed by position
    const toolCallAccumulator = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices[0];
      if (!choice) continue;

      if (
        firstDeltaMs === undefined &&
        (choice.delta?.content || (choice.delta?.tool_calls?.length ?? 0) > 0)
      ) {
        firstDeltaMs = Math.round(performance.now() - startedAt);
      }

      // Accumulate text
      if (choice.delta?.content) {
        text += choice.delta.content;
        if (onChunk) {
          if (bufferToolDisabledOutput) {
            // A provider can ignore tool_choice:none and append a tool call
            // after success-looking text. Buffer enforcement phases until the
            // finish reason proves the text is safe to release.
            bufferedChunks.push(choice.delta.content);
          } else {
            onChunk(choice.delta.content);
          }
        }
      }

      // Accumulate tool call deltas
      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const existing = toolCallAccumulator.get(tc.index);
          if (existing) {
            // Append to existing tool call's arguments
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
            }
          } else {
            // New tool call at this index
            toolCallAccumulator.set(tc.index, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            });
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    // Convert accumulated tool calls to the expected format
    const toolCalls: FunctionToolCall[] = [];
    for (const [, tc] of [...toolCallAccumulator.entries()].sort(
      (a, b) => a[0] - b[0]
    )) {
      toolCalls.push({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      });
    }

    if (bufferToolDisabledOutput && toolCalls.length === 0 && onChunk) {
      for (const chunk of bufferedChunks) onChunk(chunk);
    }

    const durationMs = Math.round(performance.now() - startedAt);
    this.logTelemetry({
      event: "home_mind_llm_phase",
      trace_id: options.traceId,
      phase: options.phase,
      duration_ms: durationMs,
      ttft_ms: firstDeltaMs ?? null,
      delivery_ttft_ms:
        firstDeltaMs === undefined
          ? null
          : bufferToolDisabledOutput
            ? durationMs
            : firstDeltaMs,
      first_delta_observed: firstDeltaMs !== undefined,
      output_buffered: bufferToolDisabledOutput,
      tools_enabled: options.toolsEnabled,
      requested_service_tier: this.config.openaiServiceTier ?? "provider_default",
      openai_request_id: response.request_id,
      prompt_tokens: usage?.prompt_tokens,
      cached_tokens: usage?.prompt_tokens_details?.cached_tokens,
      completion_tokens: usage?.completion_tokens,
      reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens,
      finish_reason: finishReason,
      tool_calls: toolCalls.map((toolCall) => toolCall.function.name),
    });

    return { text, finishReason, toolCalls };
  }

  private logTelemetry(fields: Record<string, unknown>): void {
    console.log(JSON.stringify(fields));
  }
}

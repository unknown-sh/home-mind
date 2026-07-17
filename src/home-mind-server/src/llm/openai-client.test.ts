import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Config } from "../config.js";
import type { IMemoryStore } from "../memory/interface.js";
import type { IConversationStore } from "../memory/types.js";
import type { IFactExtractor } from "./interface.js";
import type { HomeAssistantClient } from "../ha/client.js";
import { DeviceScanner } from "../ha/device-scanner.js";
import { TopologyScanner } from "../ha/topology-scanner.js";

// Async iterator helper for simulating OpenAI streams
function makeStream(chunks: object[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length)
            return { value: chunks[i++], done: false as const };
          return { value: undefined, done: true as const };
        },
      };
    },
  };
}

const mockCreate = vi.fn();

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mockCreate,
        },
      };
    },
  };
});

vi.mock("./tool-handler.js", () => ({
  handleToolCall: vi.fn().mockResolvedValue({ state: "on" }),
  extractAndStoreFacts: vi.fn().mockResolvedValue(1),
}));

import { OpenAIChatEngine } from "./openai-client.js";
import { handleToolCall, extractAndStoreFacts } from "./tool-handler.js";

describe("OpenAIChatEngine", () => {
  let engine: OpenAIChatEngine;
  let memory: IMemoryStore;
  let conversations: IConversationStore;
  let extractor: IFactExtractor;
  let ha: HomeAssistantClient;
  let config: Config;

  beforeEach(() => {
    mockCreate.mockReset();
    vi.mocked(handleToolCall).mockReset();
    vi.mocked(extractAndStoreFacts).mockReset();

    vi.mocked(handleToolCall).mockResolvedValue({ state: "on" });
    vi.mocked(extractAndStoreFacts).mockResolvedValue(1);

    memory = {
      getFactsWithinTokenLimit: vi.fn().mockResolvedValue([]),
    } as unknown as IMemoryStore;

    conversations = {
      getConversationHistory: vi.fn().mockReturnValue([]),
      storeMessage: vi.fn(),
      getKnownUsers: vi.fn().mockReturnValue([]),
      cleanupOldConversations: vi.fn().mockReturnValue(0),
      close: vi.fn(),
    } as unknown as IConversationStore;

    extractor = {} as IFactExtractor;

    ha = {
      getState: vi.fn(),
    } as unknown as HomeAssistantClient;

    config = {
      llmProvider: "openai",
      llmModel: "gpt-4o-mini",
      openaiApiKey: "test-key",
      memoryTokenLimit: 1500,
      openaiVoiceMaxTokens: 160,
      openaiMaxToolRounds: 2,
      voiceEnvironmentEntityIds: [],
    } as unknown as Config;

    const mockScanner = {
      refreshIfStale: vi.fn().mockResolvedValue(undefined),
      hasProfiles: vi.fn().mockReturnValue(false),
      formatCheatSheet: vi.fn().mockReturnValue(""),
    } as unknown as DeviceScanner;
    const mockTopology = {
      refreshIfStale: vi.fn().mockResolvedValue(undefined),
      hasLayout: vi.fn().mockReturnValue(false),
      formatSection: vi.fn().mockReturnValue(""),
    } as unknown as TopologyScanner;
    engine = new OpenAIChatEngine(config, memory, conversations, extractor, ha, mockScanner, mockTopology);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("accumulates text from stream deltas", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
        { choices: [{ delta: { content: " world" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    const result = await engine.chat({
      message: "Hi",
      userId: "user-1",
    });

    expect(result.response).toBe("Hello world");
  });

  it("fires onChunk callback for each text delta", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "A" }, finish_reason: null }] },
        { choices: [{ delta: { content: "B" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    const chunks: string[] = [];
    await engine.chat({ message: "Hi", userId: "user-1" }, (chunk) =>
      chunks.push(chunk)
    );

    expect(chunks).toEqual(["A", "B"]);
  });

  it("accumulates tool call deltas across chunks", async () => {
    // First stream: tool call
    mockCreate.mockResolvedValueOnce(
      makeStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "get_state", arguments: '{"entity' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '_id":"light.kitchen"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ])
    );

    // Second stream: final response after tool result
    mockCreate.mockResolvedValueOnce(
      makeStream([
        {
          choices: [
            { delta: { content: "The light is on" }, finish_reason: null },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    const result = await engine.chat({ message: "Is the light on?", userId: "user-1" });

    expect(handleToolCall).toHaveBeenCalledWith(ha, "get_state", {
      entity_id: "light.kitchen",
    });
    expect(result.response).toBe("The light is on");
    expect(result.toolsUsed).toEqual(["get_state"]);
  });

  it("handles multiple tool calls in one response", async () => {
    // First stream: two tool calls
    mockCreate.mockResolvedValueOnce(
      makeStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: {
                      name: "get_state",
                      arguments: '{"entity_id":"sensor.temp"}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 1,
                    id: "call-2",
                    function: {
                      name: "get_state",
                      arguments: '{"entity_id":"sensor.humidity"}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ])
    );

    // Second stream: final response
    mockCreate.mockResolvedValueOnce(
      makeStream([
        { choices: [{ delta: { content: "22°C, 45%" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    const result = await engine.chat({ message: "temp and humidity?", userId: "user-1" });

    expect(handleToolCall).toHaveBeenCalledTimes(2);
    expect(result.toolsUsed).toEqual(["get_state", "get_state"]);
  });

  it("loads conversation history when conversationId provided", async () => {
    (conversations.getConversationHistory as ReturnType<typeof vi.fn>).mockReturnValue([
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
    ]);

    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Response" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({
      message: "follow up",
      userId: "user-1",
      conversationId: "conv-1",
    });

    expect(conversations.getConversationHistory).toHaveBeenCalledWith("conv-1", 10);

    // Check messages passed to OpenAI include history
    const createCall = mockCreate.mock.calls[0][0];
    expect(createCall.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "previous question" }),
        expect.objectContaining({
          role: "assistant",
          content: "previous answer",
        }),
      ])
    );
  });

  it("stores user and assistant messages when conversationId present", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Hi!" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({
      message: "Hello",
      userId: "user-1",
      conversationId: "conv-1",
    });

    expect(conversations.storeMessage).toHaveBeenCalledWith(
      "conv-1",
      "user-1",
      "user",
      "Hello"
    );
    expect(conversations.storeMessage).toHaveBeenCalledWith(
      "conv-1",
      "user-1",
      "assistant",
      "Hi!"
    );
  });

  it("does not store messages when conversationId absent", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Hi!" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({ message: "Hello", userId: "user-1" });

    expect(conversations.storeMessage).not.toHaveBeenCalled();
  });

  it("uses the bounded completion budget for voice mode", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Short" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({
      message: "Hi",
      userId: "user-1",
      isVoice: true,
    });

    const createCall = mockCreate.mock.calls[0][0];
    expect(createCall.max_completion_tokens).toBe(160);
  });

  it("uses max_tokens 2048 for non-voice mode", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Long" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({ message: "Hi", userId: "user-1" });

    const createCall = mockCreate.mock.calls[0][0];
    expect(createCall.max_tokens).toBe(2048);
  });

  it("prefetches configured environment state and answers a voice query in one tool-free model call", async () => {
    config.voiceEnvironmentEntityIds = [
      "climate.ecobee_thermostat",
      "weather.forecast_home",
    ];
    config.openaiServiceTier = "default";
    config.openaiReasoningEffort = "none";
    vi.mocked(ha.getState)
      .mockResolvedValueOnce({
        entity_id: "climate.ecobee_thermostat",
        state: "cool",
        attributes: { current_temperature: 74, current_humidity: 40 },
        last_changed: "",
        last_updated: "",
      })
      .mockResolvedValueOnce({
        entity_id: "weather.forecast_home",
        state: "rainy",
        attributes: { temperature: 98, humidity: 23 },
        last_changed: "",
        last_updated: "",
      });
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Inside is 74°F." }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    const result = await engine.chat({
      message: "What is the weather, temperature, and humidity?",
      userId: "user-1",
      isVoice: true,
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(ha.getState).toHaveBeenCalledTimes(2);
    const createCall = mockCreate.mock.calls[0][0];
    expect(createCall.tools).toBeUndefined();
    expect(createCall.tool_choice).toBe("none");
    expect(createCall.service_tier).toBe("default");
    expect(createCall.reasoning_effort).toBe("none");
    expect(createCall.stream_options).toEqual({ include_usage: true });
    expect(JSON.stringify(createCall.messages)).toContain("Live Home Assistant environment snapshot");
    expect(result.toolsUsed).toEqual(["prefetch_environment"]);
  });

  it("disables tools after one read-only tool round", async () => {
    mockCreate
      .mockResolvedValueOnce(
        makeStream([
          {
            choices: [{
              delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "get_state", arguments: '{"entity_id":"sensor.temp"}' } }] },
              finish_reason: null,
            }],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ])
      )
      .mockResolvedValueOnce(
        makeStream([
          { choices: [{ delta: { content: "It is 74°F." }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ])
      );

    await engine.chat({ message: "What is the current temperature?", userId: "user-1" });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0].tools).toBeDefined();
    expect(mockCreate.mock.calls[1][0].tools).toBeUndefined();
    expect(mockCreate.mock.calls[1][0].tool_choice).toBe("none");
  });

  it("emits correlated per-phase token and latency telemetry", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 3332,
            completion_tokens: 12,
            total_tokens: 3344,
            prompt_tokens_details: { cached_tokens: 2688 },
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        },
      ])
    );

    await engine.chat({ message: "Hello", userId: "user-1", isVoice: true });

    const events = logSpy.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line));
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    const phaseEvent = events.find((event) => event.event === "home_mind_llm_phase");
    const chatEvent = events.find((event) => event.event === "home_mind_chat");

    expect(phaseEvent).toMatchObject({
      phase: 1,
      prompt_tokens: 3332,
      cached_tokens: 2688,
      completion_tokens: 12,
      reasoning_tokens: 0,
      finish_reason: "stop",
    });
    expect(phaseEvent.duration_ms).toBeTypeOf("number");
    expect(phaseEvent.ttft_ms).toBeTypeOf("number");
    expect(chatEvent.trace_id).toBe(phaseEvent.trace_id);
    expect(chatEvent).toMatchObject({ phases: 1, tool_rounds: 0 });
    logSpy.mockRestore();
  });

  it("fires extractAndStoreFacts after response", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Response" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({ message: "Remember I like 22°C", userId: "user-1" });

    expect(extractAndStoreFacts).toHaveBeenCalledWith(
      memory,
      extractor,
      "user-1",
      "Remember I like 22°C",
      "Response"
    );
  });

  it("catches extraction errors without failing the response", async () => {
    vi.mocked(extractAndStoreFacts).mockRejectedValue(
      new Error("extraction failed")
    );

    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "OK" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    // Should not throw
    const result = await engine.chat({ message: "Hi", userId: "user-1" });
    expect(result.response).toBe("OK");

    // Wait for the fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 10));
  });

  it("skips empty choices in stream", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [] },
        { choices: [{ delta: { content: "data" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    const result = await engine.chat({ message: "Hi", userId: "user-1" });

    expect(result.response).toBe("data");
  });

  it("includes customPrompt in system message when provided", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Hey!" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({
      message: "Hi",
      userId: "user-1",
      customPrompt: "You are Ava, a sarcastic AI.",
    });

    const createCall = mockCreate.mock.calls[0][0];
    const systemMsg = createCall.messages[0];
    expect(systemMsg.role).toBe("system");
    expect(systemMsg.content).toMatch(/^You are Ava, a sarcastic AI\./);
    expect(systemMsg.content).not.toContain("You are a helpful smart home assistant");
  });

  it("uses default identity when customPrompt absent", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({ message: "Hi", userId: "user-1" });

    const createCall = mockCreate.mock.calls[0][0];
    const systemMsg = createCall.messages[0];
    expect(systemMsg.content).toContain("You are a helpful smart home assistant");
  });

  it("returns factsLearned as 0", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    const result = await engine.chat({ message: "Hi", userId: "user-1" });

    expect(result.factsLearned).toBe(0);
  });

  describe("empty-response diagnostics", () => {
    it("attaches EMPTY_CONTENT error when finish_reason=stop with no text and no tool calls", async () => {
      mockCreate.mockResolvedValue(
        makeStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }])
      );

      const result = await engine.chat({ message: "Hi", userId: "user-1" });

      expect(result.response).toBe("");
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe("EMPTY_CONTENT");
      expect(result.error?.hint).toMatch(/OpenAI-compatible|tool calls/);
    });

    it("attaches MAX_TOKENS_TRUNCATED error when finish_reason=length with empty text", async () => {
      mockCreate.mockResolvedValue(
        makeStream([{ choices: [{ delta: {}, finish_reason: "length" }] }])
      );

      const result = await engine.chat({ message: "Hi", userId: "user-1" });

      expect(result.error?.code).toBe("MAX_TOKENS_TRUNCATED");
      expect(result.error?.hint).toMatch(/max_tokens|cut off/);
    });

    it("attaches CONTENT_FILTERED error when finish_reason=content_filter with empty text", async () => {
      mockCreate.mockResolvedValue(
        makeStream([{ choices: [{ delta: {}, finish_reason: "content_filter" }] }])
      );

      const result = await engine.chat({ message: "Hi", userId: "user-1" });

      expect(result.error?.code).toBe("CONTENT_FILTERED");
    });

    it("does NOT attach error when the model returns text", async () => {
      mockCreate.mockResolvedValue(
        makeStream([
          { choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] },
        ])
      );

      const result = await engine.chat({ message: "Hi", userId: "user-1" });

      expect(result.response).toBe("Done");
      expect(result.error).toBeUndefined();
    });
  });
});

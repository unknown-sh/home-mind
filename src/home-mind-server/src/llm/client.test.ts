import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { IMemoryStore } from "../memory/interface.js";
import type { IConversationStore } from "../memory/types.js";
import type { IFactExtractor } from "./interface.js";
import type { HomeAssistantClient } from "../ha/client.js";
import type { DeviceScanner } from "../ha/device-scanner.js";
import type { TopologyScanner } from "../ha/topology-scanner.js";

vi.mock("./tool-handler.js", () => ({
  handleToolCall: vi.fn(),
  extractAndStoreFacts: vi.fn().mockResolvedValue(0),
}));

import { LLMClient } from "./client.js";
import { extractAndStoreFacts } from "./tool-handler.js";

describe("LLMClient fact extraction", () => {
  let client: LLMClient;

  beforeEach(() => {
    vi.mocked(extractAndStoreFacts).mockReset();
    vi.mocked(extractAndStoreFacts).mockResolvedValue(0);
    const memory = {
      getFactsWithinTokenLimit: vi.fn().mockResolvedValue([]),
    } as unknown as IMemoryStore;
    const conversations = {} as IConversationStore;
    const scanner = {
      refreshIfStale: vi.fn().mockResolvedValue(undefined),
      hasProfiles: vi.fn().mockReturnValue(false),
    } as unknown as DeviceScanner;
    const topology = {
      refreshIfStale: vi.fn().mockResolvedValue(undefined),
      hasLayout: vi.fn().mockReturnValue(false),
    } as unknown as TopologyScanner;
    client = new LLMClient(
      {
        anthropicApiKey: "test",
        memoryTokenLimit: 100,
        logLevel: "info",
      } as Config,
      memory,
      conversations,
      {} as IFactExtractor,
      {} as HomeAssistantClient,
      scanner,
      topology
    );
    const streamable = client as unknown as {
      streamMessage: (...args: unknown[]) => Promise<unknown>;
    };
    vi.spyOn(streamable, "streamMessage").mockResolvedValue({
      content: [{ type: "text", text: "Response" }],
      stop_reason: "end_turn",
    });
  });

  it("extracts facts for ordinary requests", async () => {
    await client.chat({ message: "Remember this", userId: "user-1" });

    expect(extractAndStoreFacts).toHaveBeenCalledOnce();
  });

  it("skips fact extraction for synthetic operational probes", async () => {
    await client.chat({
      message: "What is the weather?",
      userId: "latency-probe",
      skipFactExtraction: true,
    });

    expect(extractAndStoreFacts).not.toHaveBeenCalled();
  });
});

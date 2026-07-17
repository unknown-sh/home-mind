import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createRouter } from "./routes.js";
import type {
  ChatRequest,
  IChatEngine,
  StreamCallback,
} from "../llm/interface.js";
import type { IMemoryStore } from "../memory/interface.js";

describe("chat request correlation", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve()))
    );
    server = undefined;
  });

  async function startServer() {
    let capturedRequest: ChatRequest | undefined;
    const chat = vi.fn(
      async (request: ChatRequest, onChunk?: StreamCallback) => {
        capturedRequest = request;
        onChunk?.("Hello");
        return { response: "Hello", toolsUsed: [], factsLearned: 0 };
      }
    );
    const llm = { chat } as IChatEngine;
    const memory = {} as IMemoryStore;
    const app = express();
    app.use(express.json());
    app.use(createRouter(llm, memory));
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const port = (server.address() as AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}`,
      getCapturedRequest: () => capturedRequest,
    };
  }

  it("returns the same request ID passed to the non-streaming engine", async () => {
    const { url, getCapturedRequest } = await startServer();
    const response = await fetch(`${url}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello" }),
    });
    await response.json();

    const requestId = response.headers.get("x-request-id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(getCapturedRequest()?.traceId).toBe(requestId);
  });

  it("returns the same request ID passed to the streaming engine", async () => {
    const { url, getCapturedRequest } = await startServer();
    const response = await fetch(`${url}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello" }),
    });
    const body = await response.text();

    const requestId = response.headers.get("x-request-id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(getCapturedRequest()?.traceId).toBe(requestId);
    expect(body).toContain("event: chunk");
    expect(body).toContain("event: done");
  });
});

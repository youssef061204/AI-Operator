import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  GeminiProvider,
  OllamaProvider,
  boundedContext,
} from "../src/runtime/providers.js";
import type { ModelContext } from "../src/runtime/contracts.js";
const context: ModelContext = {
  objective: "Inspect the fixture",
  plan: [],
  observations: [],
  verification: [],
  stepsRemaining: 2,
};
test("Ollama adapter validates transport, accounts usage, refuses redirects and cancels stalled requests", async () => {
  let mode = "ok";
  let requestBody: Record<string, unknown> = {};
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    requestBody = JSON.parse(raw);
    if (mode === "stall") return;
    if (mode === "redirect") {
      res.writeHead(302, { location: "http://127.0.0.1:1/" });
      res.end();
      return;
    }
    if (mode === "unavailable") {
      res.writeHead(503);
      res.end("private upstream response");
      return;
    }
    if (mode === "malformed") {
      res.end("not json");
      return;
    }
    if (mode === "oversize") {
      res.end("x".repeat(262145));
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        message: {
          content: JSON.stringify({ kind: "finish", summary: "fixture" }),
        },
        prompt_eval_count: 7,
        eval_count: 3,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const provider = new OllamaProvider(
    "fixture-model",
    `http://127.0.0.1:${address.port}`,
  );
  try {
    const result = await provider.decide(context, new AbortController().signal);
    assert.equal(result.tokens, 10);
    assert.equal(requestBody.stream, false);
    assert.equal(typeof requestBody.format, "object");
    assert.deepEqual(
      (requestBody.format as { oneOf?: unknown[] }).oneOf?.length,
      2,
    );
    for (const value of ["unavailable", "malformed", "oversize", "redirect"]) {
      mode = value;
      await assert.rejects(
        provider.decide(context, new AbortController().signal),
      );
    }
    mode = "stall";
    const abort = new AbortController();
    const pending = provider.decide(context, abort.signal);
    setTimeout(() => abort.abort(), 30);
    await assert.rejects(pending);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
test("context budget includes escaping and oversized objective/criteria", () => {
  const input = {
    ...context,
    objective: '"'.repeat(8000),
    verification: [
      {
        kind: "file_contains" as const,
        path: "file",
        text: "text".repeat(10000),
      },
    ],
    observations: [{ step: 1, error: '\\"'.repeat(40000) }],
  };
  const bounded = boundedContext(input, 2000);
  assert.ok(JSON.stringify(bounded).length <= 2000);
  assert.equal(input.objective.length, 8000);
});

test("Gemini adapter sends structured JSON requests and records usage", async () => {
  let requestBody: Record<string, unknown> = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: '{"kind":"finish","summary":"fixture"}' }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const provider = new GeminiProvider(
    "gemini-test",
    "test-key-that-is-long-enough",
  );
  try {
    const result = await provider.decide(context, new AbortController().signal);
    assert.equal(result.tokens, 16);
    assert.equal(
      (requestBody.generationConfig as { responseMimeType: string })
        .responseMimeType,
      "application/json",
    );
    assert.equal(
      (requestBody.contents as Array<{ role: string }>)[0].role,
      "user",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini adapter bounds and reports transient retries", async () => {
  let requests = 0;
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  Math.random = () => 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) return new Response("unavailable", { status: 503 });
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: '{"kind":"finish","summary":"fixture"}' }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const provider = new GeminiProvider(
    "gemini-test",
    "test-key-that-is-long-enough",
  );
  try {
    await provider.decide(context, new AbortController().signal);
    assert.deepEqual(provider.stats(), {
      requests: 2,
      retries: 1,
      rateLimited: 0,
      serverErrors: 1,
      persistentFailures: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  }
});

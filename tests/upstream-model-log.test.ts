import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import {
  getRequestedThinkingEffort,
  requestContext,
  setRequestedThinkingEffort,
} from "~/lib/request-context"
import { state } from "~/lib/state"
import { closeUsageStore } from "~/lib/token-usage"
import { traceIdMiddleware } from "~/lib/trace"
import type { Model } from "~/lib/types/models"
import {
  formatChatCompletionsUpstreamModelLog,
  formatGoogleUpstreamModelLog,
  formatMessagesUpstreamModelLog,
  formatResponsesUpstreamModelLog,
  logChatCompletionsUpstreamModel,
  logGoogleUpstreamModel,
  logMessagesUpstreamModel,
  logResponsesUpstreamModel,
  recordChatCompletionsRequestedThinkingEffort,
  recordMessagesRequestedThinkingEffort,
  recordResponsesRequestedThinkingEffort,
} from "~/lib/upstream-model-log"
import { completionRoutes } from "~/routes/chat-completions/route"
import { messageRoutes } from "~/routes/messages/route"
import { providerMessagesHandlerDependencies } from "~/routes/provider/messages/handler"
import { providerMessageRoutes } from "~/routes/provider/messages/route"
import { providerResponsesHandlerDependencies } from "~/routes/provider/responses/handler"
import { providerResponsesRoutes } from "~/routes/provider/responses/route"
import { responsesRoutes } from "~/routes/responses/route"
import { forwardCodexResponses } from "~/services/codex/create-responses"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

const createCopilotModel = (
  id: string,
  supportedEndpoints: Array<string>,
  supports: Model["capabilities"]["supports"] = {},
): Model => ({
  id,
  name: id,
  object: "model",
  vendor: "copilot",
  version: "1",
  preview: false,
  model_picker_enabled: true,
  supported_endpoints: supportedEndpoints,
  capabilities: {
    family: id,
    object: "model_capabilities",
    tokenizer: "o200k_base",
    type: "chat",
    limits: {
      max_context_window_tokens: 200_000,
      max_prompt_tokens: 200_000,
      max_output_tokens: 32_000,
    },
    supports,
  },
})

describe("upstream model thinking effort formatting", () => {
  test("formats Messages payloads across plain, effort, clamped, budget, adaptive, and disabled modes", () => {
    expect(
      formatMessagesUpstreamModelLog({
        model: "claude-haiku-4.5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).toBe("<-- model: claude-haiku-4.5")

    expect(
      formatMessagesUpstreamModelLog(
        {
          model: "claude-opus-5.5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hi" }],
          thinking: { type: "adaptive" },
          output_config: { effort: "max" },
        },
        "max",
      ),
    ).toBe("<-- model: claude-opus-5.5 (effort: max)")

    expect(
      formatMessagesUpstreamModelLog(
        {
          model: "claude-opus-4.6",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hi" }],
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
        },
        "xhigh",
      ),
    ).toBe("<-- model: claude-opus-4.6 (effort: xhigh -> high)")

    expect(
      formatMessagesUpstreamModelLog({
        model: "claude-sonnet-4.5",
        max_tokens: 8192,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled", budget_tokens: 4095 },
      }),
    ).toBe("<-- model: claude-sonnet-4.5 (thinking_budget: 4095)")

    expect(
      formatMessagesUpstreamModelLog({
        model: "claude-sonnet-5.5",
        max_tokens: 8192,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "adaptive" },
      }),
    ).toBe("<-- model: claude-sonnet-5.5 (thinking: adaptive)")

    expect(
      formatMessagesUpstreamModelLog(
        {
          model: "claude-sonnet-5.5",
          max_tokens: 8192,
          messages: [{ role: "user", content: "hi" }],
          thinking: { type: "disabled" },
          output_config: { effort: "max" },
        },
        "max",
      ),
    ).toBe("<-- model: claude-sonnet-5.5 (thinking: disabled)")
  })

  test("formats Chat Completions payloads across effort, budget, MiMo thinking, and disabled modes", () => {
    expect(
      formatChatCompletionsUpstreamModelLog({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).toBe("<-- model: gpt-4o")

    expect(
      formatChatCompletionsUpstreamModelLog(
        {
          model: "gemini-4-carbon",
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: "high",
        },
        "xhigh",
      ),
    ).toBe("<-- model: gemini-4-carbon (effort: xhigh -> high)")

    expect(
      formatChatCompletionsUpstreamModelLog(
        {
          model: "gemini-4-carbon",
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: "medium",
          thinking_budget: 4096,
        },
        "medium",
      ),
    ).toBe("<-- model: gemini-4-carbon (effort: medium, thinking_budget: 4096)")

    expect(
      formatChatCompletionsUpstreamModelLog({
        model: "mimo-v2-flash",
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled" },
      }),
    ).toBe("<-- model: mimo-v2-flash (thinking: enabled)")

    expect(
      formatChatCompletionsUpstreamModelLog({
        model: "mimo-v2-flash",
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "disabled" },
      }),
    ).toBe("<-- model: mimo-v2-flash (thinking: disabled)")
  })

  test("formats Responses and Google GenerateContent payloads", () => {
    expect(
      formatResponsesUpstreamModelLog({
        model: "gpt-5.4",
        input: "hi",
      }),
    ).toBe("<-- model: gpt-5.4")

    expect(
      formatResponsesUpstreamModelLog(
        {
          model: "gpt-5.4",
          input: "hi",
          reasoning: { effort: "xhigh" },
        },
        "max",
      ),
    ).toBe("<-- model: gpt-5.4 (effort: max -> xhigh)")

    const baseGenerationConfig = {
      candidateCount: 1,
      maxOutputTokens: 4096,
    }

    expect(
      formatGoogleUpstreamModelLog("models/gemini-2.5-pro", {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: baseGenerationConfig,
      }),
    ).toBe("<-- model: gemini-2.5-pro")

    expect(
      formatGoogleUpstreamModelLog(
        "models/gemini-4-carbon",
        {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: {
            ...baseGenerationConfig,
            thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
          },
        },
        "high",
      ),
    ).toBe("<-- model: gemini-4-carbon (effort: high)")

    expect(
      formatGoogleUpstreamModelLog(
        "gemini-4-carbon",
        {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: {
            ...baseGenerationConfig,
            thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
          },
        },
        "xhigh",
      ),
    ).toBe("<-- model: gemini-4-carbon (effort: xhigh -> high)")

    expect(
      formatGoogleUpstreamModelLog("gemini-4-carbon", {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: {
          ...baseGenerationConfig,
          thinkingConfig: { includeThoughts: true },
        },
      }),
    ).toBe("<-- model: gemini-4-carbon (thinking: adaptive)")

    expect(
      formatGoogleUpstreamModelLog(
        "gemini-4-carbon",
        {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: {
            ...baseGenerationConfig,
            thinkingConfig: { includeThoughts: false, thinkingLevel: "LOW" },
          },
        },
        "disabled",
      ),
    ).toBe("<-- model: gemini-4-carbon (thinking: disabled)")
  })

  test("records inbound requested effort in requestContext and safely no-ops outside a store", () => {
    setRequestedThinkingEffort("high")
    expect(getRequestedThinkingEffort()).toBeUndefined()

    requestContext.run(
      {
        traceId: "trace-test",
        startTime: Date.now(),
        userAgent: "claude-cli/2.1.0",
        sessionAffinity: undefined,
        parentSessionId: undefined,
      },
      () => {
        setRequestedThinkingEffort("   ")
        expect(getRequestedThinkingEffort()).toBeUndefined()

        recordMessagesRequestedThinkingEffort({
          model: "gemini-4-carbon",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hi" }],
          output_config: { effort: "xhigh" },
        })
        expect(getRequestedThinkingEffort()).toBe("xhigh")

        recordMessagesRequestedThinkingEffort({
          model: "gemini-4-carbon",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hi" }],
          thinking: { type: "disabled" },
          output_config: { effort: "max" },
        })
        expect(getRequestedThinkingEffort()).toBe("disabled")

        recordResponsesRequestedThinkingEffort({
          model: "gpt-5.4",
          input: "hi",
          reasoning: { effort: "max" },
        })
        expect(getRequestedThinkingEffort()).toBe("max")

        recordChatCompletionsRequestedThinkingEffort({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: "medium",
        })
        expect(getRequestedThinkingEffort()).toBe("medium")

        recordChatCompletionsRequestedThinkingEffort({
          model: "mimo-v2-flash",
          messages: [{ role: "user", content: "hi" }],
          thinking: { type: "disabled" },
          reasoning_effort: "high",
        })
        expect(getRequestedThinkingEffort()).toBe("disabled")
      },
    )
  })
})

describe("end-to-end upstream model and effort logging", () => {
  const originalFetch = globalThis.fetch
  const originalCopilotToken = state.copilotToken
  const originalCodexToken = state.codexAccessToken
  const originalCodexAccountId = state.codexAccountId
  const originalModels = state.models
  const originalTokenBasedBilling = state.tokenBasedBilling
  const originalMessagesResolve =
    providerMessagesHandlerDependencies.resolveProviderConfig
  const originalResponsesResolve =
    providerResponsesHandlerDependencies.resolveProviderConfig

  const originalConsolaLog = consola.log
  let loggedLines: Array<string> = []

  beforeEach(async () => {
    process.env[DB_PATH_ENV] = ":memory:"
    await closeUsageStore()
    loggedLines = []
    consola.log = Object.assign(
      (...args: Array<unknown>) => {
        loggedLines.push(args.map(String).join(" "))
      },
      { raw: originalConsolaLog.raw },
    )
    state.copilotToken = "test-copilot-token"
    state.codexAccessToken = "test-codex-token"
    state.codexAccountId = "test-codex-account"
    state.tokenBasedBilling = true
    state.models = {
      object: "list",
      data: [
        createCopilotModel("gemini-4-carbon", ["/chat/completions"], {
          reasoning_effort: ["low", "medium", "high"],
          tool_calls: true,
        }),
        createCopilotModel("claude-sonnet-4.6", ["/v1/messages"], {
          adaptive_thinking: true,
          reasoning_effort: ["low", "medium", "high", "max"],
          tool_calls: true,
        }),
        createCopilotModel("gpt-5.4", ["/responses"], {
          reasoning_effort: ["low", "medium", "high", "xhigh"],
          tool_calls: true,
        }),
      ],
    }
  })

  afterEach(async () => {
    consola.log = originalConsolaLog
    globalThis.fetch = originalFetch
    state.copilotToken = originalCopilotToken
    state.codexAccessToken = originalCodexToken
    state.codexAccountId = originalCodexAccountId
    state.models = originalModels
    state.tokenBasedBilling = originalTokenBasedBilling
    providerMessagesHandlerDependencies.resolveProviderConfig =
      originalMessagesResolve
    providerResponsesHandlerDependencies.resolveProviderConfig =
      originalResponsesResolve
    await closeUsageStore()
    Reflect.deleteProperty(process.env, DB_PATH_ENV)
  })

  const createTestApp = () => {
    const app = new Hono()
    app.use(traceIdMiddleware)
    app.route("/v1/messages", messageRoutes)
    app.route("/v1/responses", responsesRoutes)
    app.route("/v1/chat/completions", completionRoutes)
    app.route("/:provider/v1/messages", providerMessageRoutes)
    app.route("/:provider/v1/responses", providerResponsesRoutes)
    return app
  }

  test("logs clamped effort when Claude Code sends xhigh to Copilot gemini-4-carbon", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 0,
          model: "gemini-4-carbon",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              logprobs: null,
              finish_reason: "stop",
            },
          ],
        }),
      ),
    ) as unknown as typeof fetch

    const app = createTestApp()
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "claude-cli/2.1.325 (external, cli)",
      },
      body: JSON.stringify({
        model: "gemini-4-carbon",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "Read",
            input_schema: { type: "object", properties: {} },
          },
        ],
        output_config: { effort: "xhigh" },
      }),
    })

    expect(res.status).toBe(200)
    expect(loggedLines).toContain(
      "<-- model: gemini-4-carbon (effort: xhigh -> high)",
    )
  })

  test("logs no-tools Claude Code effort downgrade on Copilot Messages API", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4.6",
          content: [{ type: "text", text: "title" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
      ),
    ) as unknown as typeof fetch

    const app = createTestApp()
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "claude-cli/2.1.325 (external, cli)",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        max_tokens: 128,
        messages: [{ role: "user", content: "summarize" }],
        output_config: { effort: "high" },
      }),
    })

    expect(res.status).toBe(200)
    expect(loggedLines).toContain(
      "<-- model: claude-sonnet-4.6 (effort: high -> low)",
    )
  })

  test("logs clamped effort on Copilot /v1/responses and direct /v1/chat/completions", async () => {
    globalThis.fetch = mock((url: string | URL | Request) => {
      const href = url instanceof Request ? url.url : url.toString()
      if (href.endsWith("/responses")) {
        return Promise.resolve(
          Response.json({
            id: "resp_1",
            object: "response",
            created_at: 0,
            model: "gpt-5.4",
            output: [],
            output_text: "ok",
            status: "completed",
            usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
          }),
        )
      }
      return Promise.resolve(
        Response.json({
          id: "chatcmpl_2",
          object: "chat.completion",
          created: 0,
          model: "gemini-4-carbon",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              logprobs: null,
              finish_reason: "stop",
            },
          ],
        }),
      )
    }) as unknown as typeof fetch

    const app = createTestApp()
    const responsesRes = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: "hello",
        reasoning: { effort: "max" },
      }),
    })
    expect(responsesRes.status).toBe(200)

    const chatRes = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-4-carbon",
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "medium",
      }),
    })
    expect(chatRes.status).toBe(200)

    expect(loggedLines).toContain("<-- model: gpt-5.4 (effort: max -> xhigh)")
    expect(loggedLines).toContain("<-- model: gemini-4-carbon (effort: medium)")
  })

  test("logs Google, Anthropic, OpenAI-compatible, OpenAI-responses, and Codex provider upstream calls", async () => {
    const providers: Record<string, ResolvedProviderConfig> = {
      google: {
        name: "google",
        type: "google",
        apiKey: "google-key",
        authType: "x-goog-api-key",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      },
      anthropic: {
        name: "anthropic",
        type: "anthropic",
        apiKey: "anth-key",
        authType: "x-api-key",
        baseUrl: "https://api.anthropic.com",
      },
      compat: {
        name: "compat",
        type: "openai-compatible",
        apiKey: "compat-key",
        authType: "authorization",
        baseUrl: "https://compat.example",
      },
      customresp: {
        name: "customresp",
        type: "openai-responses",
        apiKey: "resp-key",
        authType: "authorization",
        baseUrl: "https://resp.example",
        models: {
          "resp-model": {
            reasoningEfforts: ["low", "medium", "high"],
          },
        },
      },
    }

    const resolveMock = (name: string) =>
      Promise.resolve(providers[name] ?? null)
    providerMessagesHandlerDependencies.resolveProviderConfig = resolveMock
    providerResponsesHandlerDependencies.resolveProviderConfig = resolveMock

    globalThis.fetch = mock((url: string | URL | Request) => {
      const href = url instanceof Request ? url.url : url.toString()
      if (href.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(
          Response.json({
            responseId: "g-1",
            candidates: [
              {
                content: { role: "model", parts: [{ text: "ok" }] },
                finishReason: "STOP",
              },
            ],
          }),
        )
      }
      if (href.endsWith("/v1/messages")) {
        return Promise.resolve(
          Response.json({
            id: "msg_p",
            type: "message",
            role: "assistant",
            model: "claude-opus-5.5",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 2 },
          }),
        )
      }
      if (href.endsWith("/v1/chat/completions")) {
        return Promise.resolve(
          Response.json({
            id: "cc_p",
            object: "chat.completion",
            created: 0,
            model: "deepseek-r1",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                logprobs: null,
                finish_reason: "stop",
              },
            ],
          }),
        )
      }
      return Promise.resolve(
        Response.json({
          id: "resp_p",
          object: "response",
          created_at: 0,
          model: "resp-model",
          output: [],
          output_text: "ok",
          status: "completed",
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        }),
      )
    }) as unknown as typeof fetch

    const app = createTestApp()

    const googleRes = await app.request("/google/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-4-carbon",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
        output_config: { effort: "max" },
      }),
    })
    expect(googleRes.status).toBe(200)

    const anthropicRes = await app.request("/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5.5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
        output_config: { effort: "xhigh" },
      }),
    })
    expect(anthropicRes.status).toBe(200)

    const compatRes = await app.request("/compat/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-r1",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
        output_config: { effort: "high" },
      }),
    })
    expect(compatRes.status).toBe(200)

    const customRespRes = await app.request("/customresp/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "resp-model",
        input: "hi",
        reasoning: { effort: "xhigh" },
      }),
    })
    expect(customRespRes.status).toBe(200)

    await forwardCodexResponses(
      {
        model: "gpt-5.4",
        input: "hi",
        stream: false,
        reasoning: { effort: "high" },
      },
      new Headers(),
      "https://codex.example",
      { transport: "http" },
    )

    logMessagesUpstreamModel({
      model: "claude-direct",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    })
    logChatCompletionsUpstreamModel({
      model: "chat-direct",
      messages: [{ role: "user", content: "hi" }],
    })
    logResponsesUpstreamModel({
      model: "resp-direct",
      input: "hi",
    })
    logGoogleUpstreamModel("gemini-direct", {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { candidateCount: 1, maxOutputTokens: 64 },
    })

    expect(loggedLines).toContain(
      "<-- model: gemini-4-carbon (effort: max -> high)",
    )
    expect(loggedLines).toContain("<-- model: claude-opus-5.5 (effort: xhigh)")
    expect(loggedLines).toContain("<-- model: deepseek-r1 (effort: high)")
    expect(loggedLines).toContain(
      "<-- model: resp-model (effort: xhigh -> high)",
    )
    expect(loggedLines).toContain("<-- model: gpt-5.4 (effort: high)")
    expect(loggedLines).toContain("<-- model: claude-direct")
    expect(loggedLines).toContain("<-- model: chat-direct")
    expect(loggedLines).toContain("<-- model: resp-direct")
    expect(loggedLines).toContain("<-- model: gemini-direct")
  })
})

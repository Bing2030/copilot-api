import consola from "consola"

import {
  getRequestedThinkingEffort,
  setRequestedThinkingEffort,
} from "./request-context"
import type { AnthropicMessagesPayload } from "./types/anthropic"
import type { ChatCompletionsPayload } from "./types/chat-completions"
import type { GoogleGenerateContentPayload } from "./types/google"
import type { ResponsesPayload } from "./types/responses"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const normalizeEffortString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const formatModelLine = (model: string, details: Array<string>): string =>
  details.length > 0 ?
    `<-- model: ${model} (${details.join(", ")})`
  : `<-- model: ${model}`

const formatEffortDetail = (
  upstreamEffort: string,
  requestedEffort: string | undefined,
): string => {
  const requested = normalizeEffortString(requestedEffort)
  if (requested && requested.toLowerCase() !== upstreamEffort.toLowerCase()) {
    return `effort: ${requested} -> ${upstreamEffort}`
  }
  return `effort: ${upstreamEffort}`
}

export const recordMessagesRequestedThinkingEffort = (
  payload: AnthropicMessagesPayload,
): void => {
  if (payload.thinking?.type === "disabled") {
    setRequestedThinkingEffort("disabled")
    return
  }
  setRequestedThinkingEffort(
    normalizeEffortString(payload.output_config?.effort),
  )
}

export const recordResponsesRequestedThinkingEffort = (
  payload: ResponsesPayload,
): void => {
  setRequestedThinkingEffort(normalizeEffortString(payload.reasoning?.effort))
}

export const recordChatCompletionsRequestedThinkingEffort = (
  payload: ChatCompletionsPayload,
): void => {
  const thinking = isRecord(payload.thinking) ? payload.thinking : undefined
  if (normalizeEffortString(thinking?.type) === "disabled") {
    setRequestedThinkingEffort("disabled")
    return
  }
  setRequestedThinkingEffort(normalizeEffortString(payload.reasoning_effort))
}

export const formatMessagesUpstreamModelLog = (
  payload: AnthropicMessagesPayload,
  requestedEffort: string | undefined = getRequestedThinkingEffort(),
): string => {
  if (payload.thinking?.type === "disabled") {
    return formatModelLine(payload.model, ["thinking: disabled"])
  }

  const details: Array<string> = []
  const effort = normalizeEffortString(payload.output_config?.effort)
  if (effort) {
    details.push(formatEffortDetail(effort, requestedEffort))
  }

  if (
    typeof payload.thinking?.budget_tokens === "number"
    && Number.isFinite(payload.thinking.budget_tokens)
  ) {
    details.push(`thinking_budget: ${payload.thinking.budget_tokens}`)
  } else if (!effort && payload.thinking?.type === "adaptive") {
    details.push("thinking: adaptive")
  }

  return formatModelLine(payload.model, details)
}

export const formatChatCompletionsUpstreamModelLog = (
  payload: ChatCompletionsPayload,
  requestedEffort: string | undefined = getRequestedThinkingEffort(),
): string => {
  const thinkingRecord =
    isRecord(payload.thinking) ? payload.thinking : undefined
  const thinkingType = normalizeEffortString(thinkingRecord?.type)
  if (thinkingType === "disabled") {
    return formatModelLine(payload.model, ["thinking: disabled"])
  }

  const details: Array<string> = []
  const effort = normalizeEffortString(payload.reasoning_effort)
  if (effort) {
    details.push(formatEffortDetail(effort, requestedEffort))
  }

  if (
    typeof payload.thinking_budget === "number"
    && Number.isFinite(payload.thinking_budget)
  ) {
    details.push(`thinking_budget: ${payload.thinking_budget}`)
  } else if (!effort && thinkingType) {
    details.push(`thinking: ${thinkingType}`)
  }

  return formatModelLine(payload.model, details)
}

export const formatResponsesUpstreamModelLog = (
  payload: ResponsesPayload,
  requestedEffort: string | undefined = getRequestedThinkingEffort(),
): string => {
  const effort = normalizeEffortString(payload.reasoning?.effort)
  return formatModelLine(
    payload.model,
    effort ? [formatEffortDetail(effort, requestedEffort)] : [],
  )
}

export const formatGoogleUpstreamModelLog = (
  model: string,
  payload: GoogleGenerateContentPayload,
  requestedEffort: string | undefined = getRequestedThinkingEffort(),
): string => {
  const cleanModel = model.replace(/^models\//u, "")
  const thinkingConfig = payload.generationConfig?.thinkingConfig

  if (thinkingConfig?.includeThoughts === false) {
    return formatModelLine(cleanModel, ["thinking: disabled"])
  }

  const level = normalizeEffortString(
    thinkingConfig?.thinkingLevel,
  )?.toLowerCase()
  if (level) {
    return formatModelLine(cleanModel, [
      formatEffortDetail(level, requestedEffort),
    ])
  }

  if (thinkingConfig?.includeThoughts === true) {
    return formatModelLine(cleanModel, ["thinking: adaptive"])
  }

  return formatModelLine(cleanModel, [])
}

export const logMessagesUpstreamModel = (
  payload: AnthropicMessagesPayload,
): void => {
  consola.log(formatMessagesUpstreamModelLog(payload))
}

export const logChatCompletionsUpstreamModel = (
  payload: ChatCompletionsPayload,
): void => {
  consola.log(formatChatCompletionsUpstreamModelLog(payload))
}

export const logResponsesUpstreamModel = (payload: ResponsesPayload): void => {
  consola.log(formatResponsesUpstreamModelLog(payload))
}

export const logGoogleUpstreamModel = (
  model: string,
  payload: GoogleGenerateContentPayload,
): void => {
  consola.log(formatGoogleUpstreamModelLog(model, payload))
}

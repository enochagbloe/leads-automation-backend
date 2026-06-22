import { PlanCode } from "@prisma/client";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { AI_DECISION_PARSE_FAILURE_REASON, AiReplyDecision, fallbackHumanReviewDecision, parseAiDecision } from "./ai-decision-parser.service";

export type AiGenerateReplyInput = {
  businessId: string;
  conversationId: string;
  messageId: string;
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  metadata?: {
    plan: PlanCode;
    channel: "WHATSAPP" | "MANUAL";
    source: "INBOUND_MESSAGE" | "SYSTEM_RETRY";
  };
};

export type AiGenerateReplyResult = {
  rawText: string;
  parsedDecision?: AiReplyDecision;
  provider: "OPENROUTER";
  model: string;
  primaryModel: string;
  finalModelUsed: string;
  fallbackAttempted: boolean;
  fallbackModelsTried: string[];
  fallbackFailureReasons: Array<{ model: string; reason: string }>;
  providerRequestCount: number;
  fallbackExhausted?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  requestId?: string;
};

export interface AiProvider {
  generateReply(input: AiGenerateReplyInput): Promise<AiGenerateReplyResult>;
}

type OpenRouterResponse = {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; code?: string };
};

function uniqueModels(primary: string, fallbacks: string[]) {
  return Array.from(new Set([primary, ...fallbacks].map((model) => model.trim()).filter(Boolean)));
}

function attemptModels(primary: string) {
  const fallbackLimit = env.OPENROUTER_MAX_FALLBACK_ATTEMPTS;
  const fallbacks = env.OPENROUTER_FALLBACK_MODELS.slice(0, fallbackLimit);
  return uniqueModels(primary, fallbacks);
}

function providerErrorCode(status: number) {
  if (status === 408 || status === 504) return "AI_PROVIDER_TIMEOUT";
  if (status === 429) return "AI_PROVIDER_RATE_LIMITED";
  if (status === 404) return "AI_MODEL_UNAVAILABLE";
  if (status >= 500) return "AI_PROVIDER_UNAVAILABLE";
  return "AI_PROVIDER_ERROR";
}

function decisionValid(decision: AiReplyDecision | undefined) {
  if (!decision) return false;
  if (decision.requiresHumanReview || decision.suggestedAction === "REQUEST_HUMAN_REVIEW") return true;
  if (decision.shouldReply && decision.suggestedAction === "SEND_REPLY") return Boolean(decision.replyText?.trim());
  return decision.suggestedAction === "NO_ACTION" || decision.suggestedAction === "DETECT_BOOKING_ONLY";
}

export class OpenRouterProvider implements AiProvider {
  async generateReply(input: AiGenerateReplyInput): Promise<AiGenerateReplyResult> {
    if (!env.OPENROUTER_API_KEY) throw new AppError(503, "AI provider is not configured.", "AI_PROVIDER_ERROR");
    const primaryModel = input.model ?? env.OPENROUTER_DEFAULT_MODEL;
    if (!primaryModel) throw new AppError(503, "AI model is not configured.", "AI_PROVIDER_ERROR");

    const startedAt = Date.now();
    const models = attemptModels(primaryModel);
    const fallbackFailureReasons: Array<{ model: string; reason: string }> = [];

    for (const model of models) {
      const attemptStartedAt = Date.now();
      try {
      const response = await fetch(`${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": env.OPENROUTER_APP_URL ?? env.APP_URL,
          "X-Title": env.OPENROUTER_APP_NAME,
        },
        body: JSON.stringify({
          model,
          temperature: input.temperature ?? 0.2,
          max_tokens: input.maxTokens ?? 700,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: input.userPrompt },
          ],
          metadata: input.metadata ? {
            businessId: input.businessId,
            conversationId: input.conversationId,
            messageId: input.messageId,
            ...input.metadata,
          } : undefined,
        }),
        signal: AbortSignal.timeout(env.OPENROUTER_TIMEOUT_MS),
      });
      const raw = await response.json().catch(() => null) as OpenRouterResponse | null;
      const rawText = raw?.choices?.[0]?.message?.content;
      if (!response.ok || !rawText) {
        fallbackFailureReasons.push({ model, reason: providerErrorCode(response.status) });
        continue;
      }
      const parsedDecision = parseAiDecision(rawText);
      if (parsedDecision.reason === AI_DECISION_PARSE_FAILURE_REASON) {
        fallbackFailureReasons.push({ model, reason: "AI_RESPONSE_PARSE_ERROR" });
        continue;
      }
      if (!decisionValid(parsedDecision)) {
        fallbackFailureReasons.push({ model, reason: "AI_RESPONSE_PARSE_ERROR" });
        continue;
      }
      return {
        rawText,
        parsedDecision,
        provider: "OPENROUTER",
        model: raw?.model ?? model,
        primaryModel,
        finalModelUsed: raw?.model ?? model,
        fallbackAttempted: fallbackFailureReasons.length > 0,
        fallbackModelsTried: [...fallbackFailureReasons.map((failure) => failure.model), model],
        fallbackFailureReasons,
        providerRequestCount: fallbackFailureReasons.length + 1,
        promptTokens: raw?.usage?.prompt_tokens,
        completionTokens: raw?.usage?.completion_tokens,
        totalTokens: raw?.usage?.total_tokens,
        latencyMs: Date.now() - attemptStartedAt,
        requestId: raw?.id,
      };
      } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
          fallbackFailureReasons.push({ model, reason: "AI_PROVIDER_TIMEOUT" });
          continue;
        }
        if (error instanceof AppError) {
          fallbackFailureReasons.push({ model, reason: error.code });
          continue;
        }
        fallbackFailureReasons.push({ model, reason: "AI_PROVIDER_ERROR" });
      }
    }

    return {
      rawText: "",
      parsedDecision: fallbackHumanReviewDecision("AI provider failed after fallback attempts."),
      provider: "OPENROUTER",
      model: primaryModel,
      primaryModel,
      finalModelUsed: primaryModel,
      fallbackAttempted: fallbackFailureReasons.length > 0,
      fallbackModelsTried: fallbackFailureReasons.map((failure) => failure.model),
      fallbackFailureReasons,
      providerRequestCount: fallbackFailureReasons.length,
      fallbackExhausted: true,
      latencyMs: Date.now() - startedAt,
    };
  }
}

export const aiProvider: AiProvider = new OpenRouterProvider();

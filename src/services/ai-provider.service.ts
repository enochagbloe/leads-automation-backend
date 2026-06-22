import { PlanCode } from "@prisma/client";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { AiReplyDecision, parseAiDecision } from "./ai-decision-parser.service";

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

export class OpenRouterProvider implements AiProvider {
  async generateReply(input: AiGenerateReplyInput): Promise<AiGenerateReplyResult> {
    if (!env.OPENROUTER_API_KEY) throw new AppError(503, "AI provider is not configured.", "AI_PROVIDER_ERROR");
    const model = input.model ?? env.OPENROUTER_DEFAULT_MODEL;
    if (!model) throw new AppError(503, "AI model is not configured.", "AI_PROVIDER_ERROR");

    const startedAt = Date.now();
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
        throw new AppError(
          response.status === 408 ? 504 : 502,
          "AI provider request failed.",
          response.status === 408 ? "AI_PROVIDER_TIMEOUT" : "AI_PROVIDER_ERROR",
          { providerStatus: response.status, providerError: raw?.error?.message },
        );
      }
      return {
        rawText,
        parsedDecision: parseAiDecision(rawText),
        provider: "OPENROUTER",
        model: raw?.model ?? model,
        promptTokens: raw?.usage?.prompt_tokens,
        completionTokens: raw?.usage?.completion_tokens,
        totalTokens: raw?.usage?.total_tokens,
        latencyMs: Date.now() - startedAt,
        requestId: raw?.id,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new AppError(504, "AI provider request timed out.", "AI_PROVIDER_TIMEOUT");
      }
      throw new AppError(502, "AI provider request failed.", "AI_PROVIDER_ERROR");
    }
  }
}

export const aiProvider: AiProvider = new OpenRouterProvider();

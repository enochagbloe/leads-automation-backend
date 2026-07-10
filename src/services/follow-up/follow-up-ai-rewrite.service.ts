import { FollowUpContextType, FollowUpRuleType, PlanCode } from "@prisma/client";
import { aiProvider } from "../ai-provider.service";
import { aiUsageService } from "../ai-usage.service";
import { subscriptionService } from "../subscription.service";

function significantNumbers(value: string) {
  return Array.from(new Set(value.match(/\b\d+(?:[.,:]\d+)?\b/g) ?? []));
}

function safeRewrite(original: string, rewritten: string) {
  const value = rewritten
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!value || value.length > 700 || value.length < 8) return null;
  for (const number of significantNumbers(original)) {
    if (!value.includes(number)) return null;
  }
  return value;
}

export const followUpAiRewriteService = {
  async rewrite(input: {
    businessId: string;
    businessAccountId: string;
    businessName: string;
    ruleType: FollowUpRuleType;
    contextType: FollowUpContextType;
    renderedTemplate: string;
  }) {
    try {
      const subscription = await subscriptionService.getCurrentRecord(input.businessAccountId);
      if (subscription.plan.code === PlanCode.BASIC) {
        return { text: input.renderedTemplate, usedAiRewrite: false, failed: false, reason: "PLAN_NOT_ALLOWED" as const };
      }
      const usage = await aiUsageService.assertCanUseAiReplies(input.businessAccountId);
      const result = await aiProvider.generateCompletion({
        businessId: input.businessId,
        systemPrompt: [
          "You rewrite short WhatsApp follow-up messages for a business.",
          "Keep the exact meaning. Do not add facts, promises, prices, discounts, availability, payment terms, policies, dates, or times.",
          "Only improve tone, clarity, and naturalness. Return only the rewritten message text.",
        ].join("\n"),
        userPrompt: [
          `Business: ${input.businessName}`,
          `Rule type: ${input.ruleType}`,
          `Context: ${input.contextType}`,
          "Original message:",
          input.renderedTemplate,
        ].join("\n"),
        temperature: 0.2,
        maxTokens: 120,
        metadata: { source: "FOLLOW_UP_AI_REWRITE", ruleType: input.ruleType, contextType: input.contextType },
      });
      await aiUsageService.trackRequest({ accountUsageId: usage.usage.id, tokens: result.totalTokens });
      const text = safeRewrite(input.renderedTemplate, result.rawText);
      const providerMetadata = {
        provider: result.provider,
        model: result.finalModelUsed,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        totalTokens: result.totalTokens,
        providerRequestCount: result.providerRequestCount,
      };
      if (!text) return { text: input.renderedTemplate, usedAiRewrite: false, failed: true, reason: "AI_REWRITE_UNSAFE_OUTPUT" as const, providerMetadata };
      return { text, usedAiRewrite: true, failed: false, reason: null, providerMetadata };
    } catch {
      return { text: input.renderedTemplate, usedAiRewrite: false, failed: true, reason: "AI_REWRITE_FAILED" as const };
    }
  },
};

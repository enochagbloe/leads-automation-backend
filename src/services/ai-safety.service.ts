import { env } from "../config/env";
import { AiReplyDecision, fallbackHumanReviewDecision } from "./ai-decision-parser.service";

export type AiSafetyInput = {
  decision: AiReplyDecision | undefined;
  businessReady: boolean;
  humanTakeover: boolean;
  minConfidence?: number;
};

export type AiSafetyResult = {
  allowed: boolean;
  decision: AiReplyDecision;
  blockedReason?: string;
  status: "SUCCESS" | "BLOCKED_LOW_CONFIDENCE" | "BLOCKED_POLICY" | "PARSE_ERROR" | "AI_BUSINESS_NOT_READY";
};

const HIGH_RISK_INTENTS = new Set([
  "COMPLAINT",
  "PAYMENT_QUESTION",
  "HUMAN_REQUEST",
  "UNKNOWN",
]);

export const aiSafetyService = {
  evaluate(input: AiSafetyInput): AiSafetyResult {
    const decision = input.decision ?? fallbackHumanReviewDecision("AI response was unavailable.");
    if (!input.decision) {
      return { allowed: false, decision, blockedReason: decision.reason, status: "PARSE_ERROR" };
    }
    if (!input.businessReady) {
      return { allowed: false, decision, blockedReason: "Business setup is not ready enough for AI replies.", status: "AI_BUSINESS_NOT_READY" };
    }
    if (input.humanTakeover) {
      return { allowed: false, decision, blockedReason: "Conversation is already in human takeover.", status: "BLOCKED_POLICY" };
    }
    if (decision.confidence < (input.minConfidence ?? env.AI_MIN_CONFIDENCE)) {
      return { allowed: false, decision, blockedReason: "AI confidence is below the configured threshold.", status: "BLOCKED_LOW_CONFIDENCE" };
    }
    if (decision.requiresHumanReview || HIGH_RISK_INTENTS.has(decision.intent)) {
      return { allowed: false, decision, blockedReason: decision.reason || "AI requested human review.", status: "BLOCKED_POLICY" };
    }
    if (decision.suggestedAction === "CREATE_BOOKING_REQUEST") {
      return { allowed: true, decision, status: "SUCCESS" };
    }
    if (!decision.shouldReply || decision.suggestedAction !== "SEND_REPLY" || !decision.replyText) {
      return { allowed: false, decision, blockedReason: decision.reason || "AI decision did not approve sending a reply.", status: "BLOCKED_POLICY" };
    }
    if (decision.intent === "BOOKING_INTENT" && /confirm(ed|ation)?/i.test(decision.replyText)) {
      return { allowed: false, decision, blockedReason: "AI reply appears to confirm an appointment without backend confirmation.", status: "BLOCKED_POLICY" };
    }
    return { allowed: true, decision, status: "SUCCESS" };
  },
};

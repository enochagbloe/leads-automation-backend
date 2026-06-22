export type AiReplyIntent =
  | "GENERAL_QUESTION"
  | "SERVICE_INQUIRY"
  | "PRICING_INQUIRY"
  | "AVAILABILITY_INQUIRY"
  | "BOOKING_INTENT"
  | "RESCHEDULE_INTENT"
  | "CANCELLATION_INTENT"
  | "COMPLAINT"
  | "PAYMENT_QUESTION"
  | "HUMAN_REQUEST"
  | "UNKNOWN";

export type AiSuggestedAction =
  | "SEND_REPLY"
  | "REQUEST_HUMAN_REVIEW"
  | "DETECT_BOOKING_ONLY"
  | "NO_ACTION";

export type AiReplyDecision = {
  intent: AiReplyIntent;
  replyText: string | null;
  confidence: number;
  shouldReply: boolean;
  requiresHumanReview: boolean;
  reason: string;
  usedKnowledge: {
    profile: boolean;
    services: boolean;
    availability: boolean;
    policies: boolean;
    conversationHistory: boolean;
  };
  suggestedAction: AiSuggestedAction;
  appointmentIntent?: {
    serviceName?: string;
    preferredDate?: string;
    preferredTime?: string;
    customerLocation?: string;
    missingFields?: string[];
  };
};

const INTENTS = new Set<AiReplyIntent>([
  "GENERAL_QUESTION",
  "SERVICE_INQUIRY",
  "PRICING_INQUIRY",
  "AVAILABILITY_INQUIRY",
  "BOOKING_INTENT",
  "RESCHEDULE_INTENT",
  "CANCELLATION_INTENT",
  "COMPLAINT",
  "PAYMENT_QUESTION",
  "HUMAN_REQUEST",
  "UNKNOWN",
]);

const ACTIONS = new Set<AiSuggestedAction>([
  "SEND_REPLY",
  "REQUEST_HUMAN_REVIEW",
  "DETECT_BOOKING_ONLY",
  "NO_ACTION",
]);

export function fallbackHumanReviewDecision(reason: string): AiReplyDecision {
  return {
    intent: "UNKNOWN",
    replyText: null,
    confidence: 0,
    shouldReply: false,
    requiresHumanReview: true,
    reason,
    usedKnowledge: {
      profile: false,
      services: false,
      availability: false,
      policies: false,
      conversationHistory: false,
    },
    suggestedAction: "REQUEST_HUMAN_REVIEW",
  };
}

function extractJson(rawText: string) {
  const trimmed = rawText.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function booleanRecord(value: unknown) {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    profile: object.profile === true,
    services: object.services === true,
    availability: object.availability === true,
    policies: object.policies === true,
    conversationHistory: object.conversationHistory === true,
  };
}

export function parseAiDecision(rawText: string): AiReplyDecision {
  try {
    const parsed = JSON.parse(extractJson(rawText)) as Record<string, unknown>;
    const intent = typeof parsed.intent === "string" && INTENTS.has(parsed.intent as AiReplyIntent)
      ? parsed.intent as AiReplyIntent
      : "UNKNOWN";
    const suggestedAction = typeof parsed.suggestedAction === "string" && ACTIONS.has(parsed.suggestedAction as AiSuggestedAction)
      ? parsed.suggestedAction as AiSuggestedAction
      : "REQUEST_HUMAN_REVIEW";
    const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
    const appointmentIntent = parsed.appointmentIntent && typeof parsed.appointmentIntent === "object" && !Array.isArray(parsed.appointmentIntent)
      ? parsed.appointmentIntent as AiReplyDecision["appointmentIntent"]
      : undefined;
    return {
      intent,
      replyText: typeof parsed.replyText === "string" && parsed.replyText.trim() ? parsed.replyText.trim() : null,
      confidence,
      shouldReply: parsed.shouldReply === true,
      requiresHumanReview: parsed.requiresHumanReview === true,
      reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "No reason provided.",
      usedKnowledge: booleanRecord(parsed.usedKnowledge),
      suggestedAction,
      ...(appointmentIntent ? { appointmentIntent } : {}),
    };
  } catch {
    return fallbackHumanReviewDecision("AI response could not be parsed as structured JSON.");
  }
}

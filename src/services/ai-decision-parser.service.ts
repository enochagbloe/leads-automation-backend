import { AppointmentLocationType } from "@prisma/client";

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
  | "CREATE_BOOKING_REQUEST"
  | "DETECT_BOOKING_ONLY"
  | "NO_ACTION";

export type AiComplaintCategory =
  | "DELAY"
  | "POOR_SERVICE"
  | "QUALITY_ISSUE"
  | "STAFF_BEHAVIOR"
  | "MISCOMMUNICATION"
  | "PAYMENT_ISSUE"
  | "APPOINTMENT_ISSUE"
  | "DELIVERY_OR_SITE_ISSUE"
  | "MISSING_ITEM_OR_MISSING_WORK"
  | "FOLLOW_UP_REQUIRED"
  | "OTHER";

export type AiComplaintSeverity = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

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
  complaint?: {
    isComplaint: boolean;
    category?: AiComplaintCategory;
    subcategory?: string;
    severity?: AiComplaintSeverity;
    summary?: string;
    requiresInternalAction?: boolean;
    suggestedStaffSpecialtyTags?: string[];
  };
  appointmentIntent?: {
    serviceName?: string;
    serviceId?: string;
    preferredDate?: string;
    preferredTime?: string;
    timezone?: string;
    customerName?: string;
    customerPhone?: string;
    customerLocation?: string;
    locationType?: AppointmentLocationType;
    notes?: string;
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
  "CREATE_BOOKING_REQUEST",
  "DETECT_BOOKING_ONLY",
  "NO_ACTION",
]);

const COMPLAINT_CATEGORIES = new Set<AiComplaintCategory>([
  "DELAY",
  "POOR_SERVICE",
  "QUALITY_ISSUE",
  "STAFF_BEHAVIOR",
  "MISCOMMUNICATION",
  "PAYMENT_ISSUE",
  "APPOINTMENT_ISSUE",
  "DELIVERY_OR_SITE_ISSUE",
  "MISSING_ITEM_OR_MISSING_WORK",
  "FOLLOW_UP_REQUIRED",
  "OTHER",
]);

const COMPLAINT_SEVERITIES = new Set<AiComplaintSeverity>(["LOW", "MEDIUM", "HIGH", "URGENT"]);
const APPOINTMENT_LOCATION_TYPES = new Set<AppointmentLocationType>(Object.values(AppointmentLocationType));

export const AI_DECISION_PARSE_FAILURE_REASON = "AI response could not be parsed as structured JSON.";

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

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()).slice(0, 12);
}

function complaintRecord(value: unknown): AiReplyDecision["complaint"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const category = typeof object.category === "string" && COMPLAINT_CATEGORIES.has(object.category as AiComplaintCategory)
    ? object.category as AiComplaintCategory
    : undefined;
  const severity = typeof object.severity === "string" && COMPLAINT_SEVERITIES.has(object.severity as AiComplaintSeverity)
    ? object.severity as AiComplaintSeverity
    : undefined;
  return {
    isComplaint: object.isComplaint === true,
    ...(category ? { category } : {}),
    ...(typeof object.subcategory === "string" && object.subcategory.trim() ? { subcategory: object.subcategory.trim().slice(0, 120) } : {}),
    ...(severity ? { severity } : {}),
    ...(typeof object.summary === "string" && object.summary.trim() ? { summary: object.summary.trim().slice(0, 500) } : {}),
    requiresInternalAction: object.requiresInternalAction === true,
    suggestedStaffSpecialtyTags: stringArray(object.suggestedStaffSpecialtyTags),
  };
}

function optionalString(value: unknown, max = 300) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function appointmentIntentRecord(value: unknown): AiReplyDecision["appointmentIntent"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const locationType = typeof object.locationType === "string" && APPOINTMENT_LOCATION_TYPES.has(object.locationType as AppointmentLocationType)
    ? object.locationType as AppointmentLocationType
    : undefined;
  return {
    ...(optionalString(object.serviceName, 120) ? { serviceName: optionalString(object.serviceName, 120) } : {}),
    ...(optionalString(object.serviceId, 80) ? { serviceId: optionalString(object.serviceId, 80) } : {}),
    ...(optionalString(object.preferredDate, 40) ? { preferredDate: optionalString(object.preferredDate, 40) } : {}),
    ...(optionalString(object.preferredTime, 40) ? { preferredTime: optionalString(object.preferredTime, 40) } : {}),
    ...(optionalString(object.timezone, 80) ? { timezone: optionalString(object.timezone, 80) } : {}),
    ...(optionalString(object.customerName, 120) ? { customerName: optionalString(object.customerName, 120) } : {}),
    ...(optionalString(object.customerPhone, 60) ? { customerPhone: optionalString(object.customerPhone, 60) } : {}),
    ...(optionalString(object.customerLocation, 500) ? { customerLocation: optionalString(object.customerLocation, 500) } : {}),
    ...(locationType ? { locationType } : {}),
    ...(optionalString(object.notes, 1000) ? { notes: optionalString(object.notes, 1000) } : {}),
    missingFields: stringArray(object.missingFields),
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
    const appointmentIntent = appointmentIntentRecord(parsed.appointmentIntent);
    const complaint = complaintRecord(parsed.complaint);
    return {
      intent,
      replyText: typeof parsed.replyText === "string" && parsed.replyText.trim() ? parsed.replyText.trim() : null,
      confidence,
      shouldReply: parsed.shouldReply === true,
      requiresHumanReview: parsed.requiresHumanReview === true,
      reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "No reason provided.",
      usedKnowledge: booleanRecord(parsed.usedKnowledge),
      suggestedAction,
      ...(complaint ? { complaint } : {}),
      ...(appointmentIntent ? { appointmentIntent } : {}),
    };
  } catch {
    return fallbackHumanReviewDecision(AI_DECISION_PARSE_FAILURE_REASON);
  }
}

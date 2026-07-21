import {
  CustomerMemoryCategory,
  CustomerMemoryMissingDetailState,
  CustomerMemorySourceType,
  CustomerMemoryTruthType,
  MessageSenderType,
} from "@prisma/client";
import { ExtractedMemory } from "./customer-memory.types";

type RequestedDetail = { key: string; label: string; pattern: RegExp };

const REQUEST_REJECTION = /\b(?:already (?:have|received|got|confirmed)|(?:we|i) (?:have|received|confirmed)|do not need|don't need|dont need|no longer (?:need|required)|not (?:needed|necessary|required))\b/i;

const REQUESTED_DETAILS: RequestedDetail[] = [
  {
    key: "contact_email",
    label: "customer email address",
    pattern: /\b(?:(?:please|kindly)\s+(?:share|provide|send|confirm)|(?:can|could|would)\s+you\s+(?:share|provide|send|confirm)|what(?:'s| is)|which)\b.{0,50}\b(?:e-?mail|email address)\b|\b(?:e-?mail|email address)\b.{0,40}\b(?:should we use|can we use)\b/i,
  },
  {
    key: "service_location",
    label: "service location",
    pattern: /\b(?:(?:please|kindly)\s+(?:share|provide|send|confirm)|(?:can|could|would)\s+you\s+(?:share|provide|send|confirm))\b.{0,50}\b(?:service location|location|address|site address)\b|\bwhere\s+(?:is|will be)\s+(?:the\s+)?(?:service\s+)?(?:location|address|site|property|project|appointment)\b|\bwhere\b.{0,50}\b(?:service|site|property|project|appointment)\b.{0,30}\b(?:located|taking place|happening)\b/i,
  },
  {
    key: "preferred_appointment_time",
    label: "preferred appointment date or time",
    pattern: /\b(?:(?:please|kindly)\s+(?:share|provide|send|confirm)|(?:can|could|would)\s+you\s+(?:share|provide|send|confirm)|what|which|when)\b.{0,60}\b(?:preferred date|preferred time|date and time|day|time|appointment time)\b/i,
  },
  {
    key: "budget_range",
    label: "customer budget range",
    pattern: /\b(?:(?:please|kindly)\s+(?:share|provide|send|confirm)|(?:can|could|would)\s+you\s+(?:share|provide|send|confirm)|what|which)\b.{0,60}\b(?:budget|budget range|price range)\b|\b(?:budget|budget range)\b.{0,40}\b(?:are you working with|should we use)\b/i,
  },
];

function clauses(content: string) {
  return content
    .normalize("NFKC")
    .split(/(?<=[.!?])\s+|[\r\n]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function aiRequestedDetails(content: string) {
  const requested = new Map<string, Pick<RequestedDetail, "key" | "label">>();
  for (const clause of clauses(content)) {
    if (REQUEST_REJECTION.test(clause)) continue;
    for (const detail of REQUESTED_DETAILS) {
      if (detail.pattern.test(clause)) requested.set(detail.key, { key: detail.key, label: detail.label });
    }
  }
  return Array.from(requested.values());
}

function aiResolvedDetails(content: string) {
  const resolved = new Map<string, { key: string; label: string; state: CustomerMemoryMissingDetailState }>();
  for (const clause of clauses(content)) {
    const state = /\b(?:cancelled|canceled)\b/i.test(clause)
      ? CustomerMemoryMissingDetailState.CANCELLED
      : /\b(?:do not need|don't need|dont need|no longer (?:need|required)|not (?:needed|necessary|required))\b/i.test(clause)
        ? CustomerMemoryMissingDetailState.NO_LONGER_REQUIRED
        : /\b(?:already (?:have|received|got|confirmed)|(?:we|i) (?:have|received|confirmed))\b/i.test(clause)
          ? CustomerMemoryMissingDetailState.PROVIDED
          : null;
    if (!state) continue;
    for (const detail of REQUESTED_DETAILS) {
      const subjectPattern = detail.key === "contact_email"
        ? /\b(?:e-?mail|email address)\b/i
        : detail.key === "service_location"
          ? /\b(?:service location|location|address|site address)\b/i
          : detail.key === "preferred_appointment_time"
            ? /\b(?:preferred date|preferred time|date and time|appointment time)\b/i
            : /\b(?:budget|budget range|price range)\b/i;
      if (subjectPattern.test(clause)) resolved.set(detail.key, { key: detail.key, label: detail.label, state });
    }
  }
  return Array.from(resolved.values());
}

function explicitUnresolvedRequest(content: string) {
  if (/\b(?:the answer is|we recommend|our recommendation is|the best option is|we have already answered)\b/i.test(content)) return null;
  const candidates = clauses(content).filter((clause) => !REQUEST_REJECTION.test(clause));
  for (const clause of candidates) {
    if (/\b(?:please|kindly)\s+(?:confirm|let us know)\b|\b(?:can|could|would)\s+you\s+confirm\b/i.test(clause)) {
      return { key: "customer_confirmation", label: "The business asked the customer for confirmation." };
    }
    if (/\b(?:would you like (?:us )?to proceed|are you ready to proceed|shall we proceed|can we proceed)\b/i.test(clause)) {
      return { key: "proceed_decision", label: "The business asked whether the customer wants to proceed." };
    }
    if (/\b(?:which|what)\b.{0,50}\b(?:service|option|package)\b.{0,30}\b(?:prefer|choose|want|need)\b/i.test(clause)) {
      return { key: "service_choice", label: "The business asked the customer to choose a service or option." };
    }
  }
  return null;
}

function resolvedUnresolvedRequests(content: string) {
  const state = /\b(?:cancelled|canceled)\b/i.test(content)
    ? CustomerMemoryMissingDetailState.CANCELLED
    : /\b(?:do not need|don't need|dont need|no longer (?:need|required)|not (?:needed|necessary|required))\b/i.test(content)
      ? CustomerMemoryMissingDetailState.NO_LONGER_REQUIRED
      : /\b(?:already (?:have|received|got|confirmed)|(?:we|i) (?:have|received|confirmed))\b/i.test(content)
        ? CustomerMemoryMissingDetailState.PROVIDED
        : null;
  if (!state) return [];
  const resolved: Array<{ key: string; label: string }> = [];
  if (/\bconfirm(?:ation|ed)?\b/i.test(content)) {
    resolved.push({ key: "customer_confirmation", label: "customer confirmation" });
  }
  if (/\b(?:proceed|go ahead|move forward)\b/i.test(content)) {
    resolved.push({ key: "proceed_decision", label: "decision about proceeding" });
  }
  if (/\b(?:service|option|package)\b/i.test(content)) {
    resolved.push({ key: "service_choice", label: "service or option choice" });
  }
  return resolved.map((request) => ({ ...request, state }));
}

export function customerMessagesNeedAiExtraction(messages: string[], serviceNames: string[]) {
  const text = messages.join(" ").replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (/^(?:hi|hello|hey|thanks?|thank you|okay|ok|yes|no|sure|great|goodbye|bye)[.! ]*$/i.test(text)) return false;
  if (text.length >= 240) return true;
  if (serviceNames.some((name) => name.length >= 3 && text.toLowerCase().includes(name.toLowerCase()))) return true;
  return /\b(?:want|need|interested|prefer|preference|budget|quote|quotation|price|cost|book|appointment|schedule|location|address|email|phone|call|contact|approval|compare|competitor|expensive|concern|problem|issue|later|tomorrow|next week|next month|not interested)\b/i.test(text);
}

export const customerMemoryDeterministicExtractionService = {
  extract(input: { messageId: string; senderType: MessageSenderType; content: string }): ExtractedMemory[] {
    if (input.senderType === MessageSenderType.STAFF) {
      return [{
        operation: "UPSERT",
        sourceMessageId: input.messageId,
        category: CustomerMemoryCategory.LAST_STAFF_ACTION,
        memoryKey: "last_staff_conversation_activity",
        valueText: "A staff member continued the customer conversation.",
        structuredValue: { sourceMessageId: input.messageId },
        truthType: CustomerMemoryTruthType.STAFF_CONFIRMED,
        sourceType: CustomerMemorySourceType.STAFF_MESSAGE,
        confidence: 1,
      }];
    }
    if (input.senderType !== MessageSenderType.AI) return [];

    const resolvedDetails = aiResolvedDetails(input.content);
    const resolvedRequests = resolvedUnresolvedRequests(input.content);
    const resolvedKeys = new Set(resolvedDetails.map((detail) => detail.key));
    const requestedDetails = aiRequestedDetails(input.content).filter((detail) => !resolvedKeys.has(detail.key));
    const detailMemories: ExtractedMemory[] = [
      ...resolvedDetails.map((detail) => ({
        operation: "RESOLVE" as const,
        sourceMessageId: input.messageId,
        category: CustomerMemoryCategory.MISSING_DETAIL,
        memoryKey: detail.key,
        valueText: `The ${detail.label} is ${detail.state.toLowerCase().replace(/_/g, " ")}.`,
        structuredValue: { sourceMessageId: input.messageId },
        truthType: CustomerMemoryTruthType.AI_INFERRED,
        sourceType: CustomerMemorySourceType.AI_MESSAGE,
        confidence: 1,
        missingDetailState: detail.state,
      })),
      ...requestedDetails.map((detail) => ({
        operation: "UPSERT" as const,
        sourceMessageId: input.messageId,
        category: CustomerMemoryCategory.MISSING_DETAIL,
        memoryKey: detail.key,
        valueText: `The business is waiting for the ${detail.label}.`,
        structuredValue: { sourceMessageId: input.messageId },
        truthType: CustomerMemoryTruthType.AI_INFERRED,
        sourceType: CustomerMemorySourceType.AI_MESSAGE,
        confidence: 1,
        missingDetailState: CustomerMemoryMissingDetailState.REQUESTED,
      })),
      ...resolvedRequests.map((request) => ({
        operation: "RESOLVE" as const,
        sourceMessageId: input.messageId,
        category: CustomerMemoryCategory.UNRESOLVED_REQUEST,
        memoryKey: request.key,
        valueText: `The ${request.label} is ${request.state.toLowerCase().replace(/_/g, " ")}.`,
        structuredValue: { sourceMessageId: input.messageId },
        truthType: CustomerMemoryTruthType.AI_INFERRED,
        sourceType: CustomerMemorySourceType.AI_MESSAGE,
        confidence: 1,
        missingDetailState: request.state,
      })),
    ];
    if (detailMemories.length) return detailMemories;

    const unresolved = explicitUnresolvedRequest(input.content);
    if (unresolved) {
      return [{
        operation: "UPSERT",
        sourceMessageId: input.messageId,
        category: CustomerMemoryCategory.UNRESOLVED_REQUEST,
        memoryKey: unresolved.key,
        valueText: unresolved.label,
        structuredValue: { sourceMessageId: input.messageId },
        truthType: CustomerMemoryTruthType.AI_INFERRED,
        sourceType: CustomerMemorySourceType.AI_MESSAGE,
        confidence: 0.8,
        missingDetailState: CustomerMemoryMissingDetailState.REQUESTED,
      }];
    }
    return [];
  },
};

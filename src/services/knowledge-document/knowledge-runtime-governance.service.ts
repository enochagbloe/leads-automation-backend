import {
  KnowledgeDocumentFactType,
  KnowledgeDocumentStatus,
  KnowledgeGovernanceReviewStatus,
} from "@prisma/client";
import type { KnowledgeGovernanceCanonicalEntityType, Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";

const SENSITIVE_INTENT = /\b(price|pricing|cost|how much|fee|charge|rate|deposit|discount|pay|payment|bank|mobile money|refund|cancel(?:lation)?|book(?:ing)?|appointment|schedule|slot|available|availability|open|clos(?:e|ing)|hours?|duration|how long|address|location|where are you)\b/i;

const INTENT_BY_FACT: Partial<Record<KnowledgeDocumentFactType, RegExp>> = {
  PRICE: /\b(price|pricing|cost|how much|rate|quote|quotation)\b/i,
  FEE: /\b(fee|charge|cost|how much)\b/i,
  DEPOSIT: /\b(deposit|upfront|advance payment)\b/i,
  DISCOUNT: /\b(discount|promotion|offer|deal)\b/i,
  LATE_FEE: /\b(late fee|penalty|late charge)\b/i,
  PAYMENT_METHOD: /\b(pay|payment|mobile money|momo|bank|cash|card)\b/i,
  PAYMENT_INSTRUCTION: /\b(pay|payment|account|mobile money|momo|bank|transfer)\b/i,
  SERVICE_DURATION: /\b(duration|how long|how many (?:minutes|hours|days)|time does)\b/i,
  BUSINESS_HOURS: /\b(open|close|closing|hours|weekend|available|availability)\b/i,
  LOCATION: /\b(location|address|where are you|directions|located)\b/i,
  CONTACT_INFORMATION: /\b(contact|phone|number|email|website|reach you)\b/i,
  BOOKING_RULE: /\b(book|booking|appointment|schedule|slot|available)\b/i,
  APPOINTMENT_POLICY: /\b(book|booking|appointment|confirm|schedule|reschedule)\b/i,
  CANCELLATION_POLICY: /\b(cancel|cancellation|reschedule)\b/i,
  REFUND_RULE: /\b(refund|money back|reimburse)\b/i,
  DELIVERY_INFORMATION: /\b(deliver|delivery|shipping|arrive)\b/i,
  RENTAL_RULE: /\b(rent|rental|hire)\b/i,
  DAMAGE_POLICY: /\b(damage|damaged|breakage)\b/i,
  TERMS: /\b(terms|conditions|policy)\b/i,
};

export type KnowledgeRuntimeGuard = {
  reviewItemId: string;
  documentId: string;
  factId: string | null;
  factType: KnowledgeDocumentFactType | null;
  factLabel: string | null;
  canonicalEntityType: string;
  canonicalEntityId: string | null;
  canonicalField: string | null;
  priority: string;
  currentSettingsValue: unknown;
  documentValue: unknown;
  source: {
    documentTitle: string;
    pageNumber: number | null;
    sheetName: string | null;
    slideNumber: number | null;
  };
};

function isSensitiveCustomerRequest(message: string) {
  return SENSITIVE_INTENT.test(message)
    || Object.values(INTENT_BY_FACT).some((pattern) => pattern.test(message));
}

export function knowledgeRuntimeGuardMatchesMessage(message: string, guard: KnowledgeRuntimeGuard) {
  const factPattern = guard.factType ? INTENT_BY_FACT[guard.factType] : undefined;
  const fieldPattern = guard.canonicalField
    ? INTENT_BY_FACT[
      guard.canonicalField.toLowerCase().includes("price") ? "PRICE"
        : guard.canonicalField.toLowerCase().includes("duration") ? "SERVICE_DURATION"
          : guard.canonicalField.toLowerCase().includes("appointment") ? "APPOINTMENT_POLICY"
            : guard.canonicalField.toLowerCase().includes("hour") ? "BUSINESS_HOURS"
              : "OTHER"
    ]
    : undefined;
  // Labels are not entity identifiers: "consult" and "consultation" may mean
  // the same service. Without a canonical entity, block the relevant category.
  if (!factPattern && !fieldPattern) return isSensitiveCustomerRequest(message);
  return Boolean(factPattern?.test(message) || fieldPattern?.test(message));
}

export async function loadKnowledgeRuntimeGuards(
  businessId: string,
  scope: Pick<Prisma.KnowledgeGovernanceReviewWhereInput, "canonicalEntityType" | "AND"> = {},
): Promise<KnowledgeRuntimeGuard[]> {
  const reviews = await prisma.knowledgeGovernanceReview.findMany({
    where: {
      ...scope,
      businessId,
      reviewStatus: { in: [KnowledgeGovernanceReviewStatus.PENDING_REVIEW, KnowledgeGovernanceReviewStatus.APPLYING] },
      blocksAiUse: true,
      requiresHumanReview: true,
      document: { status: KnowledgeDocumentStatus.ACTIVE, deletedAt: null },
      version: { isActive: true },
    },
    orderBy: [{ priority: "asc" }, { detectedAt: "asc" }],
    select: {
      id: true,
      documentId: true,
      factId: true,
      priority: true,
      canonicalEntityType: true,
      canonicalEntityId: true,
      canonicalField: true,
      existingValue: true,
      documentValue: true,
      document: { select: { title: true } },
      fact: {
        select: {
          factType: true,
          label: true,
          pageNumber: true,
          sheetName: true,
          slideNumber: true,
        },
      },
    },
  });
  return reviews.map((review) => ({
    reviewItemId: review.id,
    documentId: review.documentId,
    factId: review.factId,
    factType: review.fact?.factType ?? null,
    factLabel: review.fact?.label ?? null,
    canonicalEntityType: review.canonicalEntityType,
    canonicalEntityId: review.canonicalEntityId,
    canonicalField: review.canonicalField,
    priority: review.priority,
    currentSettingsValue: review.existingValue,
    documentValue: review.documentValue,
    source: {
      documentTitle: review.document.title,
      pageNumber: review.fact?.pageNumber ?? null,
      sheetName: review.fact?.sheetName ?? null,
      slideNumber: review.fact?.slideNumber ?? null,
    },
  }));
}

export const knowledgeRuntimeGovernanceService = {
  isSensitiveCustomerRequest,

  async evaluateCustomerRequest(input: { businessId: string; message: string }) {
    const guards = await loadKnowledgeRuntimeGuards(input.businessId);
    const matchingGuards = guards.filter((guard) => knowledgeRuntimeGuardMatchesMessage(input.message, guard));
    return {
      blocked: matchingGuards.length > 0,
      matchingGuards,
    };
  },

  async assertOperationalFieldSafe(input: {
    businessId: string;
    canonicalEntityType: KnowledgeGovernanceCanonicalEntityType;
    canonicalEntityId?: string | null;
    canonicalFields: string[];
  }) {
    return loadKnowledgeRuntimeGuards(input.businessId, {
      canonicalEntityType: input.canonicalEntityType,
      AND: [
        ...(input.canonicalEntityId == null ? [] : [{
          OR: [{ canonicalEntityId: input.canonicalEntityId }, { canonicalEntityId: null }],
        }]),
        ...(input.canonicalFields.length === 0 ? [] : [{
          OR: [{ canonicalField: { in: input.canonicalFields } }, { canonicalField: null }],
        }]),
      ],
    });
  },
};

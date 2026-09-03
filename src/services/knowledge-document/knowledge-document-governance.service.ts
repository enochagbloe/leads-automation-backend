import {
  AppointmentConfirmationMode,
  DayOfWeek,
  KnowledgeDocumentDetectedType,
  KnowledgeDocumentFactType,
  KnowledgeFactGovernanceStatus,
  KnowledgeGovernanceCanonicalEntityType,
  KnowledgeGovernanceComparisonType,
  KnowledgeGovernancePriority,
  KnowledgeGovernanceNotificationStatus,
  KnowledgeGovernanceReviewStatus,
  KnowledgeGovernanceStatus,
  Prisma,
} from "@prisma/client";

type GovernanceFact = Prisma.KnowledgeDocumentFactGetPayload<{
  select: {
    id: true;
    factType: true;
    label: true;
    valueText: true;
    currency: true;
    numericValue: true;
    sourceExcerpt: true;
  };
}>;

type CanonicalService = {
  id: string;
  name: string;
  slug: string;
  basePrice: Prisma.Decimal | null;
  currency: string;
  durationMinutes: number | null;
};

type ReviewCandidate = {
  factId?: string;
  comparisonKey: string;
  comparisonType: KnowledgeGovernanceComparisonType;
  priority: KnowledgeGovernancePriority;
  canonicalEntityType: KnowledgeGovernanceCanonicalEntityType;
  canonicalEntityId?: string;
  canonicalField?: string;
  existingValue?: unknown;
  documentValue?: unknown;
  normalizedExistingValue?: string;
  normalizedDocumentValue?: string;
  requiresHumanReview: boolean;
  blocksAiUse: boolean;
  relatedDocumentId?: string;
  relatedVersionId?: string;
};

const DAY_NAMES = Object.values(DayOfWeek);
const CRITICAL_FACT_TYPES = new Set<KnowledgeDocumentFactType>([
  KnowledgeDocumentFactType.PRICE,
  KnowledgeDocumentFactType.FEE,
  KnowledgeDocumentFactType.DEPOSIT,
  KnowledgeDocumentFactType.DISCOUNT,
  KnowledgeDocumentFactType.PAYMENT_INSTRUCTION,
  KnowledgeDocumentFactType.BOOKING_RULE,
  KnowledgeDocumentFactType.APPOINTMENT_POLICY,
  KnowledgeDocumentFactType.CANCELLATION_POLICY,
  KnowledgeDocumentFactType.REFUND_RULE,
  KnowledgeDocumentFactType.LATE_FEE,
]);
const HIGH_FACT_TYPES = new Set<KnowledgeDocumentFactType>([
  KnowledgeDocumentFactType.SERVICE_DURATION,
  KnowledgeDocumentFactType.BUSINESS_HOURS,
  KnowledgeDocumentFactType.LOCATION,
  KnowledgeDocumentFactType.CONTACT_INFORMATION,
  KnowledgeDocumentFactType.CUSTOMER_REQUIREMENT,
  KnowledgeDocumentFactType.REQUIRED_DOCUMENT,
]);

export function normalizeGovernanceText(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}@:+.%]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeGovernanceCurrency(value: string | null | undefined) {
  const normalized = (value ?? "").normalize("NFKC").trim().toUpperCase();
  if (normalized === "GH₵" || normalized === "GH¢") return "GHS";
  return normalized;
}

export function normalizeGovernanceNumber(value: Prisma.Decimal | string | number | null | undefined) {
  if (value === null || value === undefined) return "";
  const raw = String(value).replace(/,/g, "").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return "";
  const [integer = "0", fraction = ""] = raw.split(".");
  const normalizedInteger = integer.replace(/^(-?)0+(?=\d)/, "$1") || "0";
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${normalizedInteger}.${normalizedFraction}` : normalizedInteger;
}

export function knowledgeGovernancePriorityForFact(factType: KnowledgeDocumentFactType) {
  if (CRITICAL_FACT_TYPES.has(factType)) return KnowledgeGovernancePriority.CRITICAL;
  if (HIGH_FACT_TYPES.has(factType)) return KnowledgeGovernancePriority.HIGH;
  return KnowledgeGovernancePriority.NORMAL;
}

export function compareCanonicalGovernanceValues(existing: string, proposed: string) {
  if (!existing) return KnowledgeGovernanceComparisonType.MISSING_IN_SETTINGS;
  return existing === proposed
    ? KnowledgeGovernanceComparisonType.MATCH
    : KnowledgeGovernanceComparisonType.CONFLICT;
}

export function documentRepresentsServiceCatalogue(title: string, type: KnowledgeDocumentDetectedType) {
  if (type !== KnowledgeDocumentDetectedType.SERVICE_INFORMATION
    && type !== KnowledgeDocumentDetectedType.PRICING_INFORMATION
    && type !== KnowledgeDocumentDetectedType.MIXED_BUSINESS_DOCUMENT) return false;
  return /\b(catalog(?:ue)?|service list|services|price list|pricing)\b/i.test(title);
}

function normalizeTime(hour: number, minute: number, meridiem?: string) {
  let normalizedHour = hour;
  if (meridiem?.toLowerCase() === "pm" && normalizedHour < 12) normalizedHour += 12;
  if (meridiem?.toLowerCase() === "am" && normalizedHour === 12) normalizedHour = 0;
  if (normalizedHour > 23 || minute > 59) return null;
  return `${String(normalizedHour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function parseBusinessHoursCandidate(value: string) {
  const normalized = value.normalize("NFKC").toLowerCase();
  const day = DAY_NAMES.find((candidate) => normalized.includes(candidate.toLowerCase()));
  if (!day) return null;
  const afterDay = normalized.slice(normalized.indexOf(day.toLowerCase()) + day.length);
  const matches = [...afterDay.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/g)].slice(0, 2);
  if (matches.length !== 2) return null;
  const openTime = normalizeTime(Number(matches[0]![1]), Number(matches[0]![2] ?? 0), matches[0]![3]);
  const closeTime = normalizeTime(Number(matches[1]![1]), Number(matches[1]![2] ?? 0), matches[1]![3]);
  return openTime && closeTime ? { dayOfWeek: day, isOpen: true, openTime, closeTime } : null;
}

function documentFactValue(fact: GovernanceFact) {
  return {
    label: fact.label,
    valueText: fact.valueText,
    currency: fact.currency,
    numericValue: fact.numericValue?.toString() ?? null,
  };
}

function factText(fact: GovernanceFact) {
  return normalizeGovernanceText(`${fact.valueText} ${fact.sourceExcerpt ?? ""}`);
}

function matchingServices(fact: GovernanceFact, services: CanonicalService[]) {
  const text = factText(fact);
  const matches = services
    .filter((service) => {
      const name = normalizeGovernanceText(service.name);
      const slug = normalizeGovernanceText(service.slug.replace(/-/g, " "));
      return Boolean(name && (text === name || text.includes(name)))
        || Boolean(slug && (text === slug || text.includes(slug)));
    })
    .sort((a, b) => normalizeGovernanceText(b.name).length - normalizeGovernanceText(a.name).length);
  if (matches.length <= 1) return matches;
  const longest = normalizeGovernanceText(matches[0]!.name);
  return matches.filter((service) => normalizeGovernanceText(service.name).length === longest.length);
}

function comparison(input: Omit<ReviewCandidate, "comparisonKey">): ReviewCandidate {
  return {
    ...input,
    comparisonKey: [
      input.factId ?? "document",
      input.comparisonType,
      input.canonicalEntityType,
      input.canonicalEntityId ?? "none",
      input.canonicalField ?? "none",
      input.relatedVersionId ?? "none",
    ].join(":"),
  };
}

function resultForServiceFact(fact: GovernanceFact, services: CanonicalService[]): ReviewCandidate | null {
  const serviceFactTypes = new Set<KnowledgeDocumentFactType>([
    KnowledgeDocumentFactType.SERVICE,
    KnowledgeDocumentFactType.PRICE,
    KnowledgeDocumentFactType.SERVICE_DURATION,
  ]);
  if (!serviceFactTypes.has(fact.factType)) {
    return null;
  }
  const priority = knowledgeGovernancePriorityForFact(fact.factType);
  const identifiedServices = matchingServices(fact, services);
  const matches = identifiedServices.length === 0
    && services.length === 1
    && fact.factType !== KnowledgeDocumentFactType.SERVICE
    ? services
    : identifiedServices;
  const canonicalField = fact.factType === KnowledgeDocumentFactType.PRICE
    ? "basePrice"
    : fact.factType === KnowledgeDocumentFactType.SERVICE_DURATION
      ? "durationMinutes"
      : "name";
  if (matches.length !== 1) {
    return comparison({
      factId: fact.id,
      comparisonType: matches.length ? KnowledgeGovernanceComparisonType.CONFLICT : KnowledgeGovernanceComparisonType.MISSING_IN_SETTINGS,
      priority,
      canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.SERVICE,
      canonicalField,
      existingValue: matches.length ? matches.map(({ id, name }) => ({ id, name })) : undefined,
      documentValue: documentFactValue(fact),
      normalizedDocumentValue: factText(fact),
      requiresHumanReview: true,
      blocksAiUse: true,
    });
  }

  const service = matches[0]!;
  let existing: string;
  let proposed: string;
  if (fact.factType === KnowledgeDocumentFactType.PRICE) {
    existing = service.basePrice === null
      ? ""
      : `${normalizeGovernanceCurrency(service.currency)}:${normalizeGovernanceNumber(service.basePrice)}`;
    proposed = `${normalizeGovernanceCurrency(fact.currency ?? service.currency)}:${normalizeGovernanceNumber(fact.numericValue)}`;
  } else if (fact.factType === KnowledgeDocumentFactType.SERVICE_DURATION) {
    existing = normalizeGovernanceNumber(service.durationMinutes);
    proposed = normalizeGovernanceNumber(fact.numericValue);
  } else {
    existing = normalizeGovernanceText(service.name);
    proposed = existing;
  }
  const matchesCanonical = Boolean(existing && proposed && existing === proposed);
  return comparison({
    factId: fact.id,
    comparisonType: compareCanonicalGovernanceValues(existing, proposed),
    priority,
    canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.SERVICE,
    canonicalEntityId: service.id,
    canonicalField,
    existingValue: {
      serviceName: service.name,
      value: fact.factType === KnowledgeDocumentFactType.PRICE
        ? service.basePrice?.toString() ?? null
        : fact.factType === KnowledgeDocumentFactType.SERVICE_DURATION
          ? service.durationMinutes
          : service.name,
      ...(fact.factType === KnowledgeDocumentFactType.PRICE ? { currency: service.currency } : {}),
    },
    documentValue: documentFactValue(fact),
    normalizedExistingValue: existing,
    normalizedDocumentValue: proposed,
    requiresHumanReview: !matchesCanonical,
    blocksAiUse: !matchesCanonical,
  });
}

export function profileComparison(fact: GovernanceFact, business: {
  email: string | null;
  phone: string | null;
  website: string | null;
  defaultNotificationEmail: string | null;
  address: string | null;
  city: string | null;
  serviceArea: string | null;
}) {
  if (fact.factType !== KnowledgeDocumentFactType.CONTACT_INFORMATION && fact.factType !== KnowledgeDocumentFactType.LOCATION) return null;
  const profile = fact.factType === KnowledgeDocumentFactType.CONTACT_INFORMATION
    ? [
      ["email", business.email],
      ["phone", business.phone],
      ["website", business.website],
      ["defaultNotificationEmail", business.defaultNotificationEmail],
    ] as const
    : [
      ["address", business.address],
      ["city", business.city],
      ["serviceArea", business.serviceArea],
    ] as const;
  const proposed = factText(fact);
  const exact = profile.find(([, value]) => value && proposed.includes(normalizeGovernanceText(value)));
  const existingValues = profile.filter(([, value]) => value).map(([field, value]) => ({ field, value }));
  const proposedField = fact.factType === KnowledgeDocumentFactType.LOCATION
    ? "address"
    : /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i.test(fact.valueText)
      ? "email"
      : /https?:\/\//i.test(fact.valueText)
        ? "website"
        : /\+?[0-9][0-9\s().-]{5,}[0-9]/.test(fact.valueText)
          ? "phone"
          : undefined;
  const targetField = exact?.[0] ?? proposedField;
  const targetCurrentValue = targetField ? profile.find(([field]) => field === targetField)?.[1] : null;
  return comparison({
    factId: fact.id,
    comparisonType: exact
      ? KnowledgeGovernanceComparisonType.MATCH
      : (targetField ? Boolean(targetCurrentValue) : existingValues.length > 0)
        ? KnowledgeGovernanceComparisonType.CONFLICT
        : KnowledgeGovernanceComparisonType.MISSING_IN_SETTINGS,
    priority: KnowledgeGovernancePriority.HIGH,
    canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.BUSINESS_PROFILE,
    canonicalField: targetField,
    existingValue: exact ? { field: exact[0], value: exact[1] } : existingValues,
    documentValue: documentFactValue(fact),
    normalizedExistingValue: targetField ? normalizeGovernanceText(targetCurrentValue) : undefined,
    normalizedDocumentValue: proposed,
    requiresHumanReview: !exact,
    blocksAiUse: !exact,
  });
}

function availabilityComparison(fact: GovernanceFact, availability: Array<{
  id: string;
  dayOfWeek: DayOfWeek;
  isOpen: boolean;
  openTime: string | null;
  closeTime: string | null;
}>) {
  if (fact.factType !== KnowledgeDocumentFactType.BUSINESS_HOURS) return null;
  const proposed = parseBusinessHoursCandidate(fact.valueText);
  const current = proposed ? availability.find((rule) => rule.dayOfWeek === proposed.dayOfWeek) : null;
  const exact = Boolean(current && current.isOpen === proposed?.isOpen
    && current.openTime === proposed.openTime && current.closeTime === proposed.closeTime);
  return comparison({
    factId: fact.id,
    comparisonType: !current
      ? KnowledgeGovernanceComparisonType.MISSING_IN_SETTINGS
      : exact
        ? KnowledgeGovernanceComparisonType.MATCH
        : KnowledgeGovernanceComparisonType.CONFLICT,
    priority: KnowledgeGovernancePriority.HIGH,
    canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.BUSINESS_AVAILABILITY,
    canonicalEntityId: current?.id,
    canonicalField: proposed?.dayOfWeek ?? "weeklyHours",
    existingValue: current ?? undefined,
    documentValue: proposed ?? documentFactValue(fact),
    normalizedExistingValue: current ? `${current.dayOfWeek}:${current.isOpen}:${current.openTime}:${current.closeTime}` : undefined,
    normalizedDocumentValue: proposed ? `${proposed.dayOfWeek}:${proposed.isOpen}:${proposed.openTime}:${proposed.closeTime}` : factText(fact),
    requiresHumanReview: !exact,
    blocksAiUse: !exact,
  });
}

function appointmentModeFromFact(fact: GovernanceFact) {
  const value = factText(fact);
  if (/manual confirmation|manually confirm|team confirmation/.test(value)) return AppointmentConfirmationMode.MANUAL_CONFIRMATION_REQUIRED;
  if (/auto(?:matic(?:ally)?)? confirm[^.]{0,80}staff/.test(value)) return AppointmentConfirmationMode.AUTO_CONFIRM_WHEN_STAFF_ASSIGNED;
  if (/auto(?:matic(?:ally)?)? confirm|safe booking/.test(value)) return AppointmentConfirmationMode.AUTO_CONFIRM_SAFE_BOOKINGS;
  return null;
}

function appointmentComparison(fact: GovernanceFact, currentMode: AppointmentConfirmationMode) {
  if (fact.factType !== KnowledgeDocumentFactType.APPOINTMENT_POLICY && fact.factType !== KnowledgeDocumentFactType.BOOKING_RULE) return null;
  const proposed = appointmentModeFromFact(fact);
  const exact = proposed === currentMode;
  return comparison({
    factId: fact.id,
    comparisonType: proposed
      ? exact ? KnowledgeGovernanceComparisonType.MATCH : KnowledgeGovernanceComparisonType.CONFLICT
      : KnowledgeGovernanceComparisonType.MISSING_IN_SETTINGS,
    priority: KnowledgeGovernancePriority.CRITICAL,
    canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.APPOINTMENT_SETTINGS,
    canonicalField: "appointmentConfirmationMode",
    existingValue: { appointmentConfirmationMode: currentMode },
    documentValue: proposed ? { appointmentConfirmationMode: proposed } : documentFactValue(fact),
    normalizedExistingValue: currentMode,
    normalizedDocumentValue: proposed ?? factText(fact),
    requiresHumanReview: !exact,
    blocksAiUse: !exact,
  });
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function evaluateAndPersistKnowledgeGovernance(
  tx: Prisma.TransactionClient,
  input: {
    businessId: string;
    documentId: string;
    versionId: string;
    versionNumber: number;
    documentTitle: string;
    detectedDocumentType: KnowledgeDocumentDetectedType;
    analysisRequiresHumanReview: boolean;
  },
) {
  const [business, facts, priorApprovedFacts, priorVersions, relatedDocuments] = await Promise.all([
    tx.business.findUniqueOrThrow({
      where: { id: input.businessId },
      select: {
        email: true,
        phone: true,
        website: true,
        defaultNotificationEmail: true,
        address: true,
        city: true,
        serviceArea: true,
        appointmentConfirmationMode: true,
        services: {
          where: { isArchived: false, isActive: true },
          select: { id: true, name: true, slug: true, basePrice: true, currency: true, durationMinutes: true },
        },
        availability: {
          where: { isActive: true },
          select: { id: true, dayOfWeek: true, isOpen: true, openTime: true, closeTime: true },
        },
      },
    }),
    tx.knowledgeDocumentFact.findMany({
      where: { businessId: input.businessId, documentId: input.documentId, versionId: input.versionId },
      select: {
        id: true,
        factType: true,
        label: true,
        valueText: true,
        currency: true,
        numericValue: true,
        sourceExcerpt: true,
      },
    }),
    tx.knowledgeDocumentFact.findMany({
      where: {
        businessId: input.businessId,
        versionId: { not: input.versionId },
        governanceStatus: KnowledgeFactGovernanceStatus.APPROVED,
      },
      select: { id: true, factType: true, valueText: true, versionId: true, documentId: true },
      take: 1_000,
    }),
    tx.knowledgeDocumentVersion.findMany({
      where: { businessId: input.businessId, documentId: input.documentId, versionNumber: { lt: input.versionNumber } },
      orderBy: { versionNumber: "desc" },
      take: 1,
      select: { id: true },
    }),
    tx.knowledgeDocument.findMany({
      where: {
        businessId: input.businessId,
        id: { not: input.documentId },
        deletedAt: null,
        status: { not: "DELETED" },
        title: { equals: input.documentTitle, mode: "insensitive" },
      },
      select: { id: true, activeVersionId: true },
      take: 10,
    }),
  ]);

  const candidates: ReviewCandidate[] = [];
  const factStatuses = new Map<string, KnowledgeFactGovernanceStatus>();
  for (const fact of facts) {
    let candidate = resultForServiceFact(fact, business.services)
      ?? profileComparison(fact, business)
      ?? availabilityComparison(fact, business.availability)
      ?? appointmentComparison(fact, business.appointmentConfirmationMode);
    if (!candidate) {
      const normalized = factText(fact);
      const prior = priorApprovedFacts.find((item) => item.factType === fact.factType
        && normalizeGovernanceText(item.valueText) === normalized);
      candidate = comparison({
        factId: fact.id,
        comparisonType: prior ? KnowledgeGovernanceComparisonType.MATCH : KnowledgeGovernanceComparisonType.MISSING_IN_SETTINGS,
        priority: knowledgeGovernancePriorityForFact(fact.factType),
        canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.APPROVED_KNOWLEDGE,
        canonicalEntityId: prior?.id,
        canonicalField: fact.factType,
        existingValue: prior ? { factId: prior.id, valueText: prior.valueText } : undefined,
        documentValue: documentFactValue(fact),
        normalizedExistingValue: prior ? normalized : undefined,
        normalizedDocumentValue: normalized,
        requiresHumanReview: !prior,
        blocksAiUse: !prior,
        relatedDocumentId: prior?.documentId,
        relatedVersionId: prior?.versionId,
      });
    }
    candidates.push(candidate);
    factStatuses.set(
      fact.id,
      candidate.comparisonType === KnowledgeGovernanceComparisonType.MATCH
        ? KnowledgeFactGovernanceStatus.APPROVED
        : candidate.comparisonType === KnowledgeGovernanceComparisonType.CONFLICT
          ? KnowledgeFactGovernanceStatus.CONFLICT
          : KnowledgeFactGovernanceStatus.PENDING_REVIEW,
    );
  }

  if (documentRepresentsServiceCatalogue(input.documentTitle, input.detectedDocumentType)) {
    const representedServiceIds = new Set(facts.flatMap((fact) => matchingServices(fact, business.services).map((service) => service.id)));
    for (const service of business.services.filter((item) => !representedServiceIds.has(item.id))) {
      candidates.push(comparison({
        comparisonType: KnowledgeGovernanceComparisonType.MISSING_IN_DOCUMENT,
        priority: KnowledgeGovernancePriority.NORMAL,
        canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.SERVICE,
        canonicalEntityId: service.id,
        canonicalField: "name",
        existingValue: { name: service.name },
        normalizedExistingValue: normalizeGovernanceText(service.name),
        requiresHumanReview: true,
        blocksAiUse: false,
      }));
    }
  }

  const replacementVersions = [
    ...priorVersions.map((version) => ({ documentId: input.documentId, versionId: version.id })),
    ...relatedDocuments.filter((document) => document.activeVersionId).map((document) => ({
      documentId: document.id,
      versionId: document.activeVersionId!,
    })),
  ];
  for (const replacement of replacementVersions) {
    candidates.push(comparison({
      comparisonType: KnowledgeGovernanceComparisonType.POTENTIAL_REPLACEMENT,
      priority: KnowledgeGovernancePriority.NORMAL,
      canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.DOCUMENT_VERSION,
      canonicalEntityId: replacement.versionId,
      canonicalField: "activeVersionId",
      existingValue: replacement,
      documentValue: { documentId: input.documentId, versionId: input.versionId },
      requiresHumanReview: true,
      blocksAiUse: true,
      relatedDocumentId: replacement.documentId,
      relatedVersionId: replacement.versionId,
    }));
  }

  await tx.knowledgeGovernanceReview.deleteMany({
    where: { businessId: input.businessId, documentId: input.documentId, versionId: input.versionId },
  });
  const governedAt = new Date();
  const factIdsByStatus = new Map<KnowledgeFactGovernanceStatus, string[]>();
  for (const [factId, governanceStatus] of factStatuses) {
    const ids = factIdsByStatus.get(governanceStatus) ?? [];
    ids.push(factId);
    factIdsByStatus.set(governanceStatus, ids);
  }
  await Promise.all([...factIdsByStatus].map(([governanceStatus, ids]) => tx.knowledgeDocumentFact.updateMany({
    where: {
      id: { in: ids },
      businessId: input.businessId,
      documentId: input.documentId,
      versionId: input.versionId,
    },
    data: { governanceStatus, governedAt },
  })));
  if (candidates.length) {
    await tx.knowledgeGovernanceReview.createMany({
      data: candidates.map((candidate) => ({
        businessId: input.businessId,
        documentId: input.documentId,
        versionId: input.versionId,
        factId: candidate.factId,
        comparisonKey: candidate.comparisonKey,
        comparisonType: candidate.comparisonType,
        priority: candidate.priority,
        reviewStatus: candidate.requiresHumanReview
          ? KnowledgeGovernanceReviewStatus.PENDING_REVIEW
          : KnowledgeGovernanceReviewStatus.RESOLVED,
        canonicalEntityType: candidate.canonicalEntityType,
        canonicalEntityId: candidate.canonicalEntityId,
        canonicalField: candidate.canonicalField,
        existingValue: candidate.existingValue === undefined ? undefined : json(candidate.existingValue),
        documentValue: candidate.documentValue === undefined ? undefined : json(candidate.documentValue),
        normalizedExistingValue: candidate.normalizedExistingValue,
        normalizedDocumentValue: candidate.normalizedDocumentValue,
        requiresHumanReview: candidate.requiresHumanReview,
        blocksAiUse: candidate.blocksAiUse,
        relatedDocumentId: candidate.relatedDocumentId,
        relatedVersionId: candidate.relatedVersionId,
        criticalNotificationStatus: candidate.requiresHumanReview
          && candidate.comparisonType === KnowledgeGovernanceComparisonType.CONFLICT
          && candidate.priority === KnowledgeGovernancePriority.CRITICAL
          ? KnowledgeGovernanceNotificationStatus.PENDING
          : undefined,
        criticalNotificationNextAttemptAt: candidate.requiresHumanReview
          && candidate.comparisonType === KnowledgeGovernanceComparisonType.CONFLICT
          && candidate.priority === KnowledgeGovernancePriority.CRITICAL
          ? governedAt
          : undefined,
      })),
    });
  }

  const unresolved = candidates.filter((candidate) => candidate.requiresHumanReview).length;
  const approvedFacts = [...factStatuses.values()].filter((status) => status === KnowledgeFactGovernanceStatus.APPROVED).length;
  const governanceStatus = !input.analysisRequiresHumanReview && unresolved === 0 && approvedFacts === facts.length
    ? KnowledgeGovernanceStatus.APPROVED
    : KnowledgeGovernanceStatus.REVIEW_REQUIRED;
  await Promise.all([
    tx.knowledgeDocument.updateMany({
      where: { id: input.documentId, businessId: input.businessId, activeVersionId: input.versionId },
      data: { governanceStatus },
    }),
    tx.knowledgeDocumentVersion.updateMany({
      where: { id: input.versionId, documentId: input.documentId, businessId: input.businessId, isActive: true },
      data: { governanceStatus },
    }),
    tx.knowledgeDocumentAnalysis.updateMany({
      where: { versionId: input.versionId, documentId: input.documentId, businessId: input.businessId },
      data: { requiresHumanReview: governanceStatus === KnowledgeGovernanceStatus.REVIEW_REQUIRED },
    }),
  ]);

  return {
    governanceStatus,
    factCount: facts.length,
    approvedFactCount: approvedFacts,
    pendingFactCount: facts.length - approvedFacts,
    reviewCount: candidates.length,
    unresolvedReviewCount: unresolved,
    conflictCount: candidates.filter((candidate) => candidate.comparisonType === KnowledgeGovernanceComparisonType.CONFLICT).length,
    criticalCount: candidates.filter((candidate) => candidate.priority === KnowledgeGovernancePriority.CRITICAL && candidate.requiresHumanReview).length,
  };
}

import {
  KnowledgeGovernanceCanonicalEntityType,
  KnowledgeGovernanceComparisonType,
  KnowledgeGovernanceResolutionAction,
} from "@prisma/client";

type ReviewPolicyInput = {
  comparisonType: KnowledgeGovernanceComparisonType;
  canonicalEntityType: KnowledgeGovernanceCanonicalEntityType;
  canonicalEntityId?: string | null;
  canonicalField?: string | null;
};

export function allowedKnowledgeGovernanceActions(review: ReviewPolicyInput) {
  const actions = new Set<KnowledgeGovernanceResolutionAction>();

  if (review.comparisonType === KnowledgeGovernanceComparisonType.CONFLICT) {
    actions.add(KnowledgeGovernanceResolutionAction.KEEP_CURRENT_SETTINGS);
    const hasStructuredTarget = Boolean(review.canonicalField)
      && (review.canonicalEntityType !== KnowledgeGovernanceCanonicalEntityType.SERVICE || Boolean(review.canonicalEntityId));
    if (review.canonicalEntityType !== KnowledgeGovernanceCanonicalEntityType.APPROVED_KNOWLEDGE && hasStructuredTarget) {
      actions.add(KnowledgeGovernanceResolutionAction.UPDATE_SETTINGS);
    }
  }

  if (review.comparisonType === KnowledgeGovernanceComparisonType.MISSING_IN_SETTINGS) {
    if (review.canonicalField && (
      review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.BUSINESS_PROFILE
      || review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.BUSINESS_AVAILABILITY
      || review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.APPOINTMENT_SETTINGS
      || (review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.SERVICE && review.canonicalEntityId)
    )) actions.add(KnowledgeGovernanceResolutionAction.UPDATE_SETTINGS);
    if (review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.SERVICE && !review.canonicalEntityId) {
      actions.add(KnowledgeGovernanceResolutionAction.ADD_TO_SETTINGS);
    }
    if (review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.APPROVED_KNOWLEDGE) {
      actions.add(KnowledgeGovernanceResolutionAction.APPROVE_KNOWLEDGE_ONLY);
    }
    actions.add(KnowledgeGovernanceResolutionAction.REVIEW_NOT_APPLIED);
  }

  if (review.comparisonType === KnowledgeGovernanceComparisonType.MISSING_IN_DOCUMENT) {
    actions.add(KnowledgeGovernanceResolutionAction.KEEP_CURRENT_SETTINGS);
    if (review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.SERVICE && review.canonicalEntityId) {
      actions.add(KnowledgeGovernanceResolutionAction.ARCHIVE);
    }
    actions.add(KnowledgeGovernanceResolutionAction.REVIEW_NOT_APPLIED);
  }

  if (review.comparisonType === KnowledgeGovernanceComparisonType.POTENTIAL_REPLACEMENT) {
    actions.add(KnowledgeGovernanceResolutionAction.REPLACE);
    actions.add(KnowledgeGovernanceResolutionAction.REVIEW_NOT_APPLIED);
  }

  return [...actions];
}

export function isKnowledgeSettingsMutation(action: KnowledgeGovernanceResolutionAction) {
  return action === KnowledgeGovernanceResolutionAction.UPDATE_SETTINGS
    || action === KnowledgeGovernanceResolutionAction.ADD_TO_SETTINGS
    || action === KnowledgeGovernanceResolutionAction.ARCHIVE;
}

type ReplacementFact = {
  id: string;
  factType: string;
  label: string;
  valueText: string;
  currency?: string | null;
  numericValue?: { toString(): string } | string | number | null;
};

function normalizedReplacementText(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function replacementKey(fact: ReplacementFact) {
  return `${fact.factType}:${normalizedReplacementText(fact.label)}`;
}

function replacementValue(fact: ReplacementFact) {
  return [
    normalizedReplacementText(fact.valueText),
    (fact.currency ?? "").toUpperCase(),
    fact.numericValue == null ? "" : String(fact.numericValue),
  ].join(":");
}

export function classifyKnowledgeReplacementFacts(oldFacts: ReplacementFact[], newFacts: ReplacementFact[]) {
  const remainingOld = oldFacts.map((fact) => ({ fact, consumed: false }));
  const comparisons = newFacts.map((newFact) => {
    const old = remainingOld.find((candidate) => !candidate.consumed && replacementKey(candidate.fact) === replacementKey(newFact));
    if (!old) return { classification: "NEW" as const, oldFact: null, newFact };
    old.consumed = true;
    return {
      classification: replacementValue(old.fact) === replacementValue(newFact) ? "UNCHANGED" as const : "CHANGED" as const,
      oldFact: old.fact,
      newFact,
    };
  });
  return [
    ...comparisons,
    ...remainingOld.filter((candidate) => !candidate.consumed).map(({ fact }) => ({
      classification: "REMOVED" as const,
      oldFact: fact,
      newFact: null,
    })),
  ];
}

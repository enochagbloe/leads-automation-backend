import assert from "node:assert/strict";
import test from "node:test";
import {
  KnowledgeGovernanceCanonicalEntityType,
  KnowledgeGovernanceComparisonType,
  KnowledgeGovernanceResolutionAction,
} from "@prisma/client";
import {
  allowedKnowledgeGovernanceActions,
  classifyKnowledgeReplacementFacts,
} from "../src/services/knowledge-document/knowledge-governance-resolution-policy";
import {
  permanentlyDeleteKnowledgeDocumentSchema,
  resolveKnowledgeGovernanceReviewBatchSchema,
  resolveKnowledgeGovernanceReviewSchema,
} from "../src/validation/knowledge.schemas";

test("service conflicts permit update or keep-current only", () => {
  assert.deepEqual(new Set(allowedKnowledgeGovernanceActions({
    comparisonType: KnowledgeGovernanceComparisonType.CONFLICT,
    canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.SERVICE,
    canonicalEntityId: "service-1",
    canonicalField: "basePrice",
  })), new Set([
    KnowledgeGovernanceResolutionAction.UPDATE_SETTINGS,
    KnowledgeGovernanceResolutionAction.KEEP_CURRENT_SETTINGS,
  ]));
});

test("ambiguous conflicts cannot update an unidentified settings target", () => {
  const actions = allowedKnowledgeGovernanceActions({
    comparisonType: KnowledgeGovernanceComparisonType.CONFLICT,
    canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.SERVICE,
    canonicalEntityId: null,
    canonicalField: "basePrice",
  });
  assert.equal(actions.includes(KnowledgeGovernanceResolutionAction.UPDATE_SETTINGS), false);
  assert.equal(actions.includes(KnowledgeGovernanceResolutionAction.KEEP_CURRENT_SETTINGS), true);
});

test("missing services may be added but not silently archived", () => {
  const actions = allowedKnowledgeGovernanceActions({
    comparisonType: KnowledgeGovernanceComparisonType.MISSING_IN_SETTINGS,
    canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.SERVICE,
    canonicalEntityId: null,
  });
  assert.equal(actions.includes(KnowledgeGovernanceResolutionAction.ADD_TO_SETTINGS), true);
  assert.equal(actions.includes(KnowledgeGovernanceResolutionAction.ARCHIVE), false);
});

test("absence from a catalogue requires an explicit keep or archive decision", () => {
  const actions = allowedKnowledgeGovernanceActions({
    comparisonType: KnowledgeGovernanceComparisonType.MISSING_IN_DOCUMENT,
    canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.SERVICE,
    canonicalEntityId: "service-1",
  });
  assert.equal(actions.includes(KnowledgeGovernanceResolutionAction.KEEP_CURRENT_SETTINGS), true);
  assert.equal(actions.includes(KnowledgeGovernanceResolutionAction.ARCHIVE), true);
});

test("replacement candidates cannot mutate settings", () => {
  assert.deepEqual(new Set(allowedKnowledgeGovernanceActions({
    comparisonType: KnowledgeGovernanceComparisonType.POTENTIAL_REPLACEMENT,
    canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.DOCUMENT_VERSION,
    canonicalEntityId: "version-1",
  })), new Set([
    KnowledgeGovernanceResolutionAction.REPLACE,
    KnowledgeGovernanceResolutionAction.REVIEW_NOT_APPLIED,
  ]));
});

test("resolution input requires a version and supported action", () => {
  assert.equal(resolveKnowledgeGovernanceReviewSchema.safeParse({
    expectedVersionId: "version-1",
    action: "UPDATE_SETTINGS",
  }).success, true);
  assert.equal(resolveKnowledgeGovernanceReviewSchema.safeParse({ action: "UPDATE_SETTINGS" }).success, false);
  assert.equal(resolveKnowledgeGovernanceReviewSchema.safeParse({
    expectedVersionId: "version-1",
    action: "ARBITRARY_DATABASE_COMMAND",
  }).success, false);
});

test("batch decisions are bounded and carry independent idempotency keys", () => {
  assert.equal(resolveKnowledgeGovernanceReviewBatchSchema.safeParse({
    decisions: [{
      reviewId: "review-1",
      idempotencyKey: "decision-123",
      expectedVersionId: "version-1",
      action: "KEEP_CURRENT_SETTINGS",
    }],
  }).success, true);
  assert.equal(resolveKnowledgeGovernanceReviewBatchSchema.safeParse({ decisions: [] }).success, false);
});

test("permanent deletion requires an explicit true confirmation", () => {
  assert.equal(permanentlyDeleteKnowledgeDocumentSchema.safeParse({ confirmPermanentDelete: true }).success, true);
  assert.equal(permanentlyDeleteKnowledgeDocumentSchema.safeParse({ confirmPermanentDelete: false }).success, false);
  assert.equal(permanentlyDeleteKnowledgeDocumentSchema.safeParse({}).success, false);
});

test("replacement comparison classifies changed, new, removed, and unchanged facts", () => {
  const result = classifyKnowledgeReplacementFacts([
    { id: "old-price", factType: "PRICE", label: "Consultation", valueText: "GHS 400", currency: "GHS", numericValue: 400 },
    { id: "old-faq", factType: "FAQ", label: "Parking", valueText: "Parking is free" },
    { id: "old-removed", factType: "SERVICE", label: "Legacy", valueText: "Legacy service" },
  ], [
    { id: "new-price", factType: "PRICE", label: "Consultation", valueText: "GHS 500", currency: "GHS", numericValue: 500 },
    { id: "new-faq", factType: "FAQ", label: "Parking", valueText: "Parking is free" },
    { id: "new-service", factType: "SERVICE", label: "Drone", valueText: "Drone coverage" },
  ]);
  assert.deepEqual(result.map((item) => item.classification).sort(), ["CHANGED", "NEW", "REMOVED", "UNCHANGED"]);
});

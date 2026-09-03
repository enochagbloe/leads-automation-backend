import assert from "node:assert/strict";
import test from "node:test";
import {
  KnowledgeDocumentDetectedType,
  KnowledgeDocumentFactType,
  KnowledgeGovernanceComparisonType,
  KnowledgeGovernancePriority,
} from "@prisma/client";
import {
  compareCanonicalGovernanceValues,
  documentRepresentsServiceCatalogue,
  knowledgeGovernancePriorityForFact,
  normalizeGovernanceCurrency,
  normalizeGovernanceNumber,
  normalizeGovernanceText,
  parseBusinessHoursCandidate,
} from "../src/services/knowledge-document/knowledge-document-governance.service";

test("equivalent price values normalize to a match", () => {
  const settings = `${normalizeGovernanceCurrency("GHS")}:${normalizeGovernanceNumber("500.00")}`;
  const document = `${normalizeGovernanceCurrency("GH₵")}:${normalizeGovernanceNumber("0500")}`;
  assert.equal(compareCanonicalGovernanceValues(settings, document), KnowledgeGovernanceComparisonType.MATCH);
});

test("different normalized prices are a conflict", () => {
  assert.equal(
    compareCanonicalGovernanceValues("GHS:400", "GHS:500"),
    KnowledgeGovernanceComparisonType.CONFLICT,
  );
});

test("missing canonical values remain proposals and are not treated as matches", () => {
  assert.equal(
    compareCanonicalGovernanceValues("", normalizeGovernanceText("Drone Coverage")),
    KnowledgeGovernanceComparisonType.MISSING_IN_SETTINGS,
  );
});

test("operational facts receive deterministic review priority", () => {
  assert.equal(knowledgeGovernancePriorityForFact(KnowledgeDocumentFactType.PRICE), KnowledgeGovernancePriority.CRITICAL);
  assert.equal(knowledgeGovernancePriorityForFact(KnowledgeDocumentFactType.BUSINESS_HOURS), KnowledgeGovernancePriority.HIGH);
  assert.equal(knowledgeGovernancePriorityForFact(KnowledgeDocumentFactType.FAQ), KnowledgeGovernancePriority.NORMAL);
});

test("business hours are normalized without changing their day", () => {
  assert.deepEqual(parseBusinessHoursCandidate("Monday: 8:30 AM - 5 PM"), {
    dayOfWeek: "MONDAY",
    isOpen: true,
    openTime: "08:30",
    closeTime: "17:00",
  });
});

test("missing-in-document checks require meaningful catalogue scope", () => {
  assert.equal(
    documentRepresentsServiceCatalogue("2026 Service Catalogue", KnowledgeDocumentDetectedType.SERVICE_INFORMATION),
    true,
  );
  assert.equal(
    documentRepresentsServiceCatalogue("Customer notes", KnowledgeDocumentDetectedType.SERVICE_INFORMATION),
    false,
  );
});

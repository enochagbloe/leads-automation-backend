import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeDocumentFactType, KnowledgeFactGovernanceStatus } from "@prisma/client";
import { knowledgeFactIsRuntimeUsable } from "../src/services/knowledge-document/knowledge-document-runtime-policy";
import {
  KnowledgeRuntimeGuard,
  knowledgeRuntimeGuardMatchesMessage,
  knowledgeRuntimeGovernanceService,
} from "../src/services/knowledge-document/knowledge-runtime-governance.service";
import { knowledgeSettingBindingIsOutdated } from "../src/services/knowledge-document/knowledge-settings-reconciliation.service";

function guard(overrides: Partial<KnowledgeRuntimeGuard> = {}): KnowledgeRuntimeGuard {
  return {
    reviewItemId: "review-1",
    documentId: "document-1",
    factId: "fact-1",
    factType: KnowledgeDocumentFactType.PRICE,
    factLabel: "Consultation price",
    canonicalEntityType: "SERVICE",
    canonicalEntityId: "service-1",
    canonicalField: "basePrice",
    priority: "CRITICAL",
    currentSettingsValue: { amount: 400, currency: "GHS" },
    documentValue: { amount: 500, currency: "GHS" },
    source: { documentTitle: "Pricing.pdf", pageNumber: 2, sheetName: null, slideNumber: null },
    ...overrides,
  };
}

test("only current approved and unguarded facts are runtime usable", () => {
  assert.equal(knowledgeFactIsRuntimeUsable({
    governanceStatus: KnowledgeFactGovernanceStatus.APPROVED,
    activeDocument: true,
    activeVersion: true,
    blockedByUnresolvedReview: false,
  }), true);
  for (const governanceStatus of [
    KnowledgeFactGovernanceStatus.PENDING_REVIEW,
    KnowledgeFactGovernanceStatus.CONFLICT,
    KnowledgeFactGovernanceStatus.REJECTED,
    KnowledgeFactGovernanceStatus.SUPERSEDED,
    KnowledgeFactGovernanceStatus.ARCHIVED,
    KnowledgeFactGovernanceStatus.OUTDATED,
  ]) {
    assert.equal(knowledgeFactIsRuntimeUsable({
      governanceStatus,
      activeDocument: true,
      activeVersion: true,
      blockedByUnresolvedReview: false,
    }), false);
  }
});

test("a relevant price request matches its field guard without matching unrelated location questions", () => {
  assert.equal(knowledgeRuntimeGuardMatchesMessage("How much is the consultation?", guard()), true);
  assert.equal(knowledgeRuntimeGuardMatchesMessage("Where are you located?", guard()), false);
});

test("availability and appointment conflicts match operational questions", () => {
  assert.equal(knowledgeRuntimeGuardMatchesMessage("Are you open on Saturday?", guard({
    factType: KnowledgeDocumentFactType.BUSINESS_HOURS,
    factLabel: "Saturday business hours",
    canonicalEntityType: "BUSINESS_AVAILABILITY",
    canonicalField: "SATURDAY",
  })), true);
  assert.equal(knowledgeRuntimeGuardMatchesMessage("Can I book a consultation?", guard({
    factType: KnowledgeDocumentFactType.APPOINTMENT_POLICY,
    factLabel: "Consultation appointment policy",
    canonicalEntityType: "APPOINTMENT_SETTINGS",
    canonicalField: "appointmentConfirmationMode",
  })), true);
});

test("governance failures are considered sensitive only for operational customer requests", () => {
  assert.equal(knowledgeRuntimeGovernanceService.isSensitiveCustomerRequest("What is the price?"), true);
  assert.equal(knowledgeRuntimeGovernanceService.isSensitiveCustomerRequest("Hello, thank you"), false);
});

test("settings reconciliation uses canonical values and does not invalidate unchanged prices", () => {
  assert.equal(knowledgeSettingBindingIsOutdated({
    normalizedDocumentValue: "GHS:500",
    documentValue: { currency: "GHS", value: "500" },
    normalizedSettingsValue: "GHS:500",
    settingsValue: 500,
  }), false);
  assert.equal(knowledgeSettingBindingIsOutdated({
    normalizedDocumentValue: "GHS:500",
    documentValue: { currency: "GHS", value: "500" },
    normalizedSettingsValue: "GHS:550",
    settingsValue: 550,
  }), true);
});

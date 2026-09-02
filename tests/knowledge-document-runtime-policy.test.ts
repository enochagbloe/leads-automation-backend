import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeFactGovernanceStatus } from "@prisma/client";
import {
  customerSafeKnowledgeDocumentWhere,
  knowledgeFactStatusesAreCustomerSafe,
} from "../src/services/knowledge-document/knowledge-document-runtime-policy";

test("approved informational documents may have no structured facts", () => {
  assert.equal(knowledgeFactStatusesAreCustomerSafe([]), true);
  assert.equal(knowledgeFactStatusesAreCustomerSafe([
    { governanceStatus: KnowledgeFactGovernanceStatus.APPROVED },
  ]), true);
  assert.equal(knowledgeFactStatusesAreCustomerSafe([
    { governanceStatus: KnowledgeFactGovernanceStatus.APPROVED },
    { governanceStatus: KnowledgeFactGovernanceStatus.REJECTED },
  ]), false);
});

test("customer-safe database filter rejects any non-approved active-version fact", () => {
  assert.deepEqual(customerSafeKnowledgeDocumentWhere, {
    activeVersion: {
      is: {
        facts: {
          every: { governanceStatus: KnowledgeFactGovernanceStatus.APPROVED },
        },
      },
    },
  });
});

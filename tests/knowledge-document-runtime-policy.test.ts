import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeFactGovernanceStatus } from "@prisma/client";
import {
  customerSafeKnowledgeDocumentWhere,
  knowledgeFactStatusesAreCustomerSafe,
} from "../src/services/knowledge-document/knowledge-document-runtime-policy";

test("customer runtime requires at least one fact and all facts approved", () => {
  assert.equal(knowledgeFactStatusesAreCustomerSafe([]), false);
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
          some: {},
          every: { governanceStatus: KnowledgeFactGovernanceStatus.APPROVED },
        },
      },
    },
  });
});

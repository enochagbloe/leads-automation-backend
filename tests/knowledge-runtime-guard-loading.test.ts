import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/config/prisma";
import type { KnowledgeRuntimeGuard } from "../src/services/knowledge-document/knowledge-runtime-governance.service";
import { knowledgeRuntimeGuardMatchesMessage, knowledgeRuntimeGovernanceService } from "../src/services/knowledge-document/knowledge-runtime-governance.service";

const guard: KnowledgeRuntimeGuard = {
  reviewItemId: "review-101", documentId: "doc", factId: "fact", factType: "PRICE",
  factLabel: "Consultation price", canonicalEntityType: "SERVICE", canonicalEntityId: "service-1",
  canonicalField: "basePrice", priority: "CRITICAL", currentSettingsValue: 400, documentValue: 500,
  source: { documentTitle: "Prices", pageNumber: null, sheetName: null, slideNumber: null },
};

test("price conflicts do not depend on literal service labels", () => {
  for (const message of ["How much is a consult?", "What is the price?", "Can I get a quote?"]) {
    assert.equal(knowledgeRuntimeGuardMatchesMessage(message, guard), true);
  }
  assert.equal(knowledgeRuntimeGuardMatchesMessage("Where are you located?", guard), false);
  assert.equal(knowledgeRuntimeGuardMatchesMessage("Hello", guard), false);
});

test("missing intent metadata fails closed for sensitive requests", () => {
  const unknown = { ...guard, factType: null, canonicalField: null };
  assert.equal(knowledgeRuntimeGuardMatchesMessage("How much?", unknown), true);
  assert.equal(knowledgeRuntimeGuardMatchesMessage("Thanks", unknown), false);
});

test("failure handling recognizes all supported sensitive categories", () => {
  for (const message of ["Can I get a quote?", "What is your phone number?", "Do you deliver?", "Money back?", "What are the terms?"]) {
    assert.equal(knowledgeRuntimeGovernanceService.isSensitiveCustomerRequest(message), true);
  }
  assert.equal(knowledgeRuntimeGovernanceService.isSensitiveCustomerRequest("Hello"), false);
});

test("customer evaluation sees a relevant conflict after 100 other reviews", async (t) => {
  const reviews = Array.from({ length: 101 }, (_, i) => ({
    id: `review-${i + 1}`, documentId: "doc", factId: "fact", priority: "CRITICAL",
    canonicalEntityType: i === 100 ? "SERVICE" : "BUSINESS_PROFILE",
    canonicalEntityId: "service-1", canonicalField: i === 100 ? "basePrice" : "address",
    existingValue: 400, documentValue: 500, document: { title: "Knowledge" },
    fact: { factType: i === 100 ? "PRICE" : "LOCATION", label: "Consultation", pageNumber: null, sheetName: null, slideNumber: null },
  }));
  t.mock.method(prisma.knowledgeGovernanceReview, "findMany", async (args: { take?: number }) => reviews.slice(0, args.take));
  const result = await knowledgeRuntimeGovernanceService.evaluateCustomerRequest({ businessId: "tenant-1", message: "How much is a consult?" });
  assert.equal(result.blocked, true);
  assert.deepEqual(result.matchingGuards.map((item) => item.reviewItemId), ["review-101"]);
});

test("operational lookup scopes an uncapped query and includes unbound guards", async (t) => {
  let query: Record<string, any> = {};
  t.mock.method(prisma.knowledgeGovernanceReview, "findMany", async (args: Record<string, any>) => { query = args; return []; });
  await knowledgeRuntimeGovernanceService.assertOperationalFieldSafe({
    businessId: "tenant-1", canonicalEntityType: "SERVICE", canonicalEntityId: "service-1", canonicalFields: ["basePrice"],
  });
  assert.equal(query.take, undefined);
  assert.equal(query.where.businessId, "tenant-1");
  assert.equal(query.where.canonicalEntityType, "SERVICE");
  assert.deepEqual(query.where.reviewStatus.in, ["PENDING_REVIEW", "APPLYING"]);
  assert.deepEqual(query.where.document, { status: "ACTIVE", deletedAt: null });
  assert.deepEqual(query.where.version, { isActive: true });
  assert.deepEqual(query.where.AND, [
    { OR: [{ canonicalEntityId: "service-1" }, { canonicalEntityId: null }] },
    { OR: [{ canonicalField: { in: ["basePrice"] } }, { canonicalField: null }] },
  ]);
  await knowledgeRuntimeGovernanceService.assertOperationalFieldSafe({
    businessId: "tenant-1", canonicalEntityType: "BUSINESS_AVAILABILITY", canonicalFields: [],
  });
  assert.deepEqual(query.where.AND, []);
});

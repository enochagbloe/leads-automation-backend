import assert from "node:assert/strict";
import test from "node:test";
import { mockMethod } from "./helpers/mock-method";
import type { Prisma } from "@prisma/client";
import { prisma } from "../src/config/prisma";
import { profileComparison } from "../src/services/knowledge-document/knowledge-document-governance.service";
import { allowedKnowledgeGovernanceActions } from "../src/services/knowledge-document/knowledge-governance-resolution-policy";
import { knowledgeGovernanceReviewQueueQuerySchema } from "../src/validation/knowledge.schemas";
import { reconcileKnowledgeAfterSettingsMutation } from "../src/services/knowledge-document/knowledge-settings-reconciliation.service";
import { loadCustomerSafeKnowledgeFacts } from "../src/services/knowledge-document/knowledge-approved-facts.service";
import { createAiBookingRequest } from "../src/services/ai-reply-engine.service";
import { knowledgeRuntimeGovernanceService } from "../src/services/knowledge-document/knowledge-runtime-governance.service";
import { knowledgeGovernanceNotificationService } from "../src/services/knowledge-document/knowledge-governance-notification.service";
import { emailService } from "../src/services/email.service";
import { aiBusinessContextService } from "../src/services/ai-context-builder.service";
import { cacheService } from "../src/services/cache.service";
import { customerMemoryResolverService } from "../src/services/customer-memory/customer-memory-resolver.service";

test("missing phone is addable despite an existing email", () => {
  const review = profileComparison({ id: "fact", factType: "CONTACT_INFORMATION", label: "Phone", valueText: "+233 200 111 222", currency: null, numericValue: null, sourceExcerpt: null }, {
    email: "owner@example.com", phone: null, website: null, defaultNotificationEmail: null, address: null, city: null, serviceArea: null,
  });
  assert.ok(review);
  assert.equal(review.comparisonType, "MISSING_IN_SETTINGS");
  assert.equal(review.canonicalField, "phone");
  assert.equal(review.normalizedExistingValue, "");
  assert.ok(allowedKnowledgeGovernanceActions(review).includes("UPDATE_SETTINGS"));
});

test("outdated query strings retain their actual boolean value", () => {
  assert.equal(knowledgeGovernanceReviewQueueQuerySchema.parse({ outdated: "false" }).outdated, false);
  assert.equal(knowledgeGovernanceReviewQueueQuerySchema.parse({ outdated: "true" }).outdated, true);
  assert.equal(knowledgeGovernanceReviewQueueQuerySchema.parse({}).outdated, undefined);
  assert.equal(knowledgeGovernanceReviewQueueQuerySchema.safeParse({ outdated: "invalid" }).success, false);
});

test("settings reconciliation selects exact entity bindings only", async () => {
  let where: any;
  const tx = { knowledgeGovernanceReview: { findMany: async (args: any) => { where = args.where; return []; } } } as unknown as Prisma.TransactionClient;
  await reconcileKnowledgeAfterSettingsMutation(tx, {
    businessId: "tenant", actorUserId: "user", actorMembershipId: "owner",
    canonicalEntityType: "SERVICE", canonicalEntityId: "service-1", fields: [{ canonicalField: "basePrice", value: 200 }],
  });
  assert.equal(where.canonicalEntityId, "service-1");
  assert.equal(where.OR, undefined);
});

test("partial documents retain approved facts but exclude archived-service bindings", async () => {
  let where: any;
  const tx = {
    knowledgeDocumentFact: { findMany: async (args: any) => { where = args.where; return [
      { id: "safe", versionId: "v", document: { activeVersionId: "v" }, governanceReviews: [] },
      { id: "archived", versionId: "v", document: { activeVersionId: "v" }, governanceReviews: [{ canonicalEntityType: "SERVICE", canonicalEntityId: "old-service" }] },
      { id: "old-version", versionId: "old", document: { activeVersionId: "v" }, governanceReviews: [] },
    ]; } }, service: { findMany: async () => [] },
  } as unknown as Prisma.TransactionClient;
  assert.deepEqual((await loadCustomerSafeKnowledgeFacts("tenant", {}, tx)).map((f) => f.id), ["safe"]);
  assert.equal(where.governanceStatus, "APPROVED");
  assert.equal(where.document.governanceStatus, undefined);
  assert.equal(where.governanceReviews.none.blocksAiUse, true);
});

test("a governance-blocked booking never reserves the message", async (t) => {
  mockMethod(t, prisma.aiInteractionLog, "findUnique", async () => null);
  const reserve = mockMethod(t, prisma.aiInteractionLog, "create", async () => { throw new Error("must not reserve"); });
  mockMethod(t, knowledgeRuntimeGovernanceService, "assertOperationalFieldSafe", async () => [{ reviewItemId: "conflict" }]);
  const input = {
    context: { business: { id: "business" }, services: [{ id: "service", name: "Consultation", isBookable: true }] },
    businessAccountId: "account", conversationId: "conversation", leadId: "lead", messageId: "message",
    decision: { appointmentIntent: { serviceId: "service", preferredDate: "2030-01-01", preferredTime: "10:00", missingFields: [] } },
  } as unknown as Parameters<typeof createAiBookingRequest>[0];
  await assert.rejects(createAiBookingRequest(input), { code: "KNOWLEDGE_CONFLICT" });
  assert.equal(reserve.mock.callCount(), 0);
});

test("notification delivery rechecks resolution immediately before sending", async (t) => {
  mockMethod(t, prisma.knowledgeGovernanceReview, "updateMany", async () => ({ count: 1 }));
  mockMethod(t, prisma.knowledgeGovernanceReview, "findMany", async () => [{ id: "review", criticalNotificationAttempts: 0, criticalNotificationStatus: "PENDING", updatedAt: new Date() }]);
  mockMethod(t, prisma.knowledgeGovernanceReview, "findUnique", async () => ({
    id: "review", businessId: "business", documentId: "doc", reviewStatus: "PENDING_REVIEW",
    business: { name: "Business", businessAccountId: "account", members: [{ id: "owner", role: "BUSINESS_OWNER", user: { email: "owner@example.invalid" } }] },
    document: { title: "Doc" }, fact: null,
  }));
  mockMethod(t, prisma.businessNotification, "findMany", async () => [{ recipientMembershipId: "owner" }]);
  mockMethod(t, prisma, "$transaction", async (callback: any) => callback({
    $queryRaw: async () => [{ reviewStatus: "RESOLVED", criticalNotificationStatus: "PROCESSING" }],
    knowledgeGovernanceReview: { updateMany: async () => ({ count: 1 }) },
  }));
  const send = mockMethod(t, emailService, "sendKnowledgeConflictReviewEmail", async () => true);
  await knowledgeGovernanceNotificationService.processDue(1);
  assert.equal(send.mock.callCount(), 0);
});

test("a settings change during cache write rebuilds the context at the new revision", async (t) => {
  let revision = 0;
  const keys: string[] = [];
  const deleted: string[] = [];
  const memory = { memoryRevision: 1, memoryEnabled: true, degraded: false };
  mockMethod(t, prisma.conversation, "findFirst", async () => ({
    id: "conversation", leadId: "lead", lead: { customerMemoryProfile: memory, updatedAt: new Date(), lastContactedAt: null },
  }));
  mockMethod(t, prisma.message, "findFirst", async () => ({ id: "message", content: "Hello", messageType: "TEXT", createdAt: new Date() }));
  mockMethod(t, prisma.business, "findFirst", async () => ({ id: "business", name: revision === 0 ? "Old name" : "New name", knowledgeRuntimeRevision: revision, timezone: "UTC" }));
  for (const model of [prisma.service, prisma.businessAvailability, prisma.businessPolicy, prisma.knowledgeArticle,
    prisma.knowledgeDocumentChunk, prisma.knowledgeDocumentFact, prisma.knowledgeGovernanceReview,
    prisma.message, prisma.customerIssueLog, prisma.followUpJob]) {
    mockMethod(t, model, "findMany", async () => []);
  }
  mockMethod(t, customerMemoryResolverService, "resolveRuntimeSafely", async () => memory);
  mockMethod(t, customerMemoryResolverService, "isSnapshotCurrent", async () => true);
  mockMethod(t, cacheService, "get", async () => null);
  mockMethod(t, cacheService, "set", async (key: string) => { keys.push(key); revision = 1; });
  mockMethod(t, cacheService, "del", async (key: string) => { deleted.push(key); });
  const context = await aiBusinessContextService.buildBusinessContextForAi({
    businessId: "business", conversationId: "conversation", messageId: "message", plan: "BASIC",
  });
  assert.equal(context.business.name, "New name");
  assert.equal(keys.length, 2);
  assert.match(keys[0]!, /knowledge:0:/);
  assert.match(keys[1]!, /knowledge:1:/);
  assert.ok(deleted.includes(keys[0]!));
});

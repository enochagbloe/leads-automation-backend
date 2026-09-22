import assert from "node:assert/strict";
import test from "node:test";
import { mockMethod } from "./helpers/mock-method";
import { prisma } from "../src/config/prisma";
import { productionKnowledgeProvider } from "../src/services/runtime-knowledge.provider";
import { customerSafeKnowledgeDocumentWhere } from "../src/services/knowledge-document/knowledge-document-runtime-policy";

test("production knowledge boundary retains tenant, publication, visibility, approval, version and review guards", async t => {
  const calls: Record<string, any> = {};
  mockMethod(t, prisma.knowledgeArticle, "findMany", async (input: any) => { calls.articles = input; return [{ id: "article", title: "Published answer", body: "Approved body", summary: null, category: null, tags: [] }]; });
  mockMethod(t, prisma.knowledgeDocumentChunk, "findMany", async (input: any) => { calls.chunks = input; return [{ id: "chunk", documentId: "doc", document: { title: "Approved document" }, chunkText: "Confirmed information", pageNumber: 2 }]; });
  mockMethod(t, prisma.knowledgeDocumentFact, "findMany", async (input: any) => { calls.facts = input; return []; });
  mockMethod(t, prisma.knowledgeGovernanceReview, "findMany", async (input: any) => { calls.guards = input; return []; });
  const knowledge = await productionKnowledgeProvider.load({ businessId: "tenant-a" });
  for (const query of Object.values(calls)) assert.equal(query.where.businessId, "tenant-a");
  assert.equal(calls.articles.where.status, "PUBLISHED"); assert.equal(calls.articles.where.visibility, "CLIENT_SENDABLE");
  assert.equal(calls.articles.take, 20); assert.equal(calls.chunks.take, 12); assert.equal(calls.facts.take, 50);
  assert.deepEqual(calls.chunks.where.document, { status: "ACTIVE", processingStatus: "READY", governanceStatus: "APPROVED", visibility: "CLIENT_SENDABLE", ...customerSafeKnowledgeDocumentWhere });
  assert.equal(calls.facts.where.governanceStatus, "APPROVED");
  assert.equal(calls.facts.where.document.deletedAt, null);
  assert.equal(calls.facts.where.document.visibility, "CLIENT_SENDABLE");
  assert.deepEqual(calls.facts.where.version, { isActive: true, analysis: { is: { status: "COMPLETED" } } });
  assert.deepEqual(calls.facts.where.governanceReviews, { none: { blocksAiUse: true, reviewStatus: { not: "RESOLVED" } } });
  assert.deepEqual(calls.guards.where.reviewStatus.in, ["PENDING_REVIEW", "APPLYING"]);
  assert.equal(calls.guards.take, undefined);
  assert.equal(knowledge.knowledgeArticles[0]!.id, "article");
  assert.deepEqual(knowledge.knowledgeDocumentChunks[0], { id: "chunk", documentId: "doc", documentTitle: "Approved document", chunkText: "Confirmed information", pageNumber: 2 });
});

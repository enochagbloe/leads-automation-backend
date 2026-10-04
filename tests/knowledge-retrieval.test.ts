import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { env } from "../src/config/env";
import { prisma } from "../src/config/prisma";
import { knowledgeRetrievalService as retrieval } from "../src/services/knowledge-retrieval.service";
import { knowledgeEmbeddingService, knowledgeEmbeddingText, type SemanticKnowledgeCandidate } from "../src/services/knowledge-embedding.service";
import { mockMethod } from "./helpers/mock-method";

function fixture(t: TestContext) {
  const saved = { key: env.OPENROUTER_API_KEY, model: env.OPENROUTER_EMBEDDING_MODEL, dimensions: env.OPENROUTER_EMBEDDING_DIMENSIONS, threshold: env.KNOWLEDGE_SEMANTIC_MIN_SCORE };
  env.OPENROUTER_API_KEY = "synthetic"; env.OPENROUTER_EMBEDDING_MODEL = "test-model"; env.OPENROUTER_EMBEDDING_DIMENSIONS = 1536; env.KNOWLEDGE_SEMANTIC_MIN_SCORE = .78;
  t.after(() => { env.OPENROUTER_API_KEY = saved.key; env.OPENROUTER_EMBEDDING_MODEL = saved.model; env.OPENROUTER_EMBEDDING_DIMENSIONS = saved.dimensions; env.KNOWLEDGE_SEMANTIC_MIN_SCORE = saved.threshold; });
  const article: any = { relatedServiceIds: [], relatedPolicyIds: [], updatedAt: new Date(0), id: "article", businessId: "a", title: "Service information", body: "Consultation lasts an hour.", summary: null, tags: [], category: null, status: "PUBLISHED", visibility: "CLIENT_SENDABLE" };
  const doc: any = { relatedServiceIds: [], updatedAt: new Date(0), supersededByDocumentId: null, activeVersion: { isActive: true }, id: "document", businessId: "a", title: "Customer guide", description: null, category: null, tags: [], status: "ACTIVE", processingStatus: "READY", governanceStatus: "APPROVED", visibility: "CLIENT_SENDABLE", deletedAt: null, activeVersionId: "v1", allFactsApproved: true };
  const chunk: any = { id: "chunk", businessId: "a", documentId: doc.id, document: doc, chunkText: "We open at nine.", pageNumber: 2 };
  const fact: any = { id: "fact", businessId: "a", documentId: doc.id, document: doc, label: "Policy", valueText: "Give a day's notice.", governanceStatus: "APPROVED", pageNumber: 3, versionId: "v1", active: true, analyzed: true, blocked: false, canonicalEntityType: null, governanceReviews: [] };
  let rows: SemanticKnowledgeCandidate[] = []; let fail: string | undefined;
  const requests: any[] = []; const dbReads: any[] = [];
  const candidate = (sourceType: SemanticKnowledgeCandidate["sourceType"], score = .9): SemanticKnowledgeCandidate => ({
    businessId: "a", sourceType, sourceId: sourceType === "ARTICLE" ? article.id : doc.id,
    chunkId: sourceType === "ARTICLE" ? null : sourceType === "DOCUMENT_CHUNK" ? chunk.id : fact.id,
    title: sourceType === "ARTICLE" ? article.title : doc.title,
    indexedContent: sourceType === "ARTICLE" ? knowledgeEmbeddingText.article(article) : sourceType === "DOCUMENT_CHUNK" ? knowledgeEmbeddingText.chunk(chunk) : knowledgeEmbeddingText.fact(fact), score,
  });
  mockMethod(t, globalThis, "fetch", async (_url: any, input: any) => {
    requests.push(JSON.parse(input.body));
    if (fail === "provider") throw new Error("provider unavailable");
    if (fail === "provider-http") return new Response("{}", { status: 503 });
    return new Response(JSON.stringify({ data: [{ embedding: Array(1536).fill(.1) }] }), { status: 200 });
  });
  mockMethod(t, prisma, "$queryRawUnsafe", async (sql: string, _vector: string, businessId: string, limit: number, model: string) => {
    assert.match(sql, /"businessId" = \$2/); assert.match(sql, /"embeddingModel" = \$4/); assert.match(sql, /<=>/);
    assert.equal(businessId, "a"); assert.equal(model, "test-model"); assert.ok(limit <= 32); dbReads.push({ stage: "vector", limit });
    if (fail === "vector") throw new Error("database unavailable"); return rows;
  });
  mockMethod(t, prisma.knowledgeArticle, "findFirst", async ({ where }: any) => {
    dbReads.push(where); assert.equal(where.businessId, "a"); assert.equal(where.status, "PUBLISHED"); assert.equal(where.visibility, "CLIENT_SENDABLE");
    if (fail === "source") throw new Error("governance read failed");
    return article.id === where.id && article.businessId === where.businessId && article.status === where.status && article.visibility === where.visibility ? article : null;
  });
  mockMethod(t, prisma.knowledgeDocumentChunk, "findFirst", async ({ where }: any) => {
    dbReads.push(where); assert.equal(where.businessId, "a"); assert.equal(where.document.businessId, "a");
    assert.deepEqual(where.document.activeVersion, { is: { isActive: true } });
    assert.equal(where.document.supersededByDocumentId, null);
    assert.deepEqual(where.document.AND, [{ activeVersion: { is: { facts: { every: { governanceStatus: "APPROVED" } } } } }]);
    for (const [key, value] of Object.entries({ deletedAt: null, status: "ACTIVE", processingStatus: "READY", governanceStatus: "APPROVED", visibility: "CLIENT_SENDABLE" })) assert.equal(where.document[key], value);
    return chunk.businessId === where.businessId && doc.businessId === where.document.businessId && chunk.id === where.id && chunk.documentId === where.documentId && doc.status === "ACTIVE" && doc.processingStatus === "READY" && doc.governanceStatus === "APPROVED" && doc.visibility === "CLIENT_SENDABLE" && !doc.deletedAt && doc.allFactsApproved && !doc.supersededByDocumentId && doc.activeVersion?.isActive ? chunk : null;
  });
  mockMethod(t, prisma.knowledgeDocument, "findFirst", async ({ where }: any) => {
    assert.equal(where.businessId, "a"); assert.equal(where.supersededByDocumentId, null);
    assert.deepEqual(where.activeVersion, { is: { isActive: true } });
    return doc.id === where.id && doc.businessId === where.businessId && !doc.deletedAt && !doc.supersededByDocumentId && doc.activeVersion?.isActive && doc.status === "ACTIVE" && doc.processingStatus === "READY" && doc.governanceStatus === "APPROVED" && doc.visibility === "CLIENT_SENDABLE" ? doc : null;
  });
  mockMethod(t, prisma.knowledgeDocumentFact, "findMany", async ({ where, take }: any) => {
    dbReads.push(where); assert.equal(where.businessId, "a"); assert.equal(where.governanceStatus, "APPROVED"); assert.equal(take, 1); assert.equal(where.documentId, doc.id); assert.deepEqual(where.ids, undefined);
    assert.equal(where.document.visibility, "CLIENT_SENDABLE"); assert.equal(where.document.deletedAt, null); assert.deepEqual(where.version, { isActive: true, analysis: { is: { status: "COMPLETED" } } });
    assert.deepEqual(where.governanceReviews.none, { blocksAiUse: true, reviewStatus: { not: "RESOLVED" } });
    return fact.businessId === where.businessId && where.id.in.includes(fact.id) && fact.governanceStatus === "APPROVED" && !fact.blocked && fact.active && fact.analyzed && doc.status === "ACTIVE" && !doc.deletedAt && doc.visibility === "CLIENT_SENDABLE" && ["READY", "NEEDS_REVIEW"].includes(doc.processingStatus) ? [fact] : [];
  });
  mockMethod(t, prisma.service, "findMany", async ({ where }: any) => { assert.equal(where.businessId, "a"); assert.equal(where.isArchived, false); return []; });
  return { article, doc, chunk, fact, candidate, requests, dbReads, rows: (value: SemanticKnowledgeCandidate[]) => { rows = value; }, fail: (value: string) => { fail = value; } };
}
const ask = (topK?: number) => retrieval.retrieve({ businessId: "a", query: "  What are your services?  ", topK });

for (const type of ["ARTICLE", "DOCUMENT_CHUNK", "DOCUMENT_FACT"] as const) test(`current customer-safe ${type} returns bounded semantic grounding`, async t => {
  const f = fixture(t); f.rows([f.candidate(type)]); const result = await ask();
  assert.equal(result.status, "MATCHES_FOUND"); assert.equal(result.matches.length, 1);
  const match = result.matches[0]!; assert.equal(match.sourceType, type); assert.equal(match.retrieval, "semantic"); assert.equal(match.score, .9);
  assert.equal(match.sourceId, type === "ARTICLE" ? "article" : "document");
  assert.equal(match.pageNumber, type === "ARTICLE" ? null : type === "DOCUMENT_CHUNK" ? 2 : 3);
  assert.equal(match.chunkId, type === "DOCUMENT_CHUNK" ? "chunk" : undefined); assert.equal(match.factId, type === "DOCUMENT_FACT" ? "fact" : undefined);
  assert.equal(f.requests[0].input, "What are your services?"); assert.equal(f.dbReads[0].limit, 16);
});

for (const change of ["revoked", "internal", "content-changed", "foreign-source"] as const) test(`rejects stale article: ${change}`, async t => {
  const f = fixture(t); f.rows([f.candidate("ARTICLE")]);
  if (change === "revoked") f.article.status = "DRAFT";
  if (change === "internal") f.article.visibility = "INTERNAL_ONLY";
  if (change === "content-changed") f.article.body = "Entirely different source text";
  if (change === "foreign-source") f.article.businessId = "b";
  assert.deepEqual(await ask(), { status: "NO_RELEVANT_KNOWLEDGE", matches: [] });
});

for (const change of ["archived", "unready", "unapproved", "internal", "deleted", "unsafe-version", "changed-chunk", "wrong-document", "foreign-source"] as const) test(`rejects unsafe document: ${change}`, async t => {
  const f = fixture(t); const c = f.candidate("DOCUMENT_CHUNK"); f.rows([c]);
  if (change === "archived") f.doc.status = "ARCHIVED";
  if (change === "unready") f.doc.processingStatus = "NEEDS_REVIEW";
  if (change === "unapproved") f.doc.governanceStatus = "PENDING_REVIEW";
  if (change === "internal") f.doc.visibility = "INTERNAL_ONLY";
  if (change === "deleted") f.doc.deletedAt = new Date();
  if (change === "unsafe-version") f.doc.allFactsApproved = false;
  if (change === "changed-chunk") f.chunk.chunkText = "Different text";
  if (change === "wrong-document") c.sourceId = "another-document";
  if (change === "foreign-source") f.chunk.businessId = "b";
  assert.deepEqual(await ask(), { status: "NO_RELEVANT_KNOWLEDGE", matches: [] });
});

for (const change of ["unapproved", "blocked", "inactive-version", "unanalyzed", "superseded", "linked-service", "foreign", "changed-value"] as const) test(`approved-fact loader rejects unsafe fact: ${change}`, async t => {
  const f = fixture(t); f.rows([f.candidate("DOCUMENT_FACT")]);
  if (change === "unapproved") f.fact.governanceStatus = "REJECTED";
  if (change === "blocked") f.fact.blocked = true;
  if (change === "inactive-version") f.fact.active = false;
  if (change === "unanalyzed") f.fact.analyzed = false;
  if (change === "superseded") f.fact.versionId = "old";
  if (change === "linked-service") { f.fact.canonicalEntityType = "SERVICE"; f.fact.canonicalEntityId = "archived-service"; }
  if (change === "foreign") f.fact.businessId = "b";
  if (change === "changed-value") f.fact.valueText = "New policy";
  assert.deepEqual(await ask(), { status: "NO_RELEVANT_KNOWLEDGE", matches: [] });
});

test("wrong-tenant embedding rows cannot authorize even a valid local source", async t => {
  const f = fixture(t); f.rows([{ ...f.candidate("ARTICLE"), businessId: "b" }]);
  assert.deepEqual(await ask(), { status: "NO_RELEVANT_KNOWLEDGE", matches: [] }); assert.equal(f.dbReads.length, 1);
  mockMethod(t, knowledgeEmbeddingService, "searchCandidates", async () => [{ ...f.candidate("ARTICLE"), businessId: "b" }]);
  assert.equal((await ask()).matches.length, 0); assert.equal(f.dbReads.length, 1);
});

test("topK bounds and deduplication retain highest scoring distinct candidates", async t => {
  const f = fixture(t); f.rows([f.candidate("ARTICLE", .81), f.candidate("ARTICLE", .99), f.candidate("DOCUMENT_CHUNK", .91), f.candidate("DOCUMENT_FACT", .9)]);
  const result = await ask(2); assert.deepEqual(result.matches.map(m => m.score), [.99, .91]); assert.equal(f.dbReads[0].limit, 8);
  assert.equal(f.dbReads.filter(r => r.id === "article").length, 1);
  for (const topK of [0, 9, 1.5, NaN]) await assert.rejects(ask(topK), { code: "KNOWLEDGE_RETRIEVAL_INPUT_INVALID" });
});

test("threshold is configurable, inclusive, and rejects nonfinite scores", async t => {
  const f = fixture(t); f.rows([f.candidate("ARTICLE", .779)]); assert.equal((await ask()).status, "NO_RELEVANT_KNOWLEDGE");
  f.rows([f.candidate("ARTICLE", .78)]); assert.equal((await ask()).matches.length, 1);
  env.KNOWLEDGE_SEMANTIC_MIN_SCORE = .9; assert.equal((await ask()).matches.length, 0);
  f.rows([f.candidate("ARTICLE", NaN), f.candidate("DOCUMENT_CHUNK", Infinity)]); assert.equal((await ask()).matches.length, 0);
});

test("no match and invalid input never manufacture knowledge", async t => {
  const f = fixture(t); assert.deepEqual(await ask(), { status: "NO_RELEVANT_KNOWLEDGE", matches: [] });
  for (const input of [{ businessId: "", query: "q" }, { businessId: "a", query: "  " }, { businessId: "a", query: "x".repeat(2001) }, { query: "q" }]) await assert.rejects(retrieval.retrieve(input as any), { code: "KNOWLEDGE_RETRIEVAL_INPUT_INVALID" });
  assert.equal(f.requests.length, 1);
});

for (const stage of ["provider", "provider-http", "vector", "source", "disabled"]) test(`${stage} failure is unavailable, never a fabricated match`, async t => {
  const f = fixture(t); f.rows([f.candidate("ARTICLE")]); f.fail(stage);
  if (stage === "disabled") env.OPENROUTER_EMBEDDING_MODEL = undefined;
  assert.deepEqual(await ask(), { status: "RETRIEVAL_UNAVAILABLE", matches: [] });
});

for (const type of ["ARTICLE", "DOCUMENT_CHUNK", "DOCUMENT_FACT"] as const) test(`${type} grounding text and titles have hard bounds`, async t => {
  const f = fixture(t); f.article.body = "a".repeat(10000); f.article.title = "t".repeat(500); f.doc.title = "d".repeat(500); f.chunk.chunkText = "c".repeat(10000); f.fact.valueText = "f".repeat(10000);
  f.rows([f.candidate(type)]); const result = await ask(); assert.equal(result.matches.length, 1); assert.equal(result.matches[0]!.text.length, 900); assert.equal(result.matches[0]!.title.length, 200);
  assert.equal("indexedContent" in result.matches[0]!, false);
});

test("legacy asset search keeps fact exclusion while semantic candidates include facts", async t => {
  const f = fixture(t); f.rows([f.candidate("DOCUMENT_FACT"), f.candidate("ARTICLE")]);
  assert.deepEqual((await knowledgeEmbeddingService.search("a", "policy", 5)).map(r => r.sourceType), ["ARTICLE"]);
  assert.deepEqual((await knowledgeEmbeddingService.searchCandidates("a", "policy", 5)).map(r => r.sourceType), ["DOCUMENT_FACT", "ARTICLE"]);
});

test("a later governance-read failure discards already verified partial matches", async t => {
  const f = fixture(t); f.rows([f.candidate("DOCUMENT_CHUNK", .99), f.candidate("ARTICLE", .9)]); f.fail("source");
  assert.deepEqual(await ask(), { status: "RETRIEVAL_UNAVAILABLE", matches: [] });
});

test("hard maximum topK produces at most 32 candidate reads", async t => {
  const f = fixture(t); f.rows([f.candidate("ARTICLE")]); assert.equal((await ask(8)).matches.length, 1); assert.equal(f.dbReads[0].limit, 32);
  await assert.rejects(knowledgeEmbeddingService.searchCandidates("a", "question", 33), { code: "KNOWLEDGE_RETRIEVAL_INPUT_INVALID" });
});

for (const type of ["DOCUMENT_CHUNK", "DOCUMENT_FACT"] as const) for (const reason of ["superseded", "inactive-version", "unready", "unapproved", "archived", "deleted"]) test(`${type} rejects current integrity violation ${reason}`, async t => {
  const f = fixture(t); f.rows([f.candidate(type)]);
  if (reason === "superseded") f.doc.supersededByDocumentId = "replacement";
  if (reason === "inactive-version") f.doc.activeVersion.isActive = false;
  if (reason === "unready") f.doc.processingStatus = "NEEDS_REVIEW";
  if (reason === "unapproved") f.doc.governanceStatus = "PENDING_REVIEW";
  if (reason === "archived") f.doc.status = "ARCHIVED";
  if (reason === "deleted") f.doc.deletedAt = new Date();
  assert.equal((await ask()).status, "NO_RELEVANT_KNOWLEDGE");
});

for (const scenario of ["linked", "unrelated", "below-threshold", "generic", "duplicate", "category-policy"]) test(`metadata ranking and integrity: ${scenario}`, async t => {
  const f = fixture(t);
  const generic = { ...f.article, id: "generic", title: "Payment", body: "General payment terms", updatedAt: new Date("2026-01-01") };
  const linked = { ...generic, id: "linked", title: "Service payment", body: "Specific service payment terms", relatedServiceIds: ["service"], updatedAt: new Date("2026-02-01") };
  if (scenario === "duplicate") { linked.title = generic.title; linked.body = generic.body; }
  if (scenario === "category-policy") { linked.relatedServiceIds = []; linked.category = "Payment"; linked.relatedPolicyIds = ["policy"]; }
  mockMethod(t, prisma.knowledgeArticle, "findFirst", async ({ where }: any) => {
    assert.equal(where.businessId, "a"); assert.equal(where.status, "PUBLISHED"); assert.equal(where.visibility, "CLIENT_SENDABLE");
    return [generic, linked].find(a => a.id === where.id) ?? null;
  });
  const candidate = (a: any, score: number): SemanticKnowledgeCandidate => ({ businessId: "a", sourceType: "ARTICLE", sourceId: a.id, chunkId: null, title: a.title, indexedContent: knowledgeEmbeddingText.article(a), score });
  f.rows([candidate(generic, .92), ...(scenario === "generic" ? [] : [candidate(linked, scenario === "below-threshold" ? .77 : scenario === "unrelated" ? .8 : .91)])]);
  const result = await retrieval.retrieve({ businessId: "a", query: "payment", hints: { serviceId: "service", category: "Payment", policyId: "policy" } });
  assert.equal(result.matches[0]!.sourceId, ["linked", "duplicate", "category-policy"].includes(scenario) ? "linked" : "generic");
  if (["duplicate", "generic", "below-threshold"].includes(scenario)) assert.equal(result.matches.length, 1);
  assert.ok(result.matches[0]!.sourceUpdatedAt);
});

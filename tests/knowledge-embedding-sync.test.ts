import assert from "node:assert/strict";
import test from "node:test";
import { prepareAndReplaceEmbeddingBatch } from "../src/services/knowledge-embedding.service";

test("failed document embedding preparation preserves the existing set", async () => {
  const existing = ["old-1", "old-2"];
  let replacements = 0;

  await assert.rejects(
    prepareAndReplaceEmbeddingBatch({
      items: ["new-1", "new-2", "new-3"],
      prepare: async (item) => item === "new-2" ? null : `prepared:${item}`,
      replace: async (prepared) => {
        replacements += 1;
        existing.splice(0, existing.length, ...prepared);
      },
      failure: () => new Error("provider failed"),
    }),
    /provider failed/,
  );

  assert.equal(replacements, 0);
  assert.deepEqual(existing, ["old-1", "old-2"]);
});

test("complete document embedding preparation replaces the set once", async () => {
  const existing = ["old-1", "old-2"];
  let replacements = 0;

  await prepareAndReplaceEmbeddingBatch({
    items: ["new-1", "new-2"],
    prepare: async (item) => `prepared:${item}`,
    replace: async (prepared) => {
      replacements += 1;
      existing.splice(0, existing.length, ...prepared);
    },
    failure: () => new Error("provider failed"),
  });

  assert.equal(replacements, 1);
  assert.deepEqual(existing, ["prepared:new-1", "prepared:new-2"]);
});

import { env } from "../src/config/env";
import { prisma } from "../src/config/prisma";
import { knowledgeEmbeddingService as embeddings } from "../src/services/knowledge-embedding.service";
import { mockMethod } from "./helpers/mock-method";
import type { TestContext } from "node:test";

function setup(t: TestContext) {
  const original = { key: env.OPENROUTER_API_KEY, model: env.OPENROUTER_EMBEDDING_MODEL, dimensions: env.OPENROUTER_EMBEDDING_DIMENSIONS };
  env.OPENROUTER_API_KEY = "synthetic"; env.OPENROUTER_EMBEDDING_MODEL = "synthetic-model"; env.OPENROUTER_EMBEDDING_DIMENSIONS = 1536;
  t.after(() => { env.OPENROUTER_API_KEY = original.key; env.OPENROUTER_EMBEDDING_MODEL = original.model; env.OPENROUTER_EMBEDDING_DIMENSIONS = original.dimensions; });
  const article: any = { id: "article", businessId: "a", title: "Services", summary: null, body: "Confirmed information", category: null, tags: [], status: "PUBLISHED", visibility: "CLIENT_SENDABLE", updatedAt: new Date(0) };
  const document: any = { id: "document", businessId: "a", title: "Guide", description: null, category: null, tags: [], status: "ACTIVE", processingStatus: "READY", governanceStatus: "APPROVED", visibility: "CLIENT_SENDABLE", deletedAt: null, updatedAt: new Date(0), activeVersionId: "v1", activeVersion: { facts: [{ governanceStatus: "APPROVED" }] }, chunks: [{ id: "c1", chunkText: "Safe first chunk" }, { id: "c2", chunkText: "Safe second chunk" }] };
  let facts: any[] = [];
  let vectors: any[] = [{ businessId: "a", sourceId: "document", sourceType: "DOCUMENT_FACT", content: "old approved facts" }, { businessId: "b", sourceId: "document", sourceType: "DOCUMENT_CHUNK", content: "other tenant" }];
  const reads: any[] = []; const deletes: any[] = []; let requests = 0; let inTx = false; let failAt = 0; let vectorLength = 1536; let mutate: (() => void) | undefined; let failWrite = false;
  const read = (row: any, { where }: any) => { reads.push(where); assert.ok(where.businessId); return row.id === where.id && row.businessId === where.businessId ? structuredClone(row) : null; };
  mockMethod(t, prisma.knowledgeArticle, "findFirst", async (args: any) => read(article, args));
  mockMethod(t, prisma.knowledgeDocument, "findFirst", async (args: any) => read(document, args));
  mockMethod(t, prisma.knowledgeDocumentFact, "findMany", async ({ where }: any) => {
    assert.equal(where.businessId, "a"); assert.equal(where.governanceStatus, "APPROVED"); assert.equal(where.document.visibility, "CLIENT_SENDABLE");
    assert.deepEqual(where.governanceReviews.none, { blocksAiUse: true, reviewStatus: { not: "RESOLVED" } });
    return structuredClone(facts);
  });
  mockMethod(t, prisma, "$queryRaw", async () => []);
  mockMethod(t, prisma, "$executeRaw", async (strings: TemplateStringsArray, ...values: any[]) => {
    if (!strings.join("").includes("DELETE")) return 1;
    const [businessId, sourceType, sourceId] = values; assert.ok(businessId); deletes.push({ businessId, sourceType, sourceId });
    vectors = vectors.filter(v => !(v.businessId === businessId && v.sourceType === sourceType && v.sourceId === sourceId)); return 1;
  });
  mockMethod(t, prisma, "$executeRawUnsafe", async (_sql: string, _id: string, businessId: string, sourceType: string, sourceId: string, chunkId: string, _title: string, content: string) => {
    if (failWrite) throw new Error("insert failed");
    vectors.push({ businessId, sourceType, sourceId, chunkId, content }); return 1;
  });
  mockMethod(t, prisma, "$transaction", async (fn: any, options: any) => {
    assert.equal(options.isolationLevel, "Serializable"); const before = structuredClone(vectors); inTx = true;
    try { return await fn(prisma); } catch (e) { vectors = before; throw e; } finally { inTx = false; }
  });
  mockMethod(t, globalThis, "fetch", async () => {
    assert.equal(inTx, false, "No embedding network call may occur inside a transaction"); requests++; mutate?.();
    return new Response(JSON.stringify(requests === failAt ? { error: { message: "synthetic failure" } } : { data: [{ embedding: Array(vectorLength).fill(.1) }] }), { status: requests === failAt ? 503 : 200 });
  });
  return { article, document, reads, deletes, requests: () => requests, vectors: () => structuredClone(vectors), fail: (n: number) => { failAt = n; }, dimension: (n: number) => { vectorLength = n; }, mutate: (fn: () => void) => { mutate = fn; }, failWrite: () => { failWrite = true; }, approvedFact: () => {
    facts = [{ id: "fact", label: "Hours", valueText: "Weekdays", versionId: "v1", canonicalEntityType: null, governanceReviews: [], document: { title: "Guide", activeVersionId: "v1" } }];
  } };
}

for (const eligible of [true, false]) test(`article indexing eligible=${eligible}, tenant-scoped replacement`, async t => {
  const f = setup(t); if (!eligible) f.article.visibility = "INTERNAL_ONLY";
  await embeddings.syncArticle("a", "article");
  assert.equal(f.requests(), eligible ? 1 : 0); assert.equal(f.vectors().filter(v => v.sourceType === "ARTICLE").length, eligible ? 1 : 0);
  assert.ok(f.vectors().some(v => v.businessId === "b")); assert.ok(f.deletes.every(d => d.businessId === "a"));
});

test("foreign source IDs and missing tenant cannot write or delete", async t => {
  const f = setup(t); const before = f.vectors();
  await embeddings.syncArticle("b", "article"); await embeddings.syncDocument("b", "document");
  assert.deepEqual(f.vectors(), before); assert.equal(f.requests(), 0); assert.equal(f.deletes.length, 0);
  await assert.rejects(embeddings.syncArticle("", "article"), { code: "KNOWLEDGE_EMBEDDING_SCOPE_REQUIRED" });
  await assert.rejects(embeddings.deleteSource(undefined as any, "ARTICLE", "article"), { code: "KNOWLEDGE_EMBEDDING_SCOPE_REQUIRED" });
  await embeddings.deleteSource("a", "DOCUMENT_FACT", "document"); assert.equal(f.vectors().length, 1); assert.equal(f.vectors()[0].businessId, "b");
});

for (const variant of ["eligible", "internal", "draft", "unapproved", "deleted", "unsafe-fact"] as const) test(`document governance: ${variant}`, async t => {
  const f = setup(t);
  if (variant === "internal") f.document.visibility = "INTERNAL_ONLY";
  if (variant === "draft") f.document.processingStatus = "PENDING";
  if (variant === "unapproved") f.document.governanceStatus = "PENDING_REVIEW";
  if (variant === "deleted") f.document.deletedAt = new Date();
  if (variant === "unsafe-fact") f.document.activeVersion.facts[0].governanceStatus = "PENDING_REVIEW";
  await embeddings.syncDocument("a", "document");
  assert.equal(f.requests(), variant === "eligible" ? 2 : 0);
  assert.equal(f.vectors().filter(v => v.businessId === "a").length, variant === "eligible" ? 2 : 0);
  assert.equal(f.vectors().filter(v => v.businessId === "b").length, 1);
});

test("mixed document uses approved customer-safe facts, never unsafe raw chunks", async t => {
  const f = setup(t); f.document.activeVersion.facts.push({ governanceStatus: "REJECTED" }); f.approvedFact();
  await embeddings.syncDocument("a", "document");
  const own = f.vectors().filter(v => v.businessId === "a"); assert.equal(own.length, 1); assert.equal(own[0].sourceType, "DOCUMENT_FACT"); assert.equal(own[0].content, "Hours\nWeekdays");
});

for (const variant of ["provider", "write", "dimension", "changed-chunk", "changed-article", "revoked"] as const) test(`failed/stale replacement preserves old vectors: ${variant}`, async t => {
  const f = setup(t); const before = f.vectors();
  if (variant === "provider") f.fail(2);
  if (variant === "write") f.failWrite();
  if (variant === "dimension") f.dimension(1535);
  if (variant === "changed-chunk") f.mutate(() => { f.document.chunks[0].chunkText = "Changed during generation"; });
  if (variant === "changed-article") f.mutate(() => { f.article.body = "Changed during generation"; });
  if (variant === "revoked") f.mutate(() => { f.document.visibility = "INTERNAL_ONLY"; });
  await assert.rejects(variant === "changed-article" ? embeddings.syncArticle("a", "article") : embeddings.syncDocument("a", "document"));
  assert.deepEqual(f.vectors(), before);
});

test("dimension configuration must match the deployed 1536 column", async t => {
  const f = setup(t); env.OPENROUTER_EMBEDDING_DIMENSIONS = 3072;
  await assert.rejects(embeddings.syncArticle("a", "article"), { code: "KNOWLEDGE_EMBEDDING_DIMENSION_MISMATCH" }); assert.equal(f.requests(), 0);
});

test("existing tenant content is backfilled in explicit bounded pages, including fact fallback", async t => {
  const f = setup(t); const pages: any[] = [];
  mockMethod(t, prisma.knowledgeArticle, "findMany", async (args: any) => { pages.push(args); return [{ id: "article" }, { id: "next" }]; });
  mockMethod(t, prisma.knowledgeDocument, "findMany", async (args: any) => { pages.push(args); return [{ id: "document" }]; });
  const first = await embeddings.backfill("a", { kind: "ARTICLE", limit: 1 });
  assert.equal(first.nextCursor, "article"); assert.equal(first.results[0]?.status, "SYNCED");
  f.document.governanceStatus = "PENDING_REVIEW"; f.approvedFact();
  const second = await embeddings.backfill("a", { kind: "DOCUMENT", afterId: "before", limit: 1 });
  assert.equal(second.nextCursor, null); assert.equal(second.results[0]?.status, "SYNCED");
  assert.deepEqual(pages[1].where, { businessId: "a", id: { gt: "before" } }); assert.equal(pages[0].take, 2);
  assert.ok(f.vectors().some(v => v.sourceType === "DOCUMENT_FACT"));
  await assert.rejects(embeddings.backfill("a", { kind: "ARTICLE", limit: 26 }), { code: "KNOWLEDGE_EMBEDDING_BACKFILL_INVALID" });
});

test("search uses cosine and mandatory tenant parameter without leaking another tenant", async t => {
  setup(t);
  mockMethod(t, prisma, "$queryRawUnsafe", async (sql: string, _vector: string, businessId: string) => { assert.match(sql, /<=>/); assert.match(sql, /"businessId" = \$2/); assert.equal(businessId, "a"); return []; });
  assert.deepEqual(await embeddings.search("a", "hours", 5), []);
  await assert.rejects(embeddings.search("", "hours", 5), { code: "KNOWLEDGE_EMBEDDING_SCOPE_REQUIRED" });
});


test("approved facts changed during generation cannot replace their old vectors", async t => {
  const f = setup(t); f.document.governanceStatus = "PENDING_REVIEW"; f.approvedFact(); const before = f.vectors();
  f.mutate(() => { f.document.activeVersionId = "v2"; });
  await assert.rejects(embeddings.syncApprovedFacts("a", "document"), { code: "KNOWLEDGE_DOCUMENT_EMBEDDING_SOURCE_CHANGED" }); assert.deepEqual(f.vectors(), before);
});

test("backfill reports failed sources and retains old vectors for an explicit retry", async t => {
  const f = setup(t); const before = f.vectors(); f.fail(2);
  mockMethod(t, prisma.knowledgeDocument, "findMany", async ({ where, take }: any) => { assert.equal(where.businessId, "a"); assert.equal(take, 2); return [{ id: "document" }]; });
  const failed = await embeddings.backfill("a", { kind: "DOCUMENT", limit: 1 });
  assert.equal(failed.results[0]?.status, "FAILED"); assert.deepEqual(f.vectors(), before);
  f.fail(0); const retried = await embeddings.backfill("a", { kind: "DOCUMENT", limit: 1 });
  assert.equal(retried.results[0]?.status, "SYNCED"); assert.equal(f.vectors().filter(v => v.businessId === "a").length, 2);
});

for (const length of [0, 1537]) test(`invalid provider vector length ${length} is never truncated into the index`, async t => {
  const f = setup(t); f.dimension(length); const before = f.vectors();
  await assert.rejects(embeddings.syncDocument("a", "document")); assert.deepEqual(f.vectors(), before);
});

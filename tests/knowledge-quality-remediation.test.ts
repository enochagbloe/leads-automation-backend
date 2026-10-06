import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BusinessRole, Prisma } from "@prisma/client";
import { prisma } from "../src/config/prisma";
import { knowledgeQualityAuditService as audit } from "../src/services/knowledge-quality-audit.service";
import { knowledgeQualityRemediationService as remediation } from "../src/services/knowledge-quality-remediation.service";
import { knowledgeEmbeddingService } from "../src/services/knowledge-embedding.service";
import { cacheService } from "../src/services/cache.service";
import { realtimeService } from "../src/services/realtime.service";
import { auditService } from "../src/services/audit.service";
import { mockMethod } from "./helpers/mock-method";

const actor = { businessId: "a", businessAccountId: "account", userId: "user", membershipId: "member", role: BusinessRole.MANAGER };
function fixture(t: TestContext) {
  let rows: any[] = [{ id: "article", businessId: "a", title: "Payment policies", body: "Payment is due when the consultation starts.", summary: null, category: "Payments", tags: [], relatedServiceIds: [], relatedPolicyIds: [], updatedAt: new Date("2026-10-06T00:00:00Z"), status: "PUBLISHED", visibility: "CLIENT_SENDABLE" }];
  let receipts: any[] = []; let role: BusinessRole = BusinessRole.MANAGER; let writes = 0; let syncs = 0; let cache = 0; let events = 0; let logs = 0; let inject: (() => void) | undefined; let receiptFails = false; let cacheFails = false;
  const services = [{ id: "service", businessId: "a", name: "Consultation", category: "Advice", description: "Consultation", isActive: true, isArchived: false }, { id: "foreign", businessId: "b", name: "Other", isActive: true, isArchived: false }, { id: "inactive", businessId: "a", name: "Old", isActive: false, isArchived: false }];
  const policies = [{ id: "policy", businessId: "a", title: "Payment", category: "PAYMENT", shortSummary: null, isActive: true, isArchived: false, visibility: "CUSTOMER_FACING" }, { id: "internal", businessId: "a", title: "Internal", isActive: true, isArchived: false, visibility: "INTERNAL_ONLY" }];
  const eligible = (r: any, w: any) => r.businessId === w.businessId && (w.isActive === undefined || r.isActive === w.isActive) && (w.isArchived === undefined || r.isArchived === w.isArchived) && (!w.visibility || r.visibility === w.visibility) && (!w.id?.in || w.id.in.includes(r.id));
  mockMethod(t, prisma.businessMember, "findFirst", async ({ where }: any) => { assert.equal(where.id, actor.membershipId); assert.equal(where.userId, actor.userId); return { role, status: "ACTIVE", canManageKnowledgeHub: true }; });
  mockMethod(t, prisma.business, "findFirst", async ({ where }: any) => { assert.ok(where.id); return { name: "Advice Company", industry: "Consultancy", description: "Consultation payment policies" }; });
  mockMethod(t, prisma.knowledgeArticle, "findMany", async ({ where }: any) => { assert.ok(where.businessId); return structuredClone(rows.filter(r => r.businessId === where.businessId && r.status === where.status && r.visibility === where.visibility).sort((a, b) => a.id.localeCompare(b.id))); });
  mockMethod(t, prisma.knowledgeArticle, "findFirst", async ({ where }: any) => { assert.ok(where.businessId); return structuredClone(rows.find(r => r.businessId === where.businessId && r.id === where.id) ?? null); });
  mockMethod(t, prisma.knowledgeArticle, "update", async ({ where, data }: any) => {
    assert.equal(where.businessId, "a"); assert.ok(where.updatedAt instanceof Date);
    const row = rows.find(r => r.id === where.id && r.businessId === where.businessId && +r.updatedAt === +where.updatedAt);
    if (!row) throw new Prisma.PrismaClientKnownRequestError("stale", { code: "P2025", clientVersion: "test" });
    Object.assign(row, data); writes++; return structuredClone(row);
  });
  for (const [delegate, catalog] of [[prisma.service, services], [prisma.businessPolicy, policies]] as const) {
    mockMethod(t, delegate, "findMany", async ({ where }: any) => { assert.ok(where.businessId); return catalog.filter(r => eligible(r, where)); });
    mockMethod(t, delegate, "count", async ({ where }: any) => { assert.ok(where.businessId); return catalog.filter(r => eligible(r, where)).length; });
  }
  mockMethod(t, prisma.knowledgeQualityReview, "findMany", async ({ where }: any) => { assert.ok(where.businessId); return receipts.filter(r => r.businessId === where.businessId && r.action === where.action && where.findingKey.in.includes(r.findingKey)); });
  mockMethod(t, prisma.knowledgeQualityReview, "findFirst", async ({ where }: any) => { assert.ok(where.businessId); return receipts.find(r => r.businessId === where.businessId && r.idempotencyKey === where.idempotencyKey) ?? null; });
  mockMethod(t, prisma.knowledgeQualityReview, "create", async ({ data }: any) => {
    assert.equal(data.businessId, "a");
    if (receiptFails) throw new Error("receipt failure");
    if (receipts.some(r => r.businessId === data.businessId && r.idempotencyKey === data.idempotencyKey)) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
    receipts.push(structuredClone(data)); return data;
  });
  mockMethod(t, prisma, "$queryRaw", async (query: any) => {
    assert.equal(query.values[0], "a"); assert.match(query.sql, /"businessId" =/);
    if (query.sql.includes('"KnowledgeArticle"')) { if (inject) { const fn = inject; inject = undefined; fn(); } return rows.map(r => ({ id: r.id })); }
    const catalog = query.sql.includes('"BusinessPolicy"') ? policies : services;
    return catalog.filter(r => r.businessId === "a" && r.isActive && !r.isArchived && (!("visibility" in r) || r.visibility === "CUSTOMER_FACING") && query.values.slice(1).includes(r.id)).map(r => ({ id: r.id }));
  });
  let queue = Promise.resolve();
  mockMethod(t, prisma, "$transaction", async (callback: any) => {
    const previous = queue; let release!: () => void; queue = new Promise<void>(resolve => { release = resolve; }); await previous;
    const before = structuredClone({ rows, receipts, writes });
    try { return await callback(prisma); } catch (error) { rows = before.rows; receipts = before.receipts; writes = before.writes; throw error; } finally { release(); }
  });
  mockMethod(t, knowledgeEmbeddingService, "syncArticle", async (businessId: string, id: string) => { assert.equal(businessId, "a"); assert.ok(rows.some(r => r.id === id)); syncs++; });
  mockMethod(t, cacheService, "delByPattern", async () => { cache++; if (cacheFails) throw new Error("cache failed"); });
  mockMethod(t, realtimeService, "publish", () => { events++; });
  mockMethod(t, auditService, "log", async () => { logs++; });
  const finding = async (code = "MISSING_RELEVANCE_METADATA") => (await audit.audit("a")).findings.find(f => f.code === code)!;
  const input = async (action = "UPDATE_CATEGORY") => ({ findingKey: (await finding()).findingKey, action, articleId: "article", expectedArticleUpdatedAt: rows[0].updatedAt.toISOString(), ...(action === "UPDATE_CATEGORY" ? { category: "Payment" } : {}) });
  return { rows: () => rows, receipts: () => receipts, finding, input, counts: () => ({ writes, syncs, cache, events, logs }), staff: () => { role = BusinessRole.STAFF; }, inject: (fn: () => void) => { inject = fn; }, failReceipt: () => { receiptFails = true; }, failCache: () => { cacheFails = true; } };
}
const resolve = (input: unknown, key = "request") => remediation.resolve(actor, input, key, {});

test("fingerprints are stable, tenant-bound, revision-bound and audit is read-only", async t => {
  const f = fixture(t); const before = structuredClone(f.rows()); const first = await f.finding(); assert.equal((await f.finding()).findingKey, first.findingKey);
  assert.deepEqual(f.rows(), before); assert.equal(f.counts().writes, 0);
  f.rows()[0].updatedAt = new Date("2026-10-07"); assert.notEqual((await f.finding()).findingKey, first.findingKey);
});
test("dismissal persists only for exact fingerprint with no article effects", async t => {
  const f = fixture(t); const first = await f.finding();
  await resolve({ action: "DISMISS", findingKey: first.findingKey, note: "Intentional general policy" });
  assert.equal((await f.finding()).reviewStatus, "DISMISSED"); assert.equal(f.counts().writes, 0); assert.equal(f.counts().syncs, 0);
  f.rows()[0].updatedAt = new Date("2026-10-07"); assert.equal((await f.finding()).reviewStatus, "OPEN");
  assert.equal(f.receipts()[0].actorMembershipId, actor.membershipId);
});
test("explicit category update uses canonical side effects and replays without another write", async t => {
  const f = fixture(t); const input = await f.input(); const result = await resolve(input); const revision = f.rows()[0].updatedAt;
  assert.equal(result.action, "UPDATE_CATEGORY"); assert.equal(result.originalFindingStillAppears, false); assert.equal(f.rows()[0].category, "Payment");
  assert.equal(f.counts().writes, 1); assert.equal(f.counts().syncs, 1); assert.equal(f.counts().cache, 2); assert.equal(f.counts().events, 1); assert.equal(f.counts().logs, 1);
  await resolve(input); assert.equal(f.counts().writes, 1); assert.deepEqual(f.rows()[0].updatedAt, revision);
  await assert.rejects(resolve({ ...input, category: "Different" }), { code: "KNOWLEDGE_QUALITY_IDEMPOTENCY_CONFLICT" });
});
for (const kind of ["foreign-finding", "stale-finding", "stale-article", "staff", "missing-key", "missing-selection"]) test(`invalid resolution is nonmutating: ${kind}`, async t => {
  const f = fixture(t); const input = await f.input();
  let expected = "KNOWLEDGE_QUALITY_FINDING_STALE";
  if (kind === "foreign-finding") { f.rows()[0].businessId = "b"; }
  if (kind === "stale-finding") f.rows()[0].updatedAt = new Date("2026-10-07");
  if (kind === "stale-article") { input.expectedArticleUpdatedAt = new Date(0).toISOString(); expected = "KNOWLEDGE_QUALITY_ARTICLE_STALE"; }
  if (kind === "staff") { f.staff(); expected = "KNOWLEDGE_DOCUMENT_PERMISSION_DENIED"; }
  if (kind === "missing-key") expected = "KNOWLEDGE_QUALITY_IDEMPOTENCY_REQUIRED";
  if (kind === "missing-selection") { await assert.rejects(resolve({ action: "ARCHIVE_ARTICLE", findingKey: input.findingKey })); }
  else await assert.rejects(resolve(input, kind === "missing-key" ? "" : "request"), { code: expected });
  assert.equal(f.counts().writes, 0); assert.equal(f.counts().syncs, 0); assert.equal(f.receipts().length, 0);
});
for (const id of ["foreign", "missing", "inactive"]) test(`relationship rejects noncurrent service: ${id}`, async t => {
  const f = fixture(t); await assert.rejects(resolve({ ...await f.input("UPDATE_RELATIONSHIPS"), relatedServiceIds: [id], relatedPolicyIds: [] }));
  assert.equal(f.counts().writes, 0); assert.equal(f.counts().syncs, 0);
});
for (const id of ["internal", "missing"]) test(`relationship rejects noncustomer policy: ${id}`, async t => {
  const f = fixture(t); await assert.rejects(resolve({ ...await f.input("UPDATE_RELATIONSHIPS"), relatedServiceIds: [], relatedPolicyIds: [id] })); assert.equal(f.counts().writes, 0);
});
test("valid explicitly supplied relationship arrays replace exactly and sync", async t => {
  const f = fixture(t); const result = await resolve({ ...await f.input("UPDATE_RELATIONSHIPS"), relatedServiceIds: ["service"], relatedPolicyIds: ["policy"] });
  assert.deepEqual(f.rows()[0].relatedServiceIds, ["service"]); assert.deepEqual(f.rows()[0].relatedPolicyIds, ["policy"]); assert.equal(result.originalFindingStillAppears, false); assert.equal(f.counts().syncs, 1);
});
test("duplicate archive changes only manager-selected article", async t => {
  const f = fixture(t); f.rows().push({ ...structuredClone(f.rows()[0]), id: "other" });
  const duplicate = await f.finding("DUPLICATE_CUSTOMER_ARTICLE");
  await resolve({ action: "ARCHIVE_ARTICLE", findingKey: duplicate.findingKey, articleId: "other", expectedArticleUpdatedAt: f.rows()[1].updatedAt.toISOString() });
  assert.equal(f.rows()[0].status, "PUBLISHED"); assert.equal(f.rows()[1].status, "ARCHIVED"); assert.equal(f.counts().writes, 1); assert.equal(f.counts().syncs, 1);
});
test("revision changes between preflight and locked audit reject without write", async t => {
  const f = fixture(t); const input = await f.input(); f.inject(() => { f.rows()[0].updatedAt = new Date("2026-10-07"); });
  await assert.rejects(resolve(input), { code: "KNOWLEDGE_QUALITY_FINDING_STALE" }); assert.equal(f.counts().writes, 0); assert.equal(f.counts().syncs, 0);
});
test("receipt persistence failure rolls back canonical mutation", async t => {
  const f = fixture(t); const input = await f.input(); f.failReceipt(); await assert.rejects(resolve(input), /receipt failure/);
  assert.equal(f.rows()[0].category, "Payments"); assert.equal(f.counts().writes, 0); assert.equal(f.counts().syncs, 0);
});
test("post-commit failure replays committed receipt and already scheduled sync", async t => {
  const f = fixture(t); const input = await f.input(); f.failCache(); const result = await resolve(input); assert.equal(result.action, "UPDATE_CATEGORY");
  await resolve(input); assert.equal(f.counts().writes, 1); assert.equal(f.counts().syncs, 1);
});
test("concurrent duplicate requests cannot commit twice", async t => {
  const f = fixture(t); const input = await f.input(); const results = await Promise.allSettled([resolve(input), resolve(input)]);
  assert.ok(results.some(r => r.status === "fulfilled")); assert.equal(f.counts().writes, 1); assert.equal(f.receipts().length, 1); assert.equal(f.counts().syncs, 1);
});

test("foreign tenant fingerprint cannot resolve against identical local article content", async t => {
  const f = fixture(t); const local = await f.finding(); f.rows()[0].businessId = "b";
  const foreign = (await audit.audit("b")).findings.find(x => x.code === "MISSING_RELEVANCE_METADATA")!;
  f.rows()[0].businessId = "a"; assert.notEqual(foreign.findingKey, local.findingKey);
  await assert.rejects(resolve({ action: "DISMISS", findingKey: foreign.findingKey }), { code: "KNOWLEDGE_QUALITY_FINDING_STALE" });
  assert.equal(f.receipts().length, 0); assert.equal(f.counts().writes, 0);
});
test("change to another member of a duplicate group invalidates selection", async t => {
  const f = fixture(t); f.rows().push({ ...structuredClone(f.rows()[0]), id: "other" });
  const finding = await f.finding("DUPLICATE_CUSTOMER_ARTICLE");
  f.inject(() => { f.rows()[1].updatedAt = new Date("2026-10-07"); });
  await assert.rejects(resolve({ action: "ARCHIVE_ARTICLE", findingKey: finding.findingKey, articleId: "article", expectedArticleUpdatedAt: f.rows()[0].updatedAt.toISOString() }), { code: "KNOWLEDGE_QUALITY_FINDING_STALE" });
  assert.equal(f.counts().writes, 0); assert.equal(f.counts().syncs, 0);
});
test("schema rejects client business scope and incomplete relationship replacement", async t => {
  const f = fixture(t); const input = await f.input("UPDATE_RELATIONSHIPS");
  await assert.rejects(resolve({ ...input, businessId: "b", relatedServiceIds: [], relatedPolicyIds: [] }));
  await assert.rejects(resolve({ ...input, relatedServiceIds: [] }));
  assert.equal(f.counts().writes, 0); assert.equal(f.receipts().length, 0);
});

for (const action of ["UPDATE_CATEGORY", "ARCHIVE_ARTICLE"]) test(`article removed after preflight returns a stable stale conflict: ${action}`, async t => {
  const f = fixture(t); const input = await f.input(action);
  mockMethod(t, prisma.knowledgeArticle, "findFirst", async () => null);
  await assert.rejects(resolve(input), { code: "KNOWLEDGE_QUALITY_ARTICLE_STALE" });
  assert.equal(f.counts().writes, 0); assert.equal(f.receipts().length, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/config/prisma";
import { knowledgeQualityAuditService as audit } from "../src/services/knowledge-quality-audit.service";
import { mockMethod } from "./helpers/mock-method";

const article = (id: string, extra: Record<string, unknown> = {}) => ({ id, updatedAt: new Date("2026-10-06T00:00:00Z"), businessId: "a", status: "PUBLISHED", visibility: "CLIENT_SENDABLE", title: "Project guidance", body: "Planning projects and managing timelines", summary: null, category: null, tags: [], relatedServiceIds: [], relatedPolicyIds: [], ...extra });
function setup(t: Parameters<typeof mockMethod>[0], rows: ReturnType<typeof article>[]) {
  const before = structuredClone(rows); const reads: string[] = [];
  // Deliberately supply only read delegates: any attempted mutation fails the test.
  const tx = {
    knowledgeQualityReview: { findMany: async ({ where }: any) => { assert.equal(where.businessId, "a"); assert.equal(where.action, "DISMISS"); return []; } },
    business: { findFirst: async ({ where }: any) => { assert.equal(where.id, "a"); reads.push("business"); return { name: "Project Partners", industry: "Consultancy", description: "Strategy planning projects delivery management" }; } },
    knowledgeArticle: { findMany: async ({ where, take }: any) => {
      assert.deepEqual(where, { businessId: "a", status: "PUBLISHED", visibility: "CLIENT_SENDABLE" }); assert.equal(take, 5001); reads.push("articles");
      return rows.filter(r => r.businessId === where.businessId && r.status === where.status && r.visibility === where.visibility).sort((a, b) => a.id.localeCompare(b.id));
    } },
    service: { findMany: async ({ where }: any) => { assert.deepEqual(where, { businessId: "a", isActive: true, isArchived: false }); reads.push("services"); return [{ id: "service", businessId: "a", name: "Strategy consultation", category: "Planning", description: "Project delivery" }, { id: "photography", businessId: "a", name: "Event photography", category: "Photography", description: null }, { id: "foreign-service", businessId: "b", name: "Project guidance", category: "Planning", description: null }].filter(s => s.businessId === where.businessId); } },
    businessPolicy: { findMany: async ({ where }: any) => { assert.deepEqual(where, { businessId: "a", isActive: true, isArchived: false, visibility: "CUSTOMER_FACING" }); reads.push("policies"); return [{ id: "policy", businessId: "a", title: "Project cancellation", category: "CANCELLATION", shortSummary: null }, { id: "foreign-policy", businessId: "b", title: "Project guidance", category: "GENERAL", shortSummary: null }].filter(p => p.businessId === where.businessId); } },
  };
  mockMethod(t, prisma, "$transaction", async (callback: any, options: any) => { assert.equal(options.isolationLevel, "RepeatableRead"); return callback(tx); });
  t.after(() => assert.deepEqual(rows, before));
  return { reads };
}
test("exact normalized duplicate creates one stable group without mutation", async t => {
  setup(t, [article("b", { title: "PROJECT guidance!" }), article("a")]);
  const result = await audit.audit("a");
  const duplicates = result.findings.filter(f => f.code === "DUPLICATE_CUSTOMER_ARTICLE");
  assert.equal(duplicates.length, 1); assert.deepEqual(duplicates[0]!.articleIds, ["a", "b"]);
  assert.equal(result.summary.duplicateGroups, 1); assert.equal(result.summary.articlesScanned, 2);
  assert.deepEqual(await audit.audit("a"), result);
});
for (const [name, body] of [["material content", "Our project team provides training instead of delivery management"], ["numeric claims", "Planning costs GHS 200"], ["negation", "Planning is not included"]]) test(`matching titles preserve ${name}`, async t => {
  setup(t, [article("a", { body: name === "numeric claims" ? "Planning costs GHS 100" : "Planning is included" }), article("b", { body })]);
  assert.equal((await audit.audit("a")).summary.duplicateGroups, 0);
});
test("category variants create a conflict without renaming", async t => {
  setup(t, [article("a", { category: "Customer service" }), article("b", { category: " CUSTOMER-Service " }), article("c", { category: "Customer Service" })]);
  const r = await audit.audit("a"); assert.equal(r.summary.categoryConflictGroups, 1);
  assert.deepEqual(r.findings.find(f => f.code === "CATEGORY_NORMALIZATION_NEEDED")!.articleIds, ["a", "b", "c"]);
});
test("specific article without links needs metadata but does not invent relationships", async t => {
  setup(t, [article("a", { title: "Payment policy" }), article("b", { title: "Strategy consultation", relatedServiceIds: ["service"] }), article("c", { title: "Refund policy", relatedPolicyIds: ["policy"] })]);
  const r = await audit.audit("a"); assert.deepEqual(r.findings.filter(f => f.code === "MISSING_RELEVANCE_METADATA").flatMap(f => f.articleIds), ["a"]);
  assert.ok(r.findings.every(f => !Object.keys(f).includes("relatedServiceIds")));
});
test("generic company introduction is not flagged", async t => {
  setup(t, [article("a", { title: "About us", body: "Welcome to our company. We help customers achieve their goals with a friendly professional team." })]);
  assert.deepEqual((await audit.audit("a")).findings, []);
});
test("clear lexical domain mismatch is review-only", async t => {
  setup(t, [article("a", { title: "Passport renewal", body: "Submit citizenship records photographs embassy application consulate biometric identity immigration travel eligibility documents." })]);
  const r = await audit.audit("a"); assert.equal(r.summary.articlesNeedingReview, 1);
  assert.equal(r.findings[0]!.code, "POSSIBLE_OUT_OF_DOMAIN_ARTICLE"); assert.match(r.findings[0]!.suggestedAction, /Human review/);
});
test("tenant and publication visibility exclusions are mandatory at every boundary", async t => {
  const f = setup(t, [article("eligible"), article("foreign", { businessId: "b" }), article("internal", { visibility: "INTERNAL_ONLY" }), article("draft", { status: "DRAFT" }), article("review", { status: "NEEDS_REVIEW" })]);
  const r = await audit.audit("a"); assert.equal(r.summary.articlesScanned, 1); assert.deepEqual(f.reads, ["business", "articles", "services", "policies"]);
  assert.ok(r.findings.every(f => f.articleIds.every(id => id === "eligible")));
});
test("missing tenant rejected before database access", async t => {
  const f = setup(t, []); await assert.rejects(audit.audit(" "), { code: "KNOWLEDGE_AUDIT_SCOPE_REQUIRED" }); assert.deepEqual(f.reads, []);
});
test("empty tenant returns zero counts", async t => {
  setup(t, []); assert.deepEqual((await audit.audit("a")).summary, { articlesScanned: 0, findings: 0, duplicateGroups: 0, categoryConflictGroups: 0, articlesNeedingReview: 0 });
});

test("different currency claims never collapse", async t => {
  setup(t, [article("a", { body: "Planning costs $100" }), article("b", { body: "Planning costs €100" })]);
  assert.equal((await audit.audit("a")).summary.duplicateGroups, 0);
});
test("substantially identical long text forms one duplicate group", async t => {
  const body = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  setup(t, [article("a", { body }), article("b", { body: body + " today" })]);
  assert.equal((await audit.audit("a")).summary.duplicateGroups, 1);
});
test("oversized audits fail explicitly rather than returning partial counts", async t => {
  setup(t, Array.from({ length: 5001 }, (_, i) => article(String(i))));
  await assert.rejects(audit.audit("a"), { code: "KNOWLEDGE_AUDIT_LIMIT_EXCEEDED" });
});

const unrelatedBody = "Software compilers algorithms debugging programming binaries memory concurrency architecture refactoring engineers coding frameworks.";
test("linked unrelated article receives domain and specific relationship findings", async t => {
  setup(t, [article("a", { title: "From Code Builder to Software Engineer: Scaling Your Mindset", body: unrelatedBody, relatedServiceIds: ["service"] })]);
  const r = await audit.audit("a");
  assert.ok(r.findings.some(f => f.code === "POSSIBLE_OUT_OF_DOMAIN_ARTICLE"));
  const relationship = r.findings.find(f => f.code === "SUSPICIOUS_RELEVANCE_RELATIONSHIP")!;
  assert.deepEqual(relationship.metadata, { relatedServiceIds: ["service"], relatedPolicyIds: [] });
  assert.match(r.findings.find(f => f.code === "POSSIBLE_OUT_OF_DOMAIN_ARTICLE")!.suggestedAction, /relationships/);
});
test("relevant linked article retains overlap even with additional vocabulary", async t => {
  setup(t, [article("a", { body: "Strategy planning projects improve scheduling timelines coordination leadership budgets delivery goals management.", relatedServiceIds: ["service"], relatedPolicyIds: ["policy"] })]);
  const r = await audit.audit("a"); assert.ok(!r.findings.some(f => ["POSSIBLE_OUT_OF_DOMAIN_ARTICLE", "SUSPICIOUS_RELEVANCE_RELATIONSHIP", "STALE_RELEVANCE_RELATIONSHIP"].includes(f.code)));
});
test("wrong service link flagged even when article matches business domain", async t => {
  setup(t, [article("a", { body: "Strategy planning projects improve scheduling timelines coordination leadership budgets delivery goals management.", relatedServiceIds: ["photography"] })]);
  const r = await audit.audit("a");
  assert.deepEqual(r.findings.find(f => f.code === "SUSPICIOUS_RELEVANCE_RELATIONSHIP")!.metadata, { relatedServiceIds: ["photography"], relatedPolicyIds: [] });
  assert.ok(!r.findings.some(f => f.code === "POSSIBLE_OUT_OF_DOMAIN_ARTICLE"));
});
test("unresolvable service and policy links are reported without being removed", async t => {
  setup(t, [article("a", { relatedServiceIds: ["deleted-service", "foreign-service", "deleted-service"], relatedPolicyIds: ["archived-policy", "foreign-policy"] })]);
  const r = await audit.audit("a"); assert.deepEqual(r.findings.find(f => f.code === "STALE_RELEVANCE_RELATIONSHIP")!.metadata, { relatedServiceIds: ["deleted-service", "foreign-service"], relatedPolicyIds: ["archived-policy", "foreign-policy"] });
});
for (const title of ["Introduction to Project Partners", "About Project Partners", "Welcome to Project Partners", "Company introduction", "Business overview", "Who we are"]) test(`generic title exempts missing metadata only: ${title}`, async t => {
  setup(t, [article("a", { title, category: "Services", body: "We provide strategy consultation and project planning." })]);
  assert.ok(!(await audit.audit("a")).findings.some(f => f.code === "MISSING_RELEVANCE_METADATA"));
});
test("introductory business title cannot mask unrelated body", async t => {
  setup(t, [article("a", { title: "Introduction to Project Partners", body: unrelatedBody, category: "Services" })]);
  const r = await audit.audit("a"); assert.ok(r.findings.some(f => f.code === "POSSIBLE_OUT_OF_DOMAIN_ARTICLE"));
  assert.ok(!r.findings.some(f => f.code === "MISSING_RELEVANCE_METADATA"));
});
test("brief content does not trigger speculative relationship or domain judgments", async t => {
  setup(t, [article("a", { body: "Expert advice.", title: "Advice", relatedServiceIds: ["service"] })]);
  assert.deepEqual((await audit.audit("a")).findings, []);
});

test("wrong policy relationship identifies the policy independently", async t => {
  setup(t, [article("a", { title: "Photography advice", body: "Photography cameras lenses lighting composition portraits weddings editing exposure aperture shutters focus.", relatedServiceIds: ["photography"], relatedPolicyIds: ["policy"] })]);
  const r = await audit.audit("a"); assert.deepEqual(r.findings.find(f => f.code === "SUSPICIOUS_RELEVANCE_RELATIONSHIP")!.metadata, { relatedServiceIds: [], relatedPolicyIds: ["policy"] });
  assert.ok(!r.findings.some(f => f.code === "POSSIBLE_OUT_OF_DOMAIN_ARTICLE"));
});

for (const category of ["Customer Service", "Customer Support", "Support", "General Information", " CUSTOMER-Service "]) test(`generic representative article does not require relationships from category: ${category}`, async t => {
  setup(t, [article("a", { title: "How to Chat with Our Customer Representative", category, tags: ["Customer Service"], body: "Contact our team for help with your questions." })]);
  assert.ok(!(await audit.audit("a")).findings.some(f => f.code === "MISSING_RELEVANCE_METADATA"));
});
for (const title of ["Photography Payment Policies", "Refund Policies", "Appointment location information", "Strategy consultation", "Event photography", "Project cancellation"]) test(`specific operational or catalog title still requires metadata: ${title}`, async t => {
  setup(t, [article("a", { title, category: "Customer Service" })]);
  assert.deepEqual((await audit.audit("a")).findings.filter(f => f.code === "MISSING_RELEVANCE_METADATA").map(f => f.articleIds), [["a"]]);
});
test("strong operational tag remains actionable with a generic title", async t => {
  setup(t, [article("a", { title: "Useful information", category: "Customer Support", tags: ["deposit"] })]);
  assert.ok((await audit.audit("a")).findings.some(f => f.code === "MISSING_RELEVANCE_METADATA"));
});
test("duplicate representatives and category conflicts survive removal of metadata false positives", async t => {
  const content = { title: "How to Chat with Our Customer Representative", body: "Contact our team for help with your questions." };
  setup(t, [article("a", { ...content, category: "Customer service" }), article("b", { ...content, category: "Customer Service" })]);
  const r = await audit.audit("a");
  assert.equal(r.summary.duplicateGroups, 1); assert.equal(r.summary.categoryConflictGroups, 1);
  assert.ok(!r.findings.some(f => f.code === "MISSING_RELEVANCE_METADATA"));
});

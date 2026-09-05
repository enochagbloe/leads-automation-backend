import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/config/prisma";
import { env } from "../src/config/env";
import { demoService, DemoActor } from "../src/services/demo.service";
import { demoSetupService } from "../src/services/demo-setup.service";
import { demoCrawlerService, CrawlResult } from "../src/services/demo-crawler.service";
import { demoExtractionService, emptyDemoFacts } from "../src/services/demo-extraction.service";
import { demoContextSummary, demoContextSchema, demoContextService } from "../src/services/demo-context.service";
import { mockMethod } from "./helpers/mock-method";

const actor: DemoActor = { actorType: "DEMO", isDemo: true, demoSessionId: "session", businessId: "business" };
function fixture(t: import("node:test").TestContext) {
  const old = env.DEMO_ENABLED; env.DEMO_ENABLED = true; t.after(() => { env.DEMO_ENABLED = old; });
  const state: any = { setupStatus: "WAITING_FOR_BUSINESS", active: true, demoContext: null };
  let businessWrites = 0;
  const tx = {
    demoSession: {
      updateMany: async ({ where, data }: any) => {
        assert.equal(where.id, actor.demoSessionId);
        if (!state.active || where.business.id !== actor.businessId) return { count: 0 };
        if (where.OR && state.setupStatus === "PROCESSING_WEBSITE") return { count: 0 };
        if (where.setupAttemptId && where.setupAttemptId !== state.setupAttemptId) return { count: 0 };
        Object.assign(state, data); return { count: 1 };
      },
      findFirst: async ({ where }: any) => where.business.id === actor.businessId && state.active ? { id: actor.demoSessionId } : null,
    },
    business: { update: async ({ where }: any) => { assert.equal(where.id, actor.businessId); assert.equal(where.demoSessionId, actor.demoSessionId); businessWrites++; } },
  };
  mockMethod(t, prisma, "$transaction", async callback => callback(tx));
  mockMethod(t, demoService, "get", async () => ({ success: true, demo: { setupStatus: state.setupStatus, ...demoContextSummary(state.demoContext) } }));
  return { state, writes: () => businessWrites };
}
test("company-only setup is usable, stores bounded context and does not crawl", async t => {
  const { state, writes } = fixture(t);
  const crawler = mockMethod(t, demoCrawlerService, "crawl", async () => { throw new Error("must not crawl"); });
  await demoSetupService.setup(actor, { businessName: " Acme " });
  assert.equal(state.setupStatus, "READY_PARTIAL"); assert.equal(state.demoContext.businessName, "Acme");
  assert.equal(state.demoContext.sourceWebsite, null); assert.equal(crawler.mock.callCount(), 0); assert.equal(writes(), 2);
});
test("website setup saves extracted facts and replaces previous context on repeated setup", async t => {
  const { state } = fixture(t);
  const result: CrawlResult = { sourceWebsite: "https://example.com/", crawlStatus: "COMPLETE", startedAt: "start", completedAt: "end", pagesAttempted: 1, pagesFetched: 1, errorCode: null, pages: [] };
  mockMethod(t, demoCrawlerService, "crawl", async () => result);
  mockMethod(t, demoExtractionService, "extract", async () => ({ facts: { ...emptyDemoFacts(), description: "Explicit website description" }, extractionStatus: "COMPLETE" }));
  await demoSetupService.setup(actor, { businessName: "Acme", websiteUrl: "https://example.com/" });
  assert.equal(state.setupStatus, "READY"); assert.equal(state.demoContext.facts.description, "Explicit website description");
  await demoSetupService.setup(actor, { businessName: "New Company" });
  assert.equal(state.setupStatus, "READY_PARTIAL"); assert.equal(state.demoContext.sourceWebsite, null); assert.equal(state.demoContext.facts.description, null);
});
test("failed website still makes demo ready with limited knowledge", async t => {
  const { state } = fixture(t);
  mockMethod(t, demoCrawlerService, "crawl", async () => { throw new Error("internal network error with sensitive data"); });
  await demoSetupService.setup(actor, { businessName: "Acme", websiteUrl: "https://example.com" });
  assert.equal(state.setupStatus, "READY_PARTIAL"); assert.equal(state.demoContext.errorCode, "DEMO_WEBSITE_FETCH_FAILED");
  assert.doesNotMatch(JSON.stringify(state.demoContext), /sensitive/);
});
test("duplicate setup is rejected while a crawl owns the session; expired attempts cannot save", async t => {
  const { state, writes } = fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  mockMethod(t, demoCrawlerService, "crawl", async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); throw new Error("timeout"); });
  const first = demoSetupService.setup(actor, { businessName: "Acme", websiteUrl: "https://example.com" });
  await started;
  await assert.rejects(demoSetupService.setup(actor, { businessName: "Duplicate" }), { code: "DEMO_SETUP_IN_PROGRESS" });
  state.active = false; release();
  await assert.rejects(first, { code: "DEMO_SETUP_STALE" });
  assert.equal(writes(), 1);
});
test("forged cross-business setup actor cannot mutate or crawl", async t => {
  const { writes } = fixture(t);
  const crawler = mockMethod(t, demoCrawlerService, "crawl", async () => { throw new Error("must not crawl"); });
  await assert.rejects(demoSetupService.setup({ ...actor, businessId: "production" }, { businessName: "Attack", websiteUrl: "https://example.com" }), { code: "DEMO_RESOURCE_FORBIDDEN" });
  assert.equal(writes(), 0); assert.equal(crawler.mock.callCount(), 0);
});

test("oversized context saves empty fallback facts and remains READY_PARTIAL", async t => {
  const { state } = fixture(t);
  const result: CrawlResult = {
    sourceWebsite: "https://example.com/", crawlStatus: "COMPLETE", startedAt: "start", completedAt: "end", pagesAttempted: 5, pagesFetched: 5, errorCode: null,
    pages: Array.from({ length: 5 }, (_, i) => ({
      url: `https://example.com/${i}/${"x".repeat(1900)}`, title: "t".repeat(200), description: "d".repeat(500), text: "",
      links: ["booking", "contact"].map(kind => ({ url: `https://example.com/${kind}/${i}/${"x".repeat(1900)}`, label: kind })),
    })),
  };
  mockMethod(t, demoCrawlerService, "crawl", async () => result);
  mockMethod(t, demoExtractionService, "extract", async () => ({
    facts: { ...emptyDemoFacts(), description: "d".repeat(600), services: Array.from({ length: 8 }, () => ({ name: "n".repeat(150), description: "d".repeat(600), price: "p".repeat(150), duration: "t".repeat(150) })) },
    extractionStatus: "COMPLETE",
  }));
  await demoSetupService.setup(actor, { businessName: "Acme", websiteUrl: "https://example.com" });
  const context = demoContextSchema.parse(state.demoContext);
  assert.equal(context.errorCode, "DEMO_CONTEXT_TOO_LARGE");
  assert.deepEqual(context.facts, emptyDemoFacts());
  assert.equal(context.extractionStatus, "FALLBACK");
  assert.equal(state.setupStatus, "READY_PARTIAL");
  assert.ok(JSON.stringify(context).length < 40_000);
});

test("stalled recovery repairs null/malformed context and keeps ready contexts readable", async t => {
  const valid = {
    businessName: "Original", facts: emptyDemoFacts(), sourceWebsite: null,
    crawlStatus: "PROCESSING", extractionStatus: "COMPLETE", startedAt: "start", completedAt: null,
    pagesAttempted: 0, pagesFetched: 0, errorCode: null,
    sources: [], bookingLinks: [], contactLinks: [], unknowns: [],
  };
  const sessions = [null, { businessName: "Do not trust broken context", facts: {} }, valid].map((demoContext, i) => ({
    id: `session-${i}`, setupAttemptId: `attempt-${i}`, setupStartedAt: new Date(Date.now() - 120_000), demoContext,
    business: { name: " Recovered Company " },
  }));
  const saved = new Map<string, any>();
  mockMethod(t, prisma.demoSession, "findMany", async () => sessions);
  mockMethod(t, prisma.demoSession, "updateMany", async ({ where, data }) => {
    const session = sessions.find(item => item.id === where.id)!;
    assert.equal(where.status, "ACTIVE"); assert.equal(where.setupStatus, "PROCESSING_WEBSITE");
    assert.equal(where.setupAttemptId, session.setupAttemptId);
    assert.ok(where.setupStartedAt.lt > session.setupStartedAt);
    saved.set(where.id, data); return { count: 1 };
  });
  mockMethod(t, prisma.demoSession, "findFirst", async ({ where }) => saved.get(where.id));
  await demoSetupService.recoverStalled();
  for (const [i, session] of sessions.entries()) {
    assert.equal(saved.get(session.id).setupStatus, "READY_PARTIAL");
    const context = await demoContextService.getBusinessContext({ ...actor, demoSessionId: session.id });
    assert.equal(context.businessName, i === 2 ? "Original" : "Recovered Company");
    assert.equal(context.crawlStatus, "FAILED");
    assert.equal(context.extractionStatus, "FALLBACK");
    assert.equal(context.errorCode, "DEMO_SETUP_INTERRUPTED");
    assert.deepEqual(context.facts, emptyDemoFacts());
    assert.ok(context.completedAt);
  }
});

test("stalled recovery without usable business context returns to the form", async t => {
  let saved: any;
  mockMethod(t, prisma.demoSession, "findMany", async () => [{ id: actor.demoSessionId, setupAttemptId: "attempt", setupStartedAt: new Date(0), demoContext: null, business: null }]);
  mockMethod(t, prisma.demoSession, "updateMany", async ({ data }) => { saved = data; return { count: 1 }; });
  mockMethod(t, prisma.demoSession, "findFirst", async () => saved);
  await demoSetupService.recoverStalled();
  assert.equal(saved.setupStatus, "WAITING_FOR_BUSINESS");
  assert.equal(saved.setupCompletedAt, null);
  await assert.rejects(demoContextService.getBusinessContext(actor), { code: "DEMO_SETUP_NOT_READY" });
});

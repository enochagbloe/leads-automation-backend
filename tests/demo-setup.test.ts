import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/config/prisma";
import { env } from "../src/config/env";
import { demoService, DemoActor } from "../src/services/demo.service";
import { demoSetupService } from "../src/services/demo-setup.service";
import { demoCrawlerService, CrawlResult } from "../src/services/demo-crawler.service";
import { demoExtractionService, emptyDemoFacts } from "../src/services/demo-extraction.service";
import { demoContextSummary } from "../src/services/demo-context.service";
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

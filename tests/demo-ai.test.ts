import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { env } from "../src/config/env";
import { prisma } from "../src/config/prisma";
import { demoService, DemoActor } from "../src/services/demo.service";
import { demoRouter } from "../src/routes/demo.routes";
import { errorHandler } from "../src/middleware/error";
import { processLatestDemoReply } from "../src/services/demo-ai-processing.service";
import { demoMessageService } from "../src/services/demo-message.service";
import { emptyDemoFacts } from "../src/services/demo-extraction.service";
import { buildDemoBusinessContext } from "../src/services/demo-business-context.provider";
import { aiPromptContextFormatter } from "../src/services/ai-context-builder.service";
import { aiSafetyService } from "../src/services/ai-safety.service";
import { aiUsageService } from "../src/services/ai-usage.service";
import { realtimeService } from "../src/services/realtime.service";
import { customerMemoryResolverService } from "../src/services/customer-memory/customer-memory-resolver.service";
import { MetaWhatsAppProvider, MockWhatsAppProvider } from "../src/services/whatsapp-provider.service";
import { mockMethod } from "./helpers/mock-method";

const actor: DemoActor = { actorType: "DEMO", isDemo: true, demoSessionId: "session-a", businessId: "business-a" };
const decision = { intent: "PRICING_INQUIRY" as const, replyText: "Roof inspection costs GHS 300.", confidence: 1, shouldReply: true, requiresHumanReview: false, reason: "Confirmed fact", suggestedAction: "SEND_REPLY" as const, usedKnowledge: { profile: false, services: true, availability: false, policies: false, conversationHistory: true } };

function fixture(t: TestContext) {
  const saved = { DEMO_ENABLED: env.DEMO_ENABLED, OPENROUTER_API_KEY: env.OPENROUTER_API_KEY, OPENROUTER_DEFAULT_MODEL: env.OPENROUTER_DEFAULT_MODEL };
  Object.assign(env, { DEMO_ENABLED: true, OPENROUTER_API_KEY: "test-only", OPENROUTER_DEFAULT_MODEL: "test-model" });
  t.after(() => Object.assign(env, saved));
  const facts = emptyDemoFacts();
  facts.services = [{ name: "Roof inspection", description: null, price: "GHS 300", duration: null }, { name: "Roof replacement", description: null, price: null, duration: null }];
  const state = { active: true, setupStatus: "READY", setupAttemptId: "setup-a", channel: "DEMO", validLead: true, fail: false, malformed: false, nextDecision: { ...decision } as any, beforeResponse: undefined as (() => Promise<void>) | undefined };
  const context = { businessName: "Acme Roofing", facts, sourceWebsite: null, crawlStatus: "COMPLETE", extractionStatus: "COMPLETE", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), pagesAttempted: 1, pagesFetched: 1, errorCode: null, sources: [], bookingLinks: [], contactLinks: [], unknowns: ["Replacement price", "Hours", "Duration", "Policies"] };
  const rows: any[] = []; const activities: any[] = []; const requests: any[] = [];
  function add(overrides: Record<string, unknown> = {}) {
    const row = { id: randomUUID(), businessId: actor.businessId, conversationId: "conversation-a", leadId: "customer-a", senderType: "CUSTOMER", direction: "INBOUND", messageType: "TEXT", provider: "DEMO", providerMessageId: randomUUID(), metadata: { isDemo: true }, content: "How much is roof inspection?", createdAt: new Date(Date.now() + rows.length * 1000), deletedAt: null, ...overrides };
    rows.push(row); return row;
  }
  function matches(row: any, where: any): boolean {
    return Object.entries(where).every(([key, value]: [string, any]) => {
      if (key === "AND") return value.every((v: any) => matches(row, v));
      if (key === "OR") return value.some((v: any) => matches(row, v));
      if (key === "metadata") return row.metadata?.[value.path[0]] === value.equals;
      if (value && typeof value === "object" && !(value instanceof Date)) {
        if (value.in) return value.in.includes(row[key]);
        if (value.lt !== undefined) return row[key] < value.lt;
        if (value.lte !== undefined) return row[key] <= value.lte;
        if (value.contains) return row[key].toLowerCase().includes(value.contains.toLowerCase());
      }
      return value instanceof Date ? +row[key] === +value : row[key] === value;
    });
  }
  function select({ where, orderBy, take }: any) {
    let found = rows.filter(row => matches(row, where));
    if (orderBy) found.sort((a, b) => +b.createdAt - +a.createdAt || b.id.localeCompare(a.id));
    return found.slice(0, take ?? found.length).map(row => ({ ...row }));
  }
  const sessionLookup = async ({ where }: any) => {
    assert.equal(where.business.demoSessionId, where.id);
    return state.active && where.id === actor.demoSessionId && where.business.id === actor.businessId ? { ...state, demoContext: context } : null;
  };
  const tx = {
    demoSession: { updateMany: async (args: any) => ({ count: await sessionLookup(args) ? 1 : 0 }), findFirst: sessionLookup, findUniqueOrThrow: async () => ({ setupAttemptId: state.setupAttemptId }) },
    conversation: { findMany: async ({ where }: any) => [{ id: "conversation-a", businessId: where.businessId, leadId: "customer-a", channel: state.channel }], update: async ({ where }: any) => { assert.equal(where.businessId, actor.businessId); assert.equal(where.id, "conversation-a"); return {}; } },
    lead: { findFirst: async ({ where }: any) => { assert.equal(where.businessId, actor.businessId); assert.equal(where.phone, "demo_customer_session-a"); return state.validLead ? { id: "customer-a" } : null; } },
    message: {
      findFirst: async (args: any) => select(args)[0] ?? null,
      findMany: async (args: any) => select(args),
      count: async (args: any) => select(args).length,
      update: async ({ where, data }: any) => { const row = rows.find(r => matches(r, where)); assert.ok(row); Object.assign(row, data); return { ...row }; },
      create: async ({ data }: any) => add(data),
    },
    leadActivity: { create: async ({ data }: any) => { activities.push(data); return data; } },
  };
  // Model the session row lock; provider execution happens outside this queue.
  let queue = Promise.resolve();
  mockMethod(t, prisma, "$transaction", callback => { const result = queue.then(() => callback(tx)); queue = result.then(() => undefined, () => undefined); return result; });
  mockMethod(t, prisma.demoSession, "findFirst", sessionLookup);
  mockMethod(t, prisma.message, "findMany", async args => {
    assert.equal(args.where.businessId, actor.businessId); assert.equal(args.where.conversationId, "conversation-a");
    assert.ok(args.take <= env.AI_MAX_CONTEXT_MESSAGES); return select(args);
  });
  const forbidden = () => { throw new Error("Forbidden side effect"); };
  const spies = [
    mockMethod(t, MetaWhatsAppProvider.prototype, "sendTextMessage", forbidden), mockMethod(t, MockWhatsAppProvider.prototype, "sendTextMessage", forbidden),
    mockMethod(t, prisma.whatsAppIntegration, "findFirst", forbidden),
    mockMethod(t, aiUsageService, "assertCanUseAiReplies", forbidden), mockMethod(t, aiUsageService, "trackRequest", forbidden),
    mockMethod(t, prisma.subscription, "findFirst", forbidden), mockMethod(t, prisma.accountUsageRecord, "update", forbidden), mockMethod(t, prisma.businessUsageRecord, "update", forbidden),
    mockMethod(t, realtimeService, "publish", forbidden), mockMethod(t, realtimeService, "publishDemo", forbidden),
    mockMethod(t, customerMemoryResolverService, "resolveRuntimeSafely", forbidden),
  ];
  for (const delegate of [prisma.appointment, prisma.customerIssueLog, prisma.followUpJob, prisma.customerMemoryExtractionJob, prisma.businessNotification, prisma.knowledgeArticle, prisma.knowledgeDocument]) {
    for (const method of ["create", "update", "findMany"]) spies.push(mockMethod(t, delegate, method, forbidden));
  }
  t.after(() => { for (const spy of spies) assert.equal(spy.mock.callCount(), 0); });
  const fetchSpy = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, `${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`);
    const body = JSON.parse(init!.body as string); requests.push(body);
    assert.equal(body.metadata.channel, "DEMO"); assert.equal(body.metadata.isDemo, true); assert.equal(body.metadata.plan, undefined);
    await state.beforeResponse?.();
    if (state.fail) return new Response("{}", { status: 503 });
    return Response.json({ choices: [{ message: { content: state.malformed ? "invalid json" : JSON.stringify(state.nextDecision) } }], model: "test-model" });
  });
  return { state, context, rows, add, activities, requests, fetchSpy };
}

for (const status of ["READY", "READY_PARTIAL"]) test(`${status}: real prompt/provider/parser/safety/store path returns canonical reply and history`, async t => {
  const f = fixture(t); f.state.setupStatus = status;
  f.add({ content: "Earlier customer message" }); f.add({ senderType: "AI", direction: "OUTBOUND", content: "Earlier AI reply" });
  const customer = f.add();
  f.add({ businessId: "business-b", content: "Other tenant secret" });
  f.add({ conversationId: "other", content: "Other conversation secret" });
  f.add({ senderType: "STAFF", content: "Not an inbound customer" });
  f.add({ deletedAt: new Date(), content: "Deleted" }); f.add({ messageType: "IMAGE", content: "Image" });
  const result = await processLatestDemoReply(actor);
  assert.equal(result.customerMessage.id, customer.id); assert.equal(result.conversation.id, customer.conversationId);
  assert.equal(result.aiMessage.senderType, "AI"); assert.equal(result.aiMessage.direction, "OUTBOUND"); assert.equal(result.aiMessage.messageType, "TEXT");
  const stored = f.rows.find(row => row.id === result.aiMessage.id);
  assert.equal(stored.businessId, actor.businessId); assert.equal(stored.leadId, customer.leadId); assert.equal(stored.conversationId, customer.conversationId);
  assert.equal(stored.deliveryStatus, "INTERNAL"); assert.equal(stored.provider, "DEMO_AI"); assert.equal(stored.metadata.sourceCustomerMessageId, customer.id);
  const prompt = f.requests[0].messages[1].content;
  for (const value of ["Acme Roofing", "Roof inspection", "GHS 300", "Earlier customer message", "Earlier AI reply"]) assert.ok(prompt.includes(value));
  assert.ok(!prompt.includes("Other tenant secret")); assert.ok(!prompt.includes("Other conversation secret"));
  const retry = await processLatestDemoReply(actor); assert.deepEqual(retry, result); assert.equal(f.fetchSpy.mock.callCount(), 1); assert.equal(f.activities.length, 1);
  const history = await demoMessageService.list(actor);
  assert.ok(history.messages.some(m => m.id === customer.id)); assert.ok(history.messages.some(m => m.id === result.aiMessage.id));
  assert.deepEqual(history.messages.map(m => +m.createdAt), history.messages.map(m => +m.createdAt).sort((a, b) => a - b));
});

test("normalized null prices, durations, empty hours and policies remain unknown in actual runtime envelope", async t => {
  const f = fixture(t); const context = await buildDemoBusinessContext(actor, f.add() as any);
  const formatted = JSON.parse(aiPromptContextFormatter.format(context));
  const data = formatted.sections.temporaryDemoFacts.data;
  assert.equal(data.facts.services[1].price, null); assert.equal(data.facts.services[1].duration, null);
  assert.deepEqual(data.facts.openingHours, []); assert.deepEqual(data.facts.policies, []);
  const prompt = aiPromptContextFormatter.buildSystemPrompt(context);
  assert.match(prompt, /Null or absent prices, hours, durations and policies are unknown/);
  assert.doesNotMatch(prompt, /CREATE_BOOKING_REQUEST|REQUEST_HUMAN_REVIEW|Complaint case matching|complaints\[\]/);
  const production = aiPromptContextFormatter.buildSystemPrompt({ ...context, demoFacts: undefined });
  assert.match(production, /use suggestedAction CREATE_BOOKING_REQUEST/); assert.match(production, /Complaint case matching is required/);
  assert.match(production, /Request human review when uncertain/);
});

test("unready, missing customer, expired and cross-demo/production scope fail before provider", async t => {
  const f = fixture(t);
  for (const status of ["WAITING_FOR_BUSINESS", "PROCESSING_WEBSITE", "FAILED"]) {
    f.state.setupStatus = status; await assert.rejects(processLatestDemoReply(actor), { code: "DEMO_SETUP_NOT_READY" });
  }
  f.state.setupStatus = "READY";
  await assert.rejects(processLatestDemoReply(actor), { code: "DEMO_CUSTOMER_MESSAGE_NOT_FOUND" }); f.add();
  for (const businessId of ["business-b", "production"]) await assert.rejects(processLatestDemoReply({ ...actor, businessId }), { code: "DEMO_RESOURCE_FORBIDDEN" });
  f.state.channel = "WHATSAPP"; await assert.rejects(processLatestDemoReply(actor), { code: "DEMO_RESOURCE_FORBIDDEN" });
  f.state.channel = "DEMO"; f.state.validLead = false; await assert.rejects(processLatestDemoReply(actor), { code: "DEMO_RESOURCE_FORBIDDEN" });
  f.state.validLead = true; f.state.active = false; await assert.rejects(processLatestDemoReply(actor), { code: "DEMO_RESOURCE_FORBIDDEN" });
  assert.equal(f.requests.length, 0);
});

for (const failure of ["provider", "malformed", "unsafe"]) test(`${failure} failure preserves inbound and retry cannot spend again`, async t => {
  const f = fixture(t); const customer = f.add(); f.state.fail = failure === "provider"; f.state.malformed = failure === "malformed";
  if (failure === "unsafe") f.state.nextDecision = { ...decision, suggestedAction: "CREATE_BOOKING_REQUEST" };
  await assert.rejects(processLatestDemoReply(actor), { code: "DEMO_AI_UNAVAILABLE" });
  await assert.rejects(processLatestDemoReply(actor), { code: "DEMO_AI_UNAVAILABLE" });
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].content, customer.content); assert.equal(f.requests.length, 1); assert.equal(f.activities.length, 0);
});

test("50 replies enforce demo allowance, replay succeeds at cap, and GET retains latest 100", async t => {
  const f = fixture(t);
  for (let i = 0; i < 50; i++) { f.add(); await processLatestDemoReply(actor); }
  assert.equal(f.requests.length, 50); assert.equal((await demoMessageService.list(actor)).messages.length, 100);
  await processLatestDemoReply(actor); assert.equal(f.requests.length, 50);
  const newest = f.add(); await assert.rejects(processLatestDemoReply(actor), { code: "DEMO_AI_LIMIT_REACHED", statusCode: 429 });
  const history = await demoMessageService.list(actor);
  assert.equal(history.messages.length, 100); assert.equal(history.messages.at(-1)!.id, newest.id);
  assert.ok(!history.messages.some(m => m.id === f.rows[0].id));
  for (let i = f.rows.length - 1; i >= 0; i--) if (f.rows[i].provider === "DEMO_AI") f.rows.splice(i, 1);
  await assert.rejects(processLatestDemoReply(actor), { code: "DEMO_AI_LIMIT_REACHED" }); assert.equal(f.requests.length, 50);
});

test("50 failed provider attempts exhaust allowance without any successful reply", async t => {
  const f = fixture(t); f.state.fail = true;
  for (let i = 0; i < 50; i++) { f.add(); await assert.rejects(processLatestDemoReply(actor), { code: "DEMO_AI_UNAVAILABLE" }); }
  f.add(); await assert.rejects(processLatestDemoReply(actor), { code: "DEMO_AI_LIMIT_REACHED" });
  assert.equal(f.requests.length, 50); assert.equal(f.rows.filter(m => m.senderType === "AI").length, 0);
});

test("HTTP process-latest authenticates, rejects resource parameters, and returns replayable reply plus GET history", async t => {
  const httpFetch = globalThis.fetch;
  const f = fixture(t); f.add();
  mockMethod(t, demoService, "authenticate", async token => {
    if (token !== "demo-a") throw Object.assign(new Error("Invalid token"), { statusCode: 401 });
    return actor;
  });
  const app = express(); app.use(express.json()); app.use("/api/demo", demoRouter); app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/demo/session`;
  const url = `${base}/ai/process-latest`;
  assert.equal((await httpFetch(url, { method: "POST" })).status, 401);
  const headers = { Authorization: "Bearer demo-a", "Content-Type": "application/json" };
  for (const field of ["businessId", "conversationId", "leadId", "customerId", "demoSessionId"]) {
    assert.equal((await httpFetch(url, { method: "POST", headers, body: JSON.stringify({ [field]: "forged" }) })).status, 400);
  }
  assert.equal((await httpFetch(`${url}?businessId=other`, { method: "POST", headers })).status, 400);
  assert.equal(f.requests.length, 0);
  const first = await httpFetch(url, { method: "POST", headers }); assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const result = await first.json();
  assert.deepEqual(await (await httpFetch(url, { method: "POST", headers })).json(), result);
  const history = await (await httpFetch(`${base}/messages`, { headers })).json() as any;
  assert.deepEqual(history.messages.map((m: any) => m.senderType), ["CUSTOMER", "AI"]);
  assert.equal(f.requests.length, 1);
});

test("concurrent processing has one durable provider claim", async t => {
  const f = fixture(t); f.add();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  f.state.beforeResponse = async () => { entered(); await gate; };
  const first = processLatestDemoReply(actor); await started;
  try { await assert.rejects(processLatestDemoReply(actor), { code: "DEMO_AI_UNAVAILABLE" }); } finally { release(); }
  const result = await first; assert.deepEqual(await processLatestDemoReply(actor), result); assert.equal(f.requests.length, 1);
});

for (const change of ["expired", "setup"]) test(`in-flight ${change} change prevents stale reply persistence`, async t => {
  const f = fixture(t); f.add();
  f.state.beforeResponse = async () => { if (change === "expired") f.state.active = false; else f.state.setupAttemptId = "new-setup"; };
  await assert.rejects(processLatestDemoReply(actor)); assert.equal(f.rows.length, 1); assert.equal(f.activities.length, 0);
});

for (const intent of ["BOOKING_INTENT", "COMPLAINT", "HUMAN_REQUEST"]) test(`${intent} gets a conversational SEND_REPLY without action instructions`, async t => {
  const f = fixture(t); f.add({ content: intent === "BOOKING_INTENT" ? "I want to book roofing for Tuesday." : intent });
  f.state.nextDecision = { ...decision, intent, replyText: intent === "HUMAN_REQUEST" ? "This is a demo; no human has been contacted." : "Please tell me a little more." };
  const result = await processLatestDemoReply(actor); assert.equal(result.aiMessage.text, f.state.nextDecision.replyText);
  const prompt = f.requests[0].messages[0].content;
  assert.doesNotMatch(prompt, /CREATE_BOOKING_REQUEST|REQUEST_HUMAN_REVIEW|Complaint case matching/);
  assert.match(prompt, /Booking intent: ask conversationally/); assert.match(prompt, /Complaint: acknowledge/); assert.match(prompt, /Human request: explain/);
  if (intent === "HUMAN_REQUEST") assert.equal(aiSafetyService.evaluate({ decision: f.state.nextDecision, businessReady: true, humanTakeover: false }).allowed, false);
});

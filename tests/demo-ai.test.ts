import { AppError } from "../src/utils/errors";
import { responseOutput } from "./helpers/response-output";
import { conversationInterpreterService } from "../src/services/conversation-interpreter.service";
import { conversationStateService } from "../src/services/conversation-state.service";
import { conversationContextService } from "../src/services/conversation-context.service";
import { emptyState } from "../src/services/conversation-state.schema";
import { AsyncLocalStorage } from "node:async_hooks";
import { demoConversationService } from "../src/services/demo-conversation.service";
import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { env } from "../src/config/env";
import { prisma } from "../src/config/prisma";
import { demoService, DemoActor } from "../src/services/demo.service";
import { demoRouter } from "../src/routes/demo.routes";
import { errorHandler } from "../src/middleware/error";
import { processLatestDemoReply, processDemoReplyForMessage } from "../src/services/demo-ai-processing.service";
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
import { emailService } from "../src/services/email.service";
import { followUpJobSchedulerService } from "../src/services/follow-up/follow-up-scheduler.service";

const actor: DemoActor = { actorType: "DEMO", isDemo: true, demoSessionId: "session-a", businessId: "business-a" };
const decision = { intent: "PRICING_INQUIRY" as const, replyText: "Roof inspection costs GHS 300.", confidence: 1, shouldReply: true, requiresHumanReview: false, reason: "Confirmed fact", suggestedAction: "SEND_REPLY" as const, usedKnowledge: { profile: false, services: true, availability: false, policies: false, conversationHistory: true } };

function fixture(t: TestContext, liveRealtime = false) {
  mockMethod(t, console, "info", () => {});
  mockMethod(t, conversationStateService, "recordMessage", async () => ({}));
  mockMethod(t, conversationStateService, "get", async () => ({ ...emptyState(), businessId: actor.businessId, conversationId: "conversation-a", revision: 7 }) as any);
  const saved = { DEMO_ENABLED: env.DEMO_ENABLED, OPENROUTER_API_KEY: env.OPENROUTER_API_KEY, OPENROUTER_DEFAULT_MODEL: env.OPENROUTER_DEFAULT_MODEL };
  Object.assign(env, { DEMO_ENABLED: true, OPENROUTER_API_KEY: "test-only", OPENROUTER_DEFAULT_MODEL: "test-model" });
  t.after(() => Object.assign(env, saved));
  const facts = emptyDemoFacts();
  facts.services = [{ name: "Roof inspection", description: null, price: "GHS 300", duration: null }, { name: "Roof replacement", description: null, price: null, duration: null }];
  const state = { expiresAt: new Date(Date.now() + 60_000), unread: 0, preview: "", persistenceFail: false, active: true, setupStatus: "READY", setupAttemptId: "setup-a", channel: "DEMO", validLead: true, fail: false, malformed: false, nextDecision: { ...decision } as any, conversationState: emptyState(), beforeResponse: undefined as (() => Promise<void>) | undefined };
  mockMethod(t, conversationInterpreterService, "interpret", async () => ({ interpretation: { intent: state.nextDecision.intent, confidence: 1, resolvedEntities: [], needsClarification: false }, commands: [], appliedRevision: 7, replayed: false }));
  const context = { businessName: "Acme Roofing", facts, sourceWebsite: null, crawlStatus: "COMPLETE", extractionStatus: "COMPLETE", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), pagesAttempted: 1, pagesFetched: 1, errorCode: null, sources: [], bookingLinks: [], contactLinks: [], unknowns: ["Replacement price", "Hours", "Duration", "Policies"] };
  const rows: any[] = []; const activities: any[] = []; const requests: any[] = []; const events: any[] = [];
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
  mockMethod(t, conversationContextService, "getSnapshot", async (input: any) => {
    assert.equal(input.demoSessionId, actor.demoSessionId);
    assert.equal(input.businessId, actor.businessId);
    const trigger = rows.find(row => row.id === input.messageId)!;
    return { state: { ...state.conversationState, businessId: actor.businessId, conversationId: "conversation-a", revision: 7 }, currentMessage: { id: trigger.id, text: trigger.content }, recentMessages: rows.filter(row => row.createdAt <= trigger.createdAt).slice(-12).map(row => ({ ...row, text: row.content, createdAt: row.createdAt.toISOString() })), customerMemorySummary: null };
  });
  const sessionLookup = async ({ where }: any) => {
    if (where.business.demoSessionId) assert.equal(where.business.demoSessionId, where.id);
    return state.active && where.id === actor.demoSessionId && where.business.id === actor.businessId ? { ...state, demoContext: context } : null;
  };
  const tx = {
    $queryRaw: async () => [],
    demoSession: { updateMany: async (args: any) => ({ count: await sessionLookup(args) ? 1 : 0 }), findFirst: sessionLookup, findUniqueOrThrow: async () => ({ setupAttemptId: state.setupAttemptId }) },
    conversation: { findFirst: async ({ where }: any) => where.id === "conversation-a" && where.businessId === actor.businessId ? { id: "conversation-a", channel: state.channel, business: { demoSessionId: actor.demoSessionId, timezone: "Africa/Accra" } } : null, findMany: async ({ where }: any) => [{ id: "conversation-a", businessId: where.businessId, leadId: "customer-a", channel: state.channel, lastMessagePreview: state.preview, lastMessageAt: new Date(), unreadCount: state.unread, status: "AI_HANDLING", updatedAt: new Date() }], update: async ({ where, data }: any) => { assert.equal(where.businessId, actor.businessId); assert.equal(where.id, "conversation-a"); state.unread += data.unreadCount?.increment ?? 0; state.preview = data.lastMessagePreview; return {}; } },
    lead: { findFirst: async ({ where }: any) => { assert.equal(where.businessId, actor.businessId); assert.equal(where.phone, "demo_customer_session-a"); return state.validLead ? { id: "customer-a" } : null; } },
    message: {
      findFirst: async (args: any) => select(args)[0] ?? null,
      findMany: async (args: any) => select(args),
      count: async (args: any) => select(args).length,
      update: async ({ where, data }: any) => { const row = rows.find(r => matches(r, where)); assert.ok(row); Object.assign(row, data); return { ...row }; },
      create: async ({ data }: any) => { if (state.persistenceFail) throw new Error("Database failure"); const { createdAt, ...fields } = data; return add({ ...fields, ...(createdAt ? { createdAt } : {}) }); },
    },
    leadActivity: { create: async ({ data }: any) => { activities.push(data); return data; } },
  };
  // Model the session row lock; provider execution happens outside this queue.
  let queue = Promise.resolve();
  const transactionContext = new AsyncLocalStorage<boolean>();
  mockMethod(t, prisma, "$transaction", callback => { const result = queue.then(() => transactionContext.run(true, () => callback(tx))); queue = result.then(() => undefined, () => undefined); return result; });
  mockMethod(t, prisma.demoSession, "findFirst", sessionLookup);
  mockMethod(t, prisma.message, "findMany", async args => {
    assert.equal(args.where.businessId, actor.businessId); assert.equal(args.where.conversationId, "conversation-a");
    assert.ok(args.take <= env.AI_MAX_CONTEXT_MESSAGES); return select(args);
  });
  mockMethod(t, prisma.conversation, "findMany", tx.conversation.findMany);
  mockMethod(t, prisma.lead, "findFirst", tx.lead.findFirst);
  const publishDemo = realtimeService.publishDemo;
  mockMethod(t, realtimeService, "publishDemo", input => { assert.notEqual(transactionContext.getStore(), true, "events must publish after their own transaction commits"); events.push(input); if (liveRealtime) return publishDemo.call(realtimeService, input); });
  const forbidden = () => { throw new Error("Forbidden side effect"); };
  const spies = [
    mockMethod(t, emailService, "send", forbidden),
    mockMethod(t, followUpJobSchedulerService, "scheduleFollowUpJob", forbidden),
    mockMethod(t, MetaWhatsAppProvider.prototype, "sendTextMessage", forbidden), mockMethod(t, MockWhatsAppProvider.prototype, "sendTextMessage", forbidden),
    mockMethod(t, prisma.whatsAppIntegration, "findFirst", forbidden),
    mockMethod(t, aiUsageService, "assertCanUseAiReplies", forbidden), mockMethod(t, aiUsageService, "trackRequest", forbidden),
    mockMethod(t, prisma.subscription, "findFirst", forbidden), mockMethod(t, prisma.accountUsageRecord, "update", forbidden), mockMethod(t, prisma.businessUsageRecord, "update", forbidden),
    mockMethod(t, realtimeService, "publish", forbidden),
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
    return Response.json({ choices: [{ message: { content: state.malformed ? "invalid json" : JSON.stringify({ ...responseOutput({ userPrompt: body.messages[1].content }, state.nextDecision.replyText), ...(state.nextDecision.suggestedAction === "CREATE_BOOKING_REQUEST" ? { forbiddenAction: "CREATE_BOOKING_REQUEST" } : {}) }) } }], model: "test-model" });
  });
  return { state, context, rows, add, activities, requests, fetchSpy, events };
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
  assert.equal(stored.deliveryStatus, "INTERNAL"); assert.equal(stored.provider, "DEMO"); assert.equal(stored.metadata.sourceCustomerMessageId, customer.id);
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
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].content, customer.content); assert.equal(f.requests.length, failure === "provider" ? 1 : 2); assert.equal(f.activities.length, 0);
  assert.deepEqual(f.events.filter(e => e.type === "demo.ai.processing").map(e => e.payload.status), ["STARTED", "FAILED"]);
  assert.equal(f.events.filter(e => e.type === "message.created").length, 0);
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
  for (let i = f.rows.length - 1; i >= 0; i--) if (f.rows[i].senderType === "AI") f.rows.splice(i, 1);
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
  f.state.nextDecision = { ...decision, intent, replyText: intent === "HUMAN_REQUEST" ? "This is a demo; no human has been contacted." : intent === "BOOKING_INTENT" ? "What day would you like to come in?" : "I am sorry that happened." };
  const result = await processLatestDemoReply(actor); assert.equal(result.aiMessage.text, f.state.nextDecision.replyText);
  const prompt = f.requests[0].messages[0].content;
  assert.doesNotMatch(prompt, /CREATE_BOOKING_REQUEST|REQUEST_HUMAN_REVIEW|Complaint case matching/);
  assert.match(prompt, /authoritative next conversational move/); assert.match(prompt, /only SEND_REPLY is permitted/); assert.match(prompt, /no external effects/);
  if (intent === "HUMAN_REQUEST") assert.equal(aiSafetyService.evaluate({ decision: f.state.nextDecision, businessReady: true, humanTakeover: false }).allowed, false);
});

for (const status of ["READY", "READY_PARTIAL"]) test(`automatic send in ${status} runs shared AI and replays the exact canonical input`, async t => {
  const f = fixture(t); f.state.setupStatus = status;
  const input = { text: "Do you offer roofing?", clientMessageId: randomUUID() };
  const result = await demoConversationService.send(actor, input);
  assert.equal(result.message.id, result.customerMessage.id);
  assert.equal(f.requests[0].metadata.messageId, result.message.id);
  assert.deepEqual((await demoMessageService.list(actor)).messages.map(m => m.senderType), ["CUSTOMER", "AI"]);
  assert.equal(f.state.unread, 1); assert.equal(f.state.preview, result.aiMessage.text);
  const stored = f.rows.find(m => m.id === result.aiMessage.id);
  assert.equal(stored.provider, "DEMO"); assert.equal(stored.metadata.sourceInboundMessageId, result.message.id);
  // Retrying an old client ID must not process the newer message instead.
  const newer = await demoMessageService.create(actor, { text: "A newer question", clientMessageId: randomUUID() });
  assert.deepEqual(await demoConversationService.send(actor, input), result);
  assert.equal(f.requests.length, 1); assert.equal(f.activities.length, 3); assert.equal(f.state.unread, 2);
  assert.equal(f.rows.find(m => m.id === newer.message.id).metadata.demoAiAttempted, undefined);
});

test("concurrent duplicate sends commit one inbound and claim one completion", async t => {
  const f = fixture(t); const input = { text: "Roofing?", clientMessageId: randomUUID() };
  const outcomes = await Promise.allSettled([demoConversationService.send(actor, input), demoConversationService.send(actor, input)]);
  assert.ok(outcomes.some(o => o.status === "fulfilled"));
  for (const outcome of outcomes) if (outcome.status === "rejected") assert.equal(outcome.reason.code, "DEMO_AI_UNAVAILABLE");
  const replay = await demoConversationService.send(actor, input);
  assert.equal(f.rows.length, 2); assert.equal(f.requests.length, 1); assert.equal(f.activities.length, 2); assert.equal(f.state.unread, 1);
  assert.equal(replay.aiMessage.id, f.rows.find(m => m.senderType === "AI").id);
  assert.equal(f.events.filter(e => e.type === "message.created").length, 2);
  assert.deepEqual(f.events.filter(e => e.type === "demo.ai.processing").map(e => e.payload.status), ["STARTED", "COMPLETED"]);
});

test("automatic send failure keeps inbound and identical client retry cannot spend again", async t => {
  const f = fixture(t); f.state.fail = true;
  const input = { text: "Roofing?", clientMessageId: randomUUID() };
  await assert.rejects(demoConversationService.send(actor, input), { code: "DEMO_AI_UNAVAILABLE" });
  await assert.rejects(demoConversationService.send(actor, input), { code: "DEMO_AI_UNAVAILABLE" });
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].content, input.text); assert.equal(f.requests.length, 1); assert.equal(f.state.unread, 1);
});

test("50 customer sends allow 50 AI replies and only the 51st customer is rejected", async t => {
  const f = fixture(t); let lastInput!: { text: string; clientMessageId: string };
  for (let i = 0; i < 50; i++) {
    lastInput = { text: `Roofing question ${i}`, clientMessageId: randomUUID() };
    await demoConversationService.send(actor, lastInput);
  }
  assert.equal(f.rows.length, 100); assert.equal(f.state.unread, 50);
  await demoConversationService.send(actor, lastInput); assert.equal(f.rows.length, 100);
  await assert.rejects(demoConversationService.send(actor, { text: "One more", clientMessageId: randomUUID() }), { code: "DEMO_MESSAGE_LIMIT_REACHED" });
  assert.equal(f.requests.length, 50); assert.equal((await demoMessageService.list(actor)).messages.length, 100);
});

test("exact inbound selector cannot process another tenant or a noncustomer row", async t => {
  const f = fixture(t);
  for (const fields of [{ businessId: "business-b" }, { conversationId: "conversation-b" }, { leadId: "customer-b" }, { senderType: "AI" }, { direction: "OUTBOUND" }, { messageType: "IMAGE" }, { deletedAt: new Date() }]) {
    const row = f.add(fields);
    await assert.rejects(processDemoReplyForMessage(actor, row.id), { code: "DEMO_CUSTOMER_MESSAGE_NOT_FOUND" });
  }
  await assert.rejects(demoConversationService.send({ ...actor, businessId: "business-b" }, { text: "forged", clientMessageId: randomUUID() }), { code: "DEMO_RESOURCE_FORBIDDEN" });
  await assert.rejects(demoMessageService.list({ ...actor, businessId: "business-b" }), { code: "DEMO_RESOURCE_FORBIDDEN" });
  assert.equal(f.requests.length, 0);
});

test("legacy DEMO_AI reply replays without a new completion or migration", async t => {
  const f = fixture(t);
  const customer = f.add({ metadata: { demoAiAttempted: true } });
  const legacy = f.add({ senderType: "AI", direction: "OUTBOUND", provider: "DEMO_AI", providerMessageId: customer.id });
  const result = await processDemoReplyForMessage(actor, customer.id);
  assert.equal(result.aiMessage.id, legacy.id); assert.equal(f.requests.length, 0);
});

test("POST messages itself generates AI; GET restores both and retry is idempotent", async t => {
  const httpFetch = globalThis.fetch; const f = fixture(t);
  mockMethod(t, demoService, "authenticate", async token => {
    assert.equal(token, "demo-a"); return actor;
  });
  const app = express(); app.use(express.json()); app.use("/api/demo", demoRouter); app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/demo/session/messages`;
  const headers = { Authorization: "Bearer demo-a", "Content-Type": "application/json" };
  const request = { method: "POST", headers, body: JSON.stringify({ text: "Do you offer roofing?", clientMessageId: randomUUID() }) };
  const first = await httpFetch(url, request); assert.equal(first.status, 200); const result = await first.json() as any;
  assert.equal(result.message.id, result.customerMessage.id); assert.equal(result.aiMessage.senderType, "AI");
  assert.deepEqual(await (await httpFetch(url, request)).json(), result);
  assert.deepEqual((await (await httpFetch(url, { headers })).json() as any).messages.map((m: any) => m.senderType), ["CUSTOMER", "AI"]);
  assert.equal(f.requests.length, 1); assert.equal(f.state.unread, 1);
});

test("realtime lifecycle publishes committed customer, STARTED, committed AI, conversation, COMPLETED once", async t => {
  const f = fixture(t); const input = { text: "Roofing?", clientMessageId: randomUUID() };
  f.state.beforeResponse = async () => {
    assert.equal(f.rows.length, 1);
    assert.deepEqual(f.events.map(e => [e.type, e.payload.status ?? e.payload.senderType]), [
      ["message.created", "CUSTOMER"], ["conversation.updated", "AI_HANDLING"], ["demo.ai.processing", "STARTED"],
    ]);
  };
  const result = await demoConversationService.send(actor, input);
  assert.deepEqual(f.events.map(e => e.type), ["message.created", "conversation.updated", "demo.ai.processing", "message.created", "conversation.updated", "demo.ai.processing"]);
  assert.equal(f.events[3].payload.id, result.aiMessage.id); assert.equal(f.events[4].payload.unreadCount, 1);
  assert.equal(f.events[4].payload.lastMessagePreview, result.aiMessage.text); assert.equal(f.events[5].payload.status, "COMPLETED");
  for (const event of f.events) {
    assert.equal(event.businessId, actor.businessId); assert.equal(event.demoSessionId, actor.demoSessionId); assert.equal(event.conversationId, result.conversation.id);
    for (const key of ["metadata", "token", "demoContext", "model", "provider"]) assert.equal(key in event.payload, false);
  }
  await demoConversationService.send(actor, input); assert.equal(f.events.length, 6);
});

test("provider or final-save failure publishes FAILED, preserves customer and emits no AI creation", async t => {
  const f = fixture(t); const input = { text: "Roofing?", clientMessageId: randomUUID() };
  f.state.beforeResponse = async () => { f.state.persistenceFail = true; };
  await assert.rejects(demoConversationService.send(actor, input));
  assert.equal(f.rows.length, 1);
  assert.deepEqual(f.events.filter(e => e.type === "demo.ai.processing").map(e => e.payload.status), ["STARTED", "FAILED"]);
  assert.equal(f.events.filter(e => e.type === "message.created").length, 1);
  await assert.rejects(demoConversationService.send(actor, input)); assert.equal(f.events.length, 4);
});

test("invalidated session receives no late FAILED and failed inbound persistence publishes nothing", async t => {
  const f = fixture(t); const input = { text: "Roofing?", clientMessageId: randomUUID() };
  f.state.persistenceFail = true; await assert.rejects(demoConversationService.send(actor, input)); assert.equal(f.events.length, 0);
  f.state.persistenceFail = false; f.state.beforeResponse = async () => { f.state.active = false; };
  await assert.rejects(demoConversationService.send(actor, input));
  assert.deepEqual(f.events.filter(e => e.type === "demo.ai.processing").map(e => e.payload.status), ["STARTED"]);
});

test("real HTTP SSE observes the customer before provider completion and the committed AI lifecycle", async t => {
  const httpFetch = globalThis.fetch; const f = fixture(t, true);
  mockMethod(t, demoService, "authenticate", async () => actor);
  const app = express(); app.use(express.json()); app.use("/api/demo", demoRouter); app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const controller = new AbortController();
  t.after(() => { controller.abort(); realtimeService.disconnectAllDemo(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/demo/session`;
  const headers = { Authorization: "Bearer demo-a", "Content-Type": "application/json" };
  const stream = await httpFetch(`${base}/events`, { headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
  assert.equal(stream.status, 200); const reader = stream.body!.getReader(); const decoder = new TextDecoder(); let received = "";
  async function through(value: string) { while (!received.includes(value)) { const chunk = await reader.read(); assert.equal(chunk.done, false); received += decoder.decode(chunk.value, { stream: true }); } }
  await through("demo.connected");
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.state.beforeResponse = async () => { await gate; };
  const request = { method: "POST", headers, body: JSON.stringify({ text: "Do you offer roofing?", clientMessageId: randomUUID() }) };
  const sending = httpFetch(`${base}/messages`, request);
  try {
    await through('"status":"STARTED"'); assert.match(received, /"senderType":"CUSTOMER"/); assert.equal(f.rows.length, 1);
  } finally { release(); }
  const response = await sending; assert.equal(response.status, 200);
  await through('"status":"COMPLETED"');
  const frames = received.split("\n\n").filter(Boolean).map(frame => JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6)));
  assert.deepEqual(frames.map(frame => frame.type), ["demo.connected", "message.created", "conversation.updated", "demo.ai.processing", "message.created", "conversation.updated", "demo.ai.processing"]);
  assert.equal(frames[4].payload.senderType, "AI"); assert.equal(frames[5].payload.unreadCount, 1);
  const count = f.events.length; assert.equal((await httpFetch(`${base}/messages`, request)).status, 200); assert.equal(f.events.length, count);
  controller.abort(); await reader.cancel().catch(() => {});
});


test("shared provider receives fresh workflow, pending option and precedence instructions", async t => {
  const f = fixture(t);
  f.state.conversationState = { ...emptyState(), activeTopic: "APPOINTMENT", activeWorkflow: "APPOINTMENT_BOOKING", workflowStatus: "WAITING_FOR_CUSTOMER", awaiting: { type: "OPTION_SELECTION" }, offeredOptions: [{ id: "one", label: "12 PM", value: "12:00", position: 1 }, { id: "two", label: "2 PM", value: "14:00", position: 2 }] };
  f.add({ content: "The second one." });
  await processLatestDemoReply(actor);
  const serialized = JSON.stringify(f.requests[0]);
  assert.match(serialized, /OPTION_SELECTION/);
  assert.match(serialized, /APPOINTMENT_BOOKING/);
  assert.match(serialized, /14:00/);
  assert.match(serialized, /The second one/);
  assert.match(serialized, /current customer message, current conversation state, recent message history, customer memory, business knowledge/);
});


test("demo failures expose safe cause codes without leaking internal error context", async t => {
  const f = fixture(t); f.add();
  const logs: unknown[] = [];
  mockMethod(t, console, "warn", (...args: unknown[]) => { logs.push(args); });
  mockMethod(t, conversationInterpreterService, "interpret", async () => {
    throw new AppError(503, "private SQL and tokens", "CONVERSATION_DATABASE_UNAVAILABLE", { databaseCode: "P2028", secret: "private SQL and tokens" });
  });
  await assert.rejects(processLatestDemoReply(actor), (error: any) => {
    assert.equal(error.code, "DEMO_AI_UNAVAILABLE");
    assert.deepEqual(error.context, { reason: "CONVERSATION_DATABASE_UNAVAILABLE", databaseCode: "P2028" });
    return true;
  });
  assert.ok(!JSON.stringify(logs).includes("private SQL"));
  assert.equal(f.rows.filter(r => r.senderType === "CUSTOMER").length, 1);
  assert.equal(f.rows.filter(r => r.senderType === "AI").length, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { env } from "../src/config/env";
import { prisma } from "../src/config/prisma";
import { demoMessageService, parseDemoMessage } from "../src/services/demo-message.service";
import { demoService, DemoActor } from "../src/services/demo.service";
import { storeInboundCustomerMessage } from "../src/services/inbound-message-store.service";
import { aiProvider } from "../src/services/ai-provider.service";
import { MetaWhatsAppProvider, MockWhatsAppProvider } from "../src/services/whatsapp-provider.service";
import { demoContextService } from "../src/services/demo-context.service";
import { eligibleDiscoveryWhere } from "../src/services/customer-memory/customer-memory-worker.service";
import { demoRouter } from "../src/routes/demo.routes";
import { errorHandler } from "../src/middleware/error";
import { mockMethod } from "./helpers/mock-method";
const actor: DemoActor = { actorType: "DEMO", isDemo: true, demoSessionId: "session", businessId: "business" };
function fixture(t: import("node:test").TestContext) {
  const old = env.DEMO_ENABLED; env.DEMO_ENABLED = true; t.after(() => { env.DEMO_ENABLED = old; });
  const state = { status: "READY", active: true, channel: "DEMO", validLead: true, unread: 0, preview: "", lastMessageAt: null as Date | null, count: 0 };
  const rows: any[] = []; const activities: any[] = [];
  const tx = {
    demoSession: {
      updateMany: async ({ where }: any) => { assert.equal(where.business.demoSessionId, actor.demoSessionId); return { count: state.active && where.business.id === actor.businessId ? 1 : 0 }; },
      findFirst: async ({ where }: any) => { assert.equal(where.business.id, actor.businessId); return state.active ? { setupStatus: state.status } : null; },
    },
    conversation: {
      findMany: async ({ where }: any) => { assert.equal(where.businessId, actor.businessId); return [{ id: "conversation", businessId: actor.businessId, leadId: "customer", channel: state.channel }]; },
      update: async ({ where, data }: any) => { assert.deepEqual(where, { id: "conversation", businessId: actor.businessId, leadId: "customer" }); state.unread += data.unreadCount.increment; state.preview = data.lastMessagePreview; state.lastMessageAt = data.lastMessageAt; return { id: "conversation" }; },
    },
    lead: { findFirst: async ({ where }: any) => { assert.equal(where.id, "customer"); assert.equal(where.businessId, actor.businessId); assert.equal(where.phone, "demo_customer_session"); return state.validLead ? { id: "customer" } : null; } },
    message: {
      findFirst: async ({ where }: any) => rows.find(row => row.businessId === where.businessId && row.provider === where.provider && row.providerMessageId === where.providerMessageId) ?? null,
      count: async ({ where }: any) => { assert.deepEqual(where, { businessId: actor.businessId, conversationId: "conversation", senderType: "CUSTOMER" }); return state.count; },
      create: async ({ data }: any) => { const row = { ...data, id: randomUUID(), createdAt: data.createdAt ?? new Date(), deletedAt: null }; rows.push(row); state.count++; return row; },
      findMany: async ({ where, orderBy, take }: any) => { assert.deepEqual(where, { businessId: actor.businessId, conversationId: "conversation", leadId: "customer", deletedAt: null }); assert.deepEqual(orderBy, [{ createdAt: "desc" }, { id: "desc" }]); assert.equal(take, 100); return [...rows].reverse(); },
    },
    leadActivity: { create: async ({ data }: any) => { activities.push(data); } },
  };
  mockMethod(t, prisma, "$transaction", async callback => callback(tx));
  return { state, rows, activities, tx };
}
test("READY/READY_PARTIAL messages use canonical shared storage, conversation updates and no external/usage calls", async t => {
  const { state, rows, activities } = fixture(t);
  const forbiddenCalls = [
    mockMethod(t, aiProvider, "generateReply", async () => { throw new Error("AI forbidden"); }),
    mockMethod(t, aiProvider, "generateCompletion", async () => { throw new Error("AI forbidden"); }),
    mockMethod(t, aiProvider, "streamCompletion", async () => { throw new Error("AI forbidden"); }),
    mockMethod(t, MetaWhatsAppProvider.prototype, "sendTextMessage", async () => { throw new Error("Meta forbidden"); }),
    mockMethod(t, MockWhatsAppProvider.prototype, "sendTextMessage", async () => { throw new Error("WhatsApp forbidden"); }),
    mockMethod(t, prisma.whatsAppIntegration, "findFirst", async () => { throw new Error("Integration forbidden"); }),
    mockMethod(t, prisma.business, "findUnique", async () => { throw new Error("Provider guard path forbidden"); }),
    mockMethod(t, demoContextService, "getBusinessContext", async () => { throw new Error("Context runtime forbidden"); }),
    mockMethod(t, prisma.accountUsageRecord, "update", async () => { throw new Error("Quota forbidden"); }),
    mockMethod(t, prisma.businessUsageRecord, "update", async () => { throw new Error("Quota forbidden"); }),
    mockMethod(t, prisma.subscription, "findFirst", async () => { throw new Error("Subscription forbidden"); }),
    t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); }),
  ];
  for (const status of ["READY", "READY_PARTIAL"]) {
    state.status = status;
    const result = await demoMessageService.create(actor, { text: " Hi there ", clientMessageId: randomUUID() });
    assert.equal(result.conversation.id, "conversation"); assert.equal(result.message.text, "Hi there");
    assert.equal(result.message.senderType, "CUSTOMER"); assert.equal(result.message.direction, "INBOUND"); assert.equal(result.message.messageType, "TEXT");
    assert.equal("metadata" in result.message, false);
  }
  assert.equal(state.unread, 2); assert.equal(state.preview, "Hi there"); assert.equal(state.lastMessageAt, rows[1].createdAt);
  assert.equal(rows[0].businessId, actor.businessId); assert.equal(rows[0].provider, "DEMO"); assert.equal(rows[0].leadId, "customer");
  assert.equal(activities.length, 2); assert.equal(activities[0].metadata.isDemo, true);
  assert.equal((await demoMessageService.list(actor)).messages.length, 2);
  for (const spy of forbiddenCalls) assert.equal(spy.mock.callCount(), 0);
});
test("unready, expired or mismatched resources cannot store customer messages", async t => {
  const { state, rows } = fixture(t);
  const input = { text: "hi", clientMessageId: randomUUID() };
  for (const status of ["WAITING_FOR_BUSINESS", "PROCESSING_WEBSITE", "FAILED"]) {
    state.status = status;
    await assert.rejects(demoMessageService.create(actor, input), { code: "DEMO_SETUP_NOT_READY", statusCode: 409 });
  }
  state.status = "READY";
  await assert.rejects(demoMessageService.create({ ...actor, businessId: "production" }, input), { code: "DEMO_RESOURCE_FORBIDDEN" });
  state.channel = "WHATSAPP";
  await assert.rejects(demoMessageService.create(actor, input), { code: "DEMO_RESOURCE_FORBIDDEN" });
  state.channel = "DEMO"; state.validLead = false;
  await assert.rejects(demoMessageService.create(actor, input), { code: "DEMO_RESOURCE_FORBIDDEN" });
  state.validLead = true; state.active = false;
  await assert.rejects(demoMessageService.create(actor, input), { code: "DEMO_RESOURCE_FORBIDDEN" });
  assert.equal(rows.length, 0);
});
test("retry returns original message without repeating activity/unread and succeeds at the cap", async t => {
  const { state, rows, activities } = fixture(t);
  const input = { text: "Hello", clientMessageId: randomUUID() };
  const first = await demoMessageService.create(actor, input);
  state.count = 50;
  const retry = await demoMessageService.create(actor, { ...input, clientMessageId: input.clientMessageId.toUpperCase() });
  assert.deepEqual(retry, first); assert.equal(rows.length, 1); assert.equal(state.unread, 1); assert.equal(activities.length, 1);
  await assert.rejects(demoMessageService.create(actor, { ...input, text: "changed" }), { code: "DEMO_MESSAGE_CONFLICT" });
  await assert.rejects(demoMessageService.create(actor, { ...input, clientMessageId: randomUUID() }), { code: "DEMO_MESSAGE_LIMIT_REACHED", statusCode: 429 });
});
test("strict text-only validation rejects empty, oversized and forged fields", () => {
  for (const text of ["", "   ", "x".repeat(2001)]) assert.throws(() => parseDemoMessage({ text, clientMessageId: randomUUID() }), { statusCode: 400 });
  for (const key of ["businessId", "conversationId", "leadId", "customerId", "demoSessionId", "senderType"]) assert.throws(() => parseDemoMessage({ text: "hi", clientMessageId: randomUUID(), [key]: "forged" }), { statusCode: 400 });
  assert.throws(() => parseDemoMessage({ text: "hi", clientMessageId: "bad-id" }), { statusCode: 400 });
  assert.equal(parseDemoMessage({ text: "x".repeat(2000), clientMessageId: randomUUID() }).text.length, 2000);
});
test("shared core preserves transport metadata, blocked preview, timestamp and reopen changes", async t => {
  const { tx, rows, activities, state } = fixture(t);
  const createdAt = new Date("2026-01-01T00:00:00Z");
  await storeInboundCustomerMessage(tx as any, { businessId: actor.businessId, conversationId: "conversation", leadId: "customer", content: "private content", provider: "META_WHATSAPP", providerMessageId: "provider-id", createdAt, lastMessagePreview: "Locked customer message", metadata: { blocked: true }, activityMetadata: { source: "WHATSAPP" }, conversationChanges: { status: "OPEN" } });
  assert.equal(rows[0].createdAt, createdAt); assert.equal(rows[0].providerMessageId, "provider-id");
  assert.equal(state.preview, "Locked customer message"); assert.equal(activities[0].metadata.source, "WHATSAPP");
});
test("memory discovery excludes demo businesses even though their customer text is canonical", () => {
  assert.deepEqual(eligibleDiscoveryWhere("business").business, { demoSessionId: null });
});
test("HTTP message adapter accepts 2000 multibyte characters, restores history and requires auth", async t => {
  fixture(t);
  mockMethod(t, demoService, "authenticate", async value => { if (value !== "token") throw Object.assign(new Error("Authentication required"), { statusCode: 401 }); return actor; });
  const app = express(); app.use(express.json({ limit: "16kb" })); app.use("/api/demo", demoRouter); app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/demo/session/messages`;
  for (const method of ["GET", "POST"]) assert.equal((await fetch(url, { method })).status, 401);
  const headers = { Authorization: "Bearer token", "Content-Type": "application/json" };
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ text: "?".repeat(2000), clientMessageId: randomUUID() }) });
  assert.equal(response.status, 200); assert.equal((await response.json() as any).message.text.length, 2000);
  assert.equal((await (await fetch(url, { headers })).json() as any).messages.length, 1);
});

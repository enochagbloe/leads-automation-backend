import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import { EventEmitter, once } from "node:events";
import express, { Response } from "express";
import { realtimeService, DEMO_SSE_CONNECTION_LIMIT } from "../src/services/realtime.service";
import { demoRealtimeService } from "../src/services/demo-realtime.service";
import { demoService, DemoActor } from "../src/services/demo.service";
import { env } from "../src/config/env";
import { prisma } from "../src/config/prisma";
import { demoRouter } from "../src/routes/demo.routes";
import { realtimeRouter } from "../src/routes/realtime.routes";
import { errorHandler } from "../src/middleware/error";
import { mockMethod } from "./helpers/mock-method";

class Stream extends EventEmitter {
  chunks: string[] = []; writableEnded = false; blocked = false; headers: unknown;
  set(headers: unknown) { this.headers = headers; }
  flushHeaders() {}
  write(chunk: string) { this.chunks.push(chunk); this.emit("frame"); return !this.blocked; }
  end() { if (!this.writableEnded) { this.writableEnded = true; this.emit("close"); } }
  get response() { return this as unknown as Response; }
  get text() { return this.chunks.join(""); }
}
const actor: DemoActor = { actorType: "DEMO", isDemo: true, demoSessionId: "a", businessId: "business-a" };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function clean(t: TestContext) { realtimeService.disconnectAllDemo(); t.after(() => realtimeService.disconnectAllDemo()); }
function subscribe(stream: Stream, session = "a", extra = {}) {
  return realtimeService.subscribeDemo({ demoSessionId: session, businessId: `business-${session}`, conversationId: `conversation-${session}`, expiresAt: Date.now() + 60_000, response: stream.response, isValid: async () => true, ...extra });
}
function fixture(t: TestContext) {
  clean(t);
  const enabled = env.DEMO_ENABLED; env.DEMO_ENABLED = true; t.after(() => { env.DEMO_ENABLED = enabled; });
  const state = { active: true, setupStatus: "WAITING_FOR_BUSINESS", expiresAt: new Date(Date.now() + 60_000), channel: "DEMO", validLead: true };
  mockMethod(t, prisma.demoSession, "findFirst", async ({ where }: any) => state.active && state.expiresAt > new Date() && where.id === actor.demoSessionId && where.business.id === actor.businessId && where.business.demoSessionId === actor.demoSessionId ? state : null);
  mockMethod(t, prisma.conversation, "findMany", async () => [{ id: "conversation-a", businessId: actor.businessId, leadId: "lead-a", channel: state.channel }]);
  mockMethod(t, prisma.lead, "findFirst", async ({ where }: any) => state.validLead && where.id === "lead-a" && where.businessId === actor.businessId && where.phone === "demo_customer_a" ? { id: "lead-a" } : null);
  return state;
}

test("demo registry isolates all three scope keys and production registry keeps business/staff filtering", t => {
  clean(t); const a = new Stream(), b = new Stream(), owner = new Stream(), staff = new Stream();
  subscribe(a); subscribe(b, "b");
  const production = realtimeService.subscribe({ businessId: actor.businessId, userId: "owner", membershipId: "owner", role: "BUSINESS_OWNER", response: owner.response });
  const restricted = realtimeService.subscribe({ businessId: actor.businessId, userId: "staff", membershipId: "staff", role: "STAFF", response: staff.response });
  t.after(() => { realtimeService.unsubscribe(production.id); realtimeService.unsubscribe(restricted.id); });
  const input = { demoSessionId: "a", businessId: actor.businessId, conversationId: "conversation-a", type: "message.created" as const, payload: { text: "A only" } };
  realtimeService.publishDemo(input); assert.match(a.text, /A only/); assert.doesNotMatch(b.text, /A only/); assert.equal(owner.text, ""); assert.equal(staff.text, "");
  for (const mismatch of [{ demoSessionId: "b" }, { businessId: "business-b" }, { conversationId: "conversation-b" }]) realtimeService.publishDemo({ ...input, ...mismatch, payload: { text: "MISMATCH" } });
  assert.doesNotMatch(a.text + b.text, /MISMATCH/);
  realtimeService.publishDemo({ ...input, demoSessionId: "b", businessId: "business-b", conversationId: "conversation-b", payload: { text: "B only" } });
  assert.match(b.text, /B only/); assert.doesNotMatch(a.text, /B only/);
  realtimeService.publish({ businessId: actor.businessId, type: "message.created", payload: { text: "production" } });
  assert.match(owner.text, /production/); assert.equal(staff.text, ""); assert.doesNotMatch(a.text + b.text, /production/);
  realtimeService.publish({ businessId: actor.businessId, type: "message.created", assignedStaffId: "staff", payload: { text: "assigned" } });
  assert.match(staff.text, /assigned/);
});

test("disconnect, destruction adapter, backpressure and shutdown release demo subscribers/listeners", t => {
  clean(t); const a = new Stream(); subscribe(a); assert.equal(realtimeService.demoClientCount(), 1);
  a.emit("close"); assert.equal(realtimeService.demoClientCount(), 0); assert.equal(a.listenerCount("error"), 0);
  const b = new Stream(); subscribe(b); realtimeService.disconnectDemo("a"); assert.equal(b.writableEnded, true); assert.equal(realtimeService.demoClientCount(), 0);
  const slow = new Stream(); slow.blocked = true; subscribe(slow); assert.equal(realtimeService.demoClientCount(), 0);
  const c = new Stream(); subscribe(c); realtimeService.disconnectAllDemo(); assert.equal(c.writableEnded, true); assert.equal(realtimeService.demoClientCount(), 0);
});

test("expiry closes without waiting for a domain event", async t => {
  clean(t); const stream = new Stream(); const closed = once(stream, "close");
  subscribe(stream, "a", { expiresAt: Date.now() + 30 });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await closed; } finally { clearTimeout(keepAlive); }
  assert.equal(realtimeService.demoClientCount(), 0);
});

test("session destruction closes subscribers only after its persistence completes", async t => {
  fixture(t); const stream = new Stream(); await demoRealtimeService.connect(actor, stream.response);
  mockMethod(t, prisma, "$transaction", async () => { assert.equal(stream.writableEnded, false); });
  await demoService.destroy(actor.demoSessionId);
  assert.equal(stream.writableEnded, true); assert.equal(realtimeService.demoClientCount(), 0);
});

test("heartbeat uses ping, checks persisted validity, and closes failed validation", async t => {
  clean(t); const a = new Stream(), b = new Stream(); subscribe(a); subscribe(b, "b", { isValid: async () => false });
  realtimeService.heartbeat(); await tick();
  assert.match(a.text, /event: ping\ndata: \{"ts":/); assert.equal(b.writableEnded, true); assert.equal(realtimeService.demoClientCount(), 1);
  assert.equal(a.chunks.filter(c => c.includes("event: demo.connected")).length, 1);
});

test("per-session connection bound rejects before opening another SSE response", t => {
  clean(t); for (let i = 0; i < DEMO_SSE_CONNECTION_LIMIT; i++) subscribe(new Stream());
  const excess = new Stream(); assert.throws(() => subscribe(excess), { code: "DEMO_STREAM_LIMIT_REACHED" }); assert.equal(excess.text, "");
});

test("scoped adapter connects before setup, but rejects mismatches, disabled or expired sessions", async t => {
  const state = fixture(t); const stream = new Stream(); await demoRealtimeService.connect(actor, stream.response);
  assert.match(stream.text, /event: demo.connected/); assert.equal(realtimeService.demoClientCount(), 1);
  await assert.rejects(demoRealtimeService.connect({ ...actor, businessId: "business-b" }, new Stream().response));
  state.channel = "WHATSAPP"; await assert.rejects(demoRealtimeService.connect(actor, new Stream().response)); state.channel = "DEMO";
  state.validLead = false; await assert.rejects(demoRealtimeService.connect(actor, new Stream().response)); state.validLead = true;
  env.DEMO_ENABLED = false; await assert.rejects(demoRealtimeService.connect(actor, new Stream().response)); env.DEMO_ENABLED = true;
  state.active = false; realtimeService.heartbeat(); await tick(); assert.equal(stream.writableEnded, true);
  state.active = true; state.expiresAt = new Date(0); await assert.rejects(demoRealtimeService.connect(actor, new Stream().response));
});

test("HTTP SSE requires demo auth, rejects query-selected scope, streams connected and releases on disconnect", async t => {
  const state = fixture(t);
  mockMethod(t, demoService, "authenticate", async token => {
    if (token !== "valid" || !state.active) throw Object.assign(new Error("Invalid demo session"), { statusCode: 401 }); return actor;
  });
  const app = express(); app.use("/api/demo", demoRouter); app.use("/api/realtime", realtimeRouter); app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { realtimeService.disconnectAllDemo(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const url = `${base}/api/demo/session/events`; const headers = { Authorization: "Bearer valid", Accept: "text/event-stream" };
  for (const authorization of [undefined, "Bearer invalid"]) assert.equal((await fetch(url, { headers: authorization ? { Authorization: authorization } : {} })).status, 401);
  state.active = false; assert.equal((await fetch(url, { headers })).status, 401); state.active = true;
  for (const key of ["businessId", "conversationId", "leadId", "demoSessionId", "token"]) assert.equal((await fetch(`${url}?${key}=forged`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/api/realtime/events`, { headers })).status, 401);
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal }); assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  const reader = response.body!.getReader(); const chunk = await reader.read(); assert.match(new TextDecoder().decode(chunk.value), /event: demo.connected/);
  assert.equal(realtimeService.demoClientCount(), 1); controller.abort(); await reader.cancel().catch(() => {});
  for (let i = 0; i < 50 && realtimeService.demoClientCount(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(realtimeService.demoClientCount(), 0);
});

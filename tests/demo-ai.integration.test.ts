import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { randomUUID } from "node:crypto";
import { env } from "../src/config/env";
import { prisma } from "../src/config/prisma";
import { demoRouter } from "../src/routes/demo.routes";
import { errorHandler } from "../src/middleware/error";
import { demoService } from "../src/services/demo.service";
import { demoContextService } from "../src/services/demo-context.service";
import { aiProvider } from "../src/services/ai-provider.service";
import { processDemoReplyForMessage } from "../src/services/demo-ai-processing.service";
import { mockMethod } from "./helpers/mock-method";

// Explicitly opt into a dedicated test DB; never fall back to the application's DB.
const run = process.env.RUN_DEMO_AI_DATABASE_TESTS === "true" ? test : test.skip;
run("dedicated DB: create/setup/send/retry/history, concurrent dedupe and tenant isolation", async t => {
  assert.equal(process.env.NODE_ENV, "test", "Run only in the test environment");
  assert.ok(process.env.DEMO_TEST_DATABASE_URL, "A dedicated DEMO_TEST_DATABASE_URL must be explicitly supplied");
  assert.ok(env.DATABASE_URL === process.env.DEMO_TEST_DATABASE_URL, "DATABASE_URL must point to the dedicated demo test database");
  const enabled = env.DEMO_ENABLED; env.DEMO_ENABLED = true;
  const sessions: string[] = [];
  const provider = mockMethod(t, aiProvider, "generateReply", async input => {
    assert.match(input.userPrompt, /Roof inspection/); assert.match(input.userPrompt, /GHS 300/);
    return { rawText: "", provider: "OPENROUTER", model: "test", primaryModel: "test", finalModelUsed: "test", fallbackAttempted: false, fallbackModelsTried: [], fallbackFailureReasons: [], providerRequestCount: 1, latencyMs: 1, parsedDecision: { intent: "SERVICE_INQUIRY", replyText: "We offer roof inspection for GHS 300.", confidence: 1, shouldReply: true, requiresHumanReview: false, reason: "Confirmed fact", suggestedAction: "SEND_REPLY", usedKnowledge: { profile: false, services: true, availability: false, policies: false, conversationHistory: false } } };
  });
  const app = express(); app.use(express.json()); app.use("/api/demo", demoRouter); app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/demo/session`;
  const httpFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url: any, init?: any) => {
    assert.ok(String(url).startsWith(base), "Only local test HTTP requests are allowed");
    return httpFetch(url, init);
  });
  try {
    const response = await fetch(base, { method: "POST" }); assert.equal(response.status, 201);
    const created = await response.json() as any; sessions.push(created.demo.sessionId);
    const actor = await demoService.authenticate(created.token);
    const headers = { Authorization: `Bearer ${created.token}`, "Content-Type": "application/json" };
    assert.equal((await fetch(`${base}/setup`, { method: "POST", headers, body: JSON.stringify({ businessName: "Acme Roofing" }) })).status, 200);
    const context = await demoContextService.getBusinessContext(actor);
    context.facts.services = [{ name: "Roof inspection", price: "GHS 300", duration: null, description: null }];
    await prisma.demoSession.update({ where: { id: actor.demoSessionId }, data: { setupStatus: "READY", demoContext: context } });
    const request = { method: "POST", headers, body: JSON.stringify({ text: "Do you offer roofing?", clientMessageId: randomUUID() }) };
    const first = await fetch(`${base}/messages`, request); assert.equal(first.status, 200); const result = await first.json() as any;
    assert.equal(result.aiMessage.senderType, "AI"); assert.equal(result.message.id, result.customerMessage.id);
    assert.deepEqual(await (await fetch(`${base}/messages`, request)).json(), result);
    const history = await (await fetch(`${base}/messages`, { headers })).json() as any;
    assert.deepEqual(history.messages.map((m: any) => m.senderType), ["CUSTOMER", "AI"]);
    assert.equal(provider.mock.callCount(), 1);
    const concurrentRequest = { ...request, body: JSON.stringify({ text: "Tell me about inspection", clientMessageId: randomUUID() }) };
    const concurrent = await Promise.all([fetch(`${base}/messages`, concurrentRequest), fetch(`${base}/messages`, concurrentRequest)]);
    assert.ok(concurrent.some(r => r.status === 200));
    assert.ok(concurrent.every(r => r.status === 200 || r.status === 503));
    const replay = await fetch(`${base}/messages`, concurrentRequest); assert.equal(replay.status, 200);
    assert.equal(provider.mock.callCount(), 2);
    assert.equal(await prisma.message.count({ where: { businessId: actor.businessId } }), 4);
    const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: result.conversation.id } });
    assert.equal(convo.unreadCount, 2); assert.equal(convo.lastMessagePreview, result.aiMessage.text);
    const b = await demoService.create(randomUUID()); sessions.push(b.demo.sessionId);
    const other = await demoService.authenticate(b.token);
    await assert.rejects(processDemoReplyForMessage({ ...actor, businessId: other.businessId }, result.message.id), { code: "DEMO_RESOURCE_FORBIDDEN" });
    assert.equal((await fetch(`${base}/messages`, { ...request, headers: { ...headers, "X-Business-Id": other.businessId } })).status, 403);
    assert.equal((await fetch(`${base}/messages`, { headers: { ...headers, "X-Business-Id": other.businessId } })).status, 403);
    assert.equal(await prisma.message.count({ where: { businessId: other.businessId } }), 0);
    assert.equal(await prisma.businessUsageRecord.count({ where: { businessId: actor.businessId } }), 0);
    assert.equal(await prisma.appointment.count({ where: { businessId: actor.businessId } }), 0);
    assert.equal(await prisma.followUpJob.count({ where: { businessId: actor.businessId } }), 0);
    assert.equal(await prisma.customerMemoryExtractionJob.count({ where: { businessId: actor.businessId } }), 0);
    assert.equal(await prisma.businessNotification.count({ where: { businessId: actor.businessId } }), 0);
  } finally {
    server.closeAllConnections(); server.close();
    for (const id of sessions) { await demoService.destroy(id); await prisma.demoSession.delete({ where: { id } }); }
    env.DEMO_ENABLED = enabled;
  }
});

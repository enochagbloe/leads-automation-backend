import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/config/prisma";
import { env } from "../src/config/env";
import { demoService } from "../src/services/demo.service";
import { conversationStateService as service } from "../src/services/conversation-state.service";

const run = process.env.RUN_CONVERSATION_STATE_DATABASE_TESTS === "true" ? test : test.skip;
run("Postgres: composite tenant FK, concurrent CAS, durable replay and demo cascade isolation", async () => {
  assert.equal(process.env.NODE_ENV, "test", "Use a dedicated test database");
  assert.ok(process.env.CONVERSATION_STATE_TEST_DATABASE_URL);
  assert.equal(process.env.DATABASE_URL, process.env.CONVERSATION_STATE_TEST_DATABASE_URL, "Refusing the configured application database");
  const enabled = env.DEMO_ENABLED; env.DEMO_ENABLED = true;
  const sessions: string[] = [];
  let ownerId: string | undefined; let accountId: string | undefined; let businessId: string | undefined;
  try {
    const a = await demoService.create(randomUUID()); sessions.push(a.demo.sessionId);
    const b = await demoService.create(randomUUID()); sessions.push(b.demo.sessionId);
    const actor = await demoService.authenticate(a.token);
    const other = await demoService.authenticate(b.token);
    const conversationA = await prisma.conversation.findFirstOrThrow({ where: { businessId: actor.businessId } });
    const conversationB = await prisma.conversation.findFirstOrThrow({ where: { businessId: other.businessId } });
    const scope = { businessId: actor.businessId, conversationId: conversationA.id, demoSessionId: actor.demoSessionId };
    ownerId = (await prisma.user.create({ data: { firstName: "State", lastName: "Fixture", email: `${randomUUID()}@example.invalid`, passwordHash: "!disabled", status: "DISABLED" } })).id;
    accountId = (await prisma.businessAccount.create({ data: { name: "State fixture", ownerId } })).id;
    businessId = (await prisma.business.create({ data: { name: "State fixture", industry: "Test", email: `${randomUUID()}@example.invalid`, slug: randomUUID(), ownerId, businessAccountId: accountId } })).id;
    const lead = await prisma.lead.create({ data: { businessId, fullName: "Fixture", phone: `test_${randomUUID()}`, source: "OTHER" } });
    const production = await prisma.conversation.create({ data: { businessId, leadId: lead.id, channel: "MANUAL" } });
    const input = { ...scope, expectedRevision: 0, source: "WORKFLOW" as const, sourceEffectId: "start" };
    for (const target of [{ ...scope, businessId: other.businessId, conversationId: conversationB.id }, { ...scope, businessId, conversationId: production.id }]) {
      await assert.rejects(service.get(target), { code: "CONVERSATION_STATE_FORBIDDEN" });
      await assert.rejects(service.pauseWorkflow({ ...input, ...target }), { code: "CONVERSATION_STATE_FORBIDDEN" });
    }
    await assert.rejects(prisma.conversationState.create({ data: { businessId, conversationId: conversationA.id } }), { code: "P2003" });
    await service.initialize(scope);
    const writes = await Promise.allSettled([service.setActiveWorkflow(input, "APPOINTMENT_BOOKING", "APPOINTMENT"), service.setActiveWorkflow({ ...input, sourceEffectId: "other-start" }, "COMPLAINT_INTAKE", "COMPLAINT")]);
    assert.equal(writes.filter(r => r.status === "fulfilled").length, 1);
    assert.equal((await service.get(scope)).revision, 1);
    const reply = { ...input, expectedRevision: 1, sourceEffectId: "options" };
    const options = [{ id: "one", label: "12 PM", value: "12:00", position: 1 }];
    await Promise.all([service.setOptions(reply, options), service.setOptions(reply, options)]);
    assert.equal((await service.get(scope)).revision, 2);
    assert.equal(await prisma.conversationStateEffect.count({ where: { businessId: scope.businessId } }), 2);
    await service.initialize({ businessId, conversationId: production.id });
    await demoService.destroy(actor.demoSessionId);
    assert.equal(await prisma.conversationState.count({ where: { businessId: scope.businessId } }), 0);
    assert.equal(await prisma.conversationStateEffect.count({ where: { businessId: scope.businessId } }), 0);
    assert.equal((await service.get({ businessId, conversationId: production.id })).revision, 0);
    assert.equal(await prisma.customerMemoryExtractionJob.count({ where: { businessId: other.businessId } }), 0);
  } finally {
    for (const id of sessions) { await demoService.destroy(id); await prisma.demoSession.delete({ where: { id } }); }
    if (businessId) await prisma.business.delete({ where: { id: businessId } });
    if (accountId) await prisma.businessAccount.delete({ where: { id: accountId } });
    if (ownerId) await prisma.user.delete({ where: { id: ownerId } });
    env.DEMO_ENABLED = enabled;
  }
});

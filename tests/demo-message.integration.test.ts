import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { env } from "../src/config/env";
import { prisma } from "../src/config/prisma";
import { demoService } from "../src/services/demo.service";
import { demoSetupService } from "../src/services/demo-setup.service";
import { demoMessageService } from "../src/services/demo-message.service";
import { eligibleDiscoveryWhere } from "../src/services/customer-memory/customer-memory-worker.service";
const run = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? test : test.skip;

run("real storage: concurrent demo retries/cap, no usage or memory eligibility, and tenant-safe message cleanup", async () => {
  const enabled = env.DEMO_ENABLED; env.DEMO_ENABLED = true;
  const sessions: string[] = [];
  let production: { ownerId: string; accountId: string; businessId: string; messageId: string } | undefined;
  try {
    const a = await demoService.create(randomUUID()); sessions.push(a.demo.sessionId);
    const b = await demoService.create(randomUUID()); sessions.push(b.demo.sessionId);
    const actor = await demoService.authenticate(a.token);
    const other = await demoService.authenticate(b.token);
    const input = { text: "Hi, do you offer roofing?", clientMessageId: randomUUID() };
    await assert.rejects(demoMessageService.create(actor, input), { code: "DEMO_SETUP_NOT_READY" });
    await demoSetupService.setup(actor, { businessName: "Demo A" });
    await demoSetupService.setup(other, { businessName: "Demo B" });
    await prisma.demoSession.update({ where: { id: actor.demoSessionId }, data: { setupStatus: "READY" } });
    const [first, retry] = await Promise.all([demoMessageService.create(actor, input), demoMessageService.create(actor, input)]);
    assert.equal(first.message.id, retry.message.id);
    const separate = await demoMessageService.create(other, input);
    assert.notEqual(first.message.id, separate.message.id);
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: a.demo.conversation.id } });
    assert.equal(conversation.channel, "DEMO"); assert.equal(conversation.unreadCount, 1); assert.equal(conversation.lastMessagePreview, input.text);
    const stored = await prisma.message.findUniqueOrThrow({ where: { id: first.message.id } });
    assert.equal(stored.senderType, "CUSTOMER"); assert.equal(stored.direction, "INBOUND"); assert.equal(stored.messageType, "TEXT"); assert.equal(stored.businessId, actor.businessId); assert.equal(stored.leadId, a.demo.customer.id);
    assert.equal(await prisma.leadActivity.count({ where: { businessId: actor.businessId, action: "MESSAGE_CREATED" } }), 1);
    assert.equal(await prisma.message.count({ where: eligibleDiscoveryWhere(actor.businessId) }), 0);
    assert.equal(await prisma.customerMemoryExtractionJob.count({ where: { businessId: actor.businessId } }), 0);
    assert.equal(await prisma.aiInteractionLog.count({ where: { businessId: actor.businessId } }), 0);
    assert.equal(await prisma.businessUsageRecord.count({ where: { businessId: actor.businessId } }), 0);
    const business = await prisma.business.findUniqueOrThrow({ where: { id: actor.businessId } });
    assert.equal(await prisma.accountUsageRecord.count({ where: { businessAccountId: business.businessAccountId } }), 0);
    assert.equal(await prisma.subscription.count({ where: { businessAccountId: business.businessAccountId } }), 0);
    await assert.rejects(demoMessageService.create({ ...actor, businessId: other.businessId }, input), { code: "DEMO_RESOURCE_FORBIDDEN" });
    await assert.rejects(demoMessageService.list({ ...actor, businessId: other.businessId }), { code: "DEMO_RESOURCE_FORBIDDEN" });
    // At 49 customer messages, simultaneous distinct sends must admit exactly one.
    await prisma.message.createMany({ data: Array.from({ length: 48 }, () => ({ businessId: actor.businessId, conversationId: conversation.id, leadId: a.demo.customer.id, senderType: "CUSTOMER" as const, direction: "INBOUND" as const, messageType: "TEXT" as const, deliveryStatus: "DELIVERED" as const, content: "Seeded limit fixture", provider: "DEMO", providerMessageId: `demo:${actor.demoSessionId}:${randomUUID()}` })) });
    const atLimit = await Promise.allSettled([demoMessageService.create(actor, { ...input, clientMessageId: randomUUID() }), demoMessageService.create(actor, { ...input, clientMessageId: randomUUID() })]);
    assert.equal(atLimit.filter(result => result.status === "fulfilled").length, 1);
    const rejected = atLimit.find(result => result.status === "rejected"); assert.ok(rejected && rejected.status === "rejected");
    assert.equal(rejected.reason.code, "DEMO_MESSAGE_LIMIT_REACHED");
    assert.equal((await demoMessageService.create(actor, input)).message.id, first.message.id);
    assert.equal((await demoMessageService.list(actor)).messages.length, 50);
    production = await prisma.$transaction(async tx => {
      const owner = await tx.user.create({ data: { firstName: "Cleanup", lastName: "Fixture", email: `${randomUUID()}@example.invalid`, passwordHash: "!fixture", status: "DISABLED" } });
      const account = await tx.businessAccount.create({ data: { name: "Fixture", ownerId: owner.id } });
      const company = await tx.business.create({ data: { name: "Production-shaped fixture", industry: "Test", slug: randomUUID(), ownerId: owner.id, businessAccountId: account.id } });
      const lead = await tx.lead.create({ data: { businessId: company.id, fullName: "Fixture", phone: `test_${randomUUID()}`, source: "OTHER" } });
      const convo = await tx.conversation.create({ data: { businessId: company.id, leadId: lead.id, channel: "MANUAL" } });
      const message = await tx.message.create({ data: { businessId: company.id, conversationId: convo.id, leadId: lead.id, senderType: "SYSTEM", direction: "INTERNAL", messageType: "SYSTEM", deliveryStatus: "INTERNAL", content: "Protected production message" } });
      return { ownerId: owner.id, accountId: account.id, businessId: company.id, messageId: message.id };
    });
    await assert.rejects(demoMessageService.create({ ...actor, businessId: production.businessId }, input), { code: "DEMO_RESOURCE_FORBIDDEN" });
    const protectedMessage = await prisma.message.findUniqueOrThrow({ where: { id: production.messageId } });
    await demoService.destroy(actor.demoSessionId);
    assert.equal(await prisma.message.count({ where: { businessId: actor.businessId } }), 0);
    assert.deepEqual(await prisma.message.findUniqueOrThrow({ where: { id: production.messageId } }), protectedMessage);
    assert.ok(await prisma.message.findUnique({ where: { id: separate.message.id } }));
  } finally {
    for (const id of sessions) { await demoService.destroy(id); await prisma.demoSession.delete({ where: { id } }); }
    if (production) {
      await prisma.business.delete({ where: { id: production.businessId } });
      await prisma.businessAccount.delete({ where: { id: production.accountId } });
      await prisma.user.delete({ where: { id: production.ownerId } });
    }
    env.DEMO_ENABLED = enabled;
  }
});

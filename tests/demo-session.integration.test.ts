import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { env } from "../src/config/env";
import { prisma } from "../src/config/prisma";
import { demoService } from "../src/services/demo.service";
const run = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? test : test.skip;
run("demo lifecycle: atomic creation, concurrent dedupe, no billing, isolation, expiry and cascading cleanup", async () => {
  const old = env.DEMO_ENABLED; env.DEMO_ENABLED = true;
  const ids: string[] = [];
  try {
    const key = randomUUID(); const ip = randomUUID();
    const [a, b] = await Promise.all([demoService.create(ip, key), demoService.create(ip, key)]);
    ids.push(a.demo.sessionId);
    assert.equal(a.token, b.token); assert.equal(a.demo.business.id, b.demo.business.id);
    const business = await prisma.business.findUniqueOrThrow({ where: { id: a.demo.business.id } });
    assert.equal(business.demoSessionId, a.demo.sessionId);
    assert.equal(await prisma.conversation.count({ where: { businessId: business.id } }), 1);
    assert.equal(await prisma.lead.count({ where: { businessId: business.id } }), 1);
    assert.equal(await prisma.businessMember.count({ where: { businessId: business.id } }), 0);
    assert.equal(await prisma.subscription.count({ where: { businessAccountId: business.businessAccountId } }), 0);
    assert.equal(await prisma.accountUsageRecord.count({ where: { businessAccountId: business.businessAccountId } }), 0);
    const actor = await demoService.authenticate(a.token);
    assert.equal((await demoService.get(actor)).demo.customer.name, "Demo Customer");
    await assert.rejects(demoService.authenticate(a.token, randomUUID()), { code: "DEMO_RESOURCE_FORBIDDEN" });
    await demoService.destroy(a.demo.sessionId);
    await assert.rejects(demoService.authenticate(a.token), { code: "DEMO_SESSION_INVALID" });
    assert.equal(await prisma.business.count({ where: { id: business.id } }), 0);
    assert.equal(await prisma.user.count({ where: { id: business.ownerId } }), 0);
    assert.equal(await prisma.lead.count({ where: { businessId: business.id } }), 0);
    assert.equal(await prisma.conversation.count({ where: { businessId: business.id } }), 0);
    const c = await demoService.create(ip); ids.push(c.demo.sessionId);
    await prisma.demoSession.update({ where: { id: c.demo.sessionId }, data: { expiresAt: new Date(0) } });
    await assert.rejects(demoService.authenticate(c.token), { code: "DEMO_SESSION_EXPIRED" });
    await demoService.destroy(c.demo.sessionId, true);
    assert.equal((await prisma.demoSession.findUniqueOrThrow({ where: { id: c.demo.sessionId } })).status, "DESTROYED");
  } finally {
    for (const id of ids) { await demoService.destroy(id); await prisma.demoSession.delete({ where: { id } }); }
    env.DEMO_ENABLED = old;
  }
});

import { demoSetupService } from "../src/services/demo-setup.service";
import { demoContextService } from "../src/services/demo-context.service";
import { app } from "../src/app";
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

run("demo A cannot read or mutate demo B or a production tenant through HTTP", async () => {
  const old = env.DEMO_ENABLED; env.DEMO_ENABLED = true;
  const ids: string[] = [];
  let fixture: { ownerId: string; accountId: string; businessId: string; conversationId: string; leadId: string } | undefined;
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const a = await demoService.create(randomUUID()); ids.push(a.demo.sessionId);
    const b = await demoService.create(randomUUID()); ids.push(b.demo.sessionId);
    fixture = await prisma.$transaction(async tx => {
      const owner = await tx.user.create({ data: { firstName: "Integration", lastName: "Fixture", email: `${randomUUID()}@example.invalid`, passwordHash: "!test-only" } });
      const account = await tx.businessAccount.create({ data: { name: "Integration Workspace", ownerId: owner.id } });
      const business = await tx.business.create({ data: { name: "Production-shaped fixture", industry: "Test", slug: randomUUID(), ownerId: owner.id, businessAccountId: account.id } });
      const lead = await tx.lead.create({ data: { businessId: business.id, fullName: "Protected Contact", phone: `test_${randomUUID()}`, source: "OTHER" } });
      const conversation = await tx.conversation.create({ data: { businessId: business.id, leadId: lead.id, channel: "MANUAL" } });
      return { ownerId: owner.id, accountId: account.id, businessId: business.id, leadId: lead.id, conversationId: conversation.id };
    });
    assert.equal((await prisma.business.findUniqueOrThrow({ where: { id: fixture.businessId } })).demoSessionId, null);
    for (const target of [
      { businessId: b.demo.business.id, conversationId: b.demo.conversation.id, leadId: b.demo.customer.id },
      fixture,
    ]) {
      const before = await prisma.conversation.findUniqueOrThrow({ where: { id: target.conversationId } });
      const leadBefore = await prisma.lead.findUniqueOrThrow({ where: { id: target.leadId } });
      const headers = { Authorization: `Bearer ${a.token}`, "X-Business-Id": target.businessId, "Content-Type": "application/json" };
      for (const method of ["GET", "DELETE"]) {
        const response = await fetch(`${base}/api/demo/session`, { method, headers });
        assert.equal(response.status, 403);
        assert.equal((await response.json() as any).error.code, "DEMO_RESOURCE_FORBIDDEN");
      }
      const setup = await fetch(`${base}/api/demo/session/setup`, { method: "POST", headers, body: JSON.stringify({ businessName: "Unauthorized" }) });
      assert.equal(setup.status, 403); await setup.arrayBuffer();
      for (const path of [`/api/conversations/${target.conversationId}`, `/api/leads/${target.leadId}`]) {
        for (const method of ["GET", "PATCH", "DELETE"]) {
          const response = await fetch(`${base}${path}`, { method, headers, ...(method === "PATCH" ? { body: JSON.stringify({ subject: "unauthorized change", fullName: "unauthorized change" }) } : {}) });
          assert.equal(response.status, 401);
          await response.arrayBuffer();
        }
      }
      assert.deepEqual(await prisma.conversation.findUniqueOrThrow({ where: { id: target.conversationId } }), before);
      assert.deepEqual(await prisma.lead.findUniqueOrThrow({ where: { id: target.leadId } }), leadBefore);
    }
    assert.equal((await demoService.authenticate(b.token)).demoSessionId, b.demo.sessionId);
    assert.equal((await demoService.authenticate(a.token)).demoSessionId, a.demo.sessionId);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const id of ids) { await demoService.destroy(id); await prisma.demoSession.delete({ where: { id } }); }
    if (fixture) {
      await prisma.business.delete({ where: { id: fixture.businessId } });
      await prisma.businessAccount.delete({ where: { id: fixture.accountId } });
      await prisma.user.delete({ where: { id: fixture.ownerId } });
    }
    env.DEMO_ENABLED = old;
  }
});

run("concurrent stale-key retries create one fresh session and never revive old credentials", async () => {
  const old = env.DEMO_ENABLED; env.DEMO_ENABLED = true;
  const ids: string[] = [];
  const ip = randomUUID(); const key = randomUUID();
  try {
    let previous = await demoService.create(ip, key); ids.push(previous.demo.sessionId);
    for (const destroyed of [false, true]) {
      if (destroyed) await demoService.destroy(previous.demo.sessionId);
      else await prisma.demoSession.update({ where: { id: previous.demo.sessionId }, data: { expiresAt: new Date(0) } });
      const results = await Promise.all([demoService.create(ip, key), demoService.create(ip, key)]);
      for (const result of results) if (!ids.includes(result.demo.sessionId)) ids.push(result.demo.sessionId);
      const [fresh, retry] = results;
      assert.equal(fresh.demo.sessionId, retry.demo.sessionId);
      assert.equal(fresh.token, retry.token);
      assert.notEqual(fresh.demo.sessionId, previous.demo.sessionId);
      assert.notEqual(fresh.token, previous.token);
      await assert.rejects(demoService.authenticate(previous.token));
      const expired = await prisma.demoSession.findUniqueOrThrow({ where: { id: previous.demo.sessionId } });
      assert.equal(expired.idempotencyHash, null);
      assert.equal(expired.status, destroyed ? "DESTROYED" : "ACTIVE");
      assert.equal((await demoService.authenticate(fresh.token)).demoSessionId, fresh.demo.sessionId);
      previous = fresh;
    }
  } finally {
    for (const id of ids) { await demoService.destroy(id); await prisma.demoSession.delete({ where: { id } }); }
    env.DEMO_ENABLED = old;
  }
});

run("demo setup persists and restores only its tenant context; cleanup erases website data", async () => {
  const old = env.DEMO_ENABLED; env.DEMO_ENABLED = true;
  const ids: string[] = [];
  try {
    const a = await demoService.create(randomUUID()); ids.push(a.demo.sessionId);
    const b = await demoService.create(randomUUID()); ids.push(b.demo.sessionId);
    const actor = await demoService.authenticate(a.token);
    await demoSetupService.setup(actor, { businessName: "Demo Acme" });
    const restored = await demoService.get(actor);
    assert.equal(restored.demo.setupStatus, "READY_PARTIAL"); assert.equal(restored.demo.business.name, "Demo Acme");
    assert.equal((await demoContextService.getBusinessContext(actor)).businessName, "Demo Acme");
    await assert.rejects(demoSetupService.setup({ ...actor, businessId: b.demo.business.id }, { businessName: "Cross tenant" }), { code: "DEMO_RESOURCE_FORBIDDEN" });
    await assert.rejects(demoContextService.getBusinessContext({ ...actor, businessId: b.demo.business.id }), { code: "DEMO_RESOURCE_FORBIDDEN" });
    assert.equal((await prisma.business.findUniqueOrThrow({ where: { id: b.demo.business.id } })).name, "Demo Business");
    await demoSetupService.setup(actor, { businessName: "Replacement" });
    assert.equal((await demoContextService.getBusinessContext(actor)).businessName, "Replacement");
    assert.equal(await prisma.business.count({ where: { demoSessionId: actor.demoSessionId } }), 1);
    await demoService.destroy(actor.demoSessionId);
    const destroyed = await prisma.demoSession.findUniqueOrThrow({ where: { id: actor.demoSessionId } });
    assert.equal(destroyed.demoContext, null); assert.equal(destroyed.setupStartedAt, null); assert.equal(destroyed.setupAttemptId, null);
  } finally {
    for (const id of ids) { await demoService.destroy(id); await prisma.demoSession.delete({ where: { id } }); }
    env.DEMO_ENABLED = old;
  }
});

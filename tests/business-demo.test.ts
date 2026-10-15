import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../src/config/env";
import { prisma } from "../src/config/prisma";
import { demoService } from "../src/services/demo.service";
import { createBusinessDemoInvite, verifyBusinessDemoInvite, ownerDemoReadScope, demoReadPermissions } from "../src/services/business-demo.service";
import { demoRealtimeService } from "../src/services/demo-realtime.service";
import { realtimeService } from "../src/services/realtime.service";
import { conversationService } from "../src/services/conversation.service";
import { mockMethod } from "./helpers/mock-method";
import { cacheService } from "../src/services/cache.service";
import { messageService } from "../src/services/message.service";

test("business QR invitations are signed, scoped and expire; tampering never changes tenant", () => {
  const link = createBusinessDemoInvite("tenant-a", 1000);
  assert.equal(verifyBusinessDemoInvite(link.invite, 1001), "tenant-a");
  assert.throws(() => verifyBusinessDemoInvite(link.invite, link.expiresAt.getTime()), { code: "DEMO_INVITE_INVALID" });
  assert.throws(() => verifyBusinessDemoInvite(`${Buffer.from('{"businessId":"tenant-b"}').toString("base64url")}.${link.invite.split('.')[1]}`, 1001), { code: "DEMO_INVITE_INVALID" });
  for (const value of [undefined, "", "abc", link.invite + ".extra"]) assert.throws(() => verifyBusinessDemoInvite(value), { code: "DEMO_INVITE_INVALID" });
});

test("admission serializes by business: five sessions, idempotent retry, expiry frees capacity, independent tenant", async t => {
  const old = env.DEMO_ENABLED; env.DEMO_ENABLED = true; t.after(() => { env.DEMO_ENABLED = old; });
  const sessions: any[] = [], businesses: any[] = [];
  let lockKey = "";
  const tx: any = {
    $queryRaw: async (_strings: unknown, key: string) => { lockKey = key; },
    demoSession: {
      findUnique: async ({ where }: any) => sessions.find(s => where.id ? s.id === where.id : s.idempotencyHash === where.idempotencyHash),
      count: async ({ where }: any) => { assert.equal(lockKey, `business-demo:${where.hostBusinessId}`); return sessions.filter(s => s.hostBusinessId === where.hostBusinessId && s.status === "ACTIVE" && s.expiresAt > where.expiresAt.gt).length; },
      create: async ({ data }: any) => { assert.equal(data.setupStatus, "READY"); const row = { ...data, status: "ACTIVE" }; sessions.push(row); return row; },
      update: async ({ where, data }: any) => Object.assign(sessions.find(s => s.id === where.id), data),
    },
    business: {
      findFirst: async ({ where }: any) => { assert.equal(where.demoSessionId, null); assert.equal(where.deletedAt, null); return { id: where.id, name: "Project Partners", industry: "Consultancy", timezone: "Africa/Accra", defaultCurrency: "GHS", website: null }; },
      create: async ({ data }: any) => { assert.equal(data.aiRepliesEnabled, false); assert.equal(data.aiAutoReplyEnabled, false); assert.ok(data.demoSessionId); const b = { ...data, id: `isolated-${data.demoSessionId}` }; businesses.push(b); return b; },
      findUnique: async ({ where }: any) => businesses.find(b => b.demoSessionId === where.demoSessionId),
    },
    service: { findMany: async ({ where }: any) => { assert.equal(where.isArchived, false); return [{ name: "Strategy session", description: null, priceDescription: null, basePrice: null, durationMinutes: null }]; } },
    businessAvailability: { findMany: async () => [] },
    businessPolicy: { findMany: async ({ where }: any) => { assert.equal(where.visibility, "CUSTOMER_FACING"); return []; } },
    user: { create: async ({ data }: any) => { assert.equal(data.status, "DISABLED"); return { id: "synthetic-owner" }; } },
    businessAccount: { create: async () => ({ id: "synthetic-account" }) },
    lead: { create: async ({ data }: any) => { assert.equal(data.whatsAppOptedOut, true); return { id: "synthetic-customer" }; }, findFirst: async () => ({ id: "synthetic-customer", fullName: "Demo Customer" }) },
    conversation: { create: async ({ data }: any) => { assert.equal(data.channel, "DEMO"); }, findFirst: async () => ({ id: "conversation", leadId: "synthetic-customer" }) },
    auditLog: { create: async () => {} },
  };
  // Emulate transaction lock scheduling; assert the SQL lock is keyed to the host, not the IP.
  let queue = Promise.resolve();
  mockMethod(t, prisma, "$transaction", (fn: any) => { const run = queue.then(() => fn(tx)); queue = run.then(() => {}, () => {}); return run; });
  const attempts = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => demoService.create(`ip-${i}`, `key-${i}-1234567890123456`, "tenant-a")));
  assert.equal(attempts.filter(r => r.status === "fulfilled").length, 5);
  const rejected = attempts.find(r => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "DEMO_LIMIT_REACHED");
  const first = attempts[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof demoService.create>>>;
  assert.equal((await demoService.create("ip-0", "key-0-1234567890123456", "tenant-a")).token, first.value.token);
  assert.equal(sessions.length, 5);
  await demoService.create("ip-0", "key-0-1234567890123456", "tenant-b");
  sessions[0].expiresAt = new Date(0);
  const fresh = await demoService.create("ip-0", "key-0-1234567890123456", "tenant-a");
  assert.notEqual(fresh.token, first.value.token);
  assert.equal(sessions[0].idempotencyHash, null);
  assert.equal(sessions.filter(s => s.hostBusinessId === "tenant-a" && s.expiresAt > new Date()).length, 5);
});

test("owner inbox scope is tenant/session/expiry constrained and never grants mutation permissions", async t => {
  const old = env.DEMO_ENABLED; env.DEMO_ENABLED = true; t.after(() => { env.DEMO_ENABLED = old; });
  const scope: any = ownerDemoReadScope("tenant-a", "BUSINESS_OWNER");
  assert.equal(scope.business.demoSession.hostBusinessId, "tenant-a");
  assert.equal(scope.business.demoSession.status, "ACTIVE");
  assert.ok(scope.business.demoSession.expiresAt.gt instanceof Date);
  assert.deepEqual(ownerDemoReadScope("tenant-a", "STAFF"), { id: { in: [] } });
  assert.deepEqual(ownerDemoReadScope("tenant-a", "MANAGER"), { id: { in: [] } });
  assert.equal(demoReadPermissions.canReply, false); assert.equal(demoReadPermissions.canToggleAI, false);
  mockMethod(t, prisma.conversation, "findFirst", async ({ where }: any) => {
    if (where.AND) { assert.equal(where.AND[1].business.demoSession.hostBusinessId, "tenant-a"); return null; }
    assert.equal(where.businessId, "tenant-a"); return null;
  });
  await assert.rejects(conversationService.detail({ businessId: "tenant-a", role: "BUSINESS_OWNER" } as any, "foreign-conversation", { messageLimit: 50 } as any), { code: "CONVERSATION_NOT_FOUND" });
  await assert.rejects(messageService.createStaffMessage({ businessId: "tenant-a", role: "BUSINESS_OWNER" } as any, "foreign-conversation", { content: "unsafe", senderType: "STAFF", messageType: "TEXT" }, {}), { code: "CONVERSATION_NOT_FOUND" });
  env.DEMO_ENABLED = false; assert.deepEqual(ownerDemoReadScope("tenant-a", "BUSINESS_OWNER"), { id: { in: [] } });
});

test("owner demo list never uses or fills the manager's shared all-conversations cache", async t => {
  const old = env.DEMO_ENABLED; env.DEMO_ENABLED = true; t.after(() => { env.DEMO_ENABLED = old; });
  mockMethod(t, cacheService, "get", async () => ({ data: [{ id: "stale-cached" }] }));
  mockMethod(t, cacheService, "set", async () => { assert.fail("Owner demo data must not enter shared cache"); });
  mockMethod(t, prisma.conversation, "findMany", async ({ where }: any) => {
    assert.equal(where.AND[0].OR[1].business.demoSession.hostBusinessId, "tenant-a");
    return [{ id: "demo", channel: "DEMO" }];
  });
  mockMethod(t, prisma.conversation, "count", async () => 1);
  mockMethod(t, prisma, "$transaction", async queries => Promise.all(queries));
  const result: any = await conversationService.list({ businessId: "tenant-a", role: "BUSINESS_OWNER" } as any, { page: 1, limit: 20, sortBy: "lastMessageAt", sortOrder: "desc" });
  assert.equal(result.data[0].id, "demo"); assert.equal(result.data[0].permissions.canReply, false);
});

test("customer and AI notifications bridge only to owning business owner, never include bearer or message text", async t => {
  const old = env.DEMO_ENABLED; env.DEMO_ENABLED = true; t.after(() => { env.DEMO_ENABLED = old; });
  const actor = { actorType: "DEMO" as const, isDemo: true as const, businessId: "synthetic-a", demoSessionId: "session-a" };
  mockMethod(t, prisma.demoSession, "findFirst", async ({ where }: any) => { assert.equal(where.id, actor.demoSessionId); assert.equal(where.business.id, actor.businessId); return { hostBusinessId: "tenant-a", expiresAt: new Date(Date.now()+60000) }; });
  mockMethod(t, prisma.conversation, "findMany", async () => [{ id: "conversation", businessId: actor.businessId, leadId: "lead", channel: "DEMO" }]);
  mockMethod(t, prisma.lead, "findFirst", async () => ({ id: "lead" }));
  const published: any[] = []; const demo: any[] = [];
  mockMethod(t, realtimeService, "publish", input => { published.push(input); });
  mockMethod(t, realtimeService, "publishDemo", input => { demo.push(input); });
  for (const senderType of ["CUSTOMER", "AI"] as const) await demoRealtimeService.message(actor, "conversation", { id: senderType, senderType, direction: senderType === "AI" ? "OUTBOUND" : "INBOUND", text: "private text", messageType: "TEXT", createdAt: new Date() });
  assert.equal(published.length, 2); assert.equal(demo.length, 4);
  for (const event of published) { assert.equal(event.businessId, "tenant-a"); assert.deepEqual(event.roles, ["BUSINESS_OWNER"]); assert.doesNotMatch(JSON.stringify(event), /private text|token/); }
});

import { demoSetupService } from "../src/services/demo-setup.service";
import express from "express";
import { demoRouter } from "../src/routes/demo.routes";
import { errorHandler } from "../src/middleware/error";
import { AppError } from "../src/utils/errors";
import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../src/config/env";
import { prisma } from "../src/config/prisma";
import { demoService, hashDemoToken } from "../src/services/demo.service";
import { tokenService } from "../src/services/token.service";
import { MetaWhatsAppProvider } from "../src/services/whatsapp-provider.service";
import { authenticate } from "../src/middleware/auth";
import { mockMethod } from "./helpers/mock-method";
const token = `demo_${"a".repeat(64)}`;

function enable(t: import("node:test").TestContext) {
  const old = env.DEMO_ENABLED; env.DEMO_ENABLED = true; t.after(() => { env.DEMO_ENABLED = old; });
}
test("disabled demo refuses creation before persistence", async t => {
  const old = env.DEMO_ENABLED; env.DEMO_ENABLED = false; t.after(() => { env.DEMO_ENABLED = old; });
  await assert.rejects(demoService.create("test"), { code: "DEMO_DISABLED" });
});
test("opaque demo credential is not a production JWT; normal auth still rejects it and missing auth", async () => {
  assert.throws(() => tokenService.verifyAccessToken(token));
  for (const header of [undefined, `Bearer ${token}`]) {
    let error: any;
    await authenticate({ get: () => header } as any, {} as any, e => { error = e; });
    assert.equal(error.statusCode, 401);
  }
});
test("demo auth reads own scope, rejects cross-tenant headers and expired/destroyed sessions", async t => {
  enable(t);
  const session = { id: "session", status: "ACTIVE", expiresAt: new Date(Date.now() + 60000) };
  mockMethod(t, prisma.demoSession, "findUnique", async () => session);
  mockMethod(t, prisma.business, "findUnique", async () => ({ id: "demo-business", name: "Demo Business" }));
  mockMethod(t, prisma.conversation, "findFirst", async (args) => { assert.equal(args.where.businessId, "demo-business"); return { id: "conversation", leadId: "customer" }; });
  mockMethod(t, prisma.lead, "findFirst", async args => { assert.equal(args.where.businessId, "demo-business"); return { id: "customer", fullName: "Demo Customer" }; });
  mockMethod(t, prisma.demoSession, "updateMany", async () => ({ count: 1 }));
  assert.equal((await demoService.authenticate(token)).businessId, "demo-business");
  await assert.rejects(demoService.authenticate(token, "real-business"), { code: "DEMO_RESOURCE_FORBIDDEN" });
  session.expiresAt = new Date(0);
  await assert.rejects(demoService.authenticate(token), { code: "DEMO_SESSION_EXPIRED" });
  session.status = "DESTROYED";
  await assert.rejects(demoService.authenticate(token), { code: "DEMO_SESSION_INVALID" });
});
test("demo provider guard prevents Meta fetch even for direct provider calls", async t => {
  mockMethod(t, prisma.business, "findUnique", async () => ({ demoSessionId: "session" }));
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not call Meta"); });
  await assert.rejects(new MetaWhatsAppProvider("unused").sendTextMessage({ businessId: "demo-business", conversationId: "conversation", phoneNumberId: "unused", to: "demo_customer_session", message: "hello", messageId: "message" }), { code: "DEMO_RESOURCE_FORBIDDEN" });
  assert.equal(fetchMock.mock.callCount(), 0);
});
test("token hashes never persist bearer plaintext", () => { assert.notEqual(hashDemoToken(token), token); assert.equal(hashDemoToken(token).length, 64); });

test("creation reuses a retry and creates only isolated domain records without subscriptions", async t => {
  enable(t);
  let session: any;
  let businesses = 0;
  const tx = {
    $queryRaw: async () => [],
    demoSession: {
      findUnique: async () => session ?? null,
      count: async () => 0,
      update: async ({ data }: any) => { Object.assign(session, data); },
      create: async ({ data }: any) => { session = { id: "session", status: "ACTIVE", ...data }; return session; },
    },
    user: { create: async ({ data }: any) => { assert.equal(data.status, "DISABLED"); assert.equal(data.canCreateBusiness, false); assert.equal(data.demoSessionId, session.id); return { id: "owner" }; } },
    businessAccount: { create: async ({ data }: any) => { assert.equal(data.demoSessionId, session.id); return { id: "account" }; } },
    business: {
      create: async ({ data }: any) => { businesses++; assert.equal(data.demoSessionId, session.id); assert.equal(data.aiRepliesEnabled, false); return { id: "business" }; },
      findUnique: async () => ({ id: "business", name: "Demo Business" }),
    },
    lead: {
      create: async ({ data }: any) => { assert.equal(data.phone, `demo_customer_${session.id}`); assert.equal(data.businessId, "business"); return { id: "customer" }; },
      findFirst: async () => ({ id: "customer", fullName: "Demo Customer" }),
    },
    conversation: {
      create: async ({ data }: any) => { assert.equal(data.channel, "DEMO"); assert.equal(data.businessId, "business"); },
      findFirst: async () => ({ id: "conversation", leadId: "customer" }),
    },
    auditLog: { create: async ({ data }: any) => { assert.equal(data.metadata.isDemo, true); } },
  };
  mockMethod(t, prisma, "$transaction", async callback => callback(tx));
  const a = await demoService.create("ip", "random-retry-key-12345");
  const b = await demoService.create("ip", "random-retry-key-12345");
  assert.equal(businesses, 1); assert.equal(a.token, b.token);
  assert.equal(session.tokenHash, hashDemoToken(a.token));
  assert.equal(a.demo.customer.name, "Demo Customer");
  assert.equal("messages" in a.demo, false);
  for (const status of ["ACTIVE", "EXPIRED", "DESTROYED"]) {
    const oldSession = session;
    oldSession.status = status;
    oldSession.expiresAt = new Date(0);
    const fresh = await demoService.create("ip", "random-retry-key-12345");
    assert.notEqual(fresh.token, a.token);
    assert.notEqual(fresh.demo.sessionId, oldSession.id);
    assert.equal(oldSession.idempotencyHash, null);
    assert.equal(oldSession.status, status);
    assert.equal((await demoService.create("ip", "random-retry-key-12345")).token, fresh.token);
  }
});
test("cleanup refuses a mismatched production parent before deleting anything", async t => {
  let deleted = false;
  mockMethod(t, prisma, "$transaction", async callback => callback({
    demoSession: { updateMany: async () => ({ count: 1 }) },
    business: { findUnique: async () => ({ id: "demo", ownerId: "real-owner", businessAccountId: "real-account" }), delete: async () => { deleted = true; } },
    businessAccount: { findUnique: async () => ({ id: "demo-account", ownerId: "demo-owner" }) },
    user: { findUnique: async () => ({ id: "demo-owner" }) },
  }));
  await assert.rejects(demoService.destroy("session"), /ownership mismatch/);
  assert.equal(deleted, false);
});

test("HTTP demo contract authenticates GET/DELETE and returns creation credential", async t => {
  enable(t);
  const actor = { actorType: "DEMO" as const, isDemo: true as const, demoSessionId: "session", businessId: "business" };
  mockMethod(t, demoService, "create", async () => ({ success: true, token, demo: { sessionId: "session" } }));
  mockMethod(t, demoService, "authenticate", async value => { if (value !== token) throw new AppError(401, "Invalid demo session", "DEMO_SESSION_INVALID"); return actor; });
  mockMethod(t, demoService, "get", async value => { assert.deepEqual(value, actor); return { success: true, demo: { sessionId: "session" } }; });
  mockMethod(t, demoSetupService, "setup", async (value, body) => { assert.deepEqual(value, actor); assert.equal(body.businessName, "Acme"); return { success: true }; });
  const destroy = mockMethod(t, demoService, "destroy", async id => { assert.equal(id, "session"); });
  const app = express(); app.use(express.json()); app.use("/api/demo", demoRouter); app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as import("node:net").AddressInfo;
  const url = `http://127.0.0.1:${address.port}/api/demo/session`;
  const created = await fetch(url, { method: "POST" });
  assert.equal(created.status, 201); assert.equal((await created.json() as any).token, token);
  assert.equal(created.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { method: "DELETE" })).status, 401);
  const headers = { Authorization: `Bearer ${token}` };
  for (let i = 0; i < 125; i++) {
    const restored = await fetch(url, { headers });
    assert.equal(restored.status, 200);
    await restored.arrayBuffer();
  }
  assert.equal((await fetch(url, { method: "DELETE", headers })).status, 200);
  assert.equal(destroy.mock.callCount(), 1);
  assert.equal((await fetch(`${url}/setup`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ businessName: "Acme" }) })).status, 200);
  assert.equal((await fetch(`${url}/setup`, { method: "POST" })).status, 401);
});

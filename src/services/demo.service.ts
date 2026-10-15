import { BUSINESS_DEMO_SESSION_LIMIT, loadBusinessDemoContext } from "./business-demo.service";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { demoContextSummary } from "./demo-context.service";
import { realtimeService } from "./realtime.service";
import { AppError } from "../utils/errors";

export type DemoActor = { actorType: "DEMO"; isDemo: true; demoSessionId: string; businessId: string; hostBusinessId?: string | null };
export const hashDemoToken = (token: string) => createHash("sha256").update(token).digest("hex");
const privateHash = (value: string) => createHmac("sha256", env.JWT_ACCESS_SECRET).update(`demo:${value}`).digest("hex");
export function assertDemoEnabled() {
  if (!env.DEMO_ENABLED) throw new AppError(404, "Demo is unavailable", "DEMO_DISABLED");
}
const invalid = () => new AppError(401, "Invalid demo session", "DEMO_SESSION_INVALID");

async function read(tx: Prisma.TransactionClient, id: string) {
  const session = await tx.demoSession.findUnique({ where: { id } });
  if (!session || session.status !== "ACTIVE") throw invalid();
  if (session.expiresAt <= new Date()) throw new AppError(401, "Demo session expired", "DEMO_SESSION_EXPIRED");
  const business = await tx.business.findUnique({ where: { demoSessionId: id }, select: { id: true, name: true, industry: true, timezone: true, defaultCurrency: true } });
  if (!business) throw invalid();
  const conversation = await tx.conversation.findFirst({ where: { businessId: business.id, channel: "DEMO", deletedAt: null }, select: { id: true, displayId: true, status: true, channel: true, unreadCount: true, leadId: true } });
  if (!conversation) throw invalid();
  const customer = await tx.lead.findFirst({ where: { id: conversation.leadId, businessId: business.id }, select: { id: true, fullName: true } });
  if (!customer) throw invalid();
  return { sessionId: id, setupStatus: session.setupStatus ?? "WAITING_FOR_BUSINESS", ...demoContextSummary(session.demoContext), expiresAt: session.expiresAt, redirectPath: "/conversations", isDemo: true, business, conversation, customer: { id: customer.id, name: customer.fullName }, limits: { conversations: 1, messages: 50, leads: 1, appointments: 0 } };
}

export const demoService = {
  async create(ip: string, key?: string, hostBusinessId?: string) {
    assertDemoEnabled();
    if (key !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new AppError(400, "Use a random 16-128 character Idempotency-Key", "INVALID_IDEMPOTENCY_KEY");
    const ipHash = privateHash(`ip:${ip}`);
    const idempotencyHash = key ? privateHash(hostBusinessId ? `key:${ipHash}:${hostBusinessId}:${key}` : `key:${ipHash}:${key}`) : null;
    // Include the new session ID so a stale key never reissues an old credential.
    const id = randomUUID();
    const token = `demo_${idempotencyHash ? privateHash(`credential:${idempotencyHash}:${id}`) : randomBytes(32).toString("hex")}`;
    return prisma.$transaction(async tx => {
      // Cross-process admission lock: per host business, or per IP for legacy standalone demos.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${hostBusinessId ? `business-demo:${hostBusinessId}` : ipHash}, 0))::text`;
      if (idempotencyHash) {
        const existing = await tx.demoSession.findUnique({ where: { idempotencyHash } });
        if (existing?.status === "ACTIVE" && existing.expiresAt > new Date()) {
          let retryToken = `demo_${privateHash(`credential:${idempotencyHash}:${existing.id}`)}`;
          // Preserve retries for sessions issued before session-specific derivation.
          if (hashDemoToken(retryToken) !== existing.tokenHash) retryToken = `demo_${privateHash(`credential:${idempotencyHash}`)}`;
          if (hashDemoToken(retryToken) !== existing.tokenHash) throw invalid();
          return { success: true, demo: await read(tx, existing.id), token: retryToken };
        }
        if (existing) {
          await tx.demoSession.update({ where: { id: existing.id }, data: { idempotencyHash: null } });
        }
      }
      const now = new Date();
      const count = await tx.demoSession.count({ where: { ...(hostBusinessId ? { hostBusinessId } : { ipHash }), status: "ACTIVE", expiresAt: { gt: now } } });
      if (count >= (hostBusinessId ? BUSINESS_DEMO_SESSION_LIMIT : env.DEMO_MAX_ACTIVE_SESSIONS_PER_IP)) throw new AppError(429, "Too many active demo sessions", "DEMO_LIMIT_REACHED");
      const source = hostBusinessId ? await loadBusinessDemoContext(tx, hostBusinessId) : null;
      const session = await tx.demoSession.create({ data: { ...(source ? { hostBusinessId, demoContext: source.context, setupStatus: "READY" as const, setupCompletedAt: now } : {}), id, tokenHash: hashDemoToken(token), ipHash, idempotencyHash, expiresAt: new Date(now.getTime() + env.DEMO_SESSION_TTL_MINUTES * 60_000) } });
      const owner = await tx.user.create({ data: { demoSessionId: session.id, firstName: "Demo", lastName: "System", email: `${randomUUID()}@demo.invalid`, passwordHash: "!disabled-demo-identity", status: "DISABLED", canCreateBusiness: false, accountType: "STAFF_ONLY" } });
      const account = await tx.businessAccount.create({ data: { demoSessionId: session.id, name: "Demo Workspace", ownerId: owner.id } });
      // Satisfy Business_contact_required without inventing a real business contact.
      // This internal placeholder is excluded from demo responses and DemoContext.
      const business = await tx.business.create({ data: { demoSessionId: session.id, email: `business-${session.id}@demo.invalid`, name: source?.business.name ?? "Demo Business", industry: source?.business.industry ?? "Unspecified", timezone: source?.business.timezone, defaultCurrency: source?.business.defaultCurrency, slug: `demo-${session.id}`, ownerId: owner.id, businessAccountId: account.id, aiRepliesEnabled: false, aiAutoReplyEnabled: false } });
      // Lead is the existing contact model; no generated sales lead or quota writes.
      const customer = await tx.lead.create({ data: { businessId: business.id, fullName: hostBusinessId ? `Demo Customer ${session.id.slice(0, 6)}` : "Demo Customer", phone: `demo_customer_${session.id}`, source: "OTHER", whatsAppOptedOut: true } });
      await tx.conversation.create({ data: { businessId: business.id, leadId: customer.id, channel: "DEMO", aiEnabled: false } });
      await tx.auditLog.create({ data: { action: "BUSINESS_CREATED", businessId: business.id, metadata: { isDemo: true, demoSessionId: session.id } } });
      return { success: true, demo: await read(tx, session.id), token };
    }, { timeout: 15_000 });
  },
  async authenticate(token: string, requestedBusinessId?: string): Promise<DemoActor> {
    assertDemoEnabled();
    if (!/^demo_[a-f0-9]{64}$/.test(token)) throw invalid();
    const session = await prisma.demoSession.findUnique({ where: { tokenHash: hashDemoToken(token) } });
    if (!session) throw invalid();
    const demo = await read(prisma, session.id);
    if (requestedBusinessId && requestedBusinessId !== demo.business.id) throw new AppError(403, "Demo resource forbidden", "DEMO_RESOURCE_FORBIDDEN");
    const touched = await prisma.demoSession.updateMany({ where: { id: session.id, status: "ACTIVE", expiresAt: { gt: new Date() } }, data: { lastActivityAt: new Date() } });
    if (!touched.count) throw invalid();
    return { actorType: "DEMO", isDemo: true, demoSessionId: session.id, businessId: demo.business.id, ...(session.hostBusinessId ? { hostBusinessId: session.hostBusinessId } : {}) };
  },
  async get(actor: DemoActor) {
    const demo = await read(prisma, actor.demoSessionId);
    if (demo.business.id !== actor.businessId) throw invalid();
    return { success: true, demo };
  },
  async destroy(id: string, expiredOnly = false) {
    await prisma.$transaction(async tx => {
      const claimed = await tx.demoSession.updateMany({ where: { id, status: { in: ["ACTIVE", "EXPIRED"] }, ...(expiredOnly ? { expiresAt: { lte: new Date() } } : {}) }, data: { status: "EXPIRED" } });
      if (!claimed.count) return;
      const business = await tx.business.findUnique({ where: { demoSessionId: id } });
      const account = await tx.businessAccount.findUnique({ where: { demoSessionId: id } });
      const owner = await tx.user.findUnique({ where: { demoSessionId: id } });
      if (!business || !account || !owner || business.businessAccountId !== account.id || business.ownerId !== owner.id || account.ownerId !== owner.id) throw new Error("Demo cleanup ownership mismatch");
      // Refuse account/owner cascades if unexpected records were attached.
      if (await tx.business.count({ where: { businessAccountId: account.id } }) !== 1 || await tx.business.count({ where: { ownerId: owner.id } }) !== 1 || await tx.businessAccount.count({ where: { ownerId: owner.id } }) !== 1) throw new Error("Demo cleanup ownership mismatch");
      await tx.business.delete({ where: { id: business.id, demoSessionId: id } });
      await tx.businessAccount.delete({ where: { id: account.id, demoSessionId: id } });
      await tx.user.delete({ where: { id: owner.id, demoSessionId: id } });
      await tx.demoSession.update({ where: { id }, data: { status: "DESTROYED", destroyedAt: new Date(), demoContext: Prisma.DbNull, setupAttemptId: null, setupStartedAt: null, setupCompletedAt: null, setupStatus: "WAITING_FOR_BUSINESS" } });
    }, { timeout: 30_000 });
    realtimeService.disconnectDemo(id);
  },
  async cleanup() {
    const sessions = await prisma.demoSession.findMany({ where: { status: { in: ["ACTIVE", "EXPIRED"] }, expiresAt: { lte: new Date() } }, select: { id: true }, take: 100, orderBy: { expiresAt: "asc" } });
    for (const session of sessions) {
      try { await this.destroy(session.id, true); }
      catch { console.error("Demo cleanup failed", { isDemo: true, demoSessionId: session.id }); }
    }
    // Retain credential/dedupe tombstones for one day, then remove personal IP hashes too.
    await prisma.demoSession.deleteMany({ where: { status: "DESTROYED", destroyedAt: { lt: new Date(Date.now() - 86_400_000) } } });
  },
};

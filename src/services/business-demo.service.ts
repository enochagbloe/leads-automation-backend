import { createHmac, timingSafeEqual } from "node:crypto";
import { BusinessRole, Prisma } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { demoContextSchema } from "./demo-context.service";
import { emptyDemoFacts } from "./demo-extraction.service";

export const BUSINESS_DEMO_SESSION_LIMIT = 5;
const sign = (value: string) => createHmac("sha256", env.JWT_ACCESS_SECRET).update(`business-demo-invite:${value}`).digest("hex");
export function createBusinessDemoInvite(businessId: string, now = Date.now()) {
  const expiresAt = now + 24 * 60 * 60 * 1000;
  const value = Buffer.from(JSON.stringify({ businessId, expiresAt })).toString("base64url");
  return { invite: `${value}.${sign(value)}`, expiresAt: new Date(expiresAt), maxSessions: BUSINESS_DEMO_SESSION_LIMIT };
}
export function verifyBusinessDemoInvite(token: unknown, now = Date.now()): string {
  const invalid = () => new AppError(401, "Demo link is invalid or expired. Ask the business for a new link.", "DEMO_INVITE_INVALID");
  if (typeof token !== "string" || token.length > 1024) throw invalid();
  const [value, signature, extra] = token.split(".");
  if (!value || !signature || extra || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(sign(value)), Buffer.from(signature))) throw invalid();
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
    if (typeof parsed.businessId !== "string" || !parsed.businessId || !Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= now) throw invalid();
    return parsed.businessId;
  } catch { throw invalid(); }
}

/** Only customer-facing structured data is copied into the existing isolated demo adapter. */
export async function loadBusinessDemoContext(tx: Prisma.TransactionClient, businessId: string) {
  const business = await tx.business.findFirst({ where: { id: businessId, demoSessionId: null, deletedAt: null } });
  if (!business) throw new AppError(404, "Business demo unavailable", "DEMO_BUSINESS_UNAVAILABLE");
  const [services, hours, policies] = await Promise.all([
    tx.service.findMany({ where: { businessId, isActive: true, isArchived: false }, orderBy: { displayOrder: "asc" }, take: 8 }),
    tx.businessAvailability.findMany({ where: { businessId, isActive: true }, take: 7 }),
    tx.businessPolicy.findMany({ where: { businessId, isActive: true, isArchived: false, visibility: "CUSTOMER_FACING" }, orderBy: { displayOrder: "asc" }, take: 5 }),
  ]);
  const short = (s: string | null | undefined, max = 150) => s?.trim().slice(0, max) || null;
  const facts = emptyDemoFacts();
  facts.industry = short(business.industry); facts.description = short(business.description, 600);
  facts.contacts = { phone: short(business.phone), email: short(business.email), address: short(business.address, 600) };
  facts.services = services.map(s => ({ name: s.name.slice(0,150), description: short(s.description,600), price: short(s.priceDescription) ?? (s.basePrice !== null && s.priceType === "FIXED" ? `${s.currency} ${s.basePrice}` : null), duration: s.durationMinutes ? `${s.durationMinutes} minutes` : null }));
  facts.openingHours = hours.map(h => ({ day: h.dayOfWeek, hours: !h.isOpen ? "Closed" : h.openTime && h.closeTime ? `${h.openTime}–${h.closeTime}${h.breakStartTime && h.breakEndTime ? ` (break ${h.breakStartTime}–${h.breakEndTime})` : ""}` : "Hours not confirmed" }));
  facts.policies = policies.map(p => `${p.title}: ${p.shortSummary ?? p.content}`.slice(0,600));
  const timestamp = new Date().toISOString();
  return { business, context: demoContextSchema.parse({ businessName: business.name.slice(0,120), facts, sourceWebsite: business.website, crawlStatus: "NOT_STARTED", extractionStatus: "COMPLETE", startedAt: timestamp, completedAt: timestamp, pagesAttempted: 0, pagesFetched: 0, errorCode: null, sources: [], bookingLinks: [], contactLinks: [], unknowns: [] }) };
}

/** Read-only bridge. Never use this scope in production mutation authorization. */
export function ownerDemoReadScope(businessId: string, role: BusinessRole): Prisma.ConversationWhereInput {
  return role === BusinessRole.BUSINESS_OWNER && env.DEMO_ENABLED ? {
    channel: "DEMO", deletedAt: null,
    business: { demoSession: { hostBusinessId: businessId, status: "ACTIVE", expiresAt: { gt: new Date() } } },
  } : { id: { in: [] } };
}
export const demoReadPermissions = { canViewMessages: true, canReply: false, canAssign: false, canClaim: false, canClose: false, canToggleAI: false, canUpdateStatus: false };

export async function businessDemoInviteForOwner(businessId: string) {
  const business = await prisma.business.findFirst({ where: { id: businessId, demoSessionId: null, deletedAt: null }, select: { id: true } });
  if (!business) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");
  return createBusinessDemoInvite(businessId);
}

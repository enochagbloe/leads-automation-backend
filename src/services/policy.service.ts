import crypto from "node:crypto";
import {
  AuditAction,
  BusinessPolicyCategory,
  BusinessPolicySource,
  BusinessPolicyVisibility,
  BusinessRole,
  PlanCode,
  Prisma,
  SubscriptionStatus,
} from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import type {
  CreatePolicyInput,
  PolicyListQuery,
  ReorderPoliciesInput,
  UpdatePolicyInput,
} from "../validation/policy.schemas";
import type { AuditInput } from "./audit.service";
import { invalidateBusinessSetupStatus } from "./business-setup.service";
import { invalidateBusinessKnowledgePreview } from "./business-knowledge-cache.service";
import { cacheService } from "./cache.service";
import { realtimeService, RealtimeEventType } from "./realtime.service";

export type PolicyActor = {
  userId: string;
  businessAccountId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

const ACTIVE_SUBSCRIPTIONS = [SubscriptionStatus.TRIALING, SubscriptionStatus.ACTIVE];
const RECOMMENDED_CATEGORIES = [
  BusinessPolicyCategory.PAYMENT,
  BusinessPolicyCategory.CANCELLATION,
  BusinessPolicyCategory.REFUND,
  BusinessPolicyCategory.RESCHEDULING,
  BusinessPolicyCategory.DEPOSIT,
  BusinessPolicyCategory.SERVICE_AREA,
];
const PLAN_LIMITS: Record<PlanCode, number> = { BASIC: 10, PLUS: 30, PREMIUM: 100 };
const LIST_TTL = 60;
const DETAIL_TTL = 120;
const SUMMARY_TTL = 60;
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;
const PUBLIC_SELECT = {
  id: true,
  title: true,
  category: true,
  content: true,
  shortSummary: true,
  visibility: true,
  isActive: true,
  isArchived: true,
  displayOrder: true,
  priority: true,
  source: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
} satisfies Prisma.BusinessPolicySelect;

function requireManager(actor: PolicyActor) {
  if (actor.role !== BusinessRole.BUSINESS_OWNER && actor.role !== BusinessRole.MANAGER) {
    throw new AppError(403, "You do not have permission to manage business policies.", "FORBIDDEN");
  }
}

function staffScope(actor: PolicyActor): Prisma.BusinessPolicyWhereInput {
  return actor.role === BusinessRole.STAFF
    ? { isActive: true, isArchived: false, visibility: BusinessPolicyVisibility.CUSTOMER_FACING }
    : {};
}

function listKey(actor: PolicyActor, query: PolicyListQuery) {
  const hash = crypto.createHash("sha256").update(JSON.stringify({ query, role: actor.role })).digest("hex");
  return `business:${actor.businessId}:policies:list:${hash}`;
}

function detailKey(actor: PolicyActor, policyId: string) {
  return `business:${actor.businessId}:policies:detail:${policyId}:${actor.role}`;
}

function summaryKey(actor: PolicyActor) {
  return `business:${actor.businessId}:policies:summary:${actor.role}`;
}

function json(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function safe<T extends object>(policy: T) {
  const result = { ...policy } as Record<string, unknown>;
  delete result.businessId;
  delete result.createdById;
  delete result.updatedById;
  return result;
}

async function invalidatePolicyCaches(businessId: string, policyId?: string) {
  await Promise.all([
    invalidateBusinessKnowledgePreview(businessId, "POLICIES"),
    cacheService.delByPattern(`business:${businessId}:policies:list:*`),
    cacheService.delByPattern(`business:${businessId}:policies:summary:*`),
    cacheService.delByPattern(`business:${businessId}:policies:detail:${policyId ?? "*"}:*`),
    invalidateBusinessSetupStatus(businessId),
  ]);
}

function publish(
  type: RealtimeEventType,
  actor: PolicyActor,
  policy?: { id: string; category: BusinessPolicyCategory; visibility: BusinessPolicyVisibility; updatedAt: Date },
  changedFields: string[] = [],
) {
  realtimeService.publish({
    type,
    businessId: actor.businessId,
    broadcastToStaff: !policy || policy.visibility === BusinessPolicyVisibility.CUSTOMER_FACING,
    payload: {
      businessId: actor.businessId,
      ...(policy ? { policyId: policy.id, category: policy.category, changedFields, updatedAt: policy.updatedAt.toISOString() } : {}),
    },
  });
}

async function assertBusinessAndLimit(tx: Prisma.TransactionClient, actor: PolicyActor, activeDelta: 0 | 1) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "BusinessAccount"
    WHERE "id" = ${actor.businessAccountId}
    FOR UPDATE
  `);
  const [business, subscription] = await Promise.all([
    tx.business.findFirst({ where: { id: actor.businessId, businessAccountId: actor.businessAccountId, deletedAt: null }, select: { id: true } }),
    tx.subscription.findFirst({
      where: { businessAccountId: actor.businessAccountId, status: { in: ACTIVE_SUBSCRIPTIONS } },
      orderBy: { createdAt: "desc" },
      include: { plan: true },
    }),
  ]);
  if (!business) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");
  if (!subscription) throw new AppError(403, "No active subscription", "SUBSCRIPTION_REQUIRED");
  if (activeDelta === 1) {
    const limit = PLAN_LIMITS[subscription.plan.code];
    const current = await tx.businessPolicy.count({
      where: {
        business: { businessAccountId: actor.businessAccountId, deletedAt: null },
        isActive: true,
        isArchived: false,
      },
    });
    if (current >= limit) {
      throw new AppError(403, `Your current plan allows up to ${limit} active policies. Upgrade to add more active policies.`, "POLICY_LIMIT_REACHED", {
        currentPlan: subscription.plan.code,
        recommendedPlan: subscription.plan.code === PlanCode.BASIC ? PlanCode.PLUS : subscription.plan.code === PlanCode.PLUS ? PlanCode.PREMIUM : null,
        limit,
        current,
      });
    }
  }
}

async function lockPolicy(tx: Prisma.TransactionClient, actor: PolicyActor, policyId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "BusinessPolicy"
    WHERE "id" = ${policyId} AND "businessId" = ${actor.businessId}
    FOR UPDATE
  `);
}

async function loadSummary(actor: PolicyActor) {
  const policies = await prisma.businessPolicy.findMany({
    where: { businessId: actor.businessId, ...staffScope(actor) },
    select: { category: true, visibility: true, isActive: true, isArchived: true },
  });
  const configured = [...new Set(policies
    .filter((policy) => policy.isActive && !policy.isArchived && policy.visibility === BusinessPolicyVisibility.CUSTOMER_FACING)
    .map((policy) => policy.category))];
  return {
    total: policies.length,
    active: policies.filter((policy) => policy.isActive && !policy.isArchived).length,
    inactive: policies.filter((policy) => !policy.isActive && !policy.isArchived).length,
    archived: policies.filter((policy) => policy.isArchived).length,
    customerFacing: policies.filter((policy) => policy.isActive && !policy.isArchived && policy.visibility === BusinessPolicyVisibility.CUSTOMER_FACING).length,
    internalOnly: policies.filter((policy) => policy.isActive && !policy.isArchived && policy.visibility === BusinessPolicyVisibility.INTERNAL_ONLY).length,
    categoriesConfigured: configured,
    missingRecommendedCategories: RECOMMENDED_CATEGORIES.filter((category) => !configured.includes(category)),
  };
}

export const policyService = {
  async list(actor: PolicyActor, query: PolicyListQuery) {
    const key = listKey(actor, query);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const statusWhere: Prisma.BusinessPolicyWhereInput = query.status === "active"
      ? { isActive: true, isArchived: false }
      : query.status === "inactive"
        ? { isActive: false, isArchived: false }
        : query.status === "archived"
          ? { isArchived: true }
          : {};
    const where: Prisma.BusinessPolicyWhereInput = {
      businessId: actor.businessId,
      ...statusWhere,
      ...(query.category ? { category: query.category } : {}),
      ...(query.visibility ? { visibility: query.visibility } : {}),
      ...(query.search ? { OR: [
        { title: { contains: query.search, mode: "insensitive" } },
        { content: { contains: query.search, mode: "insensitive" } },
        { shortSummary: { contains: query.search, mode: "insensitive" } },
      ] } : {}),
      ...staffScope(actor),
    };
    const [items, total, summary] = await Promise.all([
      prisma.businessPolicy.findMany({
        where,
        select: PUBLIC_SELECT,
        orderBy: [{ [query.sort]: query.sortOrder }, { id: "asc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.businessPolicy.count({ where }),
      loadSummary(actor),
    ]);
    const response = { items, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) }, summary };
    await cacheService.set(key, response, LIST_TTL);
    return response;
  },

  async summary(actor: PolicyActor) {
    const key = summaryKey(actor);
    const cached = await cacheService.get<Awaited<ReturnType<typeof loadSummary>>>(key);
    if (cached) return cached;
    const response = await loadSummary(actor);
    await cacheService.set(key, response, SUMMARY_TTL);
    return response;
  },

  async detail(actor: PolicyActor, policyId: string) {
    const key = detailKey(actor, policyId);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const policy = await prisma.businessPolicy.findFirst({
      where: { id: policyId, businessId: actor.businessId, ...staffScope(actor) },
      select: PUBLIC_SELECT,
    });
    if (!policy) throw new AppError(404, "Policy not found", "POLICY_NOT_FOUND");
    await cacheService.set(key, policy, DETAIL_TTL);
    return policy;
  },

  async create(actor: PolicyActor, input: CreatePolicyInput, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    const policy = await prisma.$transaction(async (tx) => {
      await assertBusinessAndLimit(tx, actor, input.isActive !== false ? 1 : 0);
      const created = await tx.businessPolicy.create({
        data: {
          businessId: actor.businessId,
          title: input.title,
          category: input.category,
          content: input.content,
          shortSummary: input.shortSummary,
          visibility: input.visibility ?? BusinessPolicyVisibility.CUSTOMER_FACING,
          isActive: input.isActive ?? true,
          priority: input.priority ?? 0,
          displayOrder: ((await tx.businessPolicy.aggregate({ where: { businessId: actor.businessId }, _max: { displayOrder: true } }))._max.displayOrder ?? 0) + 1,
          source: BusinessPolicySource.MANUAL,
          createdById: actor.userId,
          updatedById: actor.userId,
        },
      });
      await tx.auditLog.create({ data: { ...context, action: AuditAction.BUSINESS_POLICY_CREATED, businessId: actor.businessId, userId: actor.userId, metadata: json({ businessId: actor.businessId, policyId: created.id, actorUserId: actor.userId, actorMembershipId: actor.membershipId, category: created.category }) } });
      return created;
    }, TRANSACTION_OPTIONS);
    await invalidatePolicyCaches(actor.businessId, policy.id);
    publish("business.policy.created", actor, policy, Object.keys(input));
    publish("business.policies.summary.updated", actor);
    return safe(policy);
  },

  async update(actor: PolicyActor, policyId: string, input: UpdatePolicyInput, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    const result = await prisma.$transaction(async (tx) => {
      await lockPolicy(tx, actor, policyId);
      const existing = await tx.businessPolicy.findFirst({ where: { id: policyId, businessId: actor.businessId, isArchived: false } });
      if (!existing) throw new AppError(404, "Policy not found", "POLICY_NOT_FOUND");
      const activates = input.isActive === true && !existing.isActive;
      await assertBusinessAndLimit(tx, actor, activates ? 1 : 0);
      const changedFields = Object.keys(input).filter((field) => existing[field as keyof typeof existing] !== input[field as keyof UpdatePolicyInput]);
      if (changedFields.length === 0) return { policy: existing, changedFields };
      const updated = await tx.businessPolicy.update({ where: { id: policyId }, data: { ...input, updatedById: actor.userId } });
      await tx.auditLog.create({
        data: {
          ...context,
          action: AuditAction.BUSINESS_POLICY_UPDATED,
          businessId: actor.businessId,
          userId: actor.userId,
          metadata: json({
            businessId: actor.businessId,
            policyId,
            actorUserId: actor.userId,
            actorMembershipId: actor.membershipId,
            changedFields,
            previousValues: Object.fromEntries(changedFields.map((field) => [field, existing[field as keyof typeof existing]])),
            newValues: Object.fromEntries(changedFields.map((field) => [field, updated[field as keyof typeof updated]])),
          }),
        },
      });
      return { policy: updated, changedFields };
    }, TRANSACTION_OPTIONS);
    if (result.changedFields.length === 0) return safe(result.policy);
    await invalidatePolicyCaches(actor.businessId, policyId);
    publish("business.policy.updated", actor, result.policy, result.changedFields);
    publish("business.policies.summary.updated", actor);
    return safe(result.policy);
  },

  async archive(actor: PolicyActor, policyId: string, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    const result = await prisma.$transaction(async (tx) => {
      await lockPolicy(tx, actor, policyId);
      const existing = await tx.businessPolicy.findFirst({ where: { id: policyId, businessId: actor.businessId } });
      if (!existing) throw new AppError(404, "Policy not found", "POLICY_NOT_FOUND");
      if (existing.isArchived) return { policy: existing, changed: false };
      const policy = await tx.businessPolicy.update({ where: { id: policyId }, data: { isArchived: true, isActive: false, archivedAt: new Date(), updatedById: actor.userId } });
      await tx.auditLog.create({ data: { ...context, action: AuditAction.BUSINESS_POLICY_ARCHIVED, businessId: actor.businessId, userId: actor.userId, metadata: json({ businessId: actor.businessId, policyId, actorUserId: actor.userId, actorMembershipId: actor.membershipId }) } });
      return { policy, changed: true };
    }, TRANSACTION_OPTIONS);
    if (!result.changed) return safe(result.policy);
    await invalidatePolicyCaches(actor.businessId, policyId);
    publish("business.policy.archived", actor, result.policy);
    publish("business.policies.summary.updated", actor);
    return safe(result.policy);
  },

  async restore(actor: PolicyActor, policyId: string, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    const result = await prisma.$transaction(async (tx) => {
      await lockPolicy(tx, actor, policyId);
      const existing = await tx.businessPolicy.findFirst({ where: { id: policyId, businessId: actor.businessId } });
      if (!existing) throw new AppError(404, "Policy not found", "POLICY_NOT_FOUND");
      if (!existing.isArchived) return { policy: existing, changed: false };
      await assertBusinessAndLimit(tx, actor, 1);
      const policy = await tx.businessPolicy.update({ where: { id: policyId }, data: { isArchived: false, isActive: true, archivedAt: null, updatedById: actor.userId } });
      await tx.auditLog.create({ data: { ...context, action: AuditAction.BUSINESS_POLICY_RESTORED, businessId: actor.businessId, userId: actor.userId, metadata: json({ businessId: actor.businessId, policyId, actorUserId: actor.userId, actorMembershipId: actor.membershipId }) } });
      return { policy, changed: true };
    }, TRANSACTION_OPTIONS);
    if (!result.changed) return safe(result.policy);
    await invalidatePolicyCaches(actor.businessId, policyId);
    publish("business.policy.restored", actor, result.policy);
    publish("business.policies.summary.updated", actor);
    return safe(result.policy);
  },

  async reorder(actor: PolicyActor, input: ReorderPoliciesInput, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    await prisma.$transaction(async (tx) => {
      const count = await tx.businessPolicy.count({ where: { businessId: actor.businessId, isArchived: false, id: { in: input.items.map((item) => item.id) } } });
      if (count !== input.items.length) throw new AppError(404, "One or more policies were not found", "POLICY_NOT_FOUND");
      await Promise.all(input.items.map((item) => tx.businessPolicy.update({ where: { id: item.id }, data: { displayOrder: item.displayOrder, updatedById: actor.userId } })));
      await tx.auditLog.create({ data: { ...context, action: AuditAction.BUSINESS_POLICY_REORDERED, businessId: actor.businessId, userId: actor.userId, metadata: json({ businessId: actor.businessId, actorUserId: actor.userId, actorMembershipId: actor.membershipId, items: input.items }) } });
    }, TRANSACTION_OPTIONS);
    await invalidatePolicyCaches(actor.businessId);
    publish("business.policy.reordered", actor);
    publish("business.policies.summary.updated", actor);
    return { message: "Policies reordered successfully" };
  },
};

export async function getBusinessPoliciesForAiContext(businessId: string) {
  const policies = await prisma.businessPolicy.findMany({
    where: { businessId, isActive: true, isArchived: false, visibility: BusinessPolicyVisibility.CUSTOMER_FACING },
    orderBy: [{ priority: "desc" }, { displayOrder: "asc" }],
    select: { id: true, title: true, category: true, content: true, shortSummary: true, priority: true },
  });
  const configured = [...new Set(policies.map((policy) => policy.category))];
  return { businessId, policies, gaps: { missingRecommendedCategories: RECOMMENDED_CATEGORIES.filter((category) => !configured.includes(category)) } };
}

export async function getBusinessPolicySummaryForAiContext(businessId: string) {
  const context = await getBusinessPoliciesForAiContext(businessId);
  return { businessId, activeCustomerFacingPolicies: context.policies.length, ...context.gaps };
}

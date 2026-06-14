import crypto from "node:crypto";
import {
  AuditAction,
  BusinessRole,
  PlanCode,
  Prisma,
  ServicePriceType,
  ServiceReadinessStatus,
  ServiceSource,
  SubscriptionStatus,
} from "@prisma/client";
import slugify from "slugify";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import type { AuditInput } from "./audit.service";
import { invalidateBusinessSetupStatus } from "./business-setup.service";
import { cacheService } from "./cache.service";
import { realtimeService, RealtimeEventType } from "./realtime.service";
import {
  CreateServiceInput,
  ReorderServicesInput,
  ServiceListQuery,
  UpdateServiceInput,
} from "../validation/service.schemas";

export type ServiceActor = {
  userId: string;
  businessAccountId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

type ReadinessInput = {
  name: string;
  category?: string | null;
  description?: string | null;
  basePrice?: Prisma.Decimal | string | number | null;
  currency: string;
  priceType: ServicePriceType;
  priceDescription?: string | null;
  durationMinutes?: number | null;
  requiresPayment: boolean;
  paymentRequiredBeforeBooking: boolean;
  isBookable: boolean;
  isArchived: boolean;
};

const ACTIVE_SUBSCRIPTION_STATUSES = [SubscriptionStatus.TRIALING, SubscriptionStatus.ACTIVE];
const LIST_TTL = 60;
const DETAIL_TTL = 120;
const SUMMARY_TTL = 60;
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;
const PUBLIC_SERVICE_SELECT = {
  id: true,
  name: true,
  slug: true,
  category: true,
  description: true,
  basePrice: true,
  currency: true,
  priceType: true,
  priceDescription: true,
  durationMinutes: true,
  bufferMinutes: true,
  requiresPayment: true,
  paymentRequiredBeforeBooking: true,
  isBookable: true,
  isActive: true,
  isArchived: true,
  readinessStatus: true,
  missingFields: true,
  displayOrder: true,
  source: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
} satisfies Prisma.ServiceSelect;

function requireManager(actor: ServiceActor) {
  if (actor.role !== BusinessRole.BUSINESS_OWNER && actor.role !== BusinessRole.MANAGER) {
    throw new AppError(403, "You do not have permission to manage services.", "FORBIDDEN");
  }
}

function present(value?: string | null) {
  return Boolean(value?.trim());
}

function validCurrency(value: string) {
  return /^[A-Z]{3}$/.test(value) && Intl.supportedValuesOf("currency").includes(value);
}

function priceReady(input: ReadinessInput) {
  if (input.priceType === ServicePriceType.FREE) return true;
  if (input.priceType === ServicePriceType.FIXED || input.priceType === ServicePriceType.STARTING_FROM) return input.basePrice !== null && input.basePrice !== undefined;
  if (input.priceType === ServicePriceType.RANGE) return input.basePrice !== null && input.basePrice !== undefined || present(input.priceDescription);
  if (input.priceType === ServicePriceType.QUOTE_ONLY) return present(input.priceDescription);
  return false;
}

export function calculateServiceReadiness(input: ReadinessInput) {
  if (input.isArchived) return { readinessStatus: ServiceReadinessStatus.ARCHIVED, missingFields: [] as string[] };
  const missingFields: string[] = [];
  if (!present(input.description)) missingFields.push("description");
  if (!priceReady(input)) missingFields.push("price");
  if (!present(input.currency)) missingFields.push("currency");
  if (!input.durationMinutes) missingFields.push("durationMinutes");
  if (input.paymentRequiredBeforeBooking && !input.requiresPayment) missingFields.push("paymentRequirement");

  const meaningfulData = present(input.category)
    || present(input.description)
    || input.basePrice !== null && input.basePrice !== undefined
    || input.priceType !== ServicePriceType.NOT_SET
    || present(input.priceDescription)
    || Boolean(input.durationMinutes)
    || input.isBookable
    || input.requiresPayment;
  if (!meaningfulData) return { readinessStatus: ServiceReadinessStatus.DRAFT, missingFields };

  const readyForAi = present(input.description)
    && input.priceType !== ServicePriceType.NOT_SET
    && present(input.currency)
    && priceReady(input);
  const readyForBooking = readyForAi
    && Boolean(input.durationMinutes)
    && input.isBookable
    && (!input.paymentRequiredBeforeBooking || input.requiresPayment);
  return {
    readinessStatus: readyForBooking
      ? ServiceReadinessStatus.READY_FOR_BOOKING
      : readyForAi
        ? ServiceReadinessStatus.READY_FOR_AI
        : ServiceReadinessStatus.INCOMPLETE,
    missingFields,
  };
}

function serviceSlug(name: string) {
  const base = slugify(name, { lower: true, strict: true }) || "service";
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

function safeService<T extends object>(service: T): Omit<T, "businessId" | "createdById" | "updatedById"> {
  const safe = { ...service } as Record<string, unknown>;
  delete safe.businessId;
  delete safe.createdById;
  delete safe.updatedById;
  return safe as Omit<T, "businessId" | "createdById" | "updatedById">;
}

function listKey(actor: ServiceActor, query: ServiceListQuery) {
  return `business:${actor.businessId}:services:list:${crypto.createHash("sha256").update(JSON.stringify({ query, role: actor.role })).digest("hex")}`;
}

function detailKey(businessId: string, serviceId: string, role: BusinessRole) {
  return `business:${businessId}:services:detail:${serviceId}:${role}`;
}

function summaryKey(businessId: string, role: BusinessRole) {
  return `business:${businessId}:services:summary:${role}`;
}

async function invalidateServiceCaches(businessId: string, serviceId?: string) {
  await Promise.all([
    cacheService.del(`business:${businessId}:knowledge-preview`),
    cacheService.delByPattern(`business:${businessId}:services:list:*`),
    cacheService.delByPattern(`business:${businessId}:services:summary:*`),
    ...(serviceId ? [cacheService.delByPattern(`business:${businessId}:services:detail:${serviceId}:*`)] : []),
    invalidateBusinessSetupStatus(businessId),
  ]);
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function serviceLimitError(plan: { name: string; code: PlanCode; maxServices: number | null }, current: number) {
  const message = `Your current plan allows up to ${plan.maxServices} active services. Upgrade to add more active services.`;
  const recommendedPlan = plan.code === PlanCode.BASIC ? PlanCode.PLUS : plan.code === PlanCode.PLUS ? PlanCode.PREMIUM : null;
  return new AppError(403, message, "SERVICE_LIMIT_REACHED", {
    currentPlan: plan.code,
    recommendedPlan,
    limit: plan.maxServices,
    current,
  });
}

async function mutationContext(tx: Prisma.TransactionClient, actor: ServiceActor, activeDelta: -1 | 0 | 1) {
  const [business, subscription] = await Promise.all([
    tx.business.findFirst({ where: { id: actor.businessId, businessAccountId: actor.businessAccountId, deletedAt: null } }),
    tx.subscription.findFirst({
      where: { businessAccountId: actor.businessAccountId, status: { in: ACTIVE_SUBSCRIPTION_STATUSES } },
      orderBy: { createdAt: "desc" },
      include: { plan: true, usageRecords: { orderBy: { periodStart: "desc" }, take: 1 } },
    }),
  ]);
  if (!business) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");
  if (!subscription) throw new AppError(403, "No active subscription", "SUBSCRIPTION_REQUIRED");
  const usage = subscription.usageRecords[0];
  if (!usage) throw new AppError(500, "Current account usage record is unavailable");
  if (activeDelta === 1) {
    const increment = await tx.accountUsageRecord.updateMany({
      where: {
        id: usage.id,
        ...(subscription.plan.maxServices !== null ? { servicesCount: { lt: subscription.plan.maxServices } } : {}),
      },
      data: { servicesCount: { increment: 1 } },
    });
    if (increment.count !== 1) {
      const current = await tx.accountUsageRecord.findUniqueOrThrow({ where: { id: usage.id } });
      throw serviceLimitError(subscription.plan, current.servicesCount);
    }
  } else if (activeDelta === -1) {
    await tx.accountUsageRecord.updateMany({
      where: { id: usage.id, servicesCount: { gt: 0 } },
      data: { servicesCount: { decrement: 1 } },
    });
  }
  return { business, subscription };
}

async function lockService(tx: Prisma.TransactionClient, actor: ServiceActor, serviceId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "Service"
    WHERE "id" = ${serviceId} AND "businessId" = ${actor.businessId}
    FOR UPDATE
  `);
}

function publish(type: RealtimeEventType, actor: ServiceActor, service?: { id: string; readinessStatus: ServiceReadinessStatus; missingFields: string[]; updatedAt: Date }, changedFields: string[] = []) {
  realtimeService.publish({
    type,
    businessId: actor.businessId,
    broadcastToStaff: true,
    payload: {
      businessId: actor.businessId,
      ...(service ? {
        serviceId: service.id,
        changedFields,
        readinessStatus: service.readinessStatus,
        missingFields: service.missingFields,
        updatedAt: service.updatedAt.toISOString(),
      } : {}),
    },
  });
}

function summaryWhere(actor: ServiceActor): Prisma.ServiceWhereInput {
  return {
    businessId: actor.businessId,
    ...(actor.role === BusinessRole.STAFF ? { isActive: true, isArchived: false } : {}),
  };
}

async function loadSummary(actor: ServiceActor) {
  const services = await prisma.service.findMany({
    where: summaryWhere(actor),
    select: { isActive: true, isArchived: true, readinessStatus: true, missingFields: true, isBookable: true },
  });
  const current = services.filter((service) => !service.isArchived);
  return {
    total: current.length,
    active: current.filter((service) => service.isActive).length,
    inactive: current.filter((service) => !service.isActive).length,
    archived: services.filter((service) => service.isArchived).length,
    draft: current.filter((service) => service.readinessStatus === ServiceReadinessStatus.DRAFT).length,
    incomplete: current.filter((service) => service.readinessStatus === ServiceReadinessStatus.INCOMPLETE).length,
    readyForAi: current.filter((service) => service.readinessStatus === ServiceReadinessStatus.READY_FOR_AI || service.readinessStatus === ServiceReadinessStatus.READY_FOR_BOOKING).length,
    readyForBooking: current.filter((service) => service.readinessStatus === ServiceReadinessStatus.READY_FOR_BOOKING).length,
    missingPrices: current.filter((service) => service.missingFields.includes("price")).length,
    missingDurations: current.filter((service) => service.missingFields.includes("durationMinutes")).length,
    bookable: current.filter((service) => service.isBookable).length,
  };
}

export const serviceService = {
  async list(actor: ServiceActor, query: ServiceListQuery) {
    const key = listKey(actor, query);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const statusWhere: Prisma.ServiceWhereInput = actor.role === BusinessRole.STAFF || query.status === "active"
      ? { isActive: true, isArchived: false }
      : query.status === "inactive"
        ? { isActive: false, isArchived: false }
        : query.status === "archived"
          ? { isArchived: true }
          : {};
    const where: Prisma.ServiceWhereInput = {
      businessId: actor.businessId,
      ...statusWhere,
      ...(query.readinessStatus ? { readinessStatus: query.readinessStatus } : {}),
      ...(query.category ? { category: { equals: query.category, mode: "insensitive" } } : {}),
      ...(query.search ? {
        OR: [
          { name: { contains: query.search, mode: "insensitive" } },
          { category: { contains: query.search, mode: "insensitive" } },
          { description: { contains: query.search, mode: "insensitive" } },
        ],
      } : {}),
    };
    const [items, total, summary] = await Promise.all([
      prisma.service.findMany({
        where,
        select: PUBLIC_SERVICE_SELECT,
        orderBy: [{ [query.sort]: query.sortOrder }, { id: "asc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.service.count({ where }),
      loadSummary(actor),
    ]);
    const result = { items, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) }, summary };
    await cacheService.set(key, result, LIST_TTL);
    return result;
  },

  async summary(actor: ServiceActor) {
    const key = summaryKey(actor.businessId, actor.role);
    const cached = await cacheService.get<Awaited<ReturnType<typeof loadSummary>>>(key);
    if (cached) return cached;
    const result = await loadSummary(actor);
    await cacheService.set(key, result, SUMMARY_TTL);
    return result;
  },

  async detail(actor: ServiceActor, serviceId: string) {
    const key = detailKey(actor.businessId, serviceId, actor.role);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const service = await prisma.service.findFirst({
      where: {
        id: serviceId,
        businessId: actor.businessId,
        ...(actor.role === BusinessRole.STAFF ? { isActive: true, isArchived: false } : {}),
      },
      select: PUBLIC_SERVICE_SELECT,
    });
    if (!service) throw new AppError(404, "Service not found", "SERVICE_NOT_FOUND");
    await cacheService.set(key, service, DETAIL_TTL);
    return safeService(service);
  },

  async create(actor: ServiceActor, input: CreateServiceInput, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    if (input.currency && !validCurrency(input.currency)) throw new AppError(422, "Invalid currency code.", "INVALID_CURRENCY");
    if (input.paymentRequiredBeforeBooking && !input.requiresPayment) {
      throw new AppError(422, "Payment required before booking requires requiresPayment to be true", "VALIDATION_ERROR");
    }
    const service = await prisma.$transaction(async (tx) => {
      const duplicate = await tx.service.findFirst({
        where: {
          businessId: actor.businessId,
          name: { equals: input.name, mode: "insensitive" },
          isArchived: false,
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new AppError(409, "A non-archived service with this name already exists for this business.", "SERVICE_NAME_ALREADY_EXISTS");
      }
      const { business } = await mutationContext(tx, actor, input.isActive !== false ? 1 : 0);
      const priceType = input.priceType ?? ServicePriceType.NOT_SET;
      const readiness = calculateServiceReadiness({
        ...input,
        currency: input.currency ?? business.defaultCurrency,
        priceType,
        requiresPayment: input.requiresPayment ?? false,
        paymentRequiredBeforeBooking: input.paymentRequiredBeforeBooking ?? false,
        isBookable: input.isBookable ?? false,
        isArchived: false,
      });
      const created = await tx.service.create({
        data: {
          businessId: actor.businessId,
          name: input.name,
          slug: serviceSlug(input.name),
          category: input.category,
          description: input.description,
          basePrice: input.basePrice,
          currency: input.currency ?? business.defaultCurrency,
          priceType,
          priceDescription: input.priceDescription,
          durationMinutes: input.durationMinutes,
          bufferMinutes: input.bufferMinutes ?? 0,
          requiresPayment: input.requiresPayment ?? false,
          paymentRequiredBeforeBooking: input.paymentRequiredBeforeBooking ?? false,
          isBookable: input.isBookable ?? false,
          isActive: input.isActive ?? true,
          readinessStatus: readiness.readinessStatus,
          missingFields: readiness.missingFields,
          displayOrder: ((await tx.service.aggregate({ where: { businessId: actor.businessId }, _max: { displayOrder: true } }))._max.displayOrder ?? 0) + 1,
          source: ServiceSource.MANUAL,
          createdById: actor.userId,
          updatedById: actor.userId,
        },
      });
      await tx.auditLog.create({
        data: { ...context, action: AuditAction.BUSINESS_SERVICE_CREATED, businessId: actor.businessId, userId: actor.userId, metadata: asJson({ businessId: actor.businessId, serviceId: created.id, actorUserId: actor.userId, actorMembershipId: actor.membershipId, readinessStatus: created.readinessStatus }) },
      });
      return created;
    }, TRANSACTION_OPTIONS).catch(handleMutationError);
    await invalidateServiceCaches(actor.businessId, service.id);
    publish("business.service.created", actor, service, Object.keys(input));
    publish("business.services.summary.updated", actor);
    return safeService(service);
  },

  async update(actor: ServiceActor, serviceId: string, input: UpdateServiceInput, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    if (input.currency && !validCurrency(input.currency)) throw new AppError(422, "Invalid currency code.", "INVALID_CURRENCY");
    const result = await prisma.$transaction(async (tx) => {
      await lockService(tx, actor, serviceId);
      const existing = await tx.service.findFirst({ where: { id: serviceId, businessId: actor.businessId, isArchived: false } });
      if (!existing) throw new AppError(404, "Service not found", "SERVICE_NOT_FOUND");
      if (input.paymentRequiredBeforeBooking && input.requiresPayment === undefined && !existing.requiresPayment) {
        throw new AppError(422, "Payment required before booking requires requiresPayment to be true", "VALIDATION_ERROR");
      }
      const activates = input.isActive === true && !existing.isActive;
      const deactivates = input.isActive === false && existing.isActive;
      await mutationContext(tx, actor, activates ? 1 : deactivates ? -1 : 0);
      const merged = { ...existing, ...input };
      if (merged.paymentRequiredBeforeBooking && !merged.requiresPayment) {
        throw new AppError(422, "Payment required before booking requires requiresPayment to be true", "VALIDATION_ERROR");
      }
      const readiness = calculateServiceReadiness(merged);
      const changedFields = Object.keys(input).filter((field) => String(existing[field as keyof typeof existing] ?? "") !== String(input[field as keyof UpdateServiceInput] ?? ""));
      if (changedFields.length === 0) return { service: existing, changedFields };
      const updated = await tx.service.update({
        where: { id: serviceId },
        data: { ...input, ...readiness, updatedById: actor.userId },
      });
      await tx.auditLog.create({
        data: {
          ...context,
          action: AuditAction.BUSINESS_SERVICE_UPDATED,
          businessId: actor.businessId,
          userId: actor.userId,
          metadata: asJson({
            businessId: actor.businessId,
            serviceId,
            actorUserId: actor.userId,
            actorMembershipId: actor.membershipId,
            changedFields,
            previousValues: Object.fromEntries(changedFields.map((field) => [field, existing[field as keyof typeof existing]])),
            newValues: Object.fromEntries(changedFields.map((field) => [field, updated[field as keyof typeof updated]])),
          }),
        },
      });
      return { service: updated, changedFields };
    }, TRANSACTION_OPTIONS).catch(handleMutationError);
    if (result.changedFields.length === 0) return safeService(result.service);
    await invalidateServiceCaches(actor.businessId, serviceId);
    publish("business.service.updated", actor, result.service, result.changedFields);
    publish("business.services.summary.updated", actor);
    return safeService(result.service);
  },

  async archive(actor: ServiceActor, serviceId: string, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    const service = await prisma.$transaction(async (tx) => {
      await lockService(tx, actor, serviceId);
      const existing = await tx.service.findFirst({ where: { id: serviceId, businessId: actor.businessId } });
      if (!existing) throw new AppError(404, "Service not found", "SERVICE_NOT_FOUND");
      if (existing.isArchived) return { service: existing, changed: false };
      await mutationContext(tx, actor, existing.isActive ? -1 : 0);
      const updated = await tx.service.update({
        where: { id: serviceId },
        data: { isArchived: true, isActive: false, readinessStatus: ServiceReadinessStatus.ARCHIVED, missingFields: [], archivedAt: new Date(), updatedById: actor.userId },
      });
      await tx.auditLog.create({ data: { ...context, action: AuditAction.BUSINESS_SERVICE_ARCHIVED, businessId: actor.businessId, userId: actor.userId, metadata: asJson({ businessId: actor.businessId, serviceId, actorUserId: actor.userId, actorMembershipId: actor.membershipId }) } });
      return { service: updated, changed: true };
    }, TRANSACTION_OPTIONS);
    if (!service.changed) return safeService(service.service);
    await invalidateServiceCaches(actor.businessId, serviceId);
    publish("business.service.archived", actor, service.service);
    publish("business.services.summary.updated", actor);
    return safeService(service.service);
  },

  async restore(actor: ServiceActor, serviceId: string, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    const service = await prisma.$transaction(async (tx) => {
      await lockService(tx, actor, serviceId);
      const existing = await tx.service.findFirst({ where: { id: serviceId, businessId: actor.businessId } });
      if (!existing) throw new AppError(404, "Service not found", "SERVICE_NOT_FOUND");
      if (!existing.isArchived) return { service: existing, changed: false };
      await mutationContext(tx, actor, 1);
      const readiness = calculateServiceReadiness({ ...existing, isArchived: false });
      const updated = await tx.service.update({
        where: { id: serviceId },
        data: { isArchived: false, isActive: true, archivedAt: null, ...readiness, updatedById: actor.userId },
      });
      await tx.auditLog.create({ data: { ...context, action: AuditAction.BUSINESS_SERVICE_RESTORED, businessId: actor.businessId, userId: actor.userId, metadata: asJson({ businessId: actor.businessId, serviceId, actorUserId: actor.userId, actorMembershipId: actor.membershipId }) } });
      return { service: updated, changed: true };
    }, TRANSACTION_OPTIONS).catch(handleMutationError);
    if (!service.changed) return safeService(service.service);
    await invalidateServiceCaches(actor.businessId, serviceId);
    publish("business.service.restored", actor, service.service);
    publish("business.services.summary.updated", actor);
    return safeService(service.service);
  },

  async reorder(actor: ServiceActor, input: ReorderServicesInput, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    await prisma.$transaction(async (tx) => {
      const count = await tx.service.count({ where: { businessId: actor.businessId, id: { in: input.items.map((item) => item.id) }, isArchived: false } });
      if (count !== input.items.length) throw new AppError(404, "One or more services were not found", "SERVICE_NOT_FOUND");
      await Promise.all(input.items.map((item) => tx.service.update({ where: { id: item.id }, data: { displayOrder: item.displayOrder, updatedById: actor.userId } })));
      await tx.auditLog.create({ data: { ...context, action: AuditAction.BUSINESS_SERVICE_REORDERED, businessId: actor.businessId, userId: actor.userId, metadata: asJson({ businessId: actor.businessId, actorUserId: actor.userId, actorMembershipId: actor.membershipId, items: input.items }) } });
    }, TRANSACTION_OPTIONS);
    await invalidateServiceCaches(actor.businessId);
    publish("business.service.reordered", actor);
    return { message: "Services reordered successfully" };
  },
};

function handleMutationError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
    || error instanceof Error && error.message.includes("Service_businessId_name_active_key")
  ) {
    throw new AppError(409, "A non-archived service with this name already exists for this business.", "SERVICE_NAME_ALREADY_EXISTS");
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2004"
    || error instanceof Error && (
      error.message.includes("Service_basePrice_nonnegative")
      || error.message.includes("Service_duration_positive")
      || error.message.includes("Service_buffer_nonnegative")
      || error.message.includes("Service_payment_requirement_valid")
      || error.message.includes("Service_name_not_blank")
      || error.message.includes("Service_currency_valid_length")
      || error.message.includes("Service_displayOrder_nonnegative")
      || error.message.includes("Service_archived_inactive")
    )
  ) {
    throw new AppError(422, "Service values violate a validation rule.", "VALIDATION_ERROR");
  }
  throw error;
}

export async function getBusinessServicesForAiContext(businessId: string) {
  return prisma.service.findMany({
    where: { businessId, isActive: true, isArchived: false },
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      category: true,
      description: true,
      priceType: true,
      basePrice: true,
      currency: true,
      priceDescription: true,
      durationMinutes: true,
      isBookable: true,
      requiresPayment: true,
      paymentRequiredBeforeBooking: true,
      readinessStatus: true,
      missingFields: true,
    },
  });
}

export async function getBusinessServiceSummaryForAiContext(businessId: string) {
  const [business, services] = await Promise.all([
    prisma.business.findFirst({ where: { id: businessId, deletedAt: null }, select: { id: true, defaultCurrency: true } }),
    getBusinessServicesForAiContext(businessId),
  ]);
  if (!business) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");
  return {
    businessId,
    currency: business.defaultCurrency,
    services,
    gaps: {
      missingPrices: services.filter((service) => service.missingFields.includes("price")).map((service) => service.name),
      missingDurations: services.filter((service) => service.missingFields.includes("durationMinutes")).map((service) => service.name),
      incompleteServices: services.filter((service) => service.readinessStatus === ServiceReadinessStatus.DRAFT || service.readinessStatus === ServiceReadinessStatus.INCOMPLETE).map((service) => service.name),
    },
  };
}

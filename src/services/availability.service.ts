import { AuditAction, BusinessRole, DayOfWeek, Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import type { UpsertAvailabilityInput } from "../validation/availability.schemas";
import type { AuditInput } from "./audit.service";
import { invalidateBusinessSetupStatus } from "./business-setup.service";
import { invalidateBusinessKnowledgePreview } from "./business-knowledge-cache.service";
import { cacheService } from "./cache.service";
import { realtimeService } from "./realtime.service";

export type AvailabilityActor = {
  userId: string;
  businessAccountId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

const DAYS = Object.values(DayOfWeek);
const CACHE_TTL_SECONDS = 120;
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;
const RULE_SELECT = {
  id: true,
  dayOfWeek: true,
  isOpen: true,
  openTime: true,
  closeTime: true,
  breakStartTime: true,
  breakEndTime: true,
  appliesToAllServices: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BusinessAvailabilitySelect;

type PublicRule = Prisma.BusinessAvailabilityGetPayload<{ select: typeof RULE_SELECT }>;
type AvailabilityResponse = {
  businessId: string;
  timezone: string;
  rules: PublicRule[];
  summary: {
    openDays: number;
    closedDays: number;
    hasBreakTimes: boolean;
    isComplete: boolean;
  };
};

function availabilityKey(businessId: string) {
  return `business:${businessId}:availability`;
}

function summaryKey(businessId: string) {
  return `business:${businessId}:availability:summary`;
}

function requireManager(actor: AvailabilityActor) {
  if (actor.role !== BusinessRole.BUSINESS_OWNER && actor.role !== BusinessRole.MANAGER) {
    throw new AppError(403, "You do not have permission to manage business availability.", "FORBIDDEN");
  }
}

function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function ordered<T extends { dayOfWeek: DayOfWeek }>(rules: T[]) {
  return [...rules].sort((a, b) => DAYS.indexOf(a.dayOfWeek) - DAYS.indexOf(b.dayOfWeek));
}

function completeSchedule(rules: Array<Pick<PublicRule, "dayOfWeek" | "isOpen" | "openTime" | "closeTime" | "isActive">>, timezone: string) {
  return validTimezone(timezone)
    && rules.length === 7
    && new Set(rules.map((rule) => rule.dayOfWeek)).size === 7
    && rules.some((rule) => rule.isActive && rule.isOpen)
    && rules.every((rule) => !rule.isActive || !rule.isOpen || Boolean(rule.openTime && rule.closeTime && rule.openTime < rule.closeTime));
}

function currentDay(timezone: string) {
  const safeTimezone = validTimezone(timezone) ? timezone : "UTC";
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: safeTimezone }).format(new Date()).toUpperCase() as DayOfWeek;
}

function summarize(businessId: string, timezone: string, rules: PublicRule[]) {
  const activeRules = rules.filter((rule) => rule.isActive);
  const today = currentDay(timezone);
  const todayIndex = DAYS.indexOf(today);
  const todayRule = activeRules.find((rule) => rule.dayOfWeek === today);
  let nextOpenDay: DayOfWeek | null = null;
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = DAYS[(todayIndex + offset) % 7]!;
    if (activeRules.some((rule) => rule.dayOfWeek === candidate && rule.isOpen)) {
      nextOpenDay = candidate;
      break;
    }
  }
  const openDays = activeRules.filter((rule) => rule.isOpen).length;
  return {
    businessId,
    timezone,
    openDays,
    closedDays: activeRules.filter((rule) => !rule.isOpen).length,
    hasWeeklySchedule: activeRules.length > 0,
    hasCompleteWeeklySchedule: completeSchedule(activeRules, timezone),
    nextOpenDay,
    todayStatus: todayRule ? {
      dayOfWeek: todayRule.dayOfWeek,
      isOpen: todayRule.isOpen,
      openTime: todayRule.openTime,
      closeTime: todayRule.closeTime,
    } : { dayOfWeek: today, isOpen: false, openTime: null, closeTime: null },
  };
}

function normalizedRule(rule: PublicRule | UpsertAvailabilityInput["rules"][number]) {
  return {
    dayOfWeek: rule.dayOfWeek,
    isOpen: rule.isOpen,
    openTime: rule.isOpen ? rule.openTime ?? null : null,
    closeTime: rule.isOpen ? rule.closeTime ?? null : null,
    breakStartTime: rule.isOpen ? rule.breakStartTime ?? null : null,
    breakEndTime: rule.isOpen ? rule.breakEndTime ?? null : null,
    appliesToAllServices: rule.appliesToAllServices,
    isActive: "isActive" in rule ? rule.isActive : true,
  };
}

function json(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function load(businessId: string, businessAccountId?: string) {
  const business = await prisma.business.findFirst({
    where: { id: businessId, ...(businessAccountId ? { businessAccountId } : {}), deletedAt: null },
    select: {
      id: true,
      timezone: true,
      availability: { where: { isActive: true }, select: RULE_SELECT },
    },
  });
  if (!business) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");
  return { ...business, availability: ordered(business.availability) };
}

export async function invalidateAvailabilityCaches(businessId: string) {
  await Promise.all([
    invalidateBusinessKnowledgePreview(businessId, "AVAILABILITY"),
    cacheService.del(availabilityKey(businessId)),
    cacheService.del(summaryKey(businessId)),
    invalidateBusinessSetupStatus(businessId),
  ]);
}

export async function getBusinessAvailabilityForAiContext(businessId: string) {
  const business = await load(businessId);
  const summary = summarize(business.id, business.timezone, business.availability);
  const missingDays = DAYS.filter((day) => !business.availability.some((rule) => rule.dayOfWeek === day));
  return {
    businessId,
    timezone: business.timezone,
    weeklyHours: business.availability.map(({ dayOfWeek, isOpen, openTime, closeTime, breakStartTime, breakEndTime }) => ({
      dayOfWeek, isOpen, openTime, closeTime, breakStartTime, breakEndTime,
    })),
    summary: {
      openDays: summary.openDays,
      closedDays: summary.closedDays,
      hasCompleteWeeklySchedule: summary.hasCompleteWeeklySchedule,
    },
    gaps: { missingDays, invalidRules: [] as DayOfWeek[] },
  };
}

export async function getBusinessAvailabilitySummaryForAiContext(businessId: string) {
  const business = await load(businessId);
  return summarize(business.id, business.timezone, business.availability);
}

export const availabilityService = {
  async get(actor: AvailabilityActor): Promise<AvailabilityResponse> {
    const key = availabilityKey(actor.businessId);
    const cached = await cacheService.get<AvailabilityResponse>(key);
    if (cached) return cached;
    const business = await load(actor.businessId, actor.businessAccountId);
    const summary = summarize(business.id, business.timezone, business.availability);
    const response = {
      businessId: business.id,
      timezone: business.timezone,
      rules: business.availability,
      summary: {
        openDays: summary.openDays,
        closedDays: summary.closedDays,
        hasBreakTimes: business.availability.some((rule) => rule.breakStartTime && rule.breakEndTime),
        isComplete: summary.hasCompleteWeeklySchedule,
      },
    };
    await cacheService.set(key, response, CACHE_TTL_SECONDS);
    return response;
  },

  async summary(actor: AvailabilityActor) {
    const key = summaryKey(actor.businessId);
    const cached = await cacheService.get<ReturnType<typeof summarize>>(key);
    if (cached) return cached;
    const business = await load(actor.businessId, actor.businessAccountId);
    const response = summarize(business.id, business.timezone, business.availability);
    await cacheService.set(key, response, CACHE_TTL_SECONDS);
    return response;
  },

  async upsert(actor: AvailabilityActor, input: UpsertAvailabilityInput, context: Omit<AuditInput, "action">) {
    requireManager(actor);
    if (!validTimezone(input.timezone)) throw new AppError(422, "Invalid timezone.", "INVALID_TIMEZONE");

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "Business"
        WHERE "id" = ${actor.businessId}
          AND "businessAccountId" = ${actor.businessAccountId}
          AND "deletedAt" IS NULL
        FOR UPDATE
      `);
      const existingBusiness = await tx.business.findFirst({
        where: { id: actor.businessId, businessAccountId: actor.businessAccountId, deletedAt: null },
        select: { id: true, timezone: true, availability: { select: RULE_SELECT } },
      });
      if (!existingBusiness) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");

      const previousByDay = new Map(existingBusiness.availability.map((rule) => [rule.dayOfWeek, normalizedRule(rule)]));
      const changedDays = input.rules
        .filter((rule) => JSON.stringify(previousByDay.get(rule.dayOfWeek)) !== JSON.stringify(normalizedRule(rule)))
        .map((rule) => rule.dayOfWeek);
      const timezoneChanged = existingBusiness.timezone !== input.timezone;

      if (timezoneChanged) {
        await tx.business.update({ where: { id: actor.businessId }, data: { timezone: input.timezone } });
      }
      for (const rule of input.rules) {
        const times = {
          openTime: rule.isOpen ? rule.openTime ?? null : null,
          closeTime: rule.isOpen ? rule.closeTime ?? null : null,
          breakStartTime: rule.isOpen ? rule.breakStartTime ?? null : null,
          breakEndTime: rule.isOpen ? rule.breakEndTime ?? null : null,
        };
        await tx.businessAvailability.upsert({
          where: { businessId_dayOfWeek: { businessId: actor.businessId, dayOfWeek: rule.dayOfWeek } },
          create: {
            businessId: actor.businessId,
            dayOfWeek: rule.dayOfWeek,
            isOpen: rule.isOpen,
            ...times,
            timezone: input.timezone,
            appliesToAllServices: rule.appliesToAllServices,
            isActive: true,
            createdById: actor.userId,
            updatedById: actor.userId,
          },
          update: {
            isOpen: rule.isOpen,
            ...times,
            timezone: input.timezone,
            appliesToAllServices: rule.appliesToAllServices,
            isActive: true,
            updatedById: actor.userId,
          },
        });
      }
      const rules = ordered(await tx.businessAvailability.findMany({
        where: { businessId: actor.businessId, isActive: true },
        select: RULE_SELECT,
      }));
      if (changedDays.length > 0 || timezoneChanged) {
        await tx.auditLog.create({
          data: {
            ...context,
            action: AuditAction.BUSINESS_AVAILABILITY_UPDATED,
            businessId: actor.businessId,
            userId: actor.userId,
            actorMembershipId: actor.membershipId,
            metadata: json({
              businessId: actor.businessId,
              actorUserId: actor.userId,
              actorMembershipId: actor.membershipId,
              changedDays,
              previousValues: { timezone: existingBusiness.timezone, rules: ordered(existingBusiness.availability).map(normalizedRule) },
              newValues: { timezone: input.timezone, rules: rules.map(normalizedRule) },
            }),
          },
        });
      }
      return { rules, changedDays, timezoneChanged };
    }, TRANSACTION_OPTIONS);

    if (result.changedDays.length > 0 || result.timezoneChanged) {
      await Promise.all([
        invalidateAvailabilityCaches(actor.businessId),
        cacheService.del(`business:${actor.businessId}:profile`),
      ]);
      const updatedAt = new Date().toISOString();
      for (const type of ["business.availability.updated", "business.availability.summary.updated"] as const) {
        realtimeService.publish({
          type,
          businessId: actor.businessId,
          broadcastToStaff: true,
          payload: { businessId: actor.businessId, updatedAt, changedDays: result.changedDays },
        });
      }
    }
    return this.get(actor);
  },
};

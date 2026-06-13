import { AuditAction, BusinessRole, Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { UpdateBusinessProfileInput } from "../validation/business.schemas";
import { AppError } from "../utils/errors";
import type { AuditInput } from "./audit.service";
import { invalidateBusinessSetupStatus } from "./business-setup.service";
import { cacheService } from "./cache.service";
import { realtimeService } from "./realtime.service";

export type BusinessProfileActor = {
  userId: string;
  businessAccountId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

type CachedProfile = {
  businessAccountId: string;
  profile: ReturnType<typeof safeProfile>;
};

const CACHE_TTL_SECONDS = 120;
const PROFILE_EDITABLE_FIELDS = new Set([
  "name",
  "industry",
  "description",
  "country",
  "city",
  "address",
  "serviceArea",
  "phone",
  "email",
  "website",
  "timezone",
  "defaultCurrency",
  "defaultNotificationEmail",
]);
const MANAGER_EDITABLE_FIELDS = new Set([
  "description",
  "address",
  "serviceArea",
  "phone",
  "email",
  "website",
  "defaultNotificationEmail",
]);
const PROFILE_SELECT = {
  id: true,
  businessAccountId: true,
  name: true,
  industry: true,
  description: true,
  country: true,
  city: true,
  address: true,
  serviceArea: true,
  phone: true,
  email: true,
  website: true,
  timezone: true,
  defaultCurrency: true,
  defaultNotificationEmail: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BusinessSelect;

function safeProfile(profile: Prisma.BusinessGetPayload<{ select: typeof PROFILE_SELECT }>) {
  const { businessAccountId: _businessAccountId, ...safe } = profile;
  return safe;
}

function cacheKey(businessId: string) {
  return `business:${businessId}:profile`;
}

function present(value?: string | null) {
  return Boolean(value?.trim());
}

function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function validCurrency(value: string) {
  return /^[A-Z]{3}$/.test(value) && Intl.supportedValuesOf("currency").includes(value);
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export async function invalidateBusinessProfile(businessId: string) {
  await cacheService.del(cacheKey(businessId));
}

export const businessProfileService = {
  async get(actor: BusinessProfileActor) {
    const key = cacheKey(actor.businessId);
    const cached = await cacheService.get<CachedProfile>(key);
    if (cached?.businessAccountId === actor.businessAccountId) return cached.profile;
    if (cached) await cacheService.del(key);

    const business = await prisma.business.findFirst({
      where: { id: actor.businessId, businessAccountId: actor.businessAccountId, deletedAt: null },
      select: PROFILE_SELECT,
    });
    if (!business) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");

    const profile = safeProfile(business);
    await cacheService.set(key, { businessAccountId: actor.businessAccountId, profile }, CACHE_TTL_SECONDS);
    return profile;
  },

  async update(actor: BusinessProfileActor, input: UpdateBusinessProfileInput, context: Omit<AuditInput, "action">) {
    if (actor.role === BusinessRole.STAFF) {
      throw new AppError(403, "You do not have permission to update business profile settings.", "FORBIDDEN");
    }
    if (actor.role !== BusinessRole.BUSINESS_OWNER && actor.role !== BusinessRole.MANAGER) {
      throw new AppError(403, "You do not have permission to update business profile settings.", "FORBIDDEN");
    }

    const changedFields = Object.keys(input);
    const unsupportedFields = changedFields.filter((field) => !PROFILE_EDITABLE_FIELDS.has(field));
    if (unsupportedFields.length > 0) {
      throw new AppError(422, "Unsupported business profile fields.", "VALIDATION_ERROR", { unsupportedFields });
    }
    if (actor.role === BusinessRole.MANAGER) {
      const protectedFields = changedFields.filter((field) => !MANAGER_EDITABLE_FIELDS.has(field));
      if (protectedFields.length > 0) {
        throw new AppError(403, "Only a business owner can update business identity settings.", "FORBIDDEN", { protectedFields });
      }
    }
    if (input.industry !== undefined && !/^[\p{L}\p{N}][\p{L}\p{N} &_/-]*$/u.test(input.industry)) {
      throw new AppError(422, "Industry contains unsupported characters.", "INVALID_INDUSTRY");
    }
    if (input.timezone !== undefined && !validTimezone(input.timezone)) {
      throw new AppError(422, "Invalid timezone.", "INVALID_TIMEZONE");
    }
    if (input.defaultCurrency !== undefined && !validCurrency(input.defaultCurrency)) {
      throw new AppError(422, "Invalid currency code.", "INVALID_CURRENCY");
    }

    const existing = await prisma.business.findFirst({
      where: { id: actor.businessId, businessAccountId: actor.businessAccountId, deletedAt: null },
      select: PROFILE_SELECT,
    });
    if (!existing) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");

    const nextEmail = input.email === undefined ? existing.email : input.email;
    const nextPhone = input.phone === undefined ? existing.phone : input.phone;
    if (!present(nextEmail) && !present(nextPhone)) {
      throw new AppError(422, "At least one business phone number or email address is required.", "VALIDATION_ERROR");
    }

    const actualChangedFields = changedFields.filter((field) => {
      const key = field as keyof typeof existing;
      return existing[key] !== input[field as keyof UpdateBusinessProfileInput];
    });
    if (actualChangedFields.length === 0) return safeProfile(existing);

    const data = Object.fromEntries(actualChangedFields.map((field) => [field, input[field as keyof UpdateBusinessProfileInput]]));
    const previousValues = Object.fromEntries(actualChangedFields.map((field) => [field, existing[field as keyof typeof existing]]));
    let updated: Prisma.BusinessGetPayload<{ select: typeof PROFILE_SELECT }>;
    try {
      updated = await prisma.$transaction(async (tx) => {
        const next = await tx.business.update({
          where: { id: existing.id },
          data,
          select: PROFILE_SELECT,
        });
        const newValues = Object.fromEntries(actualChangedFields.map((field) => [field, next[field as keyof typeof next]]));
        await tx.auditLog.create({
          data: {
            ...context,
            action: AuditAction.BUSINESS_PROFILE_UPDATED,
            businessId: actor.businessId,
            userId: actor.userId,
            metadata: jsonValue({
              businessId: actor.businessId,
              actorUserId: actor.userId,
              actorMembershipId: actor.membershipId,
              changedFields: actualChangedFields,
              previousValues,
              newValues,
            }),
          },
        });
        return next;
      });
    } catch (error) {
      if (
        (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2004")
        || (error instanceof Error && error.message.includes("Business_contact_required"))
      ) {
        throw new AppError(422, "At least one business phone number or email address is required.", "VALIDATION_ERROR");
      }
      throw error;
    }

    await Promise.all([
      invalidateBusinessProfile(actor.businessId),
      invalidateBusinessSetupStatus(actor.businessId),
    ]);
    realtimeService.publish({
      type: "business.profile.updated",
      businessId: actor.businessId,
      broadcastToStaff: true,
      payload: { businessId: actor.businessId, changedFields: actualChangedFields, updatedAt: updated.updatedAt.toISOString() },
    });
    return safeProfile(updated);
  },
};

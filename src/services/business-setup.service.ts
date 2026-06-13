import { PlanCode, ServiceReadinessStatus, WhatsAppIntegrationStatus, WhatsAppProvider } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { decryptCredential } from "../utils/credential-encryption";
import { AppError } from "../utils/errors";
import { cacheService } from "./cache.service";

export type BusinessSetupActor = {
  businessAccountId: string;
  businessId: string;
};

type RequiredFor = "MANUAL_INBOX" | "AI_AUTOMATION";
type SetupItem = {
  key: string;
  label: string;
  description: string;
  route: string;
  requiredFor: RequiredFor;
  planRequired: PlanCode;
  weight: number;
  complete: boolean;
};
type SetupStatusResponse = {
  businessId: string;
  plan: PlanCode;
  completionPercentage: number;
  readinessStatus: string;
  isManualInboxReady: boolean;
  isAiReady: boolean;
  missingItems: ReturnType<typeof publicItem>[];
  completedItems: Array<{ key: string; label: string }>;
  nextRecommendedStep: { key: string; label: string; route: string } | null;
  serviceProgress: {
    servicesAdded: number;
    servicesWithPricing: number;
    servicesReadyForAi: number;
    servicesReadyForBooking: number;
    missingServicePrices: number;
    missingServiceDurations: number;
  };
};
type CachedSetupStatus = {
  businessAccountId: string;
  response: SetupStatusResponse;
};

const CACHE_TTL_SECONDS = 60;

function present(value?: string | null) {
  return Boolean(value?.trim());
}

function publicItem(item: SetupItem) {
  return {
    key: item.key,
    label: item.label,
    description: item.description,
    route: item.route,
    requiredFor: item.requiredFor,
    planRequired: item.planRequired,
  };
}

function hasUsableLiveCredential(integration?: { phoneNumberId: string; accessTokenEncrypted: string | null }) {
  if (!integration) return false;
  if (!integration.accessTokenEncrypted) {
    return Boolean(env.META_WHATSAPP_ACCESS_TOKEN && env.META_WHATSAPP_PHONE_NUMBER_ID === integration.phoneNumberId);
  }
  try {
    decryptCredential(integration.accessTokenEncrypted);
    return true;
  } catch {
    return false;
  }
}

export async function invalidateBusinessSetupStatus(businessId: string) {
  await cacheService.del(`business:${businessId}:setup-status`);
}

export const businessSetupService = {
  async getStatus(actor: BusinessSetupActor) {
    const cacheKey = `business:${actor.businessId}:setup-status`;
    const cached = await cacheService.get<CachedSetupStatus>(cacheKey);
    if (cached?.businessAccountId === actor.businessAccountId) return cached.response;
    if (cached) await cacheService.del(cacheKey);

    const [business, subscription] = await Promise.all([
      prisma.business.findFirst({
        where: { id: actor.businessId, businessAccountId: actor.businessAccountId, deletedAt: null },
        include: {
          services: {
            where: { isActive: true, isArchived: false },
            select: { id: true, readinessStatus: true, missingFields: true },
          },
          availability: {
            where: { isActive: true },
            select: { id: true, openTime: true, closeTime: true },
          },
          policies: {
            where: { isActive: true, deletedAt: null },
            select: { id: true },
          },
          whatsAppIntegrations: {
            orderBy: [{ createdAt: "desc" }, { updatedAt: "desc" }],
            take: 1,
            select: { status: true, provider: true, phoneNumberId: true, accessTokenEncrypted: true },
          },
        },
      }),
      prisma.subscription.findFirst({
        where: { businessAccountId: actor.businessAccountId },
        orderBy: { createdAt: "desc" },
        include: { plan: true },
      }),
    ]);
    if (!business) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");
    if (!subscription) throw new AppError(403, "No subscription found", "SUBSCRIPTION_REQUIRED");

    const contactComplete = present(business.phone) || present(business.email);
    const locationComplete = present(business.country) && present(business.city);
    const basicInfoComplete = present(business.name)
      && contactComplete
      && present(business.timezone)
      && present(business.defaultCurrency);
    const industryDescriptionComplete = present(business.industry) && present(business.description);
    const whatsApp = business.whatsAppIntegrations[0];
    const liveCredentialAvailable = hasUsableLiveCredential(whatsApp);
    const whatsAppConnected = Boolean(
      whatsApp
      && (
        (
          whatsApp.status === WhatsAppIntegrationStatus.MOCK_CONNECTED
          && whatsApp.provider === WhatsAppProvider.MOCK_WHATSAPP
          && env.WHATSAPP_PROVIDER_MODE === "mock"
        )
        || (
          whatsApp.status === WhatsAppIntegrationStatus.CONNECTED
          && whatsApp.provider === WhatsAppProvider.META
          && liveCredentialAvailable
        )
      ),
    );
    const servicesComplete = business.services.length > 0;
    const servicesWithPricing = business.services.filter((service) => !service.missingFields.includes("price")).length;
    const servicesReadyForAi = business.services.filter((service) =>
      service.readinessStatus === ServiceReadinessStatus.READY_FOR_AI
      || service.readinessStatus === ServiceReadinessStatus.READY_FOR_BOOKING).length;
    const servicesReadyForBooking = business.services.filter((service) => service.readinessStatus === ServiceReadinessStatus.READY_FOR_BOOKING).length;
    const missingServicePrices = business.services.filter((service) => service.missingFields.includes("price")).length;
    const missingServiceDurations = business.services.filter((service) => service.missingFields.includes("durationMinutes")).length;
    const pricingComplete = servicesWithPricing > 0;
    const availabilityComplete = business.availability.some((entry) => present(entry.openTime) && present(entry.closeTime));
    const policiesComplete = business.policies.length > 0;
    const items: SetupItem[] = [
      {
        key: "businessBasicInfo",
        label: "Complete business contact information",
        description: "Add a business contact, timezone, and default currency.",
        route: "/settings/business/profile",
        requiredFor: "MANUAL_INBOX",
        planRequired: PlanCode.BASIC,
        weight: 20,
        complete: basicInfoComplete,
      },
      {
        key: "industryDescription",
        label: "Add industry and business description",
        description: "A clear description helps BizReply understand what your business does.",
        route: "/settings/business/profile",
        requiredFor: "AI_AUTOMATION",
        planRequired: PlanCode.BASIC,
        weight: 15,
        complete: industryDescriptionComplete,
      },
      {
        key: "location",
        label: "Add business country and city",
        description: "Add the country and city where the business operates.",
        route: "/settings/business/profile",
        requiredFor: "MANUAL_INBOX",
        planRequired: PlanCode.BASIC,
        weight: 10,
        complete: locationComplete,
      },
      {
        key: "whatsappConnection",
        label: "Connect WhatsApp",
        description: "Connect WhatsApp so your business can receive and reply to customer messages.",
        route: "/settings/integrations/whatsapp",
        requiredFor: "MANUAL_INBOX",
        planRequired: PlanCode.BASIC,
        weight: 15,
        complete: whatsAppConnected,
      },
      {
        key: "services",
        label: "Add at least one service",
        description: "Services help BizReply understand what your business offers.",
        route: "/settings/business/services",
        requiredFor: "AI_AUTOMATION",
        planRequired: PlanCode.BASIC,
        weight: 15,
        complete: servicesComplete,
      },
      {
        key: "servicePricing",
        label: "Add service pricing",
        description: "Add a price or pricing note to at least one active service.",
        route: "/settings/business/services",
        requiredFor: "AI_AUTOMATION",
        planRequired: PlanCode.BASIC,
        weight: 10,
        complete: pricingComplete,
      },
      {
        key: "businessHours",
        label: "Add business working hours",
        description: "Working hours help BizReply know when your business is available.",
        route: "/settings/business/availability",
        requiredFor: "AI_AUTOMATION",
        planRequired: PlanCode.BASIC,
        weight: 10,
        complete: availabilityComplete,
      },
      {
        key: "policies",
        label: "Add terms and policies",
        description: "Policies help BizReply answer safely about payments, cancellations, delays, and fees.",
        route: "/settings/business/policies",
        requiredFor: "AI_AUTOMATION",
        planRequired: PlanCode.BASIC,
        weight: 5,
        complete: policiesComplete,
      },
    ];

    const weightedCompletion = items.reduce((total, item) => total + (item.complete ? item.weight : 0), 0);
    const isManualInboxReady = basicInfoComplete && present(business.industry) && locationComplete && contactComplete && whatsAppConnected;
    const isAiReady = isManualInboxReady
      && industryDescriptionComplete
      && servicesComplete
      && pricingComplete
      && availabilityComplete
      && policiesComplete;
    const completionPercentage = weightedCompletion;
    const readinessStatus = isAiReady
      ? "READY_FOR_AI_AUTOMATION"
      : isManualInboxReady
        ? "READY_FOR_MANUAL_INBOX"
        : completionPercentage === 0
          ? "NOT_STARTED"
          : "INCOMPLETE";
    const missingItems = items.filter((item) => !item.complete).map(publicItem);
    const completedItems = items
      .filter((item) => item.complete)
      .map((item) => ({ key: item.key, label: item.label }));
    const next = items.find((item) => !item.complete);
    const result: SetupStatusResponse = {
      businessId: business.id,
      plan: subscription.plan.code,
      completionPercentage,
      readinessStatus,
      isManualInboxReady,
      isAiReady,
      missingItems,
      completedItems,
      nextRecommendedStep: next ? { key: next.key, label: next.label, route: next.route } : null,
      serviceProgress: {
        servicesAdded: business.services.length,
        servicesWithPricing,
        servicesReadyForAi,
        servicesReadyForBooking,
        missingServicePrices,
        missingServiceDurations,
      },
    };
    await cacheService.set<CachedSetupStatus>(cacheKey, { businessAccountId: actor.businessAccountId, response: result }, CACHE_TTL_SECONDS);
    return result;
  },
};

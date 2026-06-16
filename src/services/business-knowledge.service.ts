import {
  BusinessPolicyCategory,
  BusinessRole,
  ServicePriceType,
  ServiceReadinessStatus,
  WhatsAppIntegrationStatus,
  WhatsAppProvider,
} from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { decryptCredential } from "../utils/credential-encryption";
import { AppError } from "../utils/errors";
import { getBusinessAvailabilityForAiContext } from "./availability.service";
import { invalidateBusinessKnowledgePreview } from "./business-knowledge-cache.service";
import { cacheService } from "./cache.service";
import { getBusinessPoliciesForAiContext } from "./policy.service";
import { getBusinessServiceSummaryForAiContext } from "./service.service";

export { invalidateBusinessKnowledgePreview };

type SectionKey = "PROFILE" | "SERVICES" | "AVAILABILITY" | "POLICIES" | "WHATSAPP";
type Severity = "HIGH" | "MEDIUM" | "LOW";
type Topic = { key: string; label: string; reason: string; severity?: Severity; confidence?: "HIGH" };

const CACHE_TTL_SECONDS = 120;
const ROUTES: Record<SectionKey, string> = {
  PROFILE: "/settings/business/profile",
  SERVICES: "/settings/business/services",
  AVAILABILITY: "/settings/business/availability",
  POLICIES: "/settings/business/policies",
  WHATSAPP: "/settings/business/whatsapp",
};

function key(businessId: string) {
  return `business:${businessId}:knowledge-preview`;
}

function present(value?: string | null) {
  return Boolean(value?.trim());
}

function sectionStatus(score: number) {
  return score < 40 ? "MISSING" : score < 70 ? "INCOMPLETE" : score < 90 ? "PARTIAL" : "READY";
}

function section(score: number, label: string, description: string, route: string) {
  return { score, status: sectionStatus(score), label, description, route };
}

function usableMetaCredential(integration?: { phoneNumberId: string; accessTokenEncrypted: string | null }) {
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

function priceDisplay(service: {
  priceType: ServicePriceType;
  basePrice: unknown;
  currency: string;
  priceDescription: string | null;
}) {
  const amount = service.basePrice == null ? null : `${service.currency} ${service.basePrice}`;
  if (service.priceType === ServicePriceType.FREE) return "Free";
  if (service.priceType === ServicePriceType.QUOTE_ONLY) return service.priceDescription || "Quote only";
  if (service.priceType === ServicePriceType.STARTING_FROM) return amount ? `From ${amount}` : service.priceDescription || "Price not set";
  if (service.priceType === ServicePriceType.RANGE) return service.priceDescription || amount || "Price not set";
  if (service.priceType === ServicePriceType.FIXED) return amount || service.priceDescription || "Price not set";
  return "Price not set";
}

function readableHours(rules: Array<{ dayOfWeek: string; isOpen: boolean; openTime: string | null; closeTime: string | null }>) {
  return rules.map((rule) => rule.isOpen
    ? `${rule.dayOfWeek}: ${rule.openTime}-${rule.closeTime}`
    : `${rule.dayOfWeek}: Closed`);
}

async function build(businessId: string) {
  const [business, serviceSummary, availability, policyContext, policyCounts, whatsapp] = await Promise.all([
    prisma.business.findFirst({
      where: { id: businessId, deletedAt: null },
      select: {
        id: true, name: true, industry: true, description: true, country: true, city: true,
        serviceArea: true, phone: true, email: true, website: true, timezone: true, defaultCurrency: true,
      },
    }),
    getBusinessServiceSummaryForAiContext(businessId),
    getBusinessAvailabilityForAiContext(businessId),
    getBusinessPoliciesForAiContext(businessId),
    prisma.businessPolicy.findMany({ where: { businessId, isArchived: false }, select: { isActive: true, visibility: true } }),
    prisma.whatsAppIntegration.findFirst({
      where: { businessId },
      orderBy: [{ createdAt: "desc" }, { updatedAt: "desc" }],
      select: { status: true, accessTokenEncrypted: true, provider: true, phoneNumberId: true },
    }),
  ]);
  if (!business) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");

  const services = serviceSummary.services;
  const policies = policyContext.policies;
  const policyCategories = policies.map((policy) => policy.category);
  const contactReady = present(business.phone) || present(business.email);
  const locationReady = present(business.country) && present(business.city);
  const profileReady = present(business.name) && present(business.industry) && present(business.description)
    && locationReady && contactReady && present(business.timezone) && present(business.defaultCurrency);
  const profileScore = (present(business.name) ? 10 : 0)
    + (present(business.industry) ? 15 : 0) + (present(business.description) ? 20 : 0)
    + (present(business.country) ? 10 : 0) + (present(business.city) ? 10 : 0)
    + (contactReady ? 15 : 0) + (present(business.timezone) ? 10 : 0) + (present(business.defaultCurrency) ? 10 : 0);

  const readyForAi = services.filter((service) =>
    service.readinessStatus === ServiceReadinessStatus.READY_FOR_AI
    || service.readinessStatus === ServiceReadinessStatus.READY_FOR_BOOKING).length;
  const readyForBooking = services.filter((service) =>
    service.readinessStatus === ServiceReadinessStatus.READY_FOR_BOOKING
    && service.isBookable && Boolean(service.durationMinutes)).length;
  const servicesScore = services.length
    ? 30 + (readyForAi ? 35 : 0) + (readyForBooking ? 20 : 0)
      + (!serviceSummary.gaps.missingPrices.length ? 10 : 0) + (!serviceSummary.gaps.missingDurations.length ? 5 : 0)
    : 0;

  const availabilityComplete = availability.summary.hasCompleteWeeklySchedule;
  const availabilityScore = (present(availability.timezone) ? 20 : 0)
    + (availability.weeklyHours.length === 7 ? 30 : 0) + (availability.summary.openDays ? 25 : 0) + (availabilityComplete ? 25 : 0);
  const hasPolicy = (...categories: BusinessPolicyCategory[]) => categories.some((category) => policyCategories.includes(category));
  const policiesScore = (policies.length ? 40 : 0)
    + (hasPolicy(BusinessPolicyCategory.PAYMENT) ? 15 : 0)
    + (hasPolicy(BusinessPolicyCategory.CANCELLATION, BusinessPolicyCategory.RESCHEDULING) ? 15 : 0)
    + (hasPolicy(BusinessPolicyCategory.REFUND, BusinessPolicyCategory.DEPOSIT) ? 15 : 0)
    + (hasPolicy(BusinessPolicyCategory.SERVICE_AREA, BusinessPolicyCategory.TRANSPORTATION) ? 15 : 0);

  const connected = whatsapp?.status === WhatsAppIntegrationStatus.CONNECTED || whatsapp?.status === WhatsAppIntegrationStatus.MOCK_CONNECTED;
  const canSendMessages = Boolean(connected && (
    (whatsapp?.provider === WhatsAppProvider.MOCK_WHATSAPP && whatsapp.status === WhatsAppIntegrationStatus.MOCK_CONNECTED && env.WHATSAPP_PROVIDER_MODE === "mock")
    || (whatsapp?.provider === WhatsAppProvider.META && whatsapp.status === WhatsAppIntegrationStatus.CONNECTED && usableMetaCredential(whatsapp))
  ));
  const whatsappScore = connected ? (canSendMessages ? 100 : 60) : whatsapp?.status === WhatsAppIntegrationStatus.CONNECTING ? 40 : 0;
  const overallScore = Math.round(profileScore * 0.2 + servicesScore * 0.25 + availabilityScore * 0.2 + policiesScore * 0.2 + whatsappScore * 0.15);
  const isAiReady = overallScore >= 75 && profileReady && readyForAi > 0 && availabilityComplete && policies.length > 0 && canSendMessages;
  const isBookingReady = isAiReady && readyForBooking > 0 && availabilityComplete;

  const safeToAnswerTopics: Topic[] = [];
  const needsHumanConfirmationTopics: Topic[] = [];
  const gaps: Array<{ key: string; label: string; description: string; section: SectionKey; severity: Severity; route: string }> = [];
  const recommendedNextActions: Array<{ key: string; label: string; description: string; route: string; priority: number }> = [];
  const addSafe = (topicKey: string, label: string, reason: string) => safeToAnswerTopics.push({ key: topicKey, label, reason, confidence: "HIGH" });
  const addGap = (gapKey: string, label: string, description: string, sectionKey: SectionKey, severity: Severity, priority: number) => {
    gaps.push({ key: gapKey, label, description, section: sectionKey, severity, route: ROUTES[sectionKey] });
    needsHumanConfirmationTopics.push({ key: gapKey, label, reason: description, severity });
    recommendedNextActions.push({ key: gapKey, label, description, route: ROUTES[sectionKey], priority });
  };

  if (present(business.name) && present(business.industry) && present(business.description)) addSafe("business-identity", "Business identity", "Business name, industry, and description are configured.");
  else addGap("complete-profile", "Complete business profile", "Business identity or description is incomplete.", "PROFILE", "MEDIUM", 2);
  if (present(business.country) || present(business.city) || present(business.serviceArea)) addSafe("business-location", "Business location and service area", "Location or service area is configured.");
  if (contactReady) addSafe("contact-details", "Contact details", "A business phone number or email address is configured.");
  if (services.length) addSafe("services-offered", "Services offered", "At least one active service exists.");
  else addGap("add-services", "Add services", "No active services are configured.", "SERVICES", "HIGH", 1);
  if (services.length && !serviceSummary.gaps.missingPrices.length) addSafe("service-pricing", "Configured service pricing", "All active services have approved pricing.");
  else if (serviceSummary.gaps.missingPrices.length) addGap("add-service-prices", "Add service prices", "Some active services are missing prices.", "SERVICES", "HIGH", 1);
  if (serviceSummary.gaps.missingDurations.length) addGap("add-service-durations", "Add service durations", "Some active services are missing durations.", "SERVICES", "MEDIUM", 4);
  if (availabilityComplete) addSafe("opening-hours", "Opening hours", "A complete weekly availability schedule is configured.");
  else addGap("configure-availability", "Configure availability", "Weekly availability is missing or incomplete.", "AVAILABILITY", "HIGH", 2);
  if (policies.length) addSafe("customer-policies", "Customer-facing policies", "Active customer-facing policies are configured.");
  else addGap("add-policies", "Add customer-facing policies", "No active customer-facing policies are configured.", "POLICIES", "HIGH", 1);
  if (hasPolicy(BusinessPolicyCategory.REFUND)) addSafe("refund-policy", "Refund policy", "An approved refund policy is configured.");
  else addGap("add-refund-policy", "Add refund policy", "No approved refund policy is configured.", "POLICIES", "HIGH", 2);
  if (hasPolicy(BusinessPolicyCategory.CANCELLATION)) addSafe("cancellation-policy", "Cancellation policy", "An approved cancellation policy is configured.");
  else addGap("add-cancellation-policy", "Add cancellation policy", "No approved cancellation policy is configured.", "POLICIES", "HIGH", 2);
  if (!connected) addGap("connect-whatsapp", "Connect WhatsApp", "WhatsApp is not connected.", "WHATSAPP", "HIGH", 1);
  else if (!canSendMessages) addGap("restore-whatsapp-sending", "Restore WhatsApp sending", "WhatsApp is connected but cannot currently send messages.", "WHATSAPP", "HIGH", 1);

  recommendedNextActions.sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
  const preview = {
    businessId,
    generatedAt: new Date().toISOString(),
    readiness: { overallScore, level: isBookingReady ? "BOOKING_READY" : isAiReady ? "AI_READY" : overallScore < 40 ? "NOT_READY" : "PARTIAL", isAiReady, isBookingReady },
    sections: {
      profile: section(profileScore, "Business profile", "Business identity and contact readiness.", ROUTES.PROFILE),
      services: section(servicesScore, "Services & Pricing", "Active service and pricing readiness.", ROUTES.SERVICES),
      availability: section(availabilityScore, "Availability", "Weekly schedule readiness.", ROUTES.AVAILABILITY),
      policies: section(policiesScore, "Policies", "Customer-facing policy readiness.", ROUTES.POLICIES),
      whatsapp: section(whatsappScore, "WhatsApp connection", "Messaging connection readiness.", ROUTES.WHATSAPP),
    },
    businessSummary: {
      name: business.name, industry: business.industry, description: business.description, country: business.country,
      city: business.city, serviceArea: business.serviceArea, phone: business.phone, email: business.email,
      website: business.website, timezone: business.timezone, defaultCurrency: business.defaultCurrency,
    },
    servicesPreview: {
      total: services.length, active: services.length, readyForAi, readyForBooking,
      missingPrices: serviceSummary.gaps.missingPrices, missingDurations: serviceSummary.gaps.missingDurations,
      items: services.map((service) => {
        const display = priceDisplay(service);
        const { basePrice: _basePrice, currency: _currency, ...safeService } = service;
        return { ...safeService, priceDisplay: display };
      }),
    },
    availabilityPreview: {
      timezone: availability.timezone, hasCompleteWeeklySchedule: availabilityComplete, openDays: availability.summary.openDays,
      closedDays: availability.summary.closedDays, readableHours: readableHours(availability.weeklyHours), gaps: availability.gaps,
    },
    policiesPreview: {
      total: policyCounts.length, active: policyCounts.filter((policy) => policy.isActive).length, customerFacing: policies.length,
      internalOnly: policyCounts.filter((policy) => policy.isActive && policy.visibility === "INTERNAL_ONLY").length,
      configuredCategories: [...new Set(policyCategories)], missingRecommendedCategories: policyContext.gaps.missingRecommendedCategories,
      items: policies.map(({ content: _content, ...policy }) => policy),
    },
    whatsappPreview: { status: whatsapp?.status ?? WhatsAppIntegrationStatus.NOT_CONNECTED, connected, canSendMessages },
    safeToAnswerTopics,
    needsHumanConfirmationTopics,
    gaps,
    recommendedNextActions,
    aiInstructionsPreview: {
      canAnswer: safeToAnswerTopics.map((topic) => topic.label),
      shouldAvoid: needsHumanConfirmationTopics.map((topic) => topic.label),
      shouldHandoff: ["Payment disputes", "Price negotiation", "Appointment exceptions", "Complaints", ...needsHumanConfirmationTopics.filter((topic) => topic.severity === "HIGH").map((topic) => topic.label)],
    },
  };
  return preview;
}

export const businessKnowledgeService = {
  async get(actor: { businessId: string; role: BusinessRole }) {
    if (actor.role === BusinessRole.STAFF) throw new AppError(403, "You do not have permission to view the business knowledge preview.", "FORBIDDEN");
    const cached = await cacheService.get<Awaited<ReturnType<typeof build>>>(key(actor.businessId));
    if (cached) return cached;
    const value = await build(actor.businessId);
    await cacheService.set(key(actor.businessId), value, CACHE_TTL_SECONDS);
    return value;
  },
};

export async function getBusinessKnowledgeForAiContext(businessId: string) {
  const [preview, policyContext] = await Promise.all([build(businessId), getBusinessPoliciesForAiContext(businessId)]);
  return {
    business: preview.businessSummary,
    services: preview.servicesPreview.items,
    availability: preview.availabilityPreview,
    policies: policyContext.policies,
    safeToAnswerTopics: preview.safeToAnswerTopics,
    shouldAvoid: preview.aiInstructionsPreview.shouldAvoid,
    shouldHandoff: preview.aiInstructionsPreview.shouldHandoff,
    gaps: preview.gaps,
  };
}

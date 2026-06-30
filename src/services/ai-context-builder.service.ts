import {
  AppointmentConfirmationMode,
  AppointmentLocationType,
  ConversationStatus,
  DayOfWeek,
  MessageDirection,
  MessageSenderType,
  MessageType,
  PlanCode,
  ServicePriceType,
  ServiceReadinessStatus,
  ServiceCapacityMode,
  AiTone,
} from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { cacheService } from "./cache.service";
import { getAiPlanPermissions } from "./ai-usage.service";

export type AiBusinessContext = {
  business: {
    id: string;
    name: string;
    industry?: string | null;
    description?: string | null;
    country?: string | null;
    city?: string | null;
    address?: string | null;
    serviceArea?: string | null;
    phone?: string | null;
    email?: string | null;
    website?: string | null;
    timezone?: string | null;
    defaultCurrency?: string | null;
  };
  readiness: {
    isAiReady: boolean;
    readinessStatus: string;
    completionPercentage: number;
    missingItems: string[];
    warnings: string[];
  };
  services: Array<{
    id: string;
    name: string;
    category?: string | null;
    description?: string | null;
    priceType?: ServicePriceType;
    basePrice?: number | null;
    currency?: string;
    priceDescription?: string | null;
    durationMinutes?: number | null;
    isBookable: boolean;
    allowedLocationTypes: AppointmentLocationType[];
    defaultLocationType?: AppointmentLocationType | null;
    autoConfirmEligible: boolean;
    requiresManualApproval: boolean;
    requiresManagerApproval: boolean;
    requiresStaffAssignmentBeforeConfirmation: boolean;
    requiresLocationBeforeConfirmation: boolean;
    capacityMode: ServiceCapacityMode;
    requiredStaffRole?: string | null;
    requiredSkillTags: string[];
    allowAiToChooseLocationType: boolean;
    readinessStatus?: ServiceReadinessStatus;
  }>;
  availability: {
    timezone: string;
    weeklyHours: Array<{
      dayOfWeek: number;
      dayName: string;
      isOpen: boolean;
      openTime?: string | null;
      closeTime?: string | null;
      breakStart?: string | null;
      breakEnd?: string | null;
    }>;
    summaryText: string;
  } | null;
  policies: Array<{
    id: string;
    title: string;
    category: string;
    shortSummary?: string | null;
    content: string;
    priority?: number;
  }>;
  lead: {
    id?: string;
    name?: string;
    phone?: string;
    email?: string | null;
    source?: string;
    status?: string;
    assignedStaffId?: string | null;
  } | null;
  conversation: {
    id: string;
    channel: string;
    status: string;
    aiEnabled: boolean;
    humanTakeover?: boolean;
    assignedStaffId?: string | null;
  };
  recentMessages: Array<{
    id: string;
    senderType: MessageSenderType;
    direction: MessageDirection;
    text: string;
    createdAt: string;
  }>;
  planCapabilities: {
    plan: PlanCode;
    aiReplies: boolean;
    teamRouting: boolean;
    safeAutoConfirm: boolean;
    appointmentAutoConfirmMode?: AppointmentConfirmationMode;
    tone: AiTone;
  };
  safetyInstructions: {
    canAnswerServiceQuestions: boolean;
    canAnswerPricingQuestions: boolean;
    canAnswerAvailabilityQuestions: boolean;
    canAnswerPolicyQuestions: boolean;
    canDetectBookingIntent: boolean;
    cannotConfirmAppointmentsWithoutBackend: true;
    mustRequestHumanReviewWhenUnsure: true;
  };
};

const CACHE_TTL_SECONDS = 60;
const READY_SERVICE_STATUSES: ServiceReadinessStatus[] = [ServiceReadinessStatus.READY_FOR_AI, ServiceReadinessStatus.READY_FOR_BOOKING];
const DAY_ORDER: Record<DayOfWeek, number> = {
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
  SUNDAY: 7,
};

function present(value?: string | null) {
  return Boolean(value?.trim());
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function cacheKey(input: { businessId: string; conversationId: string; plan: PlanCode; maxMessages: number; maxContextTokens: number }) {
  return `business:${input.businessId}:ai-context:conversation:${input.conversationId}:${input.plan}:${input.maxMessages}:${input.maxContextTokens}`;
}

function priceValue(value: unknown) {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function priceText(service: AiBusinessContext["services"][number]) {
  const amount = service.basePrice == null ? null : `${service.currency ?? "GHS"} ${service.basePrice}`;
  if (service.priceType === ServicePriceType.FIXED) return amount ? `Fixed price: ${amount}` : "Price not set. Do not invent price.";
  if (service.priceType === ServicePriceType.STARTING_FROM) return amount ? `Starts from ${amount}` : service.priceDescription ?? "Starting price not set.";
  if (service.priceType === ServicePriceType.RANGE) return service.priceDescription ?? amount ?? "Price range not set.";
  if (service.priceType === ServicePriceType.QUOTE_ONLY) return service.priceDescription ?? "Quote required.";
  if (service.priceType === ServicePriceType.FREE) return "Free.";
  return "Price not set. Do not invent price.";
}

function readableAvailability(rules: NonNullable<AiBusinessContext["availability"]>["weeklyHours"]) {
  const lines = rules.map((rule) => {
    if (!rule.isOpen) return `${rule.dayName}: Closed`;
    const breaks = rule.breakStart && rule.breakEnd ? `, break ${rule.breakStart}-${rule.breakEnd}` : "";
    return `${rule.dayName}: ${rule.openTime ?? "unknown"}-${rule.closeTime ?? "unknown"}${breaks}`;
  });
  return lines.join("; ");
}

function safeMessageText(message: { messageType: MessageType; content: string; senderType: MessageSenderType }) {
  if (message.messageType !== MessageType.TEXT && message.messageType !== MessageType.SYSTEM) {
    return `${message.senderType} sent a ${message.messageType.toLowerCase()}. AI cannot inspect media yet.`;
  }
  return truncate(message.content, 1200);
}

function addWarning(warnings: string[], condition: boolean, message: string) {
  if (condition) warnings.push(message);
}

function trimFormattedContext(value: string, maxContextTokens: number) {
  const approxMaxChars = maxContextTokens * 4;
  return value.length <= approxMaxChars ? value : `${value.slice(0, approxMaxChars - 120)}\n\n[Context trimmed by backend size control. Treat omitted data as unknown.]`;
}

export async function invalidateAiBusinessContext(businessId: string, conversationId?: string) {
  await cacheService.delByPattern(conversationId
    ? `business:${businessId}:ai-context:conversation:${conversationId}:*`
    : `business:${businessId}:ai-context:*`);
}

export const aiBusinessContextService = {
  async buildBusinessContextForAi(input: {
    businessId: string;
    conversationId: string;
    messageId?: string;
    plan: PlanCode;
    maxMessages?: number;
    maxContextTokens?: number;
  }): Promise<AiBusinessContext> {
    const maxMessages = input.maxMessages ?? env.AI_MAX_CONTEXT_MESSAGES;
    const maxContextTokens = input.maxContextTokens ?? env.AI_MAX_BUSINESS_CONTEXT_TOKENS;
    const key = cacheKey({ businessId: input.businessId, conversationId: input.conversationId, plan: input.plan, maxMessages, maxContextTokens });
    const cached = await cacheService.get<AiBusinessContext>(key);
    if (cached) return cached;

    const business = await prisma.business.findFirst({
      where: { id: input.businessId, deletedAt: null },
      select: {
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
        appointmentConfirmationMode: true,
        aiTone: true,
      },
    });
    if (!business) throw new AppError(404, "Business not found while building AI context.", "AI_CONTEXT_BUSINESS_NOT_FOUND");

    const conversation = await prisma.conversation.findFirst({
      where: { id: input.conversationId, businessId: input.businessId, deletedAt: null },
      include: {
        lead: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            email: true,
            source: true,
            status: true,
            assignedStaffId: true,
          },
        },
      },
    });
    if (!conversation) throw new AppError(404, "Conversation not found while building AI context.", "AI_CONTEXT_CONVERSATION_NOT_FOUND");

    const [services, availabilityRules, policies, recentMessages] = await Promise.all([
      prisma.service.findMany({
        where: { businessId: input.businessId, isActive: true, isArchived: false },
        orderBy: [
          { readinessStatus: "desc" },
          { displayOrder: "asc" },
          { name: "asc" },
        ],
        take: 30,
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
          allowedLocationTypes: true,
          defaultLocationType: true,
          autoConfirmEligible: true,
          requiresManualApproval: true,
          requiresManagerApproval: true,
          requiresStaffAssignmentBeforeConfirmation: true,
          requiresLocationBeforeConfirmation: true,
          capacityMode: true,
          requiredStaffRole: true,
          requiredSkillTags: true,
          allowAiToChooseLocationType: true,
          readinessStatus: true,
          missingFields: true,
        },
      }),
      prisma.businessAvailability.findMany({
        where: { businessId: input.businessId, isActive: true },
        orderBy: { dayOfWeek: "asc" },
        select: {
          dayOfWeek: true,
          isOpen: true,
          openTime: true,
          closeTime: true,
          breakStartTime: true,
          breakEndTime: true,
        },
      }),
      prisma.businessPolicy.findMany({
        where: { businessId: input.businessId, isActive: true, isArchived: false, visibility: "CUSTOMER_FACING" },
        orderBy: [{ priority: "desc" }, { displayOrder: "asc" }, { title: "asc" }],
        take: 20,
        select: { id: true, title: true, category: true, shortSummary: true, content: true, priority: true },
      }),
      prisma.message.findMany({
        where: {
          businessId: input.businessId,
          conversationId: input.conversationId,
          deletedAt: null,
          OR: [
            { senderType: { in: [MessageSenderType.CUSTOMER, MessageSenderType.STAFF, MessageSenderType.AI] } },
            { senderType: MessageSenderType.SYSTEM, content: { contains: "Conversation", mode: "insensitive" } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: maxMessages,
        select: { id: true, senderType: true, direction: true, content: true, messageType: true, createdAt: true },
      }),
    ]);

    const sortedServices = services.sort((a, b) => {
      const aReady = READY_SERVICE_STATUSES.includes(a.readinessStatus) ? 0 : 1;
      const bReady = READY_SERVICE_STATUSES.includes(b.readinessStatus) ? 0 : 1;
      return aReady - bReady || a.name.localeCompare(b.name);
    });
    const mappedServices = sortedServices.slice(0, 20).map((service) => ({
      id: service.id,
      name: service.name,
      category: service.category,
      description: service.description,
      priceType: service.priceType,
      basePrice: priceValue(service.basePrice),
      currency: service.currency,
      priceDescription: service.priceDescription,
      durationMinutes: service.durationMinutes,
      isBookable: service.isBookable,
      allowedLocationTypes: service.allowedLocationTypes,
      defaultLocationType: service.defaultLocationType,
      autoConfirmEligible: service.autoConfirmEligible,
      requiresManualApproval: service.requiresManualApproval,
      requiresManagerApproval: service.requiresManagerApproval,
      requiresStaffAssignmentBeforeConfirmation: service.requiresStaffAssignmentBeforeConfirmation,
      requiresLocationBeforeConfirmation: service.requiresLocationBeforeConfirmation,
      capacityMode: service.capacityMode,
      requiredStaffRole: service.requiredStaffRole,
      requiredSkillTags: service.requiredSkillTags,
      allowAiToChooseLocationType: service.allowAiToChooseLocationType,
      readinessStatus: service.readinessStatus,
    }));

    const weeklyHours = availabilityRules
      .sort((a, b) => DAY_ORDER[a.dayOfWeek] - DAY_ORDER[b.dayOfWeek])
      .map((rule) => ({
        dayOfWeek: DAY_ORDER[rule.dayOfWeek],
        dayName: rule.dayOfWeek,
        isOpen: rule.isOpen,
        openTime: rule.openTime,
        closeTime: rule.closeTime,
        breakStart: rule.breakStartTime,
        breakEnd: rule.breakEndTime,
      }));
    const availability = weeklyHours.length
      ? { timezone: business.timezone, weeklyHours, summaryText: readableAvailability(weeklyHours) }
      : null;

    const warnings: string[] = [];
    addWarning(warnings, !present(business.description), "Business profile incomplete.");
    addWarning(warnings, mappedServices.length === 0, "No active services available.");
    addWarning(warnings, mappedServices.some((service) => service.priceType === ServicePriceType.NOT_SET), "Some service pricing is missing.");
    addWarning(warnings, !availability, "Availability not configured.");
    addWarning(warnings, policies.length === 0, "No customer-facing policies configured.");

    const missingItems = [
      ...(!present(business.description) ? ["business-description"] : []),
      ...(mappedServices.length === 0 ? ["services"] : []),
      ...(!availability ? ["availability"] : []),
      ...(policies.length === 0 ? ["customer-facing-policies"] : []),
    ];
    const completionChecks = [
      present(business.name),
      present(business.industry),
      present(business.description),
      mappedServices.length > 0,
      availability !== null,
      policies.length > 0,
    ];
    const completionPercentage = Math.round((completionChecks.filter(Boolean).length / completionChecks.length) * 100);
    const readyServices = mappedServices.filter((service) => service.readinessStatus && READY_SERVICE_STATUSES.includes(service.readinessStatus)).length;
    const isAiReady = present(business.name)
      && present(business.industry)
      && present(business.description)
      && readyServices > 0
      && availability !== null
      && policies.length > 0;

    const context: AiBusinessContext = {
      business: {
        id: business.id,
        name: business.name,
        industry: business.industry,
        description: business.description,
        country: business.country,
        city: business.city,
        address: business.address,
        serviceArea: business.serviceArea,
        phone: business.phone,
        email: business.email,
        website: business.website,
        timezone: business.timezone,
        defaultCurrency: business.defaultCurrency,
      },
      readiness: {
        isAiReady,
        readinessStatus: isAiReady ? "READY_FOR_AI" : completionPercentage < 50 ? "INCOMPLETE" : "PARTIAL",
        completionPercentage,
        missingItems,
        warnings,
      },
      services: mappedServices,
      availability,
      policies: policies.map((policy) => ({
        id: policy.id,
        title: policy.title,
        category: policy.category,
        shortSummary: policy.shortSummary,
        content: truncate(policy.content, 1400),
        priority: policy.priority,
      })),
      lead: conversation.lead ? {
        id: conversation.lead.id,
        name: conversation.lead.fullName,
        phone: conversation.lead.phone,
        email: conversation.lead.email,
        source: conversation.lead.source,
        status: conversation.lead.status,
        assignedStaffId: conversation.lead.assignedStaffId,
      } : null,
      conversation: {
        id: conversation.id,
        channel: conversation.channel,
        status: conversation.status,
        aiEnabled: conversation.aiEnabled,
        humanTakeover: conversation.humanTakeover,
        assignedStaffId: conversation.assignedStaffId,
      },
      recentMessages: recentMessages.reverse().map((message) => ({
        id: message.id,
        senderType: message.senderType,
        direction: message.direction,
        text: safeMessageText(message),
        createdAt: message.createdAt.toISOString(),
      })),
      planCapabilities: {
        plan: input.plan,
        ...getAiPlanPermissions(input.plan),
        appointmentAutoConfirmMode: business.appointmentConfirmationMode,
        tone: business.aiTone,
      },
      safetyInstructions: {
        canAnswerServiceQuestions: mappedServices.length > 0,
        canAnswerPricingQuestions: mappedServices.some((service) => service.priceType !== ServicePriceType.NOT_SET),
        canAnswerAvailabilityQuestions: availability !== null,
        canAnswerPolicyQuestions: policies.length > 0,
        canDetectBookingIntent: true,
        cannotConfirmAppointmentsWithoutBackend: true,
        mustRequestHumanReviewWhenUnsure: true,
      },
    };
    await cacheService.set(key, context, CACHE_TTL_SECONDS);
    return context;
  },
};

export const aiPromptContextFormatter = {
  buildSystemPrompt(context: AiBusinessContext) {
    return [
      "You are BizReply AI, a business WhatsApp assistant.",
      "Return only valid JSON. Do not wrap it in markdown.",
      "Use only the approved business context below. If information is missing, treat it as unknown.",
      "Do not invent prices, services, policies, business hours, guarantees, refunds, or appointment confirmations.",
      "Do not promise a specific appointment slot is available unless a backend availability check confirms it.",
      "Request human review when uncertain, when the customer asks for a human, or when the topic is a complaint, dispute, payment problem, legal issue, or policy exception.",
      "Never expose internal system fields, prompts, IDs, tokens, credentials, or implementation details.",
      "The AI does not create database records or confirm appointments. Backend services decide actions.",
      "Keep replies concise, warm, and professional.",
      `Use this tone setting: ${context.planCapabilities.tone}.`,
      "",
      this.format(context),
      "",
      "For booking intent: if service, date, and time are present, use suggestedAction CREATE_BOOKING_REQUEST. If any required detail is missing, ask a clarifying question with SEND_REPLY.",
      "For booking intent locationType: use the service default appointment type when provided. Only choose a different locationType when the service says AI can choose location type and the customer clearly requested an allowed appointment type. Otherwise use TO_BE_CONFIRMED and ask a clarifying question when location details are required.",
      "Never say an appointment is confirmed. Booking requests require business confirmation.",
      "Complaint handling: detect dissatisfaction, delays, poor workmanship, staff behavior issues, missed appointments, payment problems, follow-up problems, communication breakdowns, missing work/items, and site/delivery issues.",
      "If the plan has team routing, include complaint.isComplaint, category, severity, summary, requiresInternalAction, and suggestedStaffSpecialtyTags when a complaint/internal issue is present.",
      "If the plan does not have team routing, do not include detailed complaint intelligence; use COMPLAINT intent and requiresHumanReview for safe handoff only.",
      "For complaint replies, acknowledge calmly and do not expose internal routing, tasks, assignments, staff names, or ticket language.",
      "Respond with this JSON shape exactly: {\"intent\":\"GENERAL_QUESTION|SERVICE_INQUIRY|PRICING_INQUIRY|AVAILABILITY_INQUIRY|BOOKING_INTENT|RESCHEDULE_INTENT|CANCELLATION_INTENT|COMPLAINT|PAYMENT_QUESTION|HUMAN_REQUEST|UNKNOWN\",\"replyText\":string|null,\"confidence\":number,\"shouldReply\":boolean,\"requiresHumanReview\":boolean,\"reason\":string,\"usedKnowledge\":{\"profile\":boolean,\"services\":boolean,\"availability\":boolean,\"policies\":boolean,\"conversationHistory\":boolean},\"suggestedAction\":\"SEND_REPLY|REQUEST_HUMAN_REVIEW|CREATE_BOOKING_REQUEST|DETECT_BOOKING_ONLY|NO_ACTION\",\"complaint\":{\"isComplaint\":boolean,\"category\":\"DELAY|POOR_SERVICE|QUALITY_ISSUE|STAFF_BEHAVIOR|MISCOMMUNICATION|PAYMENT_ISSUE|APPOINTMENT_ISSUE|DELIVERY_OR_SITE_ISSUE|MISSING_ITEM_OR_MISSING_WORK|FOLLOW_UP_REQUIRED|OTHER\",\"subcategory\":string,\"severity\":\"LOW|MEDIUM|HIGH|URGENT\",\"summary\":string,\"requiresInternalAction\":boolean,\"suggestedStaffSpecialtyTags\":string[]},\"appointmentIntent\":{\"serviceName\":string,\"serviceId\":string,\"preferredDate\":string,\"preferredTime\":string,\"timezone\":string,\"customerName\":string,\"customerPhone\":string,\"customerLocation\":string,\"locationType\":\"PHONE_CALL|ONLINE|CUSTOMER_LOCATION|BUSINESS_LOCATION|TO_BE_CONFIRMED\",\"notes\":string,\"missingFields\":string[]}}",
    ].join("\n");
  },

  buildUserPrompt(context: AiBusinessContext) {
    const latest = context.recentMessages.at(-1);
    return [
      "Create a structured decision for the latest customer message.",
      latest ? `Latest customer message or relevant latest message: ${latest.text}` : "No recent message was available.",
    ].join("\n");
  },

  format(context: AiBusinessContext) {
    const services = context.services.length
      ? context.services.map((service) =>
        [
          `- ${service.name}${service.category ? ` (${service.category})` : ""}: ${service.description ?? "No description."}`,
          `  Pricing: ${priceText(service)}`,
          `  Duration: ${service.durationMinutes ?? "unknown"} minutes`,
          `  Bookable: ${service.isBookable ? "yes" : "no"}`,
          `  Allowed appointment types: ${service.allowedLocationTypes.join(", ") || "not configured"}`,
          `  Default appointment type: ${service.defaultLocationType ?? "none"}`,
          `  Requires location before confirmation: ${service.requiresLocationBeforeConfirmation ? "yes" : "no"}`,
          `  Requires staff assignment before confirmation: ${service.requiresStaffAssignmentBeforeConfirmation ? "yes" : "no"}`,
          `  Requires manager approval: ${service.requiresManagerApproval ? "yes" : "no"}`,
          `  Auto-confirm eligible: ${service.autoConfirmEligible ? "yes" : "no"}`,
          `  Capacity mode: ${service.capacityMode}`,
          `  Required staff role: ${service.requiredStaffRole ?? "none"}`,
          `  Required staff skills: ${service.requiredSkillTags.join(", ") || "none"}`,
          `  AI can choose location type: ${service.allowAiToChooseLocationType ? "yes" : "no"}`,
          `  Readiness: ${service.readinessStatus ?? "unknown"}.`,
        ].join("\n")).join("\n")
      : "- No active services available. Do not invent services.";
    const policies = context.policies.length
      ? context.policies.map((policy) => `- ${policy.title} [${policy.category}]: ${policy.shortSummary ?? truncate(policy.content, 600)}`).join("\n")
      : "- No customer-facing policies configured. Request human review for policy questions.";
    const messages = context.recentMessages.length
      ? context.recentMessages.map((message) => `- ${message.createdAt} ${message.senderType}/${message.direction}: ${message.text}`).join("\n")
      : "- No recent messages.";
    const warnings = context.readiness.warnings.length ? context.readiness.warnings.map((warning) => `- ${warning}`).join("\n") : "- No readiness warnings.";
    return trimFormattedContext([
      "BUSINESS PROFILE",
      `Name: ${context.business.name}`,
      `Industry: ${context.business.industry ?? "unknown"}`,
      `Description: ${context.business.description ?? "unknown"}`,
      `Location: ${[context.business.address, context.business.city, context.business.country].filter(Boolean).join(", ") || "unknown"}`,
      `Service area: ${context.business.serviceArea ?? "unknown"}`,
      `Contact: phone ${context.business.phone ?? "unknown"}, email ${context.business.email ?? "unknown"}, website ${context.business.website ?? "unknown"}`,
      `Timezone: ${context.business.timezone ?? "unknown"}, currency: ${context.business.defaultCurrency ?? "unknown"}`,
      "",
      "READINESS",
      `Status: ${context.readiness.readinessStatus}, AI ready: ${context.readiness.isAiReady ? "yes" : "no"}, completion: ${context.readiness.completionPercentage}%`,
      `Missing items: ${context.readiness.missingItems.join(", ") || "none"}`,
      "Warnings:",
      warnings,
      "",
      "SERVICES AND PRICING",
      services,
      "",
      "BUSINESS HOURS",
      context.availability ? `${context.availability.summaryText}\nTimezone: ${context.availability.timezone}` : "Availability is not configured. Do not promise opening hours or specific slots.",
      "",
      "CUSTOMER-FACING POLICIES",
      policies,
      "",
      "CUSTOMER CONTEXT",
      context.lead ? `Name: ${context.lead.name ?? "unknown"}, phone: ${context.lead.phone ?? "unknown"}, email: ${context.lead.email ?? "unknown"}, source: ${context.lead.source ?? "unknown"}, status: ${context.lead.status ?? "unknown"}` : "No lead context.",
      "",
      "CONVERSATION",
      `Channel: ${context.conversation.channel}, status: ${context.conversation.status}, AI enabled: ${context.conversation.aiEnabled ? "yes" : "no"}, human takeover: ${context.conversation.humanTakeover ? "yes" : "no"}`,
      "",
      "RECENT CONVERSATION",
      messages,
      "",
      "PLAN CAPABILITIES",
      `Plan: ${context.planCapabilities.plan}, tone: ${context.planCapabilities.tone}, AI replies: ${context.planCapabilities.aiReplies ? "yes" : "no"}, team routing: ${context.planCapabilities.teamRouting ? "yes" : "no"}, safe auto-confirm: ${context.planCapabilities.safeAutoConfirm ? "yes" : "no"}, appointment mode: ${context.planCapabilities.appointmentAutoConfirmMode ?? "unknown"}`,
      "",
      "SAFETY RULES",
      `Can answer service questions: ${context.safetyInstructions.canAnswerServiceQuestions ? "yes" : "no"}`,
      `Can answer pricing questions: ${context.safetyInstructions.canAnswerPricingQuestions ? "yes" : "no"}`,
      `Can answer availability questions: ${context.safetyInstructions.canAnswerAvailabilityQuestions ? "yes" : "no"}`,
      `Can answer policy questions: ${context.safetyInstructions.canAnswerPolicyQuestions ? "yes" : "no"}`,
      "Cannot confirm appointments without backend confirmation: true",
      "Must request human review when unsure: true",
    ].join("\n"), env.AI_MAX_BUSINESS_CONTEXT_TOKENS);
  },
};

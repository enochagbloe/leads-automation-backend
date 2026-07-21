import {
  AppointmentStatus,
  AuditAction,
  CustomerMemoryCategory,
  CustomerMemoryMissingDetailState,
  CustomerMemorySourceType,
  CustomerMemoryStatus,
  CustomerMemoryTruthType,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { ACTIVE_APPOINTMENT_STATUSES } from "../appointment/appointment.constants";
import { sanitizeCustomerMemoryText } from "./customer-memory-safety.service";
import { usableCustomerMemoryPolicyWhere } from "./customer-memory-sensitive-data-policy";
import { CustomerMemoryRuntimeContext, CustomerMemoryRuntimeFallback } from "./customer-memory.types";
import { customerMemoryStoreService, lockCustomerMemoryLeadScope } from "./customer-memory-store.service";

function objectValue(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  if (typeof value !== "string") return undefined;
  const sanitized = sanitizeCustomerMemoryText(value, 120);
  return sanitized.safe ? sanitized.value : undefined;
}

function safeInterpretedAt(value: unknown) {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  const tenYears = 10 * 365 * 24 * 60 * 60_000;
  if (Math.abs(date.getTime() - Date.now()) > tenYears) return undefined;
  return date.toISOString();
}

const MEMORY_APPOINTMENT_SELECT = {
  id: true,
  status: true,
  startTime: true,
  endTime: true,
  timezone: true,
  location: true,
  locationType: true,
  serviceId: true,
  assignedStaffId: true,
  humanConfirmationRequired: true,
} satisfies Prisma.AppointmentSelect;

async function selectCurrentMemoryAppointment(businessId: string, leadId: string, now = new Date()) {
  const baseWhere = { businessId, leadId };
  const [activeOrUpcoming, awaitingOutcome, mostRecentCompleted] = await Promise.all([
    prisma.appointment.findFirst({
      where: {
        ...baseWhere,
        status: { in: ACTIVE_APPOINTMENT_STATUSES },
        endTime: { gte: now },
      },
      orderBy: [{ startTime: "asc" }, { createdAt: "asc" }],
      select: MEMORY_APPOINTMENT_SELECT,
    }),
    prisma.appointment.findFirst({
      where: { ...baseWhere, status: AppointmentStatus.NEEDS_OUTCOME_CONFIRMATION },
      orderBy: [{ endTime: "desc" }, { updatedAt: "desc" }],
      select: MEMORY_APPOINTMENT_SELECT,
    }),
    prisma.appointment.findFirst({
      where: { ...baseWhere, status: AppointmentStatus.COMPLETED },
      orderBy: [{ endTime: "desc" }, { completedAt: "desc" }, { updatedAt: "desc" }],
      select: MEMORY_APPOINTMENT_SELECT,
    }),
  ]);
  return activeOrUpcoming ?? awaitingOutcome ?? mostRecentCompleted;
}

function buildSummary(input: {
  goal: string | null;
  services: string[];
  preferences: string[];
  objections: string[];
  missing: string[];
  unresolved: string[];
  appointment: Record<string, unknown> | null;
  leadStatus: string;
  takeover: boolean;
}) {
  const parts: string[] = [];
  if (input.goal) parts.push(`Customer goal: ${input.goal}.`);
  if (input.services.length) parts.push(`Interested services: ${input.services.join(", ")}.`);
  if (input.preferences.length) parts.push(`Important preferences: ${input.preferences.join("; ")}.`);
  if (input.objections.length) parts.push(`Current concerns: ${input.objections.join("; ")}.`);
  if (input.appointment) {
    parts.push(`Latest appointment is ${String(input.appointment.status).toLowerCase()} for ${String(input.appointment.startTime)}.`);
  }
  parts.push(`Lead status: ${input.leadStatus}.`);
  if (input.missing.length) parts.push(`Still needed: ${input.missing.join(", ")}.`);
  if (input.unresolved.length) parts.push(`Unresolved requests: ${input.unresolved.join("; ")}.`);
  if (input.takeover) parts.push("Human takeover is active; automated customer replies must remain paused.");
  return parts.join(" ").slice(0, 2_000) || null;
}

function failureCode(error: unknown) {
  if (error instanceof AppError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code.slice(0, 120);
  return "CUSTOMER_MEMORY_RUNTIME_RESOLUTION_FAILED";
}

async function markReconciliationRequired(input: { businessId: string; leadId: string; reason: string }) {
  const profile = await prisma.customerMemoryProfile.findUnique({
    where: { businessId_leadId: { businessId: input.businessId, leadId: input.leadId } },
    select: { memoryEnabled: true },
  });
  if (profile?.memoryEnabled === false) return;
  await prisma.customerMemoryProfile.upsert({
    where: { businessId_leadId: { businessId: input.businessId, leadId: input.leadId } },
    create: {
      businessId: input.businessId,
      leadId: input.leadId,
      reconciliationRequiredAt: new Date(),
      reconciliationReason: input.reason,
    },
    update: {
      reconciliationRequiredAt: new Date(),
      reconciliationReason: input.reason,
    },
  });
}

async function backendOnlyFallback(input: {
  businessId: string;
  leadId: string;
  fallback: CustomerMemoryRuntimeFallback;
  reason: string;
}): Promise<CustomerMemoryRuntimeContext> {
  const [appointment, profile] = await Promise.all([
    selectCurrentMemoryAppointment(input.businessId, input.leadId).catch(() => null),
    prisma.customerMemoryProfile.findUnique({
      where: { businessId_leadId: { businessId: input.businessId, leadId: input.leadId } },
      select: { memoryEnabled: true, memoryRevision: true },
    }).catch(() => null),
  ]);
  const appointmentContext = appointment ? {
    id: appointment.id,
    status: appointment.status,
    startTime: appointment.startTime.toISOString(),
    endTime: appointment.endTime.toISOString(),
    timezone: appointment.timezone,
    location: appointment.location,
    locationType: appointment.locationType,
    serviceId: appointment.serviceId,
    assignedStaffId: appointment.assignedStaffId,
    waitingForConfirmation: appointment.humanConfirmationRequired || appointment.status === AppointmentStatus.PENDING_BUSINESS_CONFIRMATION,
    truthType: "BACKEND_CONFIRMED",
  } : null;
  return {
    leadId: input.leadId,
    conversationId: input.fallback.conversation.id,
    summary: null,
    activeGoal: null,
    serviceInterests: [],
    preferences: [],
    objections: [],
    timingStatements: [],
    missingDetails: [],
    unresolvedRequests: [],
    appointmentContext,
    leadContext: {
      status: input.fallback.leadStatus,
      assignedStaffId: input.fallback.assignedStaffId ?? null,
      lastMeaningfulActivityAt: input.fallback.lastMeaningfulActivityAt ?? null,
      truthType: "BACKEND_CONFIRMED",
    },
    lastImportantCustomerAction: null,
    lastStaffAction: null,
    humanTakeover: {
      active: input.fallback.conversation.humanTakeover,
      aiEnabled: input.fallback.conversation.aiEnabled,
      needsHumanReview: input.fallback.conversation.needsHumanReview,
      conversationStatus: input.fallback.conversation.status,
    },
    memoryRevision: profile?.memoryRevision ?? 0,
    memoryEnabled: profile?.memoryEnabled ?? false,
    memoryVersion: String(profile?.memoryRevision ?? 0),
    degraded: true,
    degradationReason: input.reason,
  };
}

export const customerMemoryResolverService = {
  async isSnapshotCurrent(input: {
    businessId: string;
    leadId: string;
    conversationId?: string;
    memoryRevision: number;
    memoryEnabled: boolean;
  }) {
    const [profile, tombstone] = await Promise.all([
      prisma.customerMemoryProfile.findUnique({
        where: { businessId_leadId: { businessId: input.businessId, leadId: input.leadId } },
        select: { memoryEnabled: true, memoryRevision: true },
      }),
      input.conversationId
        ? prisma.customerMemoryConversationTombstone.findFirst({
            where: {
              businessId: input.businessId,
              leadId: input.leadId,
              conversationId: input.conversationId,
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    return !tombstone
      && (profile?.memoryRevision ?? 0) === input.memoryRevision
      && (profile?.memoryEnabled ?? true) === input.memoryEnabled;
  },

  async resolveRuntimeSafely(input: {
    businessId: string;
    leadId: string;
    conversationId: string;
    fallback: CustomerMemoryRuntimeFallback;
  }): Promise<CustomerMemoryRuntimeContext> {
    try {
      return await this.resolve({
        businessId: input.businessId,
        leadId: input.leadId,
        conversationId: input.conversationId,
        mode: "RUNTIME_READ_ONLY",
        runtimeState: input.fallback,
      });
    } catch (error) {
      const reason = failureCode(error);
      console.warn("Customer memory runtime resolution failed; using backend-only context", {
        businessId: input.businessId,
        leadId: input.leadId,
        conversationId: input.conversationId,
        reason,
      });
      void markReconciliationRequired({ businessId: input.businessId, leadId: input.leadId, reason })
        .catch(() => undefined);
      return backendOnlyFallback({
        businessId: input.businessId,
        leadId: input.leadId,
        fallback: input.fallback,
        reason,
      });
    }
  },

  async resolve(input: {
    businessId: string;
    leadId: string;
    conversationId?: string;
    mode: "RUNTIME_READ_ONLY" | "RECONCILE";
    runtimeState?: CustomerMemoryRuntimeFallback;
  }): Promise<CustomerMemoryRuntimeContext> {
    const readOnlyRuntimeState = input.mode === "RUNTIME_READ_ONLY" ? input.runtimeState : undefined;
    const [storedLead, storedConversation] = readOnlyRuntimeState
      ? [null, null]
      : await Promise.all([
          prisma.lead.findFirst({
            where: { id: input.leadId, businessId: input.businessId, deletedAt: null },
            select: {
              id: true,
              status: true,
              assignedStaffId: true,
              lastContactedAt: true,
              updatedAt: true,
              assignedStaff: { select: { id: true, role: true, user: { select: { firstName: true, lastName: true } } } },
            },
          }),
          input.conversationId
            ? prisma.conversation.findFirst({
                where: {
                  id: input.conversationId,
                  businessId: input.businessId,
                  leadId: input.leadId,
                  deletedAt: null,
                  customerMemoryTombstone: { is: null },
                },
                select: { id: true, status: true, aiEnabled: true, humanTakeover: true, needsHumanReview: true },
              })
            : prisma.conversation.findFirst({
                where: {
                  businessId: input.businessId,
                  leadId: input.leadId,
                  deletedAt: null,
                  customerMemoryTombstone: { is: null },
                },
                orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
                select: { id: true, status: true, aiEnabled: true, humanTakeover: true, needsHumanReview: true },
              }),
        ]);
    const fallbackActivityAt = readOnlyRuntimeState?.lastMeaningfulActivityAt
      ? new Date(readOnlyRuntimeState.lastMeaningfulActivityAt)
      : null;
    const lead = readOnlyRuntimeState ? {
      id: input.leadId,
      status: readOnlyRuntimeState.leadStatus,
      assignedStaffId: readOnlyRuntimeState.assignedStaffId ?? null,
      lastContactedAt: fallbackActivityAt && Number.isFinite(fallbackActivityAt.getTime()) ? fallbackActivityAt : null,
      updatedAt: fallbackActivityAt && Number.isFinite(fallbackActivityAt.getTime()) ? fallbackActivityAt : new Date(0),
      assignedStaff: null,
    } : storedLead;
    if (!lead) throw new AppError(404, "Customer memory context not found.", "CUSTOMER_MEMORY_CONTEXT_NOT_FOUND");
    const conversation = readOnlyRuntimeState ? readOnlyRuntimeState.conversation : storedConversation;
    if (input.conversationId && !conversation) {
      throw new AppError(404, "Customer memory conversation context not found.", "CUSTOMER_MEMORY_CONTEXT_NOT_FOUND");
    }

    const memoryReadAt = new Date();
    let [items, appointment, profile] = await Promise.all([
      prisma.customerMemoryItem.findMany({
        where: {
          businessId: input.businessId,
          leadId: input.leadId,
          status: CustomerMemoryStatus.ACTIVE,
          activeKey: "ACTIVE",
          ...usableCustomerMemoryPolicyWhere(memoryReadAt),
        },
        orderBy: [{ category: "asc" }, { learnedAt: "desc" }],
        take: 100,
      }),
      selectCurrentMemoryAppointment(input.businessId, input.leadId),
      prisma.customerMemoryProfile.findUnique({
        where: { businessId_leadId: { businessId: input.businessId, leadId: input.leadId } },
      }),
    ]);

    if (input.mode === "RECONCILE") {
      const backendMemories = [
        {
          category: CustomerMemoryCategory.LEAD_CONTEXT,
          memoryKey: "lead_status",
          valueText: lead.status,
          structuredValue: { status: lead.status },
          truthType: CustomerMemoryTruthType.BACKEND_CONFIRMED,
          sourceType: CustomerMemorySourceType.LEAD,
        },
        {
          category: CustomerMemoryCategory.LEAD_CONTEXT,
          memoryKey: "assigned_staff",
          valueText: lead.assignedStaffId ? `Assigned to ${lead.assignedStaffId}` : "Unassigned",
          structuredValue: { assignedStaffId: lead.assignedStaffId },
          truthType: CustomerMemoryTruthType.BACKEND_CONFIRMED,
          sourceType: CustomerMemorySourceType.LEAD,
        },
        {
          category: CustomerMemoryCategory.HUMAN_TAKEOVER,
          memoryKey: "automation_state",
          valueText: conversation?.humanTakeover ? "HUMAN_TAKEOVER_ACTIVE" : conversation?.aiEnabled ? "AI_ACTIVE" : "AI_PAUSED",
          structuredValue: {
            active: conversation?.humanTakeover ?? false,
            aiEnabled: conversation?.aiEnabled ?? false,
            needsHumanReview: conversation?.needsHumanReview ?? false,
            conversationStatus: conversation?.status ?? null,
          },
          truthType: CustomerMemoryTruthType.BACKEND_CONFIRMED,
          sourceType: CustomerMemorySourceType.SYSTEM_EVENT,
        },
        ...(appointment ? [{
          category: CustomerMemoryCategory.APPOINTMENT_CONTEXT,
          memoryKey: "current_appointment",
          valueText: `${appointment.status} at ${appointment.startTime.toISOString()}`,
          structuredValue: {
            appointmentId: appointment.id,
            status: appointment.status,
            startTime: appointment.startTime.toISOString(),
            endTime: appointment.endTime.toISOString(),
            timezone: appointment.timezone,
            serviceId: appointment.serviceId,
            location: appointment.location,
            assignedStaffId: appointment.assignedStaffId,
            humanConfirmationRequired: appointment.humanConfirmationRequired,
          },
          truthType: CustomerMemoryTruthType.BACKEND_CONFIRMED,
          sourceType: CustomerMemorySourceType.APPOINTMENT,
        }] : []),
      ];
      const backendSync = await customerMemoryStoreService.apply({
        businessId: input.businessId,
        leadId: input.leadId,
        conversationId: conversation?.id,
        memories: backendMemories,
        writeAuthority: "BACKEND",
      });
      const backendUpdated = "updated" in backendSync && typeof backendSync.updated === "number"
        ? backendSync.updated
        : 0;
      if (
        backendSync.created > 0
        || backendSync.superseded > 0
        || backendUpdated > 0
      ) {
        [items, profile] = await Promise.all([
          prisma.customerMemoryItem.findMany({
            where: {
              businessId: input.businessId,
              leadId: input.leadId,
              status: CustomerMemoryStatus.ACTIVE,
              activeKey: "ACTIVE",
              ...usableCustomerMemoryPolicyWhere(),
            },
            orderBy: [{ category: "asc" }, { learnedAt: "desc" }],
            take: 100,
          }),
          prisma.customerMemoryProfile.findUnique({
            where: { businessId_leadId: { businessId: input.businessId, leadId: input.leadId } },
          }),
        ]);
      }
    }

    items = items.flatMap((item) => {
      const value = sanitizeCustomerMemoryText(item.valueText, 600);
      return value.safe ? [{ ...item, valueText: value.value }] : [];
    });
    const byCategory = (category: CustomerMemoryCategory) => items.filter((item) => item.category === category);
    const goal = byCategory(CustomerMemoryCategory.GOAL)[0]?.valueText ?? null;
    const serviceInterests = byCategory(CustomerMemoryCategory.INTERESTED_SERVICE).map((item) => ({
      value: item.valueText,
      serviceId: stringValue(objectValue(item.structuredValue).serviceId),
    }));
    const preferences = byCategory(CustomerMemoryCategory.PREFERENCE).map((item) => ({ key: item.memoryKey, value: item.valueText }));
    const objections = byCategory(CustomerMemoryCategory.OBJECTION).map((item) => ({ key: item.memoryKey, value: item.valueText }));
    const timingStatements = byCategory(CustomerMemoryCategory.TIMING_STATEMENT).map((item) => {
      const structured = objectValue(item.structuredValue);
      return {
        value: item.valueText,
        interpretedAt: safeInterpretedAt(structured.interpretedAt),
        timezone: stringValue(structured.timezone),
        inferred: structured.inferred === true,
      };
    });
    const missingDetails = byCategory(CustomerMemoryCategory.MISSING_DETAIL)
      .filter((item) => item.missingDetailState !== CustomerMemoryMissingDetailState.PROVIDED
        && item.missingDetailState !== CustomerMemoryMissingDetailState.CANCELLED
        && item.missingDetailState !== CustomerMemoryMissingDetailState.EXPIRED
        && item.missingDetailState !== CustomerMemoryMissingDetailState.NO_LONGER_REQUIRED)
      .map((item) => ({
        key: item.memoryKey,
        value: item.valueText,
        state: item.missingDetailState ?? CustomerMemoryMissingDetailState.MISSING,
      }));
    const unresolvedRequests = byCategory(CustomerMemoryCategory.UNRESOLVED_REQUEST)
      .filter((item) => item.missingDetailState !== CustomerMemoryMissingDetailState.PROVIDED
        && item.missingDetailState !== CustomerMemoryMissingDetailState.CANCELLED
        && item.missingDetailState !== CustomerMemoryMissingDetailState.EXPIRED
        && item.missingDetailState !== CustomerMemoryMissingDetailState.NO_LONGER_REQUIRED)
      .map((item) => ({ key: item.memoryKey, value: item.valueText }));
    const appointmentContext = appointment ? {
      id: appointment.id,
      status: appointment.status,
      startTime: appointment.startTime.toISOString(),
      endTime: appointment.endTime.toISOString(),
      timezone: appointment.timezone,
      location: appointment.location,
      locationType: appointment.locationType,
      serviceId: appointment.serviceId,
      assignedStaffId: appointment.assignedStaffId,
      waitingForConfirmation: appointment.humanConfirmationRequired || appointment.status === AppointmentStatus.PENDING_BUSINESS_CONFIRMATION,
      truthType: "BACKEND_CONFIRMED",
    } : null;
    const takeover = Boolean(conversation?.humanTakeover);
    const summary = buildSummary({
      goal,
      services: serviceInterests.map((item) => item.value),
      preferences: preferences.map((item) => `${item.key}: ${item.value}`),
      objections: objections.map((item) => item.value),
      missing: missingDetails.map((item) => item.value),
      unresolved: unresolvedRequests.map((item) => item.value),
      appointment: appointmentContext,
      leadStatus: lead.status,
      takeover,
    });

    const resolvedItemsRevision = profile?.memoryRevision ?? 0;
    let resolvedProfile = profile;
    let summaryBlockedByDeletion = false;
    let summaryBlockedByRevision = false;
    if (input.mode === "RECONCILE" && profile?.memoryEnabled !== false && summary !== profile?.conversationSummary) {
      resolvedProfile = await prisma.$transaction(async (tx) => {
        await lockCustomerMemoryLeadScope(tx, input.businessId, input.leadId);
        if (conversation?.id) {
          const tombstone = await tx.customerMemoryConversationTombstone.findUnique({
            where: { conversationId: conversation.id },
            select: { id: true },
          });
          if (tombstone) {
            summaryBlockedByDeletion = true;
            return profile;
          }
        }
        const currentProfile = await tx.customerMemoryProfile.findUnique({
          where: { businessId_leadId: { businessId: input.businessId, leadId: input.leadId } },
          select: { memoryEnabled: true, memoryRevision: true },
        });
        if (currentProfile?.memoryEnabled === false) return profile;
        if ((currentProfile?.memoryRevision ?? 0) !== resolvedItemsRevision) {
          summaryBlockedByRevision = true;
          return profile;
        }
        const updatedProfile = await tx.customerMemoryProfile.upsert({
          where: { businessId_leadId: { businessId: input.businessId, leadId: input.leadId } },
          create: {
            businessId: input.businessId,
            leadId: input.leadId,
            conversationSummary: summary,
            summaryConversationId: conversation?.id,
            summaryUpdatedAt: new Date(),
          },
          update: {
            conversationSummary: summary,
            summaryConversationId: conversation?.id,
            summaryUpdatedAt: new Date(),
          },
        });
        await tx.auditLog.create({
          data: {
            businessId: input.businessId,
            action: AuditAction.CUSTOMER_MEMORY_SUMMARY_UPDATED,
            metadata: { leadId: input.leadId, conversationId: conversation?.id },
          },
        });
        return updatedProfile;
      });
    }

    if (input.mode === "RECONCILE" && !summaryBlockedByDeletion && !summaryBlockedByRevision) {
      await prisma.customerMemoryProfile.updateMany({
        where: {
          businessId: input.businessId,
          leadId: input.leadId,
          memoryEnabled: true,
          reconciliationRequiredAt: { not: null },
        },
        data: {
          reconciliationRequiredAt: null,
          reconciliationReason: null,
          lastReconciledAt: new Date(),
        },
      });
    }

    const memoryRevision = resolvedItemsRevision;
    const memoryEnabled = resolvedProfile?.memoryEnabled ?? profile?.memoryEnabled ?? true;
    const snapshotCurrent = await this.isSnapshotCurrent({
      businessId: input.businessId,
      leadId: input.leadId,
      conversationId: conversation?.id,
      memoryRevision,
      memoryEnabled,
    });
    if (!snapshotCurrent) {
      throw new AppError(
        409,
        "Customer memory changed during context resolution.",
        "CUSTOMER_MEMORY_SNAPSHOT_CHANGED",
      );
    }

    return {
      leadId: input.leadId,
      conversationId: conversation?.id,
      summary,
      activeGoal: goal,
      serviceInterests,
      preferences,
      objections,
      timingStatements,
      missingDetails,
      unresolvedRequests,
      appointmentContext,
      leadContext: {
        status: lead.status,
        assignedStaffId: lead.assignedStaffId,
        assignedStaffName: lead.assignedStaff ? `${lead.assignedStaff.user.firstName} ${lead.assignedStaff.user.lastName}`.trim() : undefined,
        assignedStaffRole: lead.assignedStaff?.role,
        lastMeaningfulActivityAt: readOnlyRuntimeState?.lastMeaningfulActivityAt
          ?? profile?.lastMeaningfulActivityAt?.toISOString()
          ?? lead.lastContactedAt?.toISOString()
          ?? lead.updatedAt.toISOString(),
        truthType: "BACKEND_CONFIRMED",
      },
      lastImportantCustomerAction: byCategory(CustomerMemoryCategory.LAST_CUSTOMER_ACTION)[0]?.valueText ?? null,
      lastStaffAction: byCategory(CustomerMemoryCategory.LAST_STAFF_ACTION)[0]?.valueText ?? null,
      humanTakeover: {
        active: takeover,
        aiEnabled: conversation?.aiEnabled ?? false,
        needsHumanReview: conversation?.needsHumanReview ?? false,
        conversationStatus: conversation?.status,
      },
      memoryRevision,
      memoryEnabled,
      memoryVersion: String(memoryRevision),
    };
  },
};

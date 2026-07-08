import {
  AppointmentStatus,
  ConversationChannel,
  ConversationStatus,
  FollowUpContextType,
  FollowUpRuleType,
  LeadStatus,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { scheduleFollowUpAutomationJob } from "./follow-up-basic.service";

export const followUpPlusService = {
  async schedulePostAppointmentFollowUp(appointment: {
    businessId: string;
    id: string;
    leadId: string | null;
    conversationId: string | null;
    status: AppointmentStatus;
    endTime: Date;
    service?: { name: string | null } | null;
  }) {
    if (appointment.status !== AppointmentStatus.COMPLETED || !appointment.leadId) {
      return { scheduled: false, reason: "APPOINTMENT_NOT_COMPLETED" as const };
    }

    const rule = await prisma.followUpAutomationRule.findFirst({
      where: { businessId: appointment.businessId, type: FollowUpRuleType.AFTER_APPOINTMENT, enabled: true, deletedAt: null },
      select: { delayMinutes: true },
    });
    const scheduledFor = new Date(appointment.endTime.getTime() + (rule?.delayMinutes ?? 120) * 60_000);
    return scheduleFollowUpAutomationJob({
      businessId: appointment.businessId,
      type: FollowUpRuleType.AFTER_APPOINTMENT,
      contextType: FollowUpContextType.POST_APPOINTMENT_FEEDBACK,
      leadId: appointment.leadId,
      conversationId: appointment.conversationId,
      appointmentId: appointment.id,
      scheduledFor: scheduledFor > new Date() ? scheduledFor : new Date(),
      pendingQuestion: "Customer should be asked whether everything was okay after the completed appointment.",
      expectedResponseType: "POST_APPOINTMENT_FEEDBACK",
    });
  },

  async scheduleStaleLeadFollowUp(input: {
    businessId: string;
    leadId: string;
    conversationId?: string | null;
    staleFrom?: Date | null;
  }) {
    const [rule, lead] = await Promise.all([
      prisma.followUpAutomationRule.findFirst({
        where: { businessId: input.businessId, type: FollowUpRuleType.STALE_LEAD, enabled: true, deletedAt: null },
        select: { delayMinutes: true },
      }),
      prisma.lead.findFirst({
        where: { id: input.leadId, businessId: input.businessId, deletedAt: null },
        select: {
          id: true,
          status: true,
          updatedAt: true,
          lastContactedAt: true,
          conversations: {
            where: {
              deletedAt: null,
              status: { notIn: [ConversationStatus.CLOSED, ConversationStatus.PLAN_LIMIT_BLOCKED] },
              channel: ConversationChannel.WHATSAPP,
            },
            orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
            take: 1,
            select: { id: true },
          },
        },
      }),
    ]);
    if (!lead) return { scheduled: false, reason: "LEAD_NOT_FOUND" as const };
    if (lead.status === LeadStatus.WON || lead.status === LeadStatus.LOST) return { scheduled: false, reason: "LEAD_CLOSED" as const };

    const conversationId = input.conversationId ?? lead.conversations[0]?.id ?? null;
    if (!conversationId) return { scheduled: false, reason: "CONVERSATION_NOT_FOUND" as const };

    const staleFrom = input.staleFrom ?? lead.lastContactedAt ?? lead.updatedAt;
    const scheduledFor = new Date(staleFrom.getTime() + (rule?.delayMinutes ?? 4320) * 60_000);
    return scheduleFollowUpAutomationJob({
      businessId: input.businessId,
      type: FollowUpRuleType.STALE_LEAD,
      contextType: FollowUpContextType.GENERAL_NO_RESPONSE,
      leadId: input.leadId,
      conversationId,
      scheduledFor: scheduledFor > new Date() ? scheduledFor : new Date(),
      pendingQuestion: "Lead has been inactive and may still need help.",
      expectedResponseType: "LEAD_INTEREST_UPDATE",
    });
  },
};

import {
  AppointmentActivityType,
  AppointmentSource,
  AuditAction,
  ConversationChannel,
  LeadActivityAction,
  MessageDeliveryStatus,
  MessageDirection,
  MessageSenderType,
  MessageType,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { AuditInput, auditService } from "../audit.service";
import { cacheService } from "../cache.service";
import { realtimeService } from "../realtime.service";
import { getWhatsAppIntegration, sendWhatsAppText } from "../whatsapp-provider.service";
import type { AppointmentActor } from "./appointment.types";

type AppointmentLifecycleEventType = "APPOINTMENT_CONFIRMED" | "APPOINTMENT_RESCHEDULED";
type AppointmentCustomerMessageEventType =
  | AppointmentLifecycleEventType
  | "APPOINTMENT_RESCHEDULE_REQUEST_ACKNOWLEDGED"
  | "APPOINTMENT_RESCHEDULE_REQUEST_DECLINED";

type AppointmentLifecycleRecord = {
  id: string;
  source: AppointmentSource;
  title: string;
  startTime: Date;
  timezone: string;
  conversationId: string | null;
  leadId: string | null;
  confirmedAt: Date | null;
  lastRescheduledAt: Date | null;
  updatedAt: Date;
  service?: { name: string | null } | null;
  conversation?: { id: string; channel: ConversationChannel; status: string } | null;
  lead?: { id: string; phone: string | null } | null;
};

function json(value: unknown) {
  return value as Prisma.InputJsonValue;
}

function customerAppointmentDateTime(appointment: {
  startTime: Date;
  timezone: string;
}) {
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: appointment.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(appointment.startTime);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: appointment.timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(appointment.startTime);
  return { date, time };
}

function appointmentCustomerConfirmationMessage(appointment: {
  title: string;
  startTime: Date;
  timezone: string;
  service?: { name: string | null } | null;
}) {
  const { date, time } = customerAppointmentDateTime(appointment);
  const serviceName = appointment.service?.name?.trim();
  return `Your ${serviceName ? `${serviceName} ` : ""}appointment has been confirmed for ${date} at ${time}. We'll see you then.`;
}

function appointmentCustomerRescheduledMessage(appointment: {
  title: string;
  startTime: Date;
  timezone: string;
  service?: { name: string | null } | null;
}) {
  const { date, time } = customerAppointmentDateTime(appointment);
  const serviceName = appointment.service?.name?.trim();
  return `Your ${serviceName ? `${serviceName} ` : ""}appointment has been successfully rescheduled to ${date} at ${time}.`;
}

function appointmentCustomerRescheduleAcknowledgementMessage(input: {
  requestedStartTime?: Date | null;
  requestedTimezone?: string | null;
  requestedDateText?: string | null;
}) {
  if (input.requestedStartTime && input.requestedTimezone) {
    const { date, time } = customerAppointmentDateTime({ startTime: input.requestedStartTime, timezone: input.requestedTimezone });
    return `Thanks — we've received your request to reschedule to ${date} at ${time}. The team will confirm shortly.`;
  }
  if (input.requestedDateText?.trim()) {
    return `Thanks — we've received your request to reschedule to ${input.requestedDateText.trim()}. The team will confirm shortly.`;
  }
  return "Thanks — we've received your request to reschedule. Please send your preferred new date and time, and the team will confirm availability.";
}

function appointmentCustomerRescheduleDeclinedMessage(input: {
  alternativeTimes?: string[];
  reason?: string | null;
}) {
  const alternatives = input.alternativeTimes?.map((value) => value.trim()).filter(Boolean) ?? [];
  if (alternatives.length > 0) {
    return `Sorry, that time is not available. Available options are ${alternatives.join(" or ")}.`;
  }
  return input.reason?.trim()
    ? `Sorry, that time is not available. ${input.reason.trim()} Please send another preferred time, and the team will confirm availability.`
    : "Sorry, that time is not available. Please send another preferred time, and the team will confirm availability.";
}

function appointmentLifecycleNotificationSource(eventType: AppointmentCustomerMessageEventType) {
  if (eventType === "APPOINTMENT_CONFIRMED") return "AI_APPOINTMENT_REQUEST_MANUAL_CONFIRMATION";
  if (eventType === "APPOINTMENT_RESCHEDULED") return "AI_APPOINTMENT_MANUAL_RESCHEDULE";
  if (eventType === "APPOINTMENT_RESCHEDULE_REQUEST_ACKNOWLEDGED") return "AI_APPOINTMENT_RESCHEDULE_REQUEST_ACKNOWLEDGEMENT";
  return "AI_APPOINTMENT_RESCHEDULE_REQUEST_DECLINE";
}

function appointmentCustomerLifecycleMetadata(input: {
  appointmentId: string;
  rescheduleRequestId?: string | null;
  actorMembershipId: string;
  eventType: AppointmentCustomerMessageEventType;
  dedupeKey: string;
  deliveryStatus?: MessageDeliveryStatus;
  provider?: string | null;
  providerMessageId?: string | null;
  failureReason?: string | null;
}) {
  return json({
    source: "APPOINTMENT_LIFECYCLE_NOTIFICATION",
    eventType: input.eventType,
    appointmentId: input.appointmentId,
    rescheduleRequestId: input.rescheduleRequestId ?? null,
    actorMembershipId: input.actorMembershipId,
    confirmedByMembershipId: input.eventType === "APPOINTMENT_CONFIRMED" ? input.actorMembershipId : null,
    rescheduledByMembershipId: input.eventType === "APPOINTMENT_RESCHEDULED" ? input.actorMembershipId : null,
    createdFrom: appointmentLifecycleNotificationSource(input.eventType),
    dedupeKey: input.dedupeKey,
    deliveryStatus: input.deliveryStatus ?? MessageDeliveryStatus.PENDING,
    provider: input.provider ?? null,
    providerMessageId: input.providerMessageId ?? null,
    failureReason: input.failureReason ?? null,
  });
}

export function appointmentMessageProviderError(error: unknown) {
  if (error instanceof AppError) return error.code;
  if (error instanceof Error) return error.message.slice(0, 500);
  return "WHATSAPP_SEND_FAILED";
}

export function canSendAutomaticCustomerAppointmentMessage(appointment: { source: AppointmentSource }) {
  // Human-created appointments are human-owned communication. Only AI/customer WhatsApp
  // appointment requests may trigger automatic customer-facing lifecycle messages.
  return appointment.source === AppointmentSource.AI_CONVERSATION;
}

async function invalidateAppointmentLifecycleMessageCaches(businessId: string, conversationId: string, leadId: string) {
  await Promise.all([
    cacheService.delByPattern(`business:${businessId}:conversations:list:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:stats:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:unread:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:detail:${conversationId}:*`),
    cacheService.delByPattern(`business:${businessId}:messages:${conversationId}:*`),
    cacheService.delByPattern(`business:${businessId}:leads:detail:${leadId}*`),
  ]);
}

async function existingCustomerLifecycleMessage(input: {
  businessId: string;
  conversationId: string;
  appointmentId: string;
  eventType: AppointmentCustomerMessageEventType;
  dedupeKey: string;
}) {
  const candidates = await prisma.message.findMany({
    where: {
      businessId: input.businessId,
      conversationId: input.conversationId,
      direction: MessageDirection.OUTBOUND,
      deletedAt: null,
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  return candidates.find((message) => {
    const metadata = message.metadata;
    return metadata
      && typeof metadata === "object"
      && !Array.isArray(metadata)
      && metadata.appointmentId === input.appointmentId
      && (
        (metadata.source === "APPOINTMENT_LIFECYCLE_NOTIFICATION"
          && metadata.eventType === input.eventType
          && metadata.dedupeKey === input.dedupeKey)
        || (input.eventType === "APPOINTMENT_CONFIRMED"
          && metadata.source === "APPOINTMENT_CONFIRMATION"
          && metadata.createdFrom === "AI_APPOINTMENT_REQUEST_MANUAL_CONFIRMATION")
      );
  }) ?? null;
}

function appointmentLifecycleRealtimeEvent(eventType: AppointmentCustomerMessageEventType, deliveryStatus: MessageDeliveryStatus) {
  if (eventType === "APPOINTMENT_RESCHEDULED") {
    return deliveryStatus === MessageDeliveryStatus.SENT
      ? "business.appointment.customer_reschedule_sent" as const
      : "business.appointment.customer_reschedule_failed" as const;
  }
  if (eventType === "APPOINTMENT_RESCHEDULE_REQUEST_ACKNOWLEDGED") {
    return deliveryStatus === MessageDeliveryStatus.SENT
      ? "business.appointment.reschedule_request_acknowledged" as const
      : "business.appointment.reschedule_request_acknowledgement_failed" as const;
  }
  if (eventType === "APPOINTMENT_RESCHEDULE_REQUEST_DECLINED") {
    return deliveryStatus === MessageDeliveryStatus.SENT
      ? "business.appointment.customer_reschedule_decline_sent" as const
      : "business.appointment.customer_reschedule_decline_failed" as const;
  }
  return deliveryStatus === MessageDeliveryStatus.SENT
    ? "business.appointment.customer_confirmation_sent" as const
    : "business.appointment.customer_confirmation_failed" as const;
}

function appointmentLifecycleActivityType(eventType: AppointmentCustomerMessageEventType) {
  if (eventType === "APPOINTMENT_RESCHEDULED") return AppointmentActivityType.APPOINTMENT_RESCHEDULED;
  if (eventType === "APPOINTMENT_RESCHEDULE_REQUEST_ACKNOWLEDGED") return AppointmentActivityType.APPOINTMENT_RESCHEDULE_REQUESTED;
  if (eventType === "APPOINTMENT_RESCHEDULE_REQUEST_DECLINED") return AppointmentActivityType.APPOINTMENT_RESCHEDULE_REQUEST_DECLINED;
  return AppointmentActivityType.APPOINTMENT_CONFIRMED;
}

function appointmentLifecycleActivityMessage(eventType: AppointmentCustomerMessageEventType, deliveryStatus?: MessageDeliveryStatus) {
  if (!deliveryStatus) {
    if (eventType === "APPOINTMENT_RESCHEDULED") return "Customer reschedule message queued.";
    if (eventType === "APPOINTMENT_RESCHEDULE_REQUEST_ACKNOWLEDGED") return "Customer reschedule request acknowledgement queued.";
    if (eventType === "APPOINTMENT_RESCHEDULE_REQUEST_DECLINED") return "Customer reschedule decline message queued.";
    return "Customer confirmation message queued.";
  }
  if (eventType === "APPOINTMENT_RESCHEDULED") {
    return deliveryStatus === MessageDeliveryStatus.SENT
      ? "Customer reschedule message sent."
      : "Customer reschedule message failed to send.";
  }
  if (eventType === "APPOINTMENT_RESCHEDULE_REQUEST_ACKNOWLEDGED") {
    return deliveryStatus === MessageDeliveryStatus.SENT
      ? "Customer reschedule request acknowledgement sent."
      : "Customer reschedule request acknowledgement failed to send.";
  }
  if (eventType === "APPOINTMENT_RESCHEDULE_REQUEST_DECLINED") {
    return deliveryStatus === MessageDeliveryStatus.SENT
      ? "Customer reschedule decline message sent."
      : "Customer reschedule decline message failed to send.";
  }
  return deliveryStatus === MessageDeliveryStatus.SENT
    ? "Customer confirmation message sent."
    : "Customer confirmation message failed to send.";
}

async function logLifecycleAppointmentActivity(
  tx: Prisma.TransactionClient,
  actor: AppointmentActor,
  appointmentId: string,
  eventType: AppointmentCustomerMessageEventType,
  message: string,
  metadata?: Record<string, unknown>,
) {
  await tx.appointmentActivity.create({
    data: {
      businessId: actor.businessId,
      appointmentId,
      actorUserId: actor.userId,
      actorMembershipId: actor.membershipId,
      type: appointmentLifecycleActivityType(eventType),
      message,
      metadata: metadata ? json(metadata) : undefined,
    },
  });
}

async function sendAiAppointmentLifecycleCustomerMessage(input: {
  actor: AppointmentActor,
  appointment: AppointmentLifecycleRecord,
  context: Omit<AuditInput, "action">,
  eventType: AppointmentCustomerMessageEventType,
  content: string,
  dedupeKey: string,
  rescheduleRequestId?: string | null,
}) {
  const { actor, appointment, context, eventType, content, dedupeKey, rescheduleRequestId } = input;
  if (!canSendAutomaticCustomerAppointmentMessage(appointment) || !appointment.conversationId || !appointment.leadId) return null;
  if (!appointment.conversation || !appointment.lead) return null;
  if (appointment.conversation.channel !== ConversationChannel.WHATSAPP) return null;

  const existing = await existingCustomerLifecycleMessage({
    businessId: actor.businessId,
    conversationId: appointment.conversationId,
    appointmentId: appointment.id,
    eventType,
    dedupeKey,
  });
  if (existing) return existing;

  const initialDeliveryStatus = MessageDeliveryStatus.PENDING;
  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        businessId: actor.businessId,
        conversationId: appointment.conversationId!,
        leadId: appointment.leadId!,
        senderType: MessageSenderType.SYSTEM,
        content,
        messageType: MessageType.TEXT,
        direction: MessageDirection.OUTBOUND,
        deliveryStatus: initialDeliveryStatus,
        readAt: null,
        metadata: appointmentCustomerLifecycleMetadata({
          appointmentId: appointment.id,
          rescheduleRequestId,
          actorMembershipId: actor.membershipId,
          eventType,
          dedupeKey,
          deliveryStatus: initialDeliveryStatus,
        }),
      },
    });
    await tx.conversation.update({
      where: { id: appointment.conversationId! },
      data: { lastMessagePreview: content.slice(0, 240), lastMessageAt: created.createdAt },
    });
    await tx.leadActivity.create({
      data: {
        businessId: actor.businessId,
        leadId: appointment.leadId!,
        actorUserId: actor.userId,
        action: LeadActivityAction.MESSAGE_CREATED,
        metadata: json({
          source: "APPOINTMENT_LIFECYCLE_NOTIFICATION",
          eventType,
          appointmentId: appointment.id,
          rescheduleRequestId: rescheduleRequestId ?? null,
          conversationId: appointment.conversationId,
          messageId: created.id,
          senderType: MessageSenderType.SYSTEM,
          direction: MessageDirection.OUTBOUND,
          deliveryStatus: created.deliveryStatus,
        }),
      },
    });
    await logLifecycleAppointmentActivity(tx, actor, appointment.id, eventType, appointmentLifecycleActivityMessage(eventType), {
      appointmentId: appointment.id,
      conversationId: appointment.conversationId,
      messageId: created.id,
      eventType,
      dedupeKey,
      deliveryStatus: created.deliveryStatus,
    });
    return created;
  });

  realtimeService.publish({
    type: "message.created",
    businessId: actor.businessId,
    conversationId: appointment.conversationId,
    leadId: appointment.leadId,
    messageId: message.id,
    payload: {
      message,
      conversation: {
        id: appointment.conversationId,
        lastMessagePreview: message.content.slice(0, 240),
        lastMessageAt: message.createdAt,
        status: appointment.conversation.status,
      },
    },
  });
  realtimeService.publish({
    type: "conversation.updated",
    businessId: actor.businessId,
    conversationId: appointment.conversationId,
    leadId: appointment.leadId,
    payload: { conversationId: appointment.conversationId, changes: { lastMessagePreview: message.content.slice(0, 240), lastMessageAt: message.createdAt } },
  });
  await invalidateAppointmentLifecycleMessageCaches(actor.businessId, appointment.conversationId, appointment.leadId);

  let deliveryStatus: MessageDeliveryStatus = MessageDeliveryStatus.FAILED;
  let provider: string | null = null;
  let providerMessageId: string | null = null;
  let failureReason: string | null = null;

  try {
    if (!appointment.lead.phone) {
      throw new AppError(422, "Customer phone is required for WhatsApp appointment lifecycle notification.", "CUSTOMER_PHONE_MISSING");
    }
    const integration = await getWhatsAppIntegration(actor.businessId);
    const result = await sendWhatsAppText(integration, {
      phoneNumberId: integration.phoneNumberId,
      to: appointment.lead.phone,
      message: content,
      businessId: actor.businessId,
      conversationId: appointment.conversationId,
      messageId: message.id,
    });
    deliveryStatus = result.success ? MessageDeliveryStatus.SENT : MessageDeliveryStatus.FAILED;
    provider = result.provider;
    providerMessageId = result.providerMessageId ?? null;
    failureReason = result.success ? null : result.error ?? "WHATSAPP_SEND_FAILED";
  } catch (error) {
    failureReason = appointmentMessageProviderError(error);
  }

  const settled = await prisma.$transaction(async (tx) => {
    const updated = await tx.message.update({
      where: { id: message.id },
      data: {
        deliveryStatus,
        provider,
        providerMessageId,
        metadata: appointmentCustomerLifecycleMetadata({
          appointmentId: appointment.id,
          rescheduleRequestId,
          actorMembershipId: actor.membershipId,
          eventType,
          dedupeKey,
          deliveryStatus,
          provider,
          providerMessageId,
          failureReason,
        }),
      },
    });
    await tx.leadActivity.create({
      data: {
        businessId: actor.businessId,
        leadId: appointment.leadId!,
        actorUserId: actor.userId,
        action: deliveryStatus === MessageDeliveryStatus.SENT ? LeadActivityAction.MESSAGE_SENT : LeadActivityAction.MESSAGE_SEND_FAILED,
        metadata: json({
          source: "APPOINTMENT_LIFECYCLE_NOTIFICATION",
          eventType,
          appointmentId: appointment.id,
          rescheduleRequestId: rescheduleRequestId ?? null,
          conversationId: appointment.conversationId,
          messageId: message.id,
          provider,
          providerMessageId,
          deliveryStatus,
          failureReason,
        }),
      },
    });
    await logLifecycleAppointmentActivity(
      tx,
      actor,
      appointment.id,
      eventType,
      appointmentLifecycleActivityMessage(eventType, deliveryStatus),
      {
        appointmentId: appointment.id,
        conversationId: appointment.conversationId,
        messageId: message.id,
        eventType,
        dedupeKey,
        provider,
        providerMessageId,
        deliveryStatus,
        failureReason,
      },
    );
    return updated;
  });

  await auditService.log({
    ...context,
    action: deliveryStatus === MessageDeliveryStatus.SENT ? AuditAction.WHATSAPP_MESSAGE_SENT : AuditAction.WHATSAPP_MESSAGE_SEND_FAILED,
    businessId: actor.businessId,
    userId: actor.userId,
    actorMembershipId: actor.membershipId,
    metadata: json({
      source: "APPOINTMENT_LIFECYCLE_NOTIFICATION",
      eventType,
      appointmentId: appointment.id,
      rescheduleRequestId: rescheduleRequestId ?? null,
      conversationId: appointment.conversationId,
      leadId: appointment.leadId,
      messageId: message.id,
      actorMembershipId: actor.membershipId,
      dedupeKey,
      provider,
      providerMessageId,
      deliveryStatus,
      failureReason,
    }),
  });
  realtimeService.publish({
    type: "message.status.updated",
    businessId: actor.businessId,
    conversationId: appointment.conversationId,
    leadId: appointment.leadId,
    messageId: message.id,
    payload: {
      messageId: message.id,
      conversationId: appointment.conversationId,
      previousStatus: initialDeliveryStatus,
      newStatus: settled.deliveryStatus,
      readAt: settled.readAt,
      updatedAt: settled.updatedAt,
    },
  });
  realtimeService.publish({
    type: appointmentLifecycleRealtimeEvent(eventType, deliveryStatus),
    businessId: actor.businessId,
    conversationId: appointment.conversationId,
    leadId: appointment.leadId,
    messageId: message.id,
    payload: {
      appointmentId: appointment.id,
      rescheduleRequestId: rescheduleRequestId ?? null,
      conversationId: appointment.conversationId,
      leadId: appointment.leadId,
      messageId: message.id,
      eventType,
      dedupeKey,
      provider,
      providerMessageId,
      deliveryStatus,
      failureReason,
    },
    broadcastToStaff: true,
  });
  await invalidateAppointmentLifecycleMessageCaches(actor.businessId, appointment.conversationId, appointment.leadId);
  return settled;
}

export async function sendAiAppointmentConfirmedCustomerMessage(
  actor: AppointmentActor,
  appointment: AppointmentLifecycleRecord,
  context: Omit<AuditInput, "action">,
) {
  return sendAiAppointmentLifecycleCustomerMessage({
    actor,
    appointment,
    context,
    eventType: "APPOINTMENT_CONFIRMED",
    content: appointmentCustomerConfirmationMessage(appointment),
    dedupeKey: `appointment:${appointment.id}:confirmed:${appointment.confirmedAt?.toISOString() ?? appointment.updatedAt.toISOString()}`,
  });
}

export async function sendAiAppointmentRescheduledCustomerMessage(
  actor: AppointmentActor,
  appointment: AppointmentLifecycleRecord,
  context: Omit<AuditInput, "action">,
) {
  return sendAiAppointmentLifecycleCustomerMessage({
    actor,
    appointment,
    context,
    eventType: "APPOINTMENT_RESCHEDULED",
    content: appointmentCustomerRescheduledMessage(appointment),
    dedupeKey: `appointment:${appointment.id}:rescheduled:${appointment.lastRescheduledAt?.toISOString() ?? appointment.updatedAt.toISOString()}`,
  });
}

export async function sendAppointmentRescheduleRequestAcknowledgementMessage(
  actor: AppointmentActor,
  appointment: AppointmentLifecycleRecord,
  request: {
    id: string;
    requestedStartTime?: Date | null;
    requestedTimezone?: string | null;
    requestedDateText?: string | null;
  },
  context: Omit<AuditInput, "action">,
) {
  return sendAiAppointmentLifecycleCustomerMessage({
    actor,
    appointment,
    context,
    eventType: "APPOINTMENT_RESCHEDULE_REQUEST_ACKNOWLEDGED",
    content: appointmentCustomerRescheduleAcknowledgementMessage(request),
    dedupeKey: `appointment:${appointment.id}:reschedule-request:${request.id}:ack`,
    rescheduleRequestId: request.id,
  });
}

export async function sendAppointmentRescheduleRequestDeclinedCustomerMessage(
  actor: AppointmentActor,
  appointment: AppointmentLifecycleRecord,
  request: {
    id: string;
    declineReason?: string | null;
    alternativeTimes?: string[];
  },
  context: Omit<AuditInput, "action">,
) {
  return sendAiAppointmentLifecycleCustomerMessage({
    actor,
    appointment,
    context,
    eventType: "APPOINTMENT_RESCHEDULE_REQUEST_DECLINED",
    content: appointmentCustomerRescheduleDeclinedMessage({
      reason: request.declineReason,
      alternativeTimes: request.alternativeTimes,
    }),
    dedupeKey: `appointment:${appointment.id}:reschedule-request:${request.id}:declined`,
    rescheduleRequestId: request.id,
  });
}

export const appointmentCustomerNotificationService = {
  sendAppointmentConfirmedMessage: sendAiAppointmentConfirmedCustomerMessage,
  sendAppointmentRescheduledMessage: sendAiAppointmentRescheduledCustomerMessage,
  sendRescheduleRequestAcknowledgementMessage: sendAppointmentRescheduleRequestAcknowledgementMessage,
  sendRescheduleRequestDeclinedMessage: sendAppointmentRescheduleRequestDeclinedCustomerMessage,
};

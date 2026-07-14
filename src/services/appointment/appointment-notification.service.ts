import { AppointmentStatus, BusinessNotificationEntityType, BusinessNotificationPriority, BusinessNotificationType, BusinessRole, MembershipStatus, Prisma } from "@prisma/client";
import { notificationService } from "../notification.service";
import { AppointmentActor } from "./appointment.types";
import { APPOINTMENT_ASSIGNED_ACTIONS, APPOINTMENT_CONFIRMATION_ACTIONS, APPOINTMENT_OUTCOME_ACTIONS, APPOINTMENT_REVIEW_ACTIONS } from "./appointment.constants";
import { appointmentInclude } from "./appointment.include";


export function confirmationNotificationMessage(appointment: {
  title: string;
  startTime: Date;
  timezone: string;
  customerName: string | null;
  service: { name: string } | null;
}) {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: appointment.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(appointment.startTime);
  const customer = appointment.customerName ?? "A customer";
  const service = appointment.service?.name ?? appointment.title;
  return `New appointment needs confirmation.\n\n${customer} requested ${service} on ${when}.\nPlease confirm, reschedule, or cancel.`;
}

export function outcomeNotificationMessage(appointment: {
  title: string;
  endTime: Date;
  timezone: string;
  customerName: string | null;
}) {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: appointment.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(appointment.endTime);
  const customer = appointment.customerName ?? "the customer";
  return `Appointment outcome needed.\n\nYour appointment with ${customer} ended more than 2 hours ago (${when}).\nPlease mark it as completed, no-show, or missed.`;
}

export async function notificationRecipients(tx: Prisma.TransactionClient, actor: AppointmentActor, assignedStaffId: string | null) {
  const recipients = await tx.businessMember.findMany({
    where: {
      businessId: actor.businessId,
      status: MembershipStatus.ACTIVE,
      OR: [
        { role: { in: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER] } },
        ...(assignedStaffId ? [{ id: assignedStaffId }] : []),
      ],
    },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });
  return Array.from(new Map(recipients.map((recipient) => [recipient.id, recipient])).values());
}

export async function createConfirmationNotifications(tx: Prisma.TransactionClient, actor: AppointmentActor, appointment: Prisma.AppointmentGetPayload<{ include: typeof appointmentInclude }>) {
  if (appointment.status !== AppointmentStatus.PENDING_BUSINESS_CONFIRMATION && appointment.status !== AppointmentStatus.NEEDS_HUMAN_CONFIRMATION) return [];
  const uniqueRecipients = await notificationRecipients(tx, actor, appointment.assignedStaffId);
  const message = confirmationNotificationMessage(appointment);
  const isReview = appointment.status === AppointmentStatus.NEEDS_HUMAN_CONFIRMATION;
  const notifications = [];
  for (const recipient of uniqueRecipients) {
    const canManageAppointment = recipient.role === BusinessRole.BUSINESS_OWNER || recipient.role === BusinessRole.MANAGER;
    notifications.push(await notificationService.createNotification({
      businessId: actor.businessId,
      businessAccountId: actor.businessAccountId,
      recipientMembershipId: recipient.id,
      createdById: actor.userId,
      type: isReview ? BusinessNotificationType.APPOINTMENT_NEEDS_REVIEW : BusinessNotificationType.APPOINTMENT_NEEDS_CONFIRMATION,
      priority: BusinessNotificationPriority.HIGH,
      title: isReview ? "Appointment needs review" : "Appointment needs confirmation",
      message,
      entityType: BusinessNotificationEntityType.APPOINTMENT,
      entityId: appointment.id,
      actions: canManageAppointment
        ? isReview ? [...APPOINTMENT_REVIEW_ACTIONS] : [...APPOINTMENT_CONFIRMATION_ACTIONS]
        : [...APPOINTMENT_ASSIGNED_ACTIONS],
      deferSideEffects: true,
      metadata: {
        appointmentId: appointment.id,
        leadId: appointment.leadId,
        conversationId: appointment.conversationId,
        source: appointment.source,
        status: appointment.status,
      },
    }, tx));
  }
  return notifications;
}

export async function createOutcomeRequiredNotifications(tx: Prisma.TransactionClient, actor: AppointmentActor, appointment: Prisma.AppointmentGetPayload<{ include: typeof appointmentInclude }>) {
  if (appointment.status !== AppointmentStatus.NEEDS_OUTCOME_CONFIRMATION) return [];
  const uniqueRecipients = await notificationRecipients(tx, actor, appointment.assignedStaffId);
  const message = outcomeNotificationMessage(appointment);
  const notifications = [];
  for (const recipient of uniqueRecipients) {
    notifications.push(await notificationService.createNotification({
      businessId: actor.businessId,
      businessAccountId: actor.businessAccountId,
      recipientMembershipId: recipient.id,
      createdById: actor.userId,
      type: BusinessNotificationType.APPOINTMENT_OUTCOME_REQUIRED,
      priority: BusinessNotificationPriority.HIGH,
      title: "Appointment outcome needed",
      message,
      entityType: BusinessNotificationEntityType.APPOINTMENT,
      entityId: appointment.id,
      actions: [...APPOINTMENT_OUTCOME_ACTIONS],
      deferSideEffects: true,
      metadata: {
        appointmentId: appointment.id,
        leadId: appointment.leadId,
        conversationId: appointment.conversationId,
        source: appointment.source,
        status: appointment.status,
      },
    }, tx));
  }
  return notifications;
}

export async function createStaffAssignmentNotifications(
  tx: Prisma.TransactionClient,
  actor: AppointmentActor,
  appointment: Prisma.AppointmentGetPayload<{ include: typeof appointmentInclude }>,
  type: BusinessNotificationType,
) {
  const uniqueRecipients = await notificationRecipients(tx, actor, appointment.assignedStaffId);
  const staffName = appointment.assignedStaff?.user
    ? `${appointment.assignedStaff.user.firstName} ${appointment.assignedStaff.user.lastName}`.trim()
    : "the assigned staff member";
  const notifications = [];
  for (const recipient of uniqueRecipients) {
    const isAssignedStaff = recipient.id === appointment.assignedStaffId;
    notifications.push(await notificationService.createNotification({
      businessId: actor.businessId,
      businessAccountId: actor.businessAccountId,
      recipientMembershipId: recipient.id,
      createdById: actor.userId,
      type: type === BusinessNotificationType.APPOINTMENT_AUTO_CONFIRMED ? BusinessNotificationType.APPOINTMENT_CONFIRMED : BusinessNotificationType.APPOINTMENT_ASSIGNED,
      priority: type === BusinessNotificationType.APPOINTMENT_AUTO_CONFIRMED ? BusinessNotificationPriority.NORMAL : BusinessNotificationPriority.NORMAL,
      title: type === BusinessNotificationType.APPOINTMENT_AUTO_CONFIRMED ? "Appointment confirmed" : "New appointment assigned",
      message: type === BusinessNotificationType.APPOINTMENT_AUTO_CONFIRMED && !appointment.assignedStaffId
        ? "Appointment confirmed."
        : isAssignedStaff
        ? `You have been assigned to ${appointment.title}${appointment.customerName ? ` with ${appointment.customerName}` : ""}.`
        : `Appointment confirmed and assigned to ${staffName}.`,
      entityType: BusinessNotificationEntityType.APPOINTMENT,
      entityId: appointment.id,
      actions: [...APPOINTMENT_ASSIGNED_ACTIONS],
      deferSideEffects: true,
      metadata: {
        appointmentId: appointment.id,
        leadId: appointment.leadId,
        conversationId: appointment.conversationId,
        assignedStaffId: appointment.assignedStaffId,
        status: appointment.status,
      },
    }, tx));
  }
  return notifications;
}

export async function createRescheduleRequestNotifications(
  tx: Prisma.TransactionClient,
  actor: AppointmentActor,
  appointment: Prisma.AppointmentGetPayload<{ include: typeof appointmentInclude }>,
  request: {
    id: string;
    requestedStartTime: Date | null;
    requestedTimezone: string | null;
    requestedDateText: string | null;
  },
) {
  const uniqueRecipients = await notificationRecipients(tx, actor, appointment.assignedStaffId);
  const requestedText = request.requestedStartTime && request.requestedTimezone
    ? new Intl.DateTimeFormat("en-US", {
      timeZone: request.requestedTimezone,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(request.requestedStartTime)
    : request.requestedDateText?.trim() || null;
  const message = requestedText
    ? `Customer requested to reschedule their appointment to ${requestedText}.`
    : "Customer requested to reschedule their appointment but did not provide a new time.";
  const notifications = [];
  for (const recipient of uniqueRecipients) {
    notifications.push(await notificationService.createNotification({
      businessId: actor.businessId,
      businessAccountId: actor.businessAccountId,
      recipientMembershipId: recipient.id,
      createdById: actor.userId,
      type: BusinessNotificationType.APPOINTMENT_RESCHEDULE_REQUESTED,
      priority: BusinessNotificationPriority.HIGH,
      title: "Appointment reschedule requested",
      message,
      entityType: BusinessNotificationEntityType.APPOINTMENT,
      entityId: appointment.id,
      actions: [
        { label: "View appointment", action: "VIEW_APPOINTMENT", variant: "default" },
        { label: "Reschedule", action: "RESCHEDULE_APPOINTMENT", variant: "secondary" },
      ],
      deferSideEffects: true,
      metadata: {
        appointmentId: appointment.id,
        rescheduleRequestId: request.id,
        leadId: appointment.leadId,
        conversationId: appointment.conversationId,
        assignedStaffId: appointment.assignedStaffId,
        requestedStartTime: request.requestedStartTime,
        requestedDateText: request.requestedDateText,
        status: appointment.status,
      },
    }, tx));
  }
  return notifications;
}

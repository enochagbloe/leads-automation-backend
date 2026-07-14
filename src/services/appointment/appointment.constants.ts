import { AppointmentStatus, Prisma, SubscriptionStatus } from "@prisma/client";

export const ACTIVE_APPOINTMENT_STATUSES = [
  AppointmentStatus.PENDING_BUSINESS_CONFIRMATION,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.NEEDS_HUMAN_CONFIRMATION,
  AppointmentStatus.RESCHEDULE_REQUESTED,
  AppointmentStatus.RESCHEDULED,
];
export const OUTCOME_REQUIRED_SOURCE_STATUSES = new Set<AppointmentStatus>(ACTIVE_APPOINTMENT_STATUSES);
export const STAFF_CONFLICT_BLOCKING_STATUSES = [
  ...ACTIVE_APPOINTMENT_STATUSES,
  AppointmentStatus.NEEDS_OUTCOME_CONFIRMATION,
];
export const TERMINAL_APPOINTMENT_STATUSES = new Set<AppointmentStatus>([
  AppointmentStatus.CANCELLED,
  AppointmentStatus.COMPLETED,
  AppointmentStatus.NO_SHOW,
  AppointmentStatus.MISSED,
]);
export const ACTIVE_SUBSCRIPTION_STATUSES = [SubscriptionStatus.TRIALING, SubscriptionStatus.ACTIVE];
export const TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 60_000,
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
} as const;
export const OUTCOME_CONFIRMATION_GRACE_MS = 2 * 60 * 60 * 1000;
export const CONFIRMABLE_APPOINTMENT_STATUSES = new Set<AppointmentStatus>([
  AppointmentStatus.PENDING_BUSINESS_CONFIRMATION,
  AppointmentStatus.NEEDS_HUMAN_CONFIRMATION,
  AppointmentStatus.RESCHEDULE_REQUESTED,
]);
export const APPOINTMENT_CONFIRMATION_ACTIONS = [
  { label: "Confirm", action: "CONFIRM_APPOINTMENT", variant: "default" },
  { label: "Reschedule", action: "RESCHEDULE_APPOINTMENT", variant: "secondary" },
  { label: "Cancel", action: "CANCEL_APPOINTMENT", variant: "destructive" },
  { label: "View appointment", action: "VIEW_APPOINTMENT", variant: "secondary" },
] as const;
export const APPOINTMENT_REVIEW_ACTIONS = [
  { label: "Review", action: "VIEW_APPOINTMENT", variant: "default" },
  { label: "Confirm", action: "CONFIRM_APPOINTMENT", variant: "secondary" },
  { label: "Reschedule", action: "RESCHEDULE_APPOINTMENT", variant: "secondary" },
  { label: "Cancel", action: "CANCEL_APPOINTMENT", variant: "destructive" },
] as const;
export const APPOINTMENT_OUTCOME_ACTIONS = [
  { label: "Completed", action: "MARK_COMPLETED", variant: "default" },
  { label: "No-show", action: "MARK_NO_SHOW", variant: "secondary" },
  { label: "Missed", action: "MARK_MISSED", variant: "destructive" },
  { label: "View appointment", action: "VIEW_APPOINTMENT", variant: "secondary" },
] as const;
export const APPOINTMENT_ASSIGNED_ACTIONS = [
  { label: "View appointment", action: "VIEW_APPOINTMENT", variant: "default" },
] as const;

import {
  AppointmentConfirmationMode,
  AppointmentLocationType,
  AppointmentSource,
  AppointmentStatus,
} from "@prisma/client";
import { z } from "zod";

const dateString = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must use YYYY-MM-DD format");
const timeString = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must use HH:mm format");
const nullableText = (max: number) => z.union([z.string().trim().max(max), z.null()]).optional()
  .transform((value) => value === "" ? null : value);

function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const timezone = z.string().trim().min(1).refine(validTimezone, "Invalid timezone");
const durationMinutes = z.number().int().positive().max(1440).optional();

export const appointmentListQuerySchema = z.object({
  status: z.nativeEnum(AppointmentStatus).optional(),
  source: z.nativeEnum(AppointmentSource).optional(),
  serviceId: z.string().cuid().optional(),
  assignedStaffId: z.string().cuid().optional(),
  leadId: z.string().cuid().optional(),
  conversationId: z.string().cuid().optional(),
  search: z.string().trim().max(160).optional(),
  dateFrom: dateString.optional(),
  dateTo: dateString.optional(),
  view: z.enum(["day", "week", "month", "list"]).default("list"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).superRefine((input, context) => {
  if (input.dateFrom && input.dateTo && input.dateFrom > input.dateTo) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["dateTo"], message: "dateTo must be after dateFrom" });
  }
});

export const appointmentCalendarQuerySchema = z.object({
  dateFrom: dateString,
  dateTo: dateString,
  view: z.enum(["day", "week", "month"]).default("week"),
  assignedStaffId: z.string().cuid().optional(),
  serviceId: z.string().cuid().optional(),
  status: z.nativeEnum(AppointmentStatus).optional(),
}).superRefine((input, context) => {
  if (input.dateFrom > input.dateTo) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["dateTo"], message: "dateTo must be after dateFrom" });
  }
});

export const checkAppointmentAvailabilitySchema = z.object({
  serviceId: z.string().cuid().optional(),
  date: dateString,
  time: timeString,
  timezone,
  assignedStaffId: z.string().cuid().nullable().optional(),
  durationMinutes,
  excludeAppointmentId: z.string().cuid().optional(),
});

export const appointmentSettingsSchema = z.object({
  appointmentConfirmationMode: z.nativeEnum(AppointmentConfirmationMode),
});

export const appointmentAutoConfirmSettingsSchema = z.object({
  aiAutoConfirmAppointmentsEnabled: z.boolean(),
}).strict();

export const createAppointmentSchema = z.object({
  leadId: z.string().cuid().nullable().optional(),
  conversationId: z.string().cuid().nullable().optional(),
  serviceId: z.string().cuid().nullable().optional(),
  assignedStaffId: z.string().cuid().nullable().optional(),
  customerName: nullableText(160),
  customerPhone: nullableText(40),
  customerEmail: z.union([z.string().trim().email().max(180), z.null()]).optional()
    .transform((value) => value === "" ? null : value),
  title: z.string().trim().min(2).max(180),
  description: nullableText(1000),
  notes: nullableText(2000),
  date: dateString,
  time: timeString,
  timezone,
  durationMinutes,
  locationType: z.nativeEnum(AppointmentLocationType).default(AppointmentLocationType.TO_BE_CONFIRMED),
  location: nullableText(500),
}).strict().superRefine((input, context) => {
  if (!input.leadId && !input.conversationId && !input.customerPhone) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["customerPhone"], message: "customerPhone is required when no lead or conversation is provided" });
  }
});

export const rescheduleAppointmentSchema = z.object({
  date: dateString.optional(),
  newDate: dateString.optional(),
  time: timeString.optional(),
  newStartTime: timeString.optional(),
  timezone,
  durationMinutes,
  rescheduleReason: z.string().trim().max(500).nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
  notifyCustomer: z.boolean().optional(),
}).superRefine((input, context) => {
  if (!input.date && !input.newDate) context.addIssue({ code: z.ZodIssueCode.custom, path: ["date"], message: "Date is required" });
  if (!input.time && !input.newStartTime) context.addIssue({ code: z.ZodIssueCode.custom, path: ["time"], message: "Time is required" });
}).transform((input) => ({
  date: input.date ?? input.newDate!,
  time: input.time ?? input.newStartTime!,
  timezone: input.timezone,
  durationMinutes: input.durationMinutes,
  reason: input.reason ?? input.rescheduleReason,
  notifyCustomer: input.notifyCustomer ?? false,
}));

export const cancelAppointmentSchema = z.object({
  cancellationReason: z.string().trim().max(500).nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
  notifyCustomer: z.boolean().optional(),
}).transform((input) => ({
  reason: input.reason ?? input.cancellationReason,
  notifyCustomer: input.notifyCustomer ?? false,
}));

export const confirmAppointmentSchema = z.object({
  note: z.string().trim().max(500).nullable().optional(),
});

export const completeAppointmentSchema = z.object({
  completedNote: z.string().trim().max(1000).nullable().optional(),
  outcomeNote: z.string().trim().max(1000).nullable().optional(),
}).transform((input) => ({
  completedNote: input.completedNote ?? input.outcomeNote,
}));

export const noShowAppointmentSchema = z.object({
  noShowReason: z.string().trim().max(1000).nullable().optional(),
  outcomeNote: z.string().trim().max(1000).nullable().optional(),
}).transform((input) => ({
  noShowReason: input.noShowReason ?? input.outcomeNote,
}));

export const missedAppointmentSchema = z.object({
  missedReason: z.string().trim().max(1000).nullable().optional(),
  outcomeNote: z.string().trim().max(1000).nullable().optional(),
}).transform((input) => ({
  missedReason: input.missedReason ?? input.outcomeNote,
}));

export const assignAppointmentSchema = z.object({
  assignedStaffId: z.string().cuid().nullable(),
});

export type AppointmentListQuery = z.infer<typeof appointmentListQuerySchema>;
export type AppointmentCalendarQuery = z.infer<typeof appointmentCalendarQuerySchema>;
export type CheckAppointmentAvailabilityInput = z.infer<typeof checkAppointmentAvailabilitySchema>;
export type AppointmentSettingsInput = z.infer<typeof appointmentSettingsSchema>;
export type AppointmentAutoConfirmSettingsInput = z.infer<typeof appointmentAutoConfirmSettingsSchema>;
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
export type RescheduleAppointmentInput = z.infer<typeof rescheduleAppointmentSchema>;
export type CancelAppointmentInput = z.infer<typeof cancelAppointmentSchema>;
export type AssignAppointmentInput = z.infer<typeof assignAppointmentSchema>;
export type ConfirmAppointmentInput = z.infer<typeof confirmAppointmentSchema>;
export type CompleteAppointmentInput = z.infer<typeof completeAppointmentSchema>;
export type NoShowAppointmentInput = z.infer<typeof noShowAppointmentSchema>;
export type MissedAppointmentInput = z.infer<typeof missedAppointmentSchema>;

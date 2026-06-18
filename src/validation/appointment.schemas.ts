import {
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
  source: z.nativeEnum(AppointmentSource).default(AppointmentSource.MANUAL),
}).superRefine((input, context) => {
  if (!input.leadId && !input.conversationId && !input.customerPhone) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["customerPhone"], message: "customerPhone is required when no lead or conversation is provided" });
  }
});

export const rescheduleAppointmentSchema = z.object({
  date: dateString,
  time: timeString,
  timezone,
  durationMinutes,
  reason: z.string().trim().max(500).nullable().optional(),
});

export const cancelAppointmentSchema = z.object({
  reason: z.string().trim().max(500).nullable().optional(),
});

export const assignAppointmentSchema = z.object({
  assignedStaffId: z.string().cuid().nullable(),
});

export type AppointmentListQuery = z.infer<typeof appointmentListQuerySchema>;
export type AppointmentCalendarQuery = z.infer<typeof appointmentCalendarQuerySchema>;
export type CheckAppointmentAvailabilityInput = z.infer<typeof checkAppointmentAvailabilitySchema>;
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
export type RescheduleAppointmentInput = z.infer<typeof rescheduleAppointmentSchema>;
export type CancelAppointmentInput = z.infer<typeof cancelAppointmentSchema>;
export type AssignAppointmentInput = z.infer<typeof assignAppointmentSchema>;

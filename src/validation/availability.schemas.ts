import { DayOfWeek } from "@prisma/client";
import { z } from "zod";

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Time must use HH:mm 24-hour format");
const nullableTime = z.union([time, z.null()]).optional();

const ruleSchema = z.object({
  dayOfWeek: z.nativeEnum(DayOfWeek),
  isOpen: z.boolean(),
  openTime: nullableTime,
  closeTime: nullableTime,
  breakStartTime: nullableTime,
  breakEndTime: nullableTime,
  appliesToAllServices: z.boolean().default(true),
}).strict().superRefine((rule, context) => {
  if (!rule.isOpen) {
    for (const field of ["openTime", "closeTime", "breakStartTime", "breakEndTime"] as const) {
      if (rule[field] != null) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Closed days cannot have opening or break times" });
    }
    return;
  }
  if (!rule.openTime) context.addIssue({ code: z.ZodIssueCode.custom, path: ["openTime"], message: "Open time is required for open days" });
  if (!rule.closeTime) context.addIssue({ code: z.ZodIssueCode.custom, path: ["closeTime"], message: "Close time is required for open days" });
  if (rule.openTime && rule.closeTime && rule.openTime >= rule.closeTime) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["closeTime"], message: "Close time must be after open time" });
  }
  const hasBreakStart = rule.breakStartTime != null;
  const hasBreakEnd = rule.breakEndTime != null;
  if (hasBreakStart !== hasBreakEnd) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["breakStartTime"], message: "Break start and end times must both be provided" });
  } else if (rule.breakStartTime && rule.breakEndTime && rule.openTime && rule.closeTime) {
    if (rule.breakStartTime <= rule.openTime) context.addIssue({ code: z.ZodIssueCode.custom, path: ["breakStartTime"], message: "Break must start after opening time" });
    if (rule.breakStartTime >= rule.breakEndTime) context.addIssue({ code: z.ZodIssueCode.custom, path: ["breakEndTime"], message: "Break end must be after break start" });
    if (rule.breakEndTime >= rule.closeTime) context.addIssue({ code: z.ZodIssueCode.custom, path: ["breakEndTime"], message: "Break must end before closing time" });
  }
});

export const upsertAvailabilitySchema = z.object({
  timezone: z.string().trim().min(1).max(100),
  rules: z.array(ruleSchema).length(7),
}).strict().superRefine((input, context) => {
  const days = input.rules.map((rule) => rule.dayOfWeek);
  if (new Set(days).size !== 7) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["rules"], message: "Exactly one rule is required for every day of the week" });
  }
});

export type UpsertAvailabilityInput = z.infer<typeof upsertAvailabilitySchema>;

import { AppointmentConfirmationMode } from "@prisma/client";
import { z } from "zod";

const businessName = z.string().trim().min(2).max(120);
const profileBusinessName = z.string().trim().min(2).max(100);
const email = z.string().trim().email().transform((value) => value.toLowerCase());
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const nullableLocation = z.string().trim().min(2).max(100).nullable().optional();
const website = z.string().trim().url().max(2048).refine((value) => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.username === ""
      && parsed.password === "";
  } catch {
    return false;
  }
}, "Website must use http or https");

export const businessIndustries = [
  "REAL_ESTATE",
  "CONSTRUCTION",
  "ARCHITECTURE",
  "CONSULTING",
  "SALON_BEAUTY",
  "CLINIC_HEALTHCARE",
  "HOTEL_HOSPITALITY",
  "ONLINE_STORE",
  "EDUCATION",
  "LEGAL",
  "FINANCE",
  "OTHER",
] as const;

export const createBusinessSchema = z.object({
  name: businessName.optional(),
  businessName: businessName.optional(),
  industry: z.string().trim().min(2).max(120),
  email: email.optional(),
  notificationEmail: email.optional(),
  phone: z.string().trim().min(7).max(30).optional(),
}).superRefine((input, context) => {
  if (!input.name && !input.businessName) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Business name is required",
      path: ["businessName"],
    });
  }
}).transform((input) => ({
  name: input.name ?? input.businessName!,
  industry: input.industry,
  email: input.email ?? input.notificationEmail,
  phone: input.phone,
}));

export const updateBusinessProfileSchema = z.object({
  name: profileBusinessName.optional(),
  industry: z.string().trim().min(1).max(120).optional(),
  description: nullableText(1000),
  country: nullableLocation,
  city: nullableLocation,
  address: nullableText(255),
  serviceArea: nullableText(500),
  phone: z.string().trim().regex(/^\+?[0-9][0-9\s().-]{5,28}[0-9]$/, "Invalid phone number").nullable().optional(),
  email: email.nullable().optional(),
  website: website.nullable().optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  defaultCurrency: z.string().trim().min(1).max(10).transform((value) => value.toUpperCase()).optional(),
  defaultNotificationEmail: email.nullable().optional(),
  appointmentConfirmationMode: z.nativeEnum(AppointmentConfirmationMode).optional(),
  humanHandoffEmail: z.unknown().optional(),
  humanHandoffPhone: z.unknown().optional(),
  handoffEmail: z.unknown().optional(),
  handoffPhone: z.unknown().optional(),
}).strict().superRefine((input, context) => {
  if (
    input.humanHandoffEmail !== undefined
    || input.humanHandoffPhone !== undefined
    || input.handoffEmail !== undefined
    || input.handoffPhone !== undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "humanHandoffEmail and humanHandoffPhone are not editable business profile fields.",
      path: ["humanHandoffEmail"],
    });
  }
  const editableKeys = Object.keys(input).filter((key) => !["humanHandoffEmail", "humanHandoffPhone", "handoffEmail", "handoffPhone"].includes(key));
  if (editableKeys.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one editable profile field is required" });
  }
});

export type UpdateBusinessProfileInput = z.infer<typeof updateBusinessProfileSchema>;

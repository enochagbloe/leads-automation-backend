import { z } from "zod";

const businessName = z.string().trim().min(2).max(120);
const email = z.string().trim().email().transform((value) => value.toLowerCase());

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

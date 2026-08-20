import { z } from "zod";

function cleanText(value: string) {
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
}

const text = (minimum: number, maximum: number) => z.string()
  .transform(cleanText)
  .pipe(z.string().min(minimum).max(maximum));

const optionalText = (maximum: number) => z.string()
  .transform(cleanText)
  .pipe(z.string().max(maximum))
  .transform((value) => value || undefined)
  .optional();

export const waitlistSignupSchema = z.object({
  name: text(1, 120),
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  businessName: optionalText(160),
  businessType: optionalText(100),
  whatsapp: z.string().trim().regex(/^\+[1-9]\d{7,14}$/, "Use an international WhatsApp number such as +233244001122.").optional(),
  problem: optionalText(2_000),
  source: optionalText(100),
  marketingConsent: z.boolean().default(false),
}).strict();

export const waitlistEmailSchema = z.object({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
}).strict();

export const waitlistConfirmationSchema = z.object({
  token: z.string().trim().min(32).max(256),
}).strict();

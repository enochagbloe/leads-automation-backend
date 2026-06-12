import { z } from "zod";

export const mockWhatsAppInboundSchema = z.object({
  businessId: z.string().cuid(),
  customerPhone: z.string().trim().min(5).max(40),
  customerName: z.string().trim().min(1).max(160).optional(),
  message: z.string().trim().min(1).max(10_000),
  providerMessageId: z.string().trim().min(1).max(255).optional(),
});

export const mockWhatsAppStatusSchema = z.object({
  providerMessageId: z.string().trim().min(1).max(255),
  status: z.string().trim().min(1).max(80),
});

export const startWhatsAppConnectionSchema = z.object({
  provider: z.enum(["META_WHATSAPP", "MOCK_WHATSAPP"]),
  displayPhoneNumber: z.string().trim().min(5).max(40).optional(),
});

export const completeWhatsAppConnectionSchema = z.object({
  provider: z.enum(["META_WHATSAPP", "MOCK_WHATSAPP"]),
  phoneNumberId: z.string().trim().min(1).max(255),
  displayPhoneNumber: z.string().trim().min(5).max(40).optional(),
  wabaId: z.string().trim().min(1).max(255).optional(),
  businessAccountId: z.string().trim().min(1).max(255).optional(),
  accessToken: z.string().min(1).max(10_000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const deactivateWhatsAppConnectionSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

export type MockWhatsAppInboundInput = z.infer<typeof mockWhatsAppInboundSchema>;
export type MockWhatsAppStatusInput = z.infer<typeof mockWhatsAppStatusSchema>;

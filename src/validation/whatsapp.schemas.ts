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

export type MockWhatsAppInboundInput = z.infer<typeof mockWhatsAppInboundSchema>;
export type MockWhatsAppStatusInput = z.infer<typeof mockWhatsAppStatusSchema>;

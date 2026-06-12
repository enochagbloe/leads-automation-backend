import { z } from "zod";

export const mockWhatsAppInboundSchema = z.object({
  businessId: z.string().cuid(),
  customerPhone: z.string().trim().min(5).max(40),
  customerName: z.string().trim().min(1).max(160).optional(),
  message: z.string().trim().min(1).max(10_000),
  providerMessageId: z.string().trim().min(1).max(255).optional(),
});

export type MockWhatsAppInboundInput = z.infer<typeof mockWhatsAppInboundSchema>;

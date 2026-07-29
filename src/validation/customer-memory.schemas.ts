import { CustomerMemoryMissingDetailState } from "@prisma/client";
import { z } from "zod";

export const customerMemoryParamsSchema = z.object({
  leadId: z.string().cuid(),
}).strict();

export const customerMemoryItemParamsSchema = z.object({
  leadId: z.string().cuid(),
  memoryId: z.string().cuid(),
}).strict();

export const customerMemoryConversationParamsSchema = z.object({
  leadId: z.string().cuid(),
  conversationId: z.string().cuid(),
}).strict();

export const customerMemoryDetailQuerySchema = z.object({
  includeHistory: z.coerce.boolean().default(false),
}).strict();

export const correctCustomerMemorySchema = z.object({
  valueText: z.string().trim().min(1).max(600),
  structuredValue: z.record(z.string(), z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  missingDetailState: z.nativeEnum(CustomerMemoryMissingDetailState).nullable().optional(),
  sourceStatement: z.string().trim().max(600).nullable().optional(),
}).strict();

export type CustomerMemoryDetailQuery = z.infer<typeof customerMemoryDetailQuerySchema>;


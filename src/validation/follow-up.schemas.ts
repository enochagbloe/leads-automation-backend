import {
  FollowUpContextType,
  FollowUpJobStatus,
  FollowUpRuleType,
  FollowUpSendLogDeliveryStatus,
  PlanCode,
} from "@prisma/client";
import { z } from "zod";

export const followUpSettingsSchema = z.object({
  followUpAutomationEnabled: z.boolean(),
}).strict();

export const followUpRuleCreateSchema = z.object({
  type: z.nativeEnum(FollowUpRuleType),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  enabled: z.boolean().default(false),
  delayMinutes: z.number().int().min(0).max(525_600),
  messageTemplate: z.string().trim().min(1).max(2_000),
  useAiRewrite: z.boolean().default(false),
  maxSendsPerLead: z.number().int().min(1).max(50).default(1),
  maxSendsPerConversation: z.number().int().min(1).max(20).default(1),
  cooldownMinutes: z.number().int().min(0).max(525_600).nullable().optional(),
  onlyDuringBusinessHours: z.boolean().default(true),
  planRequired: z.nativeEnum(PlanCode).optional(),
}).strict();

export const followUpRuleUpdateSchema = followUpRuleCreateSchema.partial().strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one rule field is required.",
});

export const followUpRuleListQuerySchema = z.object({
  type: z.nativeEnum(FollowUpRuleType).optional(),
  enabled: z.coerce.boolean().optional(),
  includeDeleted: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const followUpJobListQuerySchema = z.object({
  status: z.nativeEnum(FollowUpJobStatus).optional(),
  ruleId: z.string().cuid().optional(),
  leadId: z.string().cuid().optional(),
  conversationId: z.string().cuid().optional(),
  appointmentId: z.string().cuid().optional(),
  quoteId: z.string().trim().min(1).max(120).optional(),
  contextType: z.nativeEnum(FollowUpContextType).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const followUpJobCancelSchema = z.object({
  reason: z.string().trim().min(1).max(500).default("Cancelled by user."),
}).strict();

export const followUpLogListQuerySchema = z.object({
  ruleId: z.string().cuid().optional(),
  jobId: z.string().cuid().optional(),
  leadId: z.string().cuid().optional(),
  conversationId: z.string().cuid().optional(),
  appointmentId: z.string().cuid().optional(),
  quoteId: z.string().trim().min(1).max(120).optional(),
  deliveryStatus: z.nativeEnum(FollowUpSendLogDeliveryStatus).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const followUpTestTriggerSchema = z.object({
  ruleId: z.string().cuid(),
  leadId: z.string().cuid().optional(),
  conversationId: z.string().cuid().optional(),
  appointmentId: z.string().cuid().optional(),
  quoteId: z.string().trim().min(1).max(120).optional(),
  contextType: z.nativeEnum(FollowUpContextType),
  pendingQuestion: z.string().trim().max(500).optional(),
  expectedResponseType: z.string().trim().max(120).optional(),
  relatedMessageId: z.string().cuid().optional(),
  scheduledFor: z.coerce.date().optional(),
}).strict();

export type FollowUpSettingsInput = z.infer<typeof followUpSettingsSchema>;
export type FollowUpRuleCreateInput = z.infer<typeof followUpRuleCreateSchema>;
export type FollowUpRuleUpdateInput = z.infer<typeof followUpRuleUpdateSchema>;
export type FollowUpRuleListQuery = z.infer<typeof followUpRuleListQuerySchema>;
export type FollowUpJobListQuery = z.infer<typeof followUpJobListQuerySchema>;
export type FollowUpLogListQuery = z.infer<typeof followUpLogListQuerySchema>;
export type FollowUpTestTriggerInput = z.infer<typeof followUpTestTriggerSchema>;

import { CustomerIssueCategory, CustomerIssueSeverity, CustomerIssueStatus } from "@prisma/client";
import { z } from "zod";

export const customerIssueListQuerySchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  status: z.nativeEnum(CustomerIssueStatus).optional(),
  category: z.nativeEnum(CustomerIssueCategory).optional(),
  severity: z.nativeEnum(CustomerIssueSeverity).optional(),
  responsibleMembershipId: z.string().cuid().optional(),
  leadId: z.string().cuid().optional(),
  conversationId: z.string().cuid().optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const customerIssueMetricsQuerySchema = z.object({
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
});

export const complaintInsightTimeframeSchema = z.enum(["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY"]);

export const complaintInsightQuerySchema = z.object({
  timeframe: complaintInsightTimeframeSchema.default("MONTHLY"),
  periodStart: z.coerce.date().optional(),
  periodEnd: z.coerce.date().optional(),
});

export const generateComplaintInsightSchema = z.object({
  timeframe: complaintInsightTimeframeSchema.default("MONTHLY"),
  periodStart: z.coerce.date().optional(),
  periodEnd: z.coerce.date().optional(),
  notifyManagers: z.boolean().default(true),
}).strict();

export const updateCustomerIssueStatusSchema = z.object({
  status: z.nativeEnum(CustomerIssueStatus),
}).strict();

export const updateCustomerIssueIntelligenceSchema = z.object({
  category: z.nativeEnum(CustomerIssueCategory).optional(),
  severity: z.nativeEnum(CustomerIssueSeverity).optional(),
  summary: z.string().trim().min(3).max(500).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one intelligence field is required.",
});

export type CustomerIssueListQuery = z.infer<typeof customerIssueListQuerySchema>;
export type CustomerIssueMetricsQuery = z.infer<typeof customerIssueMetricsQuerySchema>;
export type ComplaintInsightQuery = z.infer<typeof complaintInsightQuerySchema>;
export type GenerateComplaintInsightInput = z.infer<typeof generateComplaintInsightSchema>;

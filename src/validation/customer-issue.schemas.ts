import { CustomerIssueCategory, CustomerIssueSeverity, CustomerIssueStatus } from "@prisma/client";
import { z } from "zod";

export const customerIssueListQuerySchema = z.object({
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

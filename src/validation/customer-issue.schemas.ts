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

export const updateCustomerIssueStatusSchema = z.object({
  status: z.nativeEnum(CustomerIssueStatus),
}).strict();

export type CustomerIssueListQuery = z.infer<typeof customerIssueListQuerySchema>;

import { BusinessPolicyCategory, BusinessPolicyVisibility } from "@prisma/client";
import { z } from "zod";

const nullableSummary = z.union([z.string().trim().max(300), z.null()]).optional()
  .transform((value) => value === "" ? null : value);

const fields = {
  title: z.string().trim().min(2).max(120),
  category: z.nativeEnum(BusinessPolicyCategory),
  content: z.string().trim().min(10).max(3000),
  shortSummary: nullableSummary,
  visibility: z.nativeEnum(BusinessPolicyVisibility).optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().min(0).max(100000).optional(),
};

export const createPolicySchema = z.object(fields).strict();
export const updatePolicySchema = z.object(fields).partial().strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");
export const reorderPoliciesSchema = z.object({
  items: z.array(z.object({
    id: z.string().cuid(),
    displayOrder: z.number().int().min(0).max(100000),
  }).strict()).min(1).max(500),
}).superRefine((input, context) => {
  if (new Set(input.items.map((item) => item.id)).size !== input.items.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "Duplicate policy IDs are not allowed" });
  }
});
export const policyListQuerySchema = z.object({
  category: z.nativeEnum(BusinessPolicyCategory).optional(),
  visibility: z.nativeEnum(BusinessPolicyVisibility).optional(),
  status: z.enum(["active", "inactive", "archived", "all"]).default("active"),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(["displayOrder", "priority", "category", "createdAt", "updatedAt"]).default("displayOrder"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
});

export type CreatePolicyInput = z.infer<typeof createPolicySchema>;
export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;
export type ReorderPoliciesInput = z.infer<typeof reorderPoliciesSchema>;
export type PolicyListQuery = z.infer<typeof policyListQuerySchema>;

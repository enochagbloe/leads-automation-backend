import { LeadSource, LeadStatus } from "@prisma/client";
import { z } from "zod";

const nullableEmail = z.union([z.string().trim().email(), z.literal(""), z.null()]).optional()
  .transform((value) => value === "" ? null : typeof value === "string" ? value.toLowerCase() : value);
const nullableText = z.union([z.string().trim().max(5000), z.null()]).optional();
const customFields = z.record(z.unknown()).nullable().optional();
const tags = z.array(z.string().trim().min(1).max(60)).max(30).optional()
  .transform((values) => values ? [...new Set(values)] : values);

export const createLeadSchema = z.object({
  fullName: z.string().trim().min(1).max(160),
  phone: z.string().trim().min(5).max(40)
    .transform((value) => value.replace(/[\s()-]/g, ""))
    .refine((value) => value.length >= 5, "Phone number is too short"),
  email: nullableEmail,
  source: z.nativeEnum(LeadSource).default(LeadSource.MANUAL),
  status: z.nativeEnum(LeadStatus).default(LeadStatus.NEW),
  assignedStaffId: z.string().cuid().nullable().optional(),
  notes: nullableText,
  tags,
  customFields,
});

export const updateLeadSchema = createLeadSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: "At least one field is required",
});

export const assignLeadSchema = z.object({ assignedStaffId: z.string().cuid().nullable() });
export const updateLeadStatusSchema = z.object({ status: z.nativeEnum(LeadStatus) });

export const leadListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(160).optional(),
  status: z.nativeEnum(LeadStatus).optional(),
  source: z.nativeEnum(LeadSource).optional(),
  assignedStaffId: z.string().cuid().optional(),
  tag: z.string().trim().max(60).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  sortBy: z.enum(["createdAt", "updatedAt", "fullName", "status", "lastContactedAt"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>;
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;
export type LeadListQuery = z.infer<typeof leadListQuerySchema>;

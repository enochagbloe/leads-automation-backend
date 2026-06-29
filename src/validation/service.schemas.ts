import { ServicePriceType, ServiceReadinessStatus } from "@prisma/client";
import { z } from "zod";

const nullableText = (max: number) => z.union([z.string().trim().max(max), z.null()]).optional()
  .transform((value) => value === "" ? null : value);
const nullablePrice = z.union([
  z.string().trim()
    .regex(/^\d+(\.\d{1,2})?$/, "Price must be a non-negative decimal with at most 2 decimal places")
    .refine((value) => Number(value) <= 9_999_999_999.99, "Price is too large"),
  z.number().finite().nonnegative().max(9_999_999_999.99).transform((value) => value.toFixed(2)),
  z.null(),
]).optional();

const serviceFields = {
  name: z.string().trim().min(2).max(100),
  category: nullableText(80),
  description: nullableText(1000),
  basePrice: nullablePrice,
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).optional(),
  priceType: z.nativeEnum(ServicePriceType).optional(),
  priceDescription: nullableText(500),
  durationMinutes: z.number().int().positive().max(10080).nullable().optional(),
  bufferMinutes: z.number().int().min(0).max(1440).optional(),
  requiresPayment: z.boolean().optional(),
  paymentRequiredBeforeBooking: z.boolean().optional(),
  autoConfirmEligible: z.boolean().optional(),
  requiresManualApproval: z.boolean().optional(),
  requiresDepositBeforeConfirmation: z.boolean().optional(),
  requiresLocationBeforeConfirmation: z.boolean().optional(),
  requiresStaffAssignment: z.boolean().optional(),
  isBookable: z.boolean().optional(),
  isActive: z.boolean().optional(),
};

function paymentRequirement(input: { requiresPayment?: boolean; paymentRequiredBeforeBooking?: boolean }, context: z.RefinementCtx) {
  if (input.paymentRequiredBeforeBooking && input.requiresPayment === false) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["paymentRequiredBeforeBooking"],
      message: "Payment required before booking requires requiresPayment to be true",
    });
  }
}

export const createServiceSchema = z.object(serviceFields).strict().superRefine(paymentRequirement);
export const updateServiceSchema = z.object(serviceFields).partial().strict()
  .refine((input) => Object.keys(input).length > 0, "At least one field is required")
  .superRefine(paymentRequirement);

export const reorderServicesSchema = z.object({
  items: z.array(z.object({
    id: z.string().cuid(),
    displayOrder: z.number().int().min(0).max(100000),
  }).strict()).min(1).max(500),
}).superRefine((input, context) => {
  if (new Set(input.items.map((item) => item.id)).size !== input.items.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "Duplicate service IDs are not allowed" });
  }
});

export const serviceListQuerySchema = z.object({
  status: z.enum(["active", "inactive", "archived", "all"]).default("active"),
  readinessStatus: z.nativeEnum(ServiceReadinessStatus).optional(),
  search: z.string().trim().max(100).optional(),
  category: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(["displayOrder", "name", "createdAt", "updatedAt"]).default("displayOrder"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
});

export type CreateServiceInput = z.infer<typeof createServiceSchema>;
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;
export type ServiceListQuery = z.infer<typeof serviceListQuerySchema>;
export type ReorderServicesInput = z.infer<typeof reorderServicesSchema>;

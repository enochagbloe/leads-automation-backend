import { z } from "zod";

export const customerGoals = ["ARRANGE_SERVICE", "SEEK_SERVICE", "INQUIRE_SERVICE", "SUPPORT", "COMPLAINT", "HUMAN_ASSISTANCE", "GENERAL_INQUIRY"] as const;
export const serviceResolutions = ["EXACT", "INFERRED", "AMBIGUOUS", "UNRESOLVED", "UNSUPPORTED", "UNSPECIFIED"] as const;
export const customerPurposeSchema = z.object({
  goal: z.enum(customerGoals),
  need: z.string().trim().min(1).max(500).nullable(),
  resolution: z.enum(serviceResolutions),
  serviceId: z.string().min(1).max(128).nullable(),
  candidateServiceIds: z.array(z.string().min(1).max(128)).max(3).refine(ids => new Set(ids).size === ids.length),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.object({ messageId: z.string().min(1).max(128), quote: z.string().min(1).max(300) }).strict()).min(1).max(3),
  catalogEvidence: z.array(z.object({ serviceId: z.string().min(1).max(128), quote: z.string().min(1).max(300) }).strict()).max(3),
}).strict();
export type CustomerPurpose = z.infer<typeof customerPurposeSchema>;

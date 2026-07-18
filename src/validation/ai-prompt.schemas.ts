import { AiPromptScope, AiPromptStatus } from "@prisma/client";
import { z } from "zod";

export const aiPromptListQuerySchema = z.object({
  scope: z.nativeEnum(AiPromptScope).optional(),
  status: z.nativeEnum(AiPromptStatus).optional(),
  includeArchived: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const aiPromptVersionListQuerySchema = z.object({
  status: z.nativeEnum(AiPromptStatus).optional(),
  createdBy: z.string().cuid().optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const aiPromptCreateDraftSchema = z.object({
  scope: z.nativeEnum(AiPromptScope),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  promptText: z.string().trim().min(1).max(8_000),
  changeSummary: z.string().trim().max(500).nullable().optional(),
}).strict();

export const aiPromptCreateVersionSchema = z.object({
  promptText: z.string().trim().min(1).max(8_000),
  changeSummary: z.string().trim().max(500).nullable().optional(),
}).strict();

export const aiPromptUpdateDraftSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  promptText: z.string().trim().min(1).max(8_000).optional(),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  baseRevision: z.number().int().min(1).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one field is required.",
}).superRefine((value, ctx) => {
  if (value.promptText !== undefined && value.baseRevision === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseRevision"],
      message: "baseRevision is required when updating promptText.",
    });
  }
});

export const aiPromptDraftAutosaveSchema = z.object({
  promptText: z.string().trim().min(1).max(8_000),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  clientMutationId: z.string().trim().min(8).max(120).regex(/^[A-Za-z0-9._:-]+$/),
  clientUpdatedAt: z.coerce.date(),
  baseRevision: z.number().int().min(1),
}).strict();

export const aiPromptDraftConflictResolutionSchema = z.object({
  promptText: z.string().trim().min(1).max(8_000),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  clientMutationId: z.string().trim().min(8).max(120).regex(/^[A-Za-z0-9._:-]+$/),
  clientUpdatedAt: z.coerce.date().optional(),
  expectedServerRevision: z.number().int().min(1),
  resolution: z.literal("REPLACE_SERVER_DRAFT"),
}).strict();

export const aiPromptPreviewSchema = z.object({
  promptText: z.string().trim().min(1).max(8_000).optional(),
  customerContext: z.string().trim().max(2_000).optional(),
  testContext: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const aiPromptScopeQuerySchema = z.object({
  scope: z.nativeEnum(AiPromptScope),
});

export const aiPromptScopeParamSchema = z.object({
  scope: z.nativeEnum(AiPromptScope, {
    errorMap: () => ({ message: "INVALID_AI_PROMPT_SCOPE" }),
  }),
}).strict();

export type AiPromptListQuery = z.infer<typeof aiPromptListQuerySchema>;
export type AiPromptVersionListQuery = z.infer<typeof aiPromptVersionListQuerySchema>;
export type AiPromptCreateDraftInput = z.infer<typeof aiPromptCreateDraftSchema>;
export type AiPromptCreateVersionInput = z.infer<typeof aiPromptCreateVersionSchema>;
export type AiPromptUpdateDraftInput = z.infer<typeof aiPromptUpdateDraftSchema>;
export type AiPromptDraftAutosaveInput = z.infer<typeof aiPromptDraftAutosaveSchema>;
export type AiPromptDraftConflictResolutionInput = z.infer<typeof aiPromptDraftConflictResolutionSchema>;
export type AiPromptPreviewInput = z.infer<typeof aiPromptPreviewSchema>;
export type AiPromptScopeParam = z.infer<typeof aiPromptScopeParamSchema>;

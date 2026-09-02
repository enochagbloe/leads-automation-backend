import {
  KnowledgeArticleStatus,
  KnowledgeAssetSendType,
  KnowledgeAssetVisibility,
  KnowledgeDocumentStatus,
  KnowledgeDocumentProcessingStatus,
  KnowledgeGovernanceResolutionAction,
  KnowledgeGovernanceComparisonType,
  KnowledgeGovernancePriority,
  KnowledgeGovernanceReviewStatus,
  KnowledgeDocumentFactType,
} from "@prisma/client";
import { z } from "zod";

const trimmed = z.string().trim();
const optionalTrimmed = trimmed.optional();
const nullableTrimmed = trimmed.nullable().optional();
const tags = z.array(trimmed.min(1).max(60)).max(20).default([]);
const idList = z.array(trimmed.min(1)).max(50).default([]);

export const knowledgeArticleListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: optionalTrimmed,
  status: z.nativeEnum(KnowledgeArticleStatus).optional(),
  visibility: z.nativeEnum(KnowledgeAssetVisibility).optional(),
  category: optionalTrimmed,
});

export const createKnowledgeArticleSchema = z.object({
  title: trimmed.min(2).max(160),
  slug: optionalTrimmed,
  summary: nullableTrimmed,
  body: trimmed.min(20).max(50_000),
  category: nullableTrimmed,
  tags,
  relatedServiceIds: idList,
  relatedPolicyIds: idList,
  visibility: z.nativeEnum(KnowledgeAssetVisibility).default(KnowledgeAssetVisibility.INTERNAL_ONLY),
  status: z.enum([KnowledgeArticleStatus.DRAFT, KnowledgeArticleStatus.NEEDS_REVIEW]).default(KnowledgeArticleStatus.DRAFT),
});

export const updateKnowledgeArticleSchema = createKnowledgeArticleSchema.partial().extend({
  tags: z.array(trimmed.min(1).max(60)).max(20).optional(),
  relatedServiceIds: z.array(trimmed.min(1)).max(50).optional(),
  relatedPolicyIds: z.array(trimmed.min(1)).max(50).optional(),
});

export const updateKnowledgeArticleStatusSchema = z.object({
  status: z.nativeEnum(KnowledgeArticleStatus),
});

export const draftKnowledgeArticleSchema = z.object({
  topic: trimmed.min(3).max(160),
  category: optionalTrimmed,
  relatedServiceIds: z.array(trimmed.min(1)).max(10).default([]),
  relatedPolicyIds: z.array(trimmed.min(1)).max(10).default([]),
  visibility: z.nativeEnum(KnowledgeAssetVisibility).default(KnowledgeAssetVisibility.INTERNAL_ONLY),
  customerQuestion: optionalTrimmed,
  notes: optionalTrimmed,
});

export const generateStarterArticlesSchema = z.object({
  count: z.number().int().positive().max(8).default(4),
  categories: z.array(trimmed.min(1).max(80)).max(8).optional(),
});

export const knowledgeDocumentListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: optionalTrimmed,
  status: z.nativeEnum(KnowledgeDocumentStatus).optional(),
  processingStatus: z.nativeEnum(KnowledgeDocumentProcessingStatus).optional(),
  visibility: z.nativeEnum(KnowledgeAssetVisibility).optional(),
  category: optionalTrimmed,
  uploaderId: optionalTrimmed,
  sortBy: z.enum(["createdAt", "updatedAt"]).default("updatedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const knowledgeDocumentVersionListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const uploadKnowledgeDocumentMetadataSchema = z.object({
  title: trimmed.min(2).max(160),
  description: nullableTrimmed,
  category: nullableTrimmed,
  tags,
  relatedServiceIds: idList,
  visibility: z.nativeEnum(KnowledgeAssetVisibility).default(KnowledgeAssetVisibility.INTERNAL_ONLY),
  fileName: trimmed.min(1).max(220),
  mimeType: trimmed.min(1).max(160),
});

export const uploadKnowledgeDocumentSchema = uploadKnowledgeDocumentMetadataSchema.extend({
  fileBase64: trimmed.min(10),
});

export const replaceKnowledgeDocumentMetadataSchema = z.object({
  fileName: trimmed.min(1).max(220),
  mimeType: trimmed.min(1).max(160),
});

export const updateKnowledgeDocumentSchema = z.object({
  title: trimmed.min(2).max(160).optional(),
  description: nullableTrimmed,
  category: nullableTrimmed,
  tags: z.array(trimmed.min(1).max(60)).max(20).optional(),
  relatedServiceIds: z.array(trimmed.min(1)).max(50).optional(),
  visibility: z.nativeEnum(KnowledgeAssetVisibility).optional(),
});

export const updateKnowledgeDocumentStatusSchema = z.object({
  status: z.nativeEnum(KnowledgeDocumentStatus),
});

export const approveKnowledgeDocumentReviewSchema = z.object({
  versionId: trimmed.min(1).max(191),
  note: trimmed.max(1_000).nullable().optional(),
});

export const rejectKnowledgeDocumentReviewSchema = z.object({
  versionId: trimmed.min(1).max(191),
  reason: trimmed.min(3).max(1_000),
});

const governanceResolutionFields = {
  expectedVersionId: trimmed.min(1).max(191),
  action: z.nativeEnum(KnowledgeGovernanceResolutionAction),
  expectedCanonicalValue: z.unknown().optional(),
  settingsInput: z.record(z.string(), z.unknown()).optional(),
  note: trimmed.max(1_000).nullable().optional(),
};

export const resolveKnowledgeGovernanceReviewSchema = z.object(governanceResolutionFields).strict();

export const resolveKnowledgeGovernanceReviewBatchSchema = z.object({
  decisions: z.array(z.object({
    reviewId: trimmed.min(1).max(191),
    idempotencyKey: trimmed.min(8).max(191),
    ...governanceResolutionFields,
  }).strict()).min(1).max(50),
}).strict();

export const completeKnowledgeDocumentReplacementSchema = z.object({
  reviewId: trimmed.min(1).max(191),
  expectedVersionId: trimmed.min(1).max(191),
  note: trimmed.max(1_000).nullable().optional(),
}).strict();

export const knowledgeGovernanceReviewQueueQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  priority: z.nativeEnum(KnowledgeGovernancePriority).optional(),
  status: z.nativeEnum(KnowledgeGovernanceReviewStatus).optional(),
  comparisonType: z.nativeEnum(KnowledgeGovernanceComparisonType).optional(),
  factType: z.nativeEnum(KnowledgeDocumentFactType).optional(),
  documentId: optionalTrimmed,
  outdated: z.preprocess((value) => value === "true" ? true : value === "false" ? false : value, z.boolean().optional()),
});

export const permanentlyDeleteKnowledgeDocumentSchema = z.object({
  confirmPermanentDelete: z.literal(true),
}).strict();

export const knowledgeSearchQuerySchema = z.object({
  query: trimmed.min(1).max(120),
  conversationId: optionalTrimmed,
  limit: z.coerce.number().int().positive().max(20).default(10),
});

export const sendKnowledgeAssetSchema = z.object({
  assetType: z.nativeEnum(KnowledgeAssetSendType),
  articleId: trimmed.min(1).optional(),
  documentId: trimmed.min(1).optional(),
  note: trimmed.max(500).optional(),
}).superRefine((value, context) => {
  if (value.assetType === KnowledgeAssetSendType.ARTICLE_PDF && !value.articleId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["articleId"], message: "articleId is required for ARTICLE_PDF." });
  }
  if (value.assetType === KnowledgeAssetSendType.UPLOADED_DOCUMENT && !value.documentId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["documentId"], message: "documentId is required for UPLOADED_DOCUMENT." });
  }
});

export type KnowledgeArticleListQuery = z.infer<typeof knowledgeArticleListQuerySchema>;
export type CreateKnowledgeArticleInput = z.infer<typeof createKnowledgeArticleSchema>;
export type UpdateKnowledgeArticleInput = z.infer<typeof updateKnowledgeArticleSchema>;
export type DraftKnowledgeArticleInput = z.infer<typeof draftKnowledgeArticleSchema>;
export type GenerateStarterArticlesInput = z.infer<typeof generateStarterArticlesSchema>;
export type KnowledgeDocumentListQuery = z.infer<typeof knowledgeDocumentListQuerySchema>;
export type KnowledgeDocumentVersionListQuery = z.infer<typeof knowledgeDocumentVersionListQuerySchema>;
export type UploadKnowledgeDocumentInput = z.infer<typeof uploadKnowledgeDocumentSchema>;
export type UploadKnowledgeDocumentMetadataInput = z.infer<typeof uploadKnowledgeDocumentMetadataSchema>;
export type ReplaceKnowledgeDocumentMetadataInput = z.infer<typeof replaceKnowledgeDocumentMetadataSchema>;
export type UpdateKnowledgeDocumentInput = z.infer<typeof updateKnowledgeDocumentSchema>;
export type ApproveKnowledgeDocumentReviewInput = z.infer<typeof approveKnowledgeDocumentReviewSchema>;
export type RejectKnowledgeDocumentReviewInput = z.infer<typeof rejectKnowledgeDocumentReviewSchema>;
export type ResolveKnowledgeGovernanceReviewInput = z.infer<typeof resolveKnowledgeGovernanceReviewSchema>;
export type ResolveKnowledgeGovernanceReviewBatchInput = z.infer<typeof resolveKnowledgeGovernanceReviewBatchSchema>;
export type CompleteKnowledgeDocumentReplacementInput = z.infer<typeof completeKnowledgeDocumentReplacementSchema>;
export type KnowledgeGovernanceReviewQueueQuery = z.infer<typeof knowledgeGovernanceReviewQueueQuerySchema>;
export type PermanentlyDeleteKnowledgeDocumentInput = z.infer<typeof permanentlyDeleteKnowledgeDocumentSchema>;
export type KnowledgeSearchQuery = z.infer<typeof knowledgeSearchQuerySchema>;
export type SendKnowledgeAssetInput = z.infer<typeof sendKnowledgeAssetSchema>;

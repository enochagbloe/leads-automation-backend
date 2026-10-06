import { z } from "zod";
const base = { findingKey: z.string().regex(/^[a-f0-9]{64}$/), note: z.string().trim().max(1000).optional() };
const article = { articleId: z.string().trim().min(1).max(128), expectedArticleUpdatedAt: z.string().datetime({ offset: true }) };
const ids = z.array(z.string().trim().min(1).max(128)).max(50).refine(v => new Set(v).size === v.length, "Duplicate relationship IDs");
export const resolveKnowledgeQualitySchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("DISMISS") }).strict(),
  z.object({ ...base, ...article, action: z.literal("UPDATE_CATEGORY"), category: z.string().trim().min(1).max(160) }).strict(),
  z.object({ ...base, ...article, action: z.literal("UPDATE_RELATIONSHIPS"), relatedServiceIds: ids, relatedPolicyIds: ids }).strict(),
  z.object({ ...base, ...article, action: z.literal("ARCHIVE_ARTICLE") }).strict(),
]);
export type ResolveKnowledgeQualityInput = z.infer<typeof resolveKnowledgeQualitySchema>;

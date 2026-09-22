import type { AiBusinessContext } from "./ai-context-builder.service";
import { KnowledgeArticleStatus, KnowledgeAssetVisibility, KnowledgeDocumentStatus, KnowledgeDocumentProcessingStatus, KnowledgeGovernanceStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { customerSafeKnowledgeDocumentWhere } from "./knowledge-document/knowledge-document-runtime-policy";
import { loadKnowledgeRuntimeGuards } from "./knowledge-document/knowledge-runtime-governance.service";
import { loadCustomerSafeKnowledgeFacts } from "./knowledge-document/knowledge-approved-facts.service";

export type RuntimeKnowledge = Pick<AiBusinessContext, "knowledgeArticles" | "knowledgeDocumentChunks" | "approvedKnowledgeFacts" | "runtimeKnowledgeGuards">;
/** Retrieval only. Providers cannot interpret messages or authorize workflow effects. */
export interface RuntimeKnowledgeProvider<Scope> { load(scope: Scope): Promise<RuntimeKnowledge>; }

/** Keep Knowledge Hub publication, visibility, approval and conflict filters at this boundary. */
export const productionKnowledgeProvider: RuntimeKnowledgeProvider<{ businessId: string }> = {
  async load({ businessId }) {
    const [knowledgeArticles, chunks, facts, guards] = await Promise.all([
      prisma.knowledgeArticle.findMany({
        where: {
          businessId,
          status: KnowledgeArticleStatus.PUBLISHED,
          visibility: KnowledgeAssetVisibility.CLIENT_SENDABLE,
        },
        orderBy: [{ updatedAt: "desc" }, { title: "asc" }],
        take: 20,
        select: { id: true, title: true, summary: true, body: true, category: true, tags: true },
      }),
      prisma.knowledgeDocumentChunk.findMany({
        where: {
          businessId,
          document: {
            status: KnowledgeDocumentStatus.ACTIVE,
            processingStatus: KnowledgeDocumentProcessingStatus.READY,
            governanceStatus: KnowledgeGovernanceStatus.APPROVED,
            visibility: KnowledgeAssetVisibility.CLIENT_SENDABLE,
            ...customerSafeKnowledgeDocumentWhere,
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: 12,
        select: {
          id: true,
          documentId: true,
          chunkText: true,
          pageNumber: true,
          document: { select: { title: true } },
        },
      }),
      loadCustomerSafeKnowledgeFacts(businessId, { limit: 50 }),
      loadKnowledgeRuntimeGuards(businessId),
    ]);
    return {
      knowledgeArticles,
      knowledgeDocumentChunks: chunks.map(c => ({ id: c.id, documentId: c.documentId, documentTitle: c.document.title, chunkText: c.chunkText.length > 900 ? c.chunkText.slice(0, 897) + "..." : c.chunkText, pageNumber: c.pageNumber })),
      approvedKnowledgeFacts: facts.map(f => ({ id: f.id, documentId: f.documentId, documentTitle: f.document.title, factType: f.factType, label: truncate(f.label, 180), valueText: truncate(f.valueText, 700), currency: f.currency, numericValue: finiteNumber(f.numericValue), sourceLabel: f.sourceLabel, pageNumber: f.pageNumber })),
      runtimeKnowledgeGuards: guards.map(g => ({ reviewItemId: g.reviewItemId, canonicalEntityType: g.canonicalEntityType, canonicalEntityId: g.canonicalEntityId, canonicalField: g.canonicalField, priority: g.priority })),
    };
  },
};
const truncate = (value: string, limit: number) => value.length <= limit ? value : value.slice(0, limit - 3) + "...";

const finiteNumber = (value: unknown) => value == null || !Number.isFinite(Number(value)) ? null : Number(value);

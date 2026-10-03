import { z } from "zod";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { knowledgeEmbeddingService, knowledgeEmbeddingText, type SemanticKnowledgeCandidate, type EmbeddingSourceType } from "./knowledge-embedding.service";
import { customerSafeKnowledgeDocumentWhere } from "./knowledge-document/knowledge-document-runtime-policy";
import { loadCustomerSafeKnowledgeFacts } from "./knowledge-document/knowledge-approved-facts.service";

const inputSchema = z.object({
  businessId: z.string().trim().min(1).max(200),
  query: z.string().trim().min(1).max(2000),
  topK: z.number().int().min(1).max(8).default(4),
}).strict();

export type KnowledgeGrounding = {
  sourceType: EmbeddingSourceType;
  sourceId: string;
  chunkId?: string;
  factId?: string;
  title: string;
  text: string;
  pageNumber: number | null;
  score: number;
  retrieval: "semantic";
};
export type KnowledgeRetrievalResult = {
  status: "MATCHES_FOUND" | "NO_RELEVANT_KNOWLEDGE" | "RETRIEVAL_UNAVAILABLE";
  matches: KnowledgeGrounding[];
};
const truncate = (text: string, limit: number) => text.length <= limit ? text : text.slice(0, limit - 3) + "...";

async function ground(businessId: string, candidate: SemanticKnowledgeCandidate): Promise<KnowledgeGrounding | null> {
  const common = { sourceType: candidate.sourceType, sourceId: candidate.sourceId, score: candidate.score, retrieval: "semantic" as const };
  if (candidate.sourceType === "ARTICLE") {
    if (candidate.chunkId !== null) return null;
    const article = await prisma.knowledgeArticle.findFirst({
      where: { businessId, id: candidate.sourceId, status: "PUBLISHED", visibility: "CLIENT_SENDABLE" },
      select: { businessId: true, id: true, title: true, body: true, summary: true, category: true, tags: true },
    });
    if (!article || article.businessId !== businessId || knowledgeEmbeddingText.article(article) !== candidate.indexedContent) return null;
    return { ...common, title: truncate(article.title, 200), text: truncate([article.summary, article.body].filter(Boolean).join("\n"), 900), pageNumber: null };
  }
  if (!candidate.chunkId) return null;
  if (candidate.sourceType === "DOCUMENT_CHUNK") {
    const chunk = await prisma.knowledgeDocumentChunk.findFirst({
      where: { businessId, id: candidate.chunkId, documentId: candidate.sourceId, document: {
        businessId, deletedAt: null, status: "ACTIVE", processingStatus: "READY", governanceStatus: "APPROVED", visibility: "CLIENT_SENDABLE",
        ...customerSafeKnowledgeDocumentWhere,
      } },
      select: { businessId: true, id: true, documentId: true, chunkText: true, pageNumber: true,
        document: { select: { title: true, description: true, category: true, tags: true } } },
    });
    if (!chunk || chunk.businessId !== businessId || knowledgeEmbeddingText.chunk(chunk) !== candidate.indexedContent) return null;
    return { ...common, chunkId: chunk.id, title: truncate(chunk.document.title, 200), text: truncate(chunk.chunkText, 900), pageNumber: chunk.pageNumber };
  }
  if (candidate.sourceType === "DOCUMENT_FACT") {
    // Keep approval, active-version, review-block and linked-service checks in their existing owner.
    const facts = await loadCustomerSafeKnowledgeFacts(businessId, { documentId: candidate.sourceId, ids: [candidate.chunkId], limit: 1 });
    const fact = facts.find(f => f.businessId === businessId && f.documentId === candidate.sourceId && f.id === candidate.chunkId);
    if (!fact || knowledgeEmbeddingText.fact(fact) !== candidate.indexedContent || fact.document.title !== candidate.title) return null;
    return { ...common, factId: fact.id, title: truncate(fact.document.title, 200), text: truncate(`${fact.label}\n${fact.valueText}`, 900), pageNumber: fact.pageNumber };
  }
  return null;
}

/** Standalone, read-only retrieval. No runtime registration, prompt mutation or model response call. */
export const knowledgeRetrievalService = {
  async retrieve(input: { businessId: string; query: string; topK?: number }): Promise<KnowledgeRetrievalResult> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new AppError(400, "A business, nonempty query (max 2000 characters), and topK from 1 to 8 are required.", "KNOWLEDGE_RETRIEVAL_INPUT_INVALID");
    const { businessId, query, topK } = parsed.data;
    try {
      // Bounded overfetch leaves room for deduplication and rejected/revoked sources.
      const candidates = await knowledgeEmbeddingService.searchCandidates(businessId, query, topK * 4);
      const matches: KnowledgeGrounding[] = [];
      const seen = new Set<string>();
      for (const candidate of candidates.slice(0, topK * 4).sort((a, b) => b.score - a.score)) {
        if (candidate.businessId !== businessId || !Number.isFinite(candidate.score) || candidate.score < env.KNOWLEDGE_SEMANTIC_MIN_SCORE || candidate.score > 1) continue;
        const key = JSON.stringify([candidate.sourceType, candidate.sourceId, candidate.chunkId ?? null]);
        if (seen.has(key)) continue;
        seen.add(key);
        const match = await ground(businessId, candidate);
        if (match?.text.trim()) matches.push(match);
        if (matches.length === topK) break;
      }
      return { status: matches.length ? "MATCHES_FOUND" : "NO_RELEVANT_KNOWLEDGE", matches };
    } catch {
      // No partial/unverified results on provider, vector DB or governance-read failure.
      return { status: "RETRIEVAL_UNAVAILABLE", matches: [] };
    }
  },
};

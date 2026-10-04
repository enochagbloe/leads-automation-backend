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
  hints: z.object({ serviceId: z.string().trim().min(1).max(200).optional(), policyId: z.string().trim().min(1).max(200).optional(), category: z.string().trim().min(1).max(100).optional() }).strict().optional(),
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
  category?: string | null;
  relatedServiceIds?: string[];
  relatedPolicyIds?: string[];
  sourceUpdatedAt?: string;
  sourceVersionId?: string | null;
};
export type KnowledgeRetrievalResult = {
  status: "MATCHES_FOUND" | "NO_RELEVANT_KNOWLEDGE" | "RETRIEVAL_UNAVAILABLE";
  matches: KnowledgeGrounding[];
};
const truncate = (text: string, limit: number) => text.length <= limit ? text : text.slice(0, limit - 3) + "...";

const metadataSelect = { category: true, relatedServiceIds: true, updatedAt: true } as const;
const metadata = (source: { category: string | null; relatedServiceIds: string[]; updatedAt: Date }) => ({
  category: source.category, relatedServiceIds: source.relatedServiceIds, sourceUpdatedAt: source.updatedAt?.toISOString(),
});
const currentDocumentWhere = {
  deletedAt: null, supersededByDocumentId: null, status: "ACTIVE", processingStatus: "READY",
  governanceStatus: "APPROVED", visibility: "CLIENT_SENDABLE", activeVersion: { is: { isActive: true } },
} as const;
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// Compare complete indexed content, not the truncated customer snippet.
const duplicate = (a: string, b: string) => {
  const x = normalize(a), y = normalize(b);
  if (x === y) return true;
  if (JSON.stringify(x.match(/\d+/g)) !== JSON.stringify(y.match(/\d+/g))) return false;
  const left = new Set(x.split(" ")), right = new Set(y.split(" "));
  const union = new Set([...left, ...right]);
  return union.size > 20 && [...left].filter(word => right.has(word)).length / union.size >= .95;
};

async function ground(businessId: string, candidate: SemanticKnowledgeCandidate): Promise<KnowledgeGrounding | null> {
  const common = { sourceType: candidate.sourceType, sourceId: candidate.sourceId, score: candidate.score, retrieval: "semantic" as const };
  if (candidate.sourceType === "ARTICLE") {
    if (candidate.chunkId !== null) return null;
    const article = await prisma.knowledgeArticle.findFirst({
      where: { businessId, id: candidate.sourceId, status: "PUBLISHED", visibility: "CLIENT_SENDABLE" },
      select: { businessId: true, id: true, title: true, body: true, summary: true, category: true, tags: true, relatedServiceIds: true, relatedPolicyIds: true, updatedAt: true },
    });
    if (!article || article.businessId !== businessId || knowledgeEmbeddingText.article(article) !== candidate.indexedContent) return null;
    return { ...common, ...metadata(article), relatedPolicyIds: article.relatedPolicyIds, title: truncate(article.title, 200), text: truncate([article.summary, article.body].filter(Boolean).join("\n"), 900), pageNumber: null };
  }
  if (!candidate.chunkId) return null;
  if (candidate.sourceType === "DOCUMENT_CHUNK") {
    const chunk = await prisma.knowledgeDocumentChunk.findFirst({
      where: { businessId, id: candidate.chunkId, documentId: candidate.sourceId, document: {
        businessId, ...currentDocumentWhere, AND: [customerSafeKnowledgeDocumentWhere],
      } },
      select: { businessId: true, id: true, documentId: true, chunkText: true, pageNumber: true,
        document: { select: { title: true, description: true, tags: true, ...metadataSelect, activeVersionId: true } } },
    });
    if (!chunk || chunk.businessId !== businessId || knowledgeEmbeddingText.chunk(chunk) !== candidate.indexedContent) return null;
    return { ...common, ...metadata(chunk.document), sourceVersionId: chunk.document.activeVersionId, chunkId: chunk.id, title: truncate(chunk.document.title, 200), text: truncate(chunk.chunkText, 900), pageNumber: chunk.pageNumber };
  }
  if (candidate.sourceType === "DOCUMENT_FACT") {
    const document = await prisma.knowledgeDocument.findFirst({
      where: { businessId, id: candidate.sourceId, ...currentDocumentWhere },
      select: { businessId: true, activeVersionId: true, ...metadataSelect },
    });
    if (!document || document.businessId !== businessId) return null;
    // Keep approval, active-version, review-block and linked-service checks in their existing owner.
    const facts = await loadCustomerSafeKnowledgeFacts(businessId, { documentId: candidate.sourceId, ids: [candidate.chunkId], limit: 1 });
    const fact = facts.find(f => f.businessId === businessId && f.documentId === candidate.sourceId && f.id === candidate.chunkId);
    if (!fact || fact.versionId !== document.activeVersionId || knowledgeEmbeddingText.fact(fact) !== candidate.indexedContent || fact.document.title !== candidate.title) return null;
    return { ...common, ...metadata(document), sourceVersionId: document.activeVersionId, factId: fact.id, title: truncate(fact.document.title, 200), text: truncate(`${fact.label}\n${fact.valueText}`, 900), pageNumber: fact.pageNumber };
  }
  return null;
}

/** Standalone, read-only retrieval. No runtime registration, prompt mutation or model response call. */
export const knowledgeRetrievalService = {
  async retrieve(input: z.input<typeof inputSchema>): Promise<KnowledgeRetrievalResult> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new AppError(400, "A business, nonempty query (max 2000 characters), and topK from 1 to 8 are required.", "KNOWLEDGE_RETRIEVAL_INPUT_INVALID");
    const { businessId, query, topK, hints } = parsed.data;
    try {
      // Bounded overfetch leaves room for deduplication and rejected/revoked sources.
      const candidates = await knowledgeEmbeddingService.searchCandidates(businessId, query, topK * 4);
      const grounded: { match: KnowledgeGrounding; content: string }[] = [];
      const seen = new Set<string>();
      for (const candidate of candidates.slice(0, topK * 4).sort((a, b) => b.score - a.score)) {
        if (candidate.businessId !== businessId || !Number.isFinite(candidate.score) || candidate.score < env.KNOWLEDGE_SEMANTIC_MIN_SCORE || candidate.score > 1) continue;
        const key = JSON.stringify([candidate.sourceType, candidate.sourceId, candidate.chunkId ?? null]);
        if (seen.has(key)) continue;
        seen.add(key);
        const match = await ground(businessId, candidate);
        if (match?.text.trim()) grounded.push({ match, content: candidate.indexedContent });
      }
      // Newest valid duplicate wins independent of vector ordering; never mutate source content.
      grounded.sort((a, b) => (Date.parse(b.match.sourceUpdatedAt ?? "") || 0) - (Date.parse(a.match.sourceUpdatedAt ?? "") || 0)
        || a.match.sourceId.localeCompare(b.match.sourceId) || (a.match.chunkId ?? a.match.factId ?? "").localeCompare(b.match.chunkId ?? b.match.factId ?? ""));
      const unique: typeof grounded = [];
      for (const item of grounded) if (!unique.some(other => normalize(other.match.title) === normalize(item.match.title) && duplicate(other.content, item.content))) unique.push(item);
      // Metadata can move a source at most .06 semantic points; it cannot bypass the threshold.
      const rank = (m: KnowledgeGrounding) => m.score
        + (hints?.serviceId && m.relatedServiceIds?.includes(hints.serviceId) ? .04 : 0)
        + (hints?.policyId && m.relatedPolicyIds?.includes(hints.policyId) ? .01 : 0)
        + (hints?.category && normalize(m.category ?? "") === normalize(hints.category) ? .01 : 0);
      const matches = unique.map(item => item.match).sort((a, b) => rank(b) - rank(a) || b.score - a.score || a.sourceId.localeCompare(b.sourceId)).slice(0, topK);
      return { status: matches.length ? "MATCHES_FOUND" : "NO_RELEVANT_KNOWLEDGE", matches };
    } catch {
      // No partial/unverified results on provider, vector DB or governance-read failure.
      return { status: "RETRIEVAL_UNAVAILABLE", matches: [] };
    }
  },
};

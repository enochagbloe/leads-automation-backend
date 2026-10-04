import crypto from "node:crypto";
import { KnowledgeArticleStatus, KnowledgeAssetSendType, KnowledgeAssetVisibility, KnowledgeDocumentProcessingStatus, KnowledgeDocumentStatus, KnowledgeGovernanceStatus, Prisma } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { loadCustomerSafeKnowledgeFacts } from "./knowledge-document/knowledge-approved-facts.service";
import { lockKnowledgeDocumentGovernance } from "./knowledge-document/knowledge-document-governance-lock.service";
import {
  knowledgeFactStatusesAreCustomerSafe,
} from "./knowledge-document/knowledge-document-runtime-policy";

export type EmbeddingSourceType = "ARTICLE" | "DOCUMENT_CHUNK" | "DOCUMENT_FACT";

type VectorSearchResult = {
  sourceType: EmbeddingSourceType;
  sourceId: string;
  chunkId: string | null;
  score: number;
};

/** Internal candidates are untrusted until current source governance is checked. */
export type SemanticKnowledgeCandidate = VectorSearchResult & {
  businessId: string;
  title: string;
  indexedContent: string;
};

type OpenRouterEmbeddingResponse = {
  data?: Array<{ embedding?: number[] }>;
  error?: { message?: string };
};

const EMBEDDING_DIMENSIONS = 1536; // Must match the existing vector(1536) column.
const MAX_EMBEDDING_TEXT_CHARS = 6000;
const MAX_DOCUMENT_EMBEDDING_CHUNKS = 80;

type EmbeddingInput = {
  businessId: string;
  sourceType: EmbeddingSourceType;
  sourceId: string;
  chunkId?: string | null;
  title: string;
  content: string;
};

type PreparedEmbedding = EmbeddingInput & { embedding: number[] };

export async function prepareAndReplaceEmbeddingBatch<TInput, TPrepared>(input: {
  items: readonly TInput[];
  prepare: (item: TInput) => Promise<TPrepared | null>;
  replace: (prepared: readonly TPrepared[]) => Promise<void>;
  failure: () => Error;
}) {
  const prepared: TPrepared[] = [];
  for (const item of input.items) {
    const result = await input.prepare(item);
    if (!result) throw input.failure();
    prepared.push(result);
  }
  await input.replace(prepared);
}

function enabled() {
  return Boolean(env.OPENROUTER_API_KEY && env.OPENROUTER_EMBEDDING_MODEL);
}

function vectorLiteral(values: number[]) {
  return `[${values.map((value) => {
    return Number(value).toFixed(8);
  }).join(",")}]`;
}

function sourceId(input: {
  businessId: string;
  sourceType: EmbeddingSourceType;
  sourceId: string;
  chunkId?: string | null;
}) {
  return crypto.createHash("sha256")
    .update(`${input.businessId}:${input.sourceType}:${input.sourceId}:${input.chunkId ?? ""}`)
    .digest("hex");
}

function articleText(article: {
  title: string;
  summary: string | null;
  body: string;
  category: string | null;
  tags: string[];
}) {
  return [
    article.title,
    article.category ? `Category: ${article.category}` : "",
    article.summary ? `Summary: ${article.summary}` : "",
    article.tags.length ? `Tags: ${article.tags.join(", ")}` : "",
    article.body,
  ].filter(Boolean).join("\n").slice(0, MAX_EMBEDDING_TEXT_CHARS);
}

function documentChunkText(chunk: {
  chunkText: string;
  document: { title: string; description: string | null; category: string | null; tags: string[] };
}) {
  return [
    chunk.document.title,
    chunk.document.category ? `Category: ${chunk.document.category}` : "",
    chunk.document.description ? `Description: ${chunk.document.description}` : "",
    chunk.document.tags.length ? `Tags: ${chunk.document.tags.join(", ")}` : "",
    chunk.chunkText,
  ].filter(Boolean).join("\n").slice(0, MAX_EMBEDDING_TEXT_CHARS);
}

// Shared with retrieval to reject embeddings whose indexed text no longer matches the source.
export const knowledgeEmbeddingText = { article: articleText, chunk: documentChunkText,
  fact: (fact: { label: string; valueText: string }) => `${fact.label}\n${fact.valueText}`.slice(0, MAX_EMBEDDING_TEXT_CHARS),
};

async function createEmbedding(text: string) {
  if (!enabled()) return null;
  if (env.OPENROUTER_EMBEDDING_DIMENSIONS !== EMBEDDING_DIMENSIONS) throw new AppError(503, "Embedding dimensions must match vector(1536).", "KNOWLEDGE_EMBEDDING_DIMENSION_MISMATCH");
  const response = await fetch(`${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": env.OPENROUTER_APP_URL ?? env.APP_URL,
      "X-Title": env.OPENROUTER_APP_NAME,
    },
    body: JSON.stringify({
      model: env.OPENROUTER_EMBEDDING_MODEL,
      input: text,
      dimensions: env.OPENROUTER_EMBEDDING_DIMENSIONS,
    }),
    signal: AbortSignal.timeout(env.OPENROUTER_TIMEOUT_MS),
  });
  const raw = await response.json().catch(() => null) as OpenRouterEmbeddingResponse | null;
  if (!response.ok || !raw?.data?.[0]?.embedding?.length) {
    console.error("Knowledge embedding generation failed", { status: response.status, error: raw?.error?.message });
    return null;
  }
  const vector = raw.data[0].embedding;
  if (vector.length !== EMBEDDING_DIMENSIONS || vector.some(v => !Number.isFinite(v)) || !vector.some(v => v !== 0)) {
    throw new AppError(503, "Invalid embedding vector returned by provider.", "KNOWLEDGE_EMBEDDING_VECTOR_INVALID");
  }
  return vector;
}

async function prepareEmbedding(input: EmbeddingInput): Promise<PreparedEmbedding | null> {
  const embedding = await createEmbedding(input.content);
  return embedding ? { ...input, embedding } : null;
}

async function writeEmbedding(tx: Prisma.TransactionClient | typeof prisma, input: PreparedEmbedding) {
  await tx.$executeRawUnsafe(
    `INSERT INTO "KnowledgeSearchEmbedding"
      ("id", "businessId", "sourceType", "sourceId", "chunkId", "title", "content", "embedding", "embeddingModel", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, CURRENT_TIMESTAMP)
     ON CONFLICT ("businessId", "sourceType", "sourceId", "chunkId")
     DO UPDATE SET
      "title" = EXCLUDED."title",
      "content" = EXCLUDED."content",
      "embedding" = EXCLUDED."embedding",
      "embeddingModel" = EXCLUDED."embeddingModel",
      "updatedAt" = CURRENT_TIMESTAMP`,
    sourceId(input),
    input.businessId,
    input.sourceType,
    input.sourceId,
    input.chunkId ?? null,
    input.title,
    input.content,
    vectorLiteral(input.embedding),
    env.OPENROUTER_EMBEDDING_MODEL!,
  );
}

function assertScope(businessId: string) {
  if (typeof businessId !== "string" || !businessId.trim()) throw new AppError(400, "Business scope is required.", "KNOWLEDGE_EMBEDDING_SCOPE_REQUIRED");
}

type SourceKind = "ARTICLE" | "DOCUMENT" | "FACTS";
async function loadSource(db: Prisma.TransactionClient, businessId: string, id: string, kind: SourceKind) {
  if (kind === "ARTICLE") {
    const article = await db.knowledgeArticle.findFirst({ where: { id, businessId } });
    if (!article) return null;
    const inputs: EmbeddingInput[] = article.status === KnowledgeArticleStatus.PUBLISHED && article.visibility === KnowledgeAssetVisibility.CLIENT_SENDABLE
      ? [{ businessId, sourceType: "ARTICLE", sourceId: id, title: article.title, content: articleText(article) }] : [];
    return { version: article.updatedAt, inputs };
  }
  const document = await db.knowledgeDocument.findFirst({ where: { id, businessId }, include: {
    chunks: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: MAX_DOCUMENT_EMBEDDING_CHUNKS },
    activeVersion: { select: { isActive: true, facts: { select: { governanceStatus: true } } } },
  } });
  if (!document) return null;
  if (document.supersededByDocumentId || !document.activeVersion?.isActive) {
    return { version: document.updatedAt, activeVersionId: document.activeVersionId, inputs: [] };
  }
  const wholeDocumentSafe = kind !== "FACTS" && !document.deletedAt
    && document.status === KnowledgeDocumentStatus.ACTIVE
    && document.processingStatus === KnowledgeDocumentProcessingStatus.READY
    && document.governanceStatus === KnowledgeGovernanceStatus.APPROVED
    && document.visibility === KnowledgeAssetVisibility.CLIENT_SENDABLE
    && document.activeVersion !== null
    && knowledgeFactStatusesAreCustomerSafe(document.activeVersion.facts);
  let inputs: EmbeddingInput[];
  if (wholeDocumentSafe) {
    inputs = document.chunks.map(chunk => ({ businessId, sourceType: "DOCUMENT_CHUNK", sourceId: id, chunkId: chunk.id, title: document.title, content: documentChunkText({ chunkText: chunk.chunkText, document }) }));
    if (!inputs.length) throw new AppError(409, "The document has no chunks available for embedding.", "KNOWLEDGE_DOCUMENT_EMBEDDING_SOURCE_EMPTY");
  } else {
    const facts = await loadCustomerSafeKnowledgeFacts(businessId, { documentId: id, limit: MAX_DOCUMENT_EMBEDDING_CHUNKS }, db);
    inputs = facts.map(fact => ({ businessId, sourceType: "DOCUMENT_FACT", sourceId: id, chunkId: fact.id, title: fact.document.title, content: knowledgeEmbeddingText.fact(fact) }));
  }
  return { version: document.updatedAt, activeVersionId: document.activeVersionId, inputs };
}

async function syncSource(businessId: string, id: string, kind: SourceKind) {
  assertScope(businessId);
  if (!enabled()) return;
  const snapshot = await loadSource(prisma, businessId, id, kind);
  if (!snapshot) return; // A foreign/missing source can never delete another tenant's vectors.
  await prepareAndReplaceEmbeddingBatch({
    items: snapshot.inputs, prepare: prepareEmbedding,
    failure: () => new AppError(503, "Knowledge embeddings could not be generated.", "KNOWLEDGE_DOCUMENT_EMBEDDING_GENERATION_FAILED"),
    replace: async prepared => {
      await prisma.$transaction(async tx => {
        // Serialize with existing governance operations, then lock the scoped parent.
        if (kind !== "ARTICLE") {
          await lockKnowledgeDocumentGovernance(tx, id);
          await tx.$queryRaw`SELECT "id" FROM "KnowledgeDocument" WHERE "businessId" = ${businessId} AND "id" = ${id} FOR UPDATE`;
        } else {
          await tx.$queryRaw`SELECT "id" FROM "KnowledgeArticle" WHERE "businessId" = ${businessId} AND "id" = ${id} FOR UPDATE`;
        }
        const current = await loadSource(tx, businessId, id, kind);
        if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw new AppError(409, "Knowledge changed while embeddings were generated.", "KNOWLEDGE_DOCUMENT_EMBEDDING_SOURCE_CHANGED");
        // Switch fact/chunk representations and replace only after the entire batch is ready.
        const types = kind === "ARTICLE" ? ["ARTICLE"] : kind === "FACTS" ? ["DOCUMENT_FACT"] : ["DOCUMENT_CHUNK", "DOCUMENT_FACT"];
        for (const type of types) await tx.$executeRaw`DELETE FROM "KnowledgeSearchEmbedding" WHERE "businessId" = ${businessId} AND "sourceType" = ${type} AND "sourceId" = ${id}`;
        for (const embedding of prepared) await writeEmbedding(tx, embedding);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 30_000 });
    },
  });
}

async function searchVectors(businessId: string, query: string, limit: number, strict: boolean): Promise<SemanticKnowledgeCandidate[]> {
  assertScope(businessId);
  if (!enabled()) {
    if (strict) throw new AppError(503, "Embedding provider is not configured.", "KNOWLEDGE_EMBEDDING_DISABLED");
    return [];
  }
  const embedding = await createEmbedding(query);
  if (!embedding) {
    if (strict) throw new AppError(503, "Query embedding unavailable.", "KNOWLEDGE_EMBEDDING_UNAVAILABLE");
    return [];
  }
  const rows = await prisma.$queryRawUnsafe<SemanticKnowledgeCandidate[]>(
    `SELECT "businessId", "sourceType", "sourceId", "chunkId", "title", "content" AS "indexedContent",
      1 - ("embedding" <=> $1::vector) AS score
     FROM "KnowledgeSearchEmbedding"
     WHERE "businessId" = $2 AND "embeddingModel" = $4
     ORDER BY "embedding" <=> $1::vector
     LIMIT $3`, vectorLiteral(embedding), businessId, limit, env.OPENROUTER_EMBEDDING_MODEL!,
  );
  return rows.filter(row => row.businessId === businessId
    && ["ARTICLE", "DOCUMENT_CHUNK", "DOCUMENT_FACT"].includes(row.sourceType)
    && typeof row.sourceId === "string" && Number.isFinite(row.score));
}

export const knowledgeEmbeddingService = {
  isEnabled: enabled,
  async deleteSource(businessId: string, sourceType: EmbeddingSourceType, sourceId: string) {
    assertScope(businessId);
    await prisma.$executeRaw`DELETE FROM "KnowledgeSearchEmbedding" WHERE "businessId" = ${businessId} AND "sourceType" = ${sourceType} AND "sourceId" = ${sourceId}`;
  },
  async syncArticle(businessId: string, articleId: string) { await syncSource(businessId, articleId, "ARTICLE"); },
  async syncDocument(businessId: string, documentId: string) { await syncSource(businessId, documentId, "DOCUMENT"); },
  async syncApprovedFacts(businessId: string, documentId: string) { await syncSource(businessId, documentId, "FACTS"); },

  /** Explicit one-tenant page. Call again with nextCursor; never runs at startup. */
  async backfill(businessId: string, input: { kind: "ARTICLE" | "DOCUMENT"; afterId?: string; limit?: number }) {
    assertScope(businessId);
    if (!enabled()) throw new AppError(503, "Embedding provider is not configured.", "KNOWLEDGE_EMBEDDING_DISABLED");
    const limit = input.limit ?? 10;
    if (!["ARTICLE", "DOCUMENT"].includes(input.kind) || !Number.isInteger(limit) || limit < 1 || limit > 25) throw new AppError(400, "Choose ARTICLE or DOCUMENT and a page size between 1 and 25.", "KNOWLEDGE_EMBEDDING_BACKFILL_INVALID");
    const where = { businessId, ...(input.afterId ? { id: { gt: input.afterId } } : {}) };
    // Include ineligible sources so explicit sync also removes revoked vectors. Fact eligibility is evaluated per document.
    const rows = input.kind === "ARTICLE"
      ? await prisma.knowledgeArticle.findMany({ where, orderBy: { id: "asc" }, take: limit + 1, select: { id: true } })
      : await prisma.knowledgeDocument.findMany({ where, orderBy: { id: "asc" }, take: limit + 1, select: { id: true } });
    const results: Array<{ id: string; status: "SYNCED" | "FAILED"; errorCode?: string }> = [];
    for (const row of rows.slice(0, limit)) {
      try { await syncSource(businessId, row.id, input.kind); results.push({ id: row.id, status: "SYNCED" }); }
      catch (error) { results.push({ id: row.id, status: "FAILED", errorCode: error instanceof AppError ? error.code : "KNOWLEDGE_EMBEDDING_SYNC_FAILED" }); }
    }
    return { businessId, kind: input.kind, results, nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
  },

  /** Existing asset search contract remains article/chunk only, with lexical fallback. */
  async search(businessId: string, query: string, limit: number): Promise<VectorSearchResult[]> {
    const rows = await searchVectors(businessId, query, limit, false);
    return rows.filter(row => row.sourceType !== "DOCUMENT_FACT")
      .map(({ sourceType, sourceId, chunkId, score }) => ({ sourceType, sourceId, chunkId, score }));
  },

  /** Standalone semantic retrieval explicitly opts into facts and failure reporting. */
  async searchCandidates(businessId: string, query: string, limit: number): Promise<SemanticKnowledgeCandidate[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new AppError(400, "Candidate limit must be between 1 and 32.", "KNOWLEDGE_RETRIEVAL_INPUT_INVALID");
    return searchVectors(businessId, query, limit, true);
  },
};

export function embeddingResultTypeToAssetType(sourceType: EmbeddingSourceType) {
  return sourceType === "ARTICLE" ? KnowledgeAssetSendType.ARTICLE_PDF : KnowledgeAssetSendType.UPLOADED_DOCUMENT;
}

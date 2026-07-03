import crypto from "node:crypto";
import { KnowledgeArticleStatus, KnowledgeAssetSendType, KnowledgeAssetVisibility, KnowledgeDocumentStatus } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";

type EmbeddingSourceType = "ARTICLE" | "DOCUMENT_CHUNK";

type VectorSearchResult = {
  sourceType: EmbeddingSourceType;
  sourceId: string;
  chunkId: string | null;
  score: number;
};

type OpenRouterEmbeddingResponse = {
  data?: Array<{ embedding?: number[] }>;
  error?: { message?: string };
};

const MAX_EMBEDDING_TEXT_CHARS = 6000;

function enabled() {
  return Boolean(env.OPENROUTER_API_KEY && env.OPENROUTER_EMBEDDING_MODEL);
}

function vectorLiteral(values: number[]) {
  return `[${values.map((value) => {
    if (!Number.isFinite(value)) return "0";
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

async function createEmbedding(text: string) {
  if (!enabled()) return null;
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
  return raw.data[0].embedding.slice(0, env.OPENROUTER_EMBEDDING_DIMENSIONS);
}

async function upsertEmbedding(input: {
  businessId: string;
  sourceType: EmbeddingSourceType;
  sourceId: string;
  chunkId?: string | null;
  title: string;
  content: string;
}) {
  const embedding = await createEmbedding(input.content);
  if (!embedding) return false;
  await prisma.$executeRawUnsafe(
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
    vectorLiteral(embedding),
    env.OPENROUTER_EMBEDDING_MODEL!,
  );
  return true;
}

export const knowledgeEmbeddingService = {
  isEnabled: enabled,

  async deleteSource(businessId: string, sourceType: EmbeddingSourceType, sourceId: string) {
    await prisma.$executeRaw`
      DELETE FROM "KnowledgeSearchEmbedding"
      WHERE "businessId" = ${businessId}
        AND "sourceType" = ${sourceType}
        AND "sourceId" = ${sourceId}
    `;
  },

  async syncArticle(articleId: string) {
    if (!enabled()) return;
    const article = await prisma.knowledgeArticle.findUnique({ where: { id: articleId } });
    if (!article) return;
    if (article.status !== KnowledgeArticleStatus.PUBLISHED || article.visibility !== KnowledgeAssetVisibility.CLIENT_SENDABLE) {
      await this.deleteSource(article.businessId, "ARTICLE", article.id);
      return;
    }
    await upsertEmbedding({
      businessId: article.businessId,
      sourceType: "ARTICLE",
      sourceId: article.id,
      title: article.title,
      content: articleText(article),
    });
  },

  async syncDocument(documentId: string) {
    if (!enabled()) return;
    const document = await prisma.knowledgeDocument.findUnique({
      where: { id: documentId },
      include: { chunks: { orderBy: { createdAt: "asc" } } },
    });
    if (!document) return;
    if (document.status !== KnowledgeDocumentStatus.ACTIVE || document.visibility !== KnowledgeAssetVisibility.CLIENT_SENDABLE) {
      await this.deleteSource(document.businessId, "DOCUMENT_CHUNK", document.id);
      return;
    }
    for (const chunk of document.chunks.slice(0, 80)) {
      await upsertEmbedding({
        businessId: document.businessId,
        sourceType: "DOCUMENT_CHUNK",
        sourceId: document.id,
        chunkId: chunk.id,
        title: document.title,
        content: documentChunkText({ chunkText: chunk.chunkText, document }),
      });
    }
  },

  async search(businessId: string, query: string, limit: number): Promise<VectorSearchResult[]> {
    if (!enabled()) return [];
    const embedding = await createEmbedding(query);
    if (!embedding) return [];
    const rows = await prisma.$queryRawUnsafe<Array<{
      sourceType: EmbeddingSourceType;
      sourceId: string;
      chunkId: string | null;
      score: number;
    }>>(
      `SELECT "sourceType", "sourceId", "chunkId", 1 - ("embedding" <=> $1::vector) AS score
       FROM "KnowledgeSearchEmbedding"
       WHERE "businessId" = $2
       ORDER BY "embedding" <=> $1::vector
       LIMIT $3`,
      vectorLiteral(embedding),
      businessId,
      limit,
    );
    return rows.filter((row) =>
      (row.sourceType === "ARTICLE" || row.sourceType === "DOCUMENT_CHUNK")
      && typeof row.sourceId === "string"
      && typeof row.score === "number");
  },
};

export function embeddingResultTypeToAssetType(sourceType: EmbeddingSourceType) {
  return sourceType === "ARTICLE" ? KnowledgeAssetSendType.ARTICLE_PDF : KnowledgeAssetSendType.UPLOADED_DOCUMENT;
}

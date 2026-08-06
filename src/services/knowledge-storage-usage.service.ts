import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import {
  isStorageObjectNotFoundError,
  resolveStorageObjectProvider,
  storageService,
} from "./storage.service";

type KnowledgeStorageClient = Prisma.TransactionClient | typeof prisma;

export type KnowledgeStorageUsage = {
  documentVersionBytes: number;
  articlePdfBytes: number;
  totalBytes: number;
  unmeasuredArticlePdfCount: number;
};

function usage(documentVersionBytes: number, articlePdfBytes: number, unmeasuredArticlePdfCount: number) {
  return {
    documentVersionBytes,
    articlePdfBytes,
    totalBytes: documentVersionBytes + articlePdfBytes,
    unmeasuredArticlePdfCount,
  } satisfies KnowledgeStorageUsage;
}

export async function calculateKnowledgeStorageUsage(
  client: KnowledgeStorageClient,
  businessAccountId: string,
): Promise<KnowledgeStorageUsage> {
  const [documentVersions, articlePdfs, unmeasuredArticlePdfCount] = await Promise.all([
    client.knowledgeDocumentVersion.aggregate({
      where: {
        business: { businessAccountId },
        storageObjectKey: { not: null },
        storageDeletedAt: null,
      },
      _sum: { fileSize: true },
    }),
    client.knowledgeArticle.aggregate({
      where: {
        business: { businessAccountId },
        pdfFileKey: { not: null },
        pdfFileSize: { not: null },
      },
      _sum: { pdfFileSize: true },
    }),
    client.knowledgeArticle.count({
      where: {
        business: { businessAccountId },
        pdfFileKey: { not: null },
        pdfFileSize: null,
      },
    }),
  ]);
  return usage(
    documentVersions._sum.fileSize ?? 0,
    articlePdfs._sum.pdfFileSize ?? 0,
    unmeasuredArticlePdfCount,
  );
}

export async function calculateKnowledgeStorageUsageByBusiness(
  client: KnowledgeStorageClient,
  businessAccountId: string,
) {
  const [documentVersions, articlePdfs, unmeasuredArticlePdfs] = await Promise.all([
    client.knowledgeDocumentVersion.groupBy({
      by: ["businessId"],
      where: {
        business: { businessAccountId },
        storageObjectKey: { not: null },
        storageDeletedAt: null,
      },
      _sum: { fileSize: true },
    }),
    client.knowledgeArticle.groupBy({
      by: ["businessId"],
      where: {
        business: { businessAccountId },
        pdfFileKey: { not: null },
        pdfFileSize: { not: null },
      },
      _sum: { pdfFileSize: true },
    }),
    client.knowledgeArticle.groupBy({
      by: ["businessId"],
      where: {
        business: { businessAccountId },
        pdfFileKey: { not: null },
        pdfFileSize: null,
      },
      _count: { _all: true },
    }),
  ]);
  const result = new Map<string, KnowledgeStorageUsage>();
  const businessIds = new Set([
    ...documentVersions.map((entry) => entry.businessId),
    ...articlePdfs.map((entry) => entry.businessId),
    ...unmeasuredArticlePdfs.map((entry) => entry.businessId),
  ]);
  for (const businessId of businessIds) {
    result.set(businessId, usage(
      documentVersions.find((entry) => entry.businessId === businessId)?._sum.fileSize ?? 0,
      articlePdfs.find((entry) => entry.businessId === businessId)?._sum.pdfFileSize ?? 0,
      unmeasuredArticlePdfs.find((entry) => entry.businessId === businessId)?._count._all ?? 0,
    ));
  }
  return result;
}

export function assertKnowledgeStorageUsageMeasured(value: KnowledgeStorageUsage) {
  if (value.unmeasuredArticlePdfCount === 0) return;
  throw new AppError(
    503,
    "Knowledge storage usage is being reconciled. Please try again shortly.",
    "KNOWLEDGE_STORAGE_USAGE_RECONCILIATION_REQUIRED",
    { unmeasuredObjectCount: value.unmeasuredArticlePdfCount },
  );
}

export async function reconcileKnowledgeArticlePdfSizes(businessAccountId: string, limit = 100) {
  const articles = await prisma.knowledgeArticle.findMany({
    where: {
      business: { businessAccountId },
      pdfFileKey: { not: null },
      pdfFileSize: null,
    },
    select: {
      id: true,
      pdfFileKey: true,
      pdfStorageObjectKey: true,
      pdfStorageProvider: true,
    },
    orderBy: { updatedAt: "asc" },
    take: Math.max(1, Math.min(500, Math.trunc(limit))),
  });
  let measured = 0;
  let missing = 0;
  for (const article of articles) {
    const objectKey = article.pdfStorageObjectKey ?? article.pdfFileKey;
    if (!objectKey) continue;
    try {
      const provider = await resolveStorageObjectProvider(objectKey, article.pdfStorageProvider);
      const metadata = await storageService.statFile(objectKey, provider);
      const changed = await prisma.knowledgeArticle.updateMany({
        where: { id: article.id, pdfFileKey: article.pdfFileKey, pdfFileSize: null },
        data: {
          pdfFileSize: metadata.fileSize,
          pdfStorageProvider: provider,
          pdfStorageObjectKey: objectKey,
        },
      });
      measured += changed.count;
    } catch (error) {
      if (!isStorageObjectNotFoundError(error)) continue;
      const changed = await prisma.knowledgeArticle.updateMany({
        where: { id: article.id, pdfFileKey: article.pdfFileKey, pdfFileSize: null },
        data: {
          pdfFileKey: null,
          pdfFileUrl: null,
          pdfFileSize: null,
          pdfStorageProvider: null,
          pdfStorageObjectKey: null,
          lastPdfGeneratedAt: null,
        },
      });
      missing += changed.count;
    }
  }
  return { inspected: articles.length, measured, missing };
}

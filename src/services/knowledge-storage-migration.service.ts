import crypto from "node:crypto";
import path from "node:path";
import {
  KnowledgeStorageMigrationJobStatus,
  KnowledgeStorageProvider,
} from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import {
  configuredKnowledgeStorageProvider,
  isStorageObjectNotFoundError,
  resolveStorageObjectProvider,
  storageService,
} from "./storage.service";

const MAX_ATTEMPTS = 10;
type MigrationStorage = Pick<typeof storageService, "deleteFile" | "readBuffer" | "statFile" | "uploadBuffer">;

function retryAt(attemptCount: number) {
  return new Date(Date.now() + Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.max(0, attemptCount - 1)));
}

function targetObjectKey(businessId: string, sourceObjectKey: string) {
  const digest = crypto.createHash("sha256").update(sourceObjectKey).digest("hex").slice(0, 20);
  const fileName = path.posix.basename(sourceObjectKey).replace(/[^a-zA-Z0-9._-]/g, "-").slice(-100) || "file.bin";
  return `businesses/${businessId}/legacy/${digest}-${fileName}`;
}

async function resolveUnknownMetadata(limit: number) {
  const [articles, attachments] = await Promise.all([
    prisma.knowledgeArticle.findMany({
      where: {
        pdfStorageProvider: null,
        OR: [{ pdfStorageObjectKey: { not: null } }, { pdfFileKey: { not: null } }],
      },
      select: { id: true, pdfFileKey: true, pdfStorageObjectKey: true },
      take: limit,
    }),
    prisma.conversationMessageAttachment.findMany({
      where: {
        storageProvider: null,
        OR: [{ storageObjectKey: { not: null } }, { fileKey: { not: null } }],
      },
      select: { id: true, fileKey: true, storageObjectKey: true },
      take: limit,
    }),
  ]);
  for (const article of articles) {
    const objectKey = article.pdfStorageObjectKey ?? article.pdfFileKey;
    if (!objectKey) continue;
    const provider = await resolveStorageObjectProvider(objectKey).catch(() => null);
    if (!provider) continue;
    await prisma.knowledgeArticle.updateMany({
      where: { id: article.id, pdfStorageProvider: null },
      data: { pdfStorageProvider: provider, pdfStorageObjectKey: objectKey, pdfFileKey: objectKey },
    });
  }
  for (const attachment of attachments) {
    const objectKey = attachment.storageObjectKey ?? attachment.fileKey;
    if (!objectKey) continue;
    const provider = await resolveStorageObjectProvider(objectKey).catch(() => null);
    if (!provider) continue;
    await prisma.conversationMessageAttachment.updateMany({
      where: { id: attachment.id, storageProvider: null },
      data: { storageProvider: provider, storageObjectKey: objectKey, fileKey: objectKey },
    });
  }
  return articles.length + attachments.length;
}

async function discoverMigrationJobs(limit: number) {
  const targetProvider = configuredKnowledgeStorageProvider();
  if (targetProvider !== KnowledgeStorageProvider.S3_COMPATIBLE) return 0;
  const [articles, attachments] = await Promise.all([
    prisma.knowledgeArticle.findMany({
      where: {
        pdfStorageProvider: { not: null, notIn: [targetProvider] },
        pdfStorageObjectKey: { not: null },
      },
      select: { businessId: true, pdfStorageProvider: true, pdfStorageObjectKey: true },
      take: limit,
    }),
    prisma.conversationMessageAttachment.findMany({
      where: {
        storageProvider: { not: null, notIn: [targetProvider] },
        storageObjectKey: { not: null },
      },
      select: { businessId: true, storageProvider: true, storageObjectKey: true },
      take: limit,
    }),
  ]);
  const sources = new Map<string, {
    businessId: string;
    sourceProvider: KnowledgeStorageProvider;
    sourceObjectKey: string;
  }>();
  for (const value of [
    ...articles.map((article) => ({
      businessId: article.businessId,
      sourceProvider: article.pdfStorageProvider!,
      sourceObjectKey: article.pdfStorageObjectKey!,
    })),
    ...attachments.map((attachment) => ({
      businessId: attachment.businessId,
      sourceProvider: attachment.storageProvider!,
      sourceObjectKey: attachment.storageObjectKey!,
    })),
  ]) {
    sources.set(`${value.businessId}:${value.sourceProvider}:${value.sourceObjectKey}`, value);
  }
  for (const source of sources.values()) {
    await prisma.knowledgeStorageMigrationJob.upsert({
      where: {
        businessId_sourceProvider_sourceObjectKey_targetProvider: {
          businessId: source.businessId,
          sourceProvider: source.sourceProvider,
          sourceObjectKey: source.sourceObjectKey,
          targetProvider,
        },
      },
      create: {
        ...source,
        targetProvider,
        targetObjectKey: targetObjectKey(source.businessId, source.sourceObjectKey),
        nextAttemptAt: new Date(),
      },
      update: {},
    });
  }
  return sources.size;
}

async function claimJob(jobId?: string) {
  const now = new Date();
  const candidates = await prisma.knowledgeStorageMigrationJob.findMany({
    where: {
      ...(jobId ? { id: jobId } : {}),
      attemptCount: { lt: MAX_ATTEMPTS },
      OR: [
        { status: KnowledgeStorageMigrationJobStatus.SCHEDULED, nextAttemptAt: { lte: now } },
        { status: KnowledgeStorageMigrationJobStatus.FAILED, nextAttemptAt: { lte: now } },
      ],
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: jobId ? 1 : 10,
  });
  for (const candidate of candidates) {
    const processingStartedAt = new Date();
    const changed = await prisma.knowledgeStorageMigrationJob.updateMany({
      where: {
        id: candidate.id,
        status: candidate.status,
        attemptCount: candidate.attemptCount,
        updatedAt: candidate.updatedAt,
      },
      data: {
        status: KnowledgeStorageMigrationJobStatus.PROCESSING,
        attemptCount: { increment: 1 },
        processingStartedAt,
        nextAttemptAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    if (changed.count === 1) {
      return { ...candidate, attemptCount: candidate.attemptCount + 1, processingStartedAt };
    }
  }
  return null;
}

async function sourceReferenceCount(sourceProvider: KnowledgeStorageProvider, sourceObjectKey: string) {
  const [articles, attachments] = await Promise.all([
    prisma.knowledgeArticle.count({
      where: { pdfStorageProvider: sourceProvider, pdfStorageObjectKey: sourceObjectKey },
    }),
    prisma.conversationMessageAttachment.count({
      where: { storageProvider: sourceProvider, storageObjectKey: sourceObjectKey },
    }),
  ]);
  return articles + attachments;
}

async function sourceContentType(
  businessId: string,
  sourceProvider: KnowledgeStorageProvider,
  sourceObjectKey: string,
) {
  const [article, attachment] = await Promise.all([
    prisma.knowledgeArticle.findFirst({
      where: {
        businessId,
        pdfStorageProvider: sourceProvider,
        pdfStorageObjectKey: sourceObjectKey,
      },
      select: { id: true },
    }),
    prisma.conversationMessageAttachment.findFirst({
      where: {
        businessId,
        storageProvider: sourceProvider,
        storageObjectKey: sourceObjectKey,
      },
      select: { mimeType: true },
    }),
  ]);
  return article ? "application/pdf" : attachment?.mimeType ?? "application/octet-stream";
}

async function failJob(job: Awaited<ReturnType<typeof claimJob>> & {}, error: unknown) {
  if (!job) return;
  const exhausted = job.attemptCount >= MAX_ATTEMPTS;
  await prisma.knowledgeStorageMigrationJob.updateMany({
    where: {
      id: job.id,
      status: KnowledgeStorageMigrationJobStatus.PROCESSING,
      attemptCount: job.attemptCount,
      processingStartedAt: job.processingStartedAt,
    },
    data: {
      status: exhausted
        ? KnowledgeStorageMigrationJobStatus.EXHAUSTED
        : KnowledgeStorageMigrationJobStatus.FAILED,
      processingStartedAt: null,
      nextAttemptAt: exhausted ? null : retryAt(job.attemptCount),
      completedAt: exhausted ? new Date() : null,
      errorCode: error instanceof AppError ? error.code : "KNOWLEDGE_STORAGE_MIGRATION_FAILED",
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : "Storage migration failed.",
    },
  });
}

export async function processKnowledgeStorageMigrationJob(
  jobId?: string,
  storage: MigrationStorage = storageService,
) {
  const job = await claimJob(jobId);
  if (!job) return false;
  try {
    const references = await sourceReferenceCount(job.sourceProvider, job.sourceObjectKey);
    if (references > 0) {
      let source: Buffer | null = null;
      try {
        source = await storage.readBuffer(job.sourceObjectKey, job.sourceProvider);
      } catch (error) {
        if (!isStorageObjectNotFoundError(error)) throw error;
        await storage.statFile(job.targetObjectKey, job.targetProvider);
      }
      if (source) {
        const contentType = await sourceContentType(
          job.businessId,
          job.sourceProvider,
          job.sourceObjectKey,
        );
        await storage.uploadBuffer({
          businessId: job.businessId,
          fileName: path.posix.basename(job.targetObjectKey),
          contentType,
          buffer: source,
          objectKey: job.targetObjectKey,
          storageProvider: job.targetProvider,
        });
        const copied = await storage.statFile(job.targetObjectKey, job.targetProvider);
        if (copied.fileSize !== source.byteLength) {
          throw new AppError(503, "Copied storage object size does not match.", "KNOWLEDGE_STORAGE_MIGRATION_COPY_MISMATCH");
        }
      }
      await prisma.$transaction(async (tx) => {
        const lease = await tx.knowledgeStorageMigrationJob.updateMany({
          where: {
            id: job.id,
            status: KnowledgeStorageMigrationJobStatus.PROCESSING,
            attemptCount: job.attemptCount,
            processingStartedAt: job.processingStartedAt,
          },
          data: { errorCode: null, errorMessage: null },
        });
        if (lease.count !== 1) {
          throw new AppError(409, "Storage migration lease changed.", "KNOWLEDGE_STORAGE_MIGRATION_LEASE_CHANGED");
        }
        await tx.knowledgeArticle.updateMany({
          where: {
            businessId: job.businessId,
            pdfStorageProvider: job.sourceProvider,
            pdfStorageObjectKey: job.sourceObjectKey,
          },
          data: {
            pdfStorageProvider: job.targetProvider,
            pdfStorageObjectKey: job.targetObjectKey,
            pdfFileKey: job.targetObjectKey,
          },
        });
        await tx.conversationMessageAttachment.updateMany({
          where: {
            businessId: job.businessId,
            storageProvider: job.sourceProvider,
            storageObjectKey: job.sourceObjectKey,
          },
          data: {
            storageProvider: job.targetProvider,
            storageObjectKey: job.targetObjectKey,
            fileKey: job.targetObjectKey,
          },
        });
      });
    }
    if (await sourceReferenceCount(job.sourceProvider, job.sourceObjectKey) === 0) {
      await storage.deleteFile(job.sourceObjectKey, job.sourceProvider);
    } else {
      throw new AppError(409, "Legacy storage references remain.", "KNOWLEDGE_STORAGE_MIGRATION_REFERENCES_REMAIN");
    }
    const completed = await prisma.knowledgeStorageMigrationJob.updateMany({
      where: {
        id: job.id,
        status: KnowledgeStorageMigrationJobStatus.PROCESSING,
        attemptCount: job.attemptCount,
        processingStartedAt: job.processingStartedAt,
      },
      data: {
        status: KnowledgeStorageMigrationJobStatus.COMPLETED,
        processingStartedAt: null,
        nextAttemptAt: null,
        completedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    });
    return completed.count === 1;
  } catch (error) {
    await failJob(job, error);
    return true;
  }
}

async function recoverStaleJobs() {
  const staleBefore = new Date(Date.now() - env.KNOWLEDGE_DOCUMENT_CLEANUP_STALE_SECONDS * 1_000);
  const jobs = await prisma.knowledgeStorageMigrationJob.findMany({
    where: {
      status: KnowledgeStorageMigrationJobStatus.PROCESSING,
      processingStartedAt: { lt: staleBefore },
    },
    take: env.KNOWLEDGE_DOCUMENT_CLEANUP_BATCH_SIZE,
  });
  for (const job of jobs) {
    if (!job.processingStartedAt) continue;
    await failJob({ ...job, processingStartedAt: job.processingStartedAt }, new Error("Stale storage migration recovered."));
  }
}

export const knowledgeStorageMigrationService = {
  async tick(limit = env.KNOWLEDGE_DOCUMENT_CLEANUP_BATCH_SIZE) {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    await resolveUnknownMetadata(boundedLimit);
    await discoverMigrationJobs(boundedLimit);
    await recoverStaleJobs();
    let processed = 0;
    while (processed < boundedLimit && await processKnowledgeStorageMigrationJob()) processed += 1;
    return processed;
  },
};

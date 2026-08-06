import {
  AuditAction,
  KnowledgeDocumentRetentionStatus,
  KnowledgeDocumentStatus,
  KnowledgeDocumentStorageDeletionJobStatus,
  Prisma,
} from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { auditService } from "../audit.service";
import { isStorageObjectNotFoundError, storageService } from "../storage.service";
import {
  knowledgeDocumentStorageDeletionCanBeClaimed,
  knowledgeDocumentStorageDeletionOwnershipMatches,
  knowledgeDocumentStorageDeletionRetryAt,
} from "./knowledge-document-storage-cleanup-policy";

type StorageDeletionAdapter = Pick<typeof storageService, "deleteFile" | "statFile">;

function safeFailure(error: unknown) {
  if (error instanceof AppError) return { code: error.code, message: error.message.slice(0, 300) };
  return {
    code: "KNOWLEDGE_DOCUMENT_STORAGE_DELETION_FAILED",
    message: "The retained document object could not be deleted.",
  };
}

async function auditJob(
  job: { businessId: string; documentId: string; versionId: string; id: string },
  action: AuditAction,
  metadata: Record<string, unknown>,
) {
  await auditService.log({
    action,
    businessId: job.businessId,
    metadata: {
      deletionJobId: job.id,
      documentId: job.documentId,
      versionId: job.versionId,
      ...metadata,
    } as Prisma.InputJsonValue,
  }).catch((error) => {
    console.error("Knowledge document storage deletion audit failed", {
      deletionJobId: job.id,
      action,
      error,
    });
  });
}

async function claimJob(jobId?: string) {
  const now = new Date();
  const candidates = await prisma.knowledgeDocumentStorageDeletionJob.findMany({
    where: {
      ...(jobId ? { id: jobId } : {}),
      attemptCount: { lt: env.KNOWLEDGE_DOCUMENT_CLEANUP_MAX_ATTEMPTS },
      OR: [
        {
          status: KnowledgeDocumentStorageDeletionJobStatus.SCHEDULED,
          scheduledFor: { lte: now },
        },
        {
          status: KnowledgeDocumentStorageDeletionJobStatus.FAILED,
          nextAttemptAt: { lte: now },
        },
      ],
    },
    orderBy: [{ nextAttemptAt: "asc" }, { scheduledFor: "asc" }, { createdAt: "asc" }],
    take: jobId ? 1 : Math.max(2, env.KNOWLEDGE_DOCUMENT_CLEANUP_BATCH_SIZE * 2),
  });
  for (const candidate of candidates) {
    if (!knowledgeDocumentStorageDeletionCanBeClaimed({
      status: candidate.status,
      attemptCount: candidate.attemptCount,
      maximumAttempts: env.KNOWLEDGE_DOCUMENT_CLEANUP_MAX_ATTEMPTS,
      scheduledFor: candidate.scheduledFor,
      nextAttemptAt: candidate.nextAttemptAt,
      now,
    })) continue;
    const processingStartedAt = new Date();
    const changed = await prisma.$transaction(async (tx) => {
      const claimed = await tx.knowledgeDocumentStorageDeletionJob.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          attemptCount: candidate.attemptCount,
          updatedAt: candidate.updatedAt,
        },
        data: {
          status: KnowledgeDocumentStorageDeletionJobStatus.PROCESSING,
          attemptCount: { increment: 1 },
          processingStartedAt,
          nextAttemptAt: null,
          completedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      if (claimed.count !== 1) return false;
      await tx.knowledgeDocument.updateMany({
        where: {
          id: candidate.documentId,
          businessId: candidate.businessId,
          status: KnowledgeDocumentStatus.DELETED,
          retentionStatus: {
            in: [
              KnowledgeDocumentRetentionStatus.PENDING_DELETION,
              KnowledgeDocumentRetentionStatus.DELETION_FAILED,
            ],
          },
        },
        data: { retentionStatus: KnowledgeDocumentRetentionStatus.DELETION_IN_PROGRESS },
      });
      return true;
    });
    if (changed) return { ...candidate, attemptCount: candidate.attemptCount + 1, processingStartedAt };
  }
  return null;
}

async function failJob(
  job: { id: string; businessId: string; documentId: string; versionId: string; attemptCount: number; processingStartedAt: Date },
  error: unknown,
) {
  const failure = safeFailure(error);
  const exhausted = job.attemptCount >= env.KNOWLEDGE_DOCUMENT_CLEANUP_MAX_ATTEMPTS;
  const changed = await prisma.$transaction(async (tx) => {
    const failed = await tx.knowledgeDocumentStorageDeletionJob.updateMany({
      where: {
        id: job.id,
        status: KnowledgeDocumentStorageDeletionJobStatus.PROCESSING,
        attemptCount: job.attemptCount,
        processingStartedAt: job.processingStartedAt,
      },
      data: {
        status: exhausted
          ? KnowledgeDocumentStorageDeletionJobStatus.EXHAUSTED
          : KnowledgeDocumentStorageDeletionJobStatus.FAILED,
        processingStartedAt: null,
        nextAttemptAt: exhausted ? null : knowledgeDocumentStorageDeletionRetryAt(job.attemptCount),
        completedAt: exhausted ? new Date() : null,
        lastErrorCode: failure.code,
        lastErrorMessage: failure.message,
      },
    });
    if (failed.count !== 1) return false;
    await tx.knowledgeDocument.updateMany({
      where: { id: job.documentId, businessId: job.businessId, status: KnowledgeDocumentStatus.DELETED },
      data: { retentionStatus: KnowledgeDocumentRetentionStatus.DELETION_FAILED },
    });
    return true;
  });
  if (changed) {
    await auditJob(job, AuditAction.KNOWLEDGE_DOCUMENT_STORAGE_DELETION_FAILED, {
      errorCode: failure.code,
      attemptCount: job.attemptCount,
      exhausted,
    });
  }
}

async function confirmObjectDeleted(
  objectKey: string,
  provider: Parameters<StorageDeletionAdapter["deleteFile"]>[1],
  storage: StorageDeletionAdapter,
) {
  await storage.deleteFile(objectKey, provider);
  try {
    await storage.statFile(objectKey, provider);
  } catch (error) {
    if (isStorageObjectNotFoundError(error)) return;
    throw error;
  }
  throw new AppError(
    503,
    "The storage provider has not confirmed object deletion.",
    "KNOWLEDGE_DOCUMENT_STORAGE_DELETION_NOT_CONFIRMED",
  );
}

async function completeJob(
  job: {
    id: string;
    businessId: string;
    documentId: string;
    versionId: string;
    storageObjectKey: string;
    attemptCount: number;
    processingStartedAt: Date;
  },
) {
  return prisma.$transaction(async (tx) => {
    const completedAt = new Date();
    const completed = await tx.knowledgeDocumentStorageDeletionJob.updateMany({
      where: {
        id: job.id,
        status: KnowledgeDocumentStorageDeletionJobStatus.PROCESSING,
        attemptCount: job.attemptCount,
        processingStartedAt: job.processingStartedAt,
      },
      data: {
        status: KnowledgeDocumentStorageDeletionJobStatus.COMPLETED,
        processingStartedAt: null,
        nextAttemptAt: null,
        completedAt,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    if (completed.count !== 1) return false;
    const version = await tx.knowledgeDocumentVersion.updateMany({
      where: {
        id: job.versionId,
        documentId: job.documentId,
        businessId: job.businessId,
        storageObjectKey: job.storageObjectKey,
        storageDeletedAt: null,
      },
      data: { storageObjectKey: null, storageDeletedAt: completedAt },
    });
    if (version.count !== 1) {
      throw new AppError(409, "Storage reference changed during deletion.", "KNOWLEDGE_DOCUMENT_STORAGE_DELETION_STATE_CHANGED");
    }
    await tx.knowledgeDocument.updateMany({
      where: {
        id: job.documentId,
        businessId: job.businessId,
        storageObjectKey: job.storageObjectKey,
      },
      data: { fileKey: null, storageObjectKey: null },
    });
    const remaining = await tx.knowledgeDocumentVersion.count({
      where: {
        documentId: job.documentId,
        businessId: job.businessId,
        storageDeletedAt: null,
        storageObjectKey: { not: null },
      },
    });
    if (remaining === 0) {
      await tx.knowledgeDocument.update({
        where: { id: job.documentId },
        data: {
          retentionStatus: KnowledgeDocumentRetentionStatus.PURGED,
          storageDeletedAt: completedAt,
          activeVersionId: null,
          fileKey: null,
          storageObjectKey: null,
        },
      });
      await tx.knowledgeDocumentVersion.updateMany({
        where: { documentId: job.documentId, businessId: job.businessId, isActive: true },
        data: { isActive: false },
      });
    } else {
      await tx.knowledgeDocument.update({
        where: { id: job.documentId },
        data: { retentionStatus: KnowledgeDocumentRetentionStatus.PENDING_DELETION },
      });
    }
    return true;
  });
}

export async function processKnowledgeDocumentStorageDeletionJob(
  jobId?: string,
  storage: StorageDeletionAdapter = storageService,
) {
  const claimed = await claimJob(jobId);
  if (!claimed) return false;
  try {
    const current = await prisma.knowledgeDocumentStorageDeletionJob.findFirst({
      where: {
        id: claimed.id,
        status: KnowledgeDocumentStorageDeletionJobStatus.PROCESSING,
        attemptCount: claimed.attemptCount,
        processingStartedAt: claimed.processingStartedAt,
      },
      include: { document: true, version: true },
    });
    if (!current) return false;
    if (!knowledgeDocumentStorageDeletionOwnershipMatches({
      jobBusinessId: current.businessId,
      jobDocumentId: current.documentId,
      jobVersionId: current.versionId,
      jobObjectKey: current.storageObjectKey,
      documentBusinessId: current.document.businessId,
      documentDeleted: current.document.status === KnowledgeDocumentStatus.DELETED,
      versionBusinessId: current.version.businessId,
      versionDocumentId: current.version.documentId,
      versionId: current.version.id,
      versionObjectKey: current.version.storageObjectKey,
    })) {
      throw new AppError(409, "Storage deletion ownership validation failed.", "KNOWLEDGE_DOCUMENT_STORAGE_DELETION_SCOPE_MISMATCH");
    }
    const sharedReference = await prisma.knowledgeDocumentVersion.findFirst({
      where: {
        id: { not: current.versionId },
        storageObjectKey: current.storageObjectKey,
        storageDeletedAt: null,
      },
      select: { id: true },
    });
    if (!sharedReference) {
      await confirmObjectDeleted(current.storageObjectKey, current.storageProvider, storage);
    }
    const completed = await completeJob({
      id: current.id,
      businessId: current.businessId,
      documentId: current.documentId,
      versionId: current.versionId,
      storageObjectKey: current.storageObjectKey,
      attemptCount: current.attemptCount,
      processingStartedAt: current.processingStartedAt!,
    });
    if (completed) {
      await auditJob(current, AuditAction.KNOWLEDGE_DOCUMENT_STORAGE_DELETION_COMPLETED, {
        attemptCount: current.attemptCount,
        sharedReferenceRetained: Boolean(sharedReference),
      });
    }
    return completed;
  } catch (error) {
    await failJob({
      id: claimed.id,
      businessId: claimed.businessId,
      documentId: claimed.documentId,
      versionId: claimed.versionId,
      attemptCount: claimed.attemptCount,
      processingStartedAt: claimed.processingStartedAt,
    }, error);
    return true;
  }
}

async function recoverStaleJobs() {
  const staleBefore = new Date(Date.now() - env.KNOWLEDGE_DOCUMENT_CLEANUP_STALE_SECONDS * 1_000);
  const jobs = await prisma.knowledgeDocumentStorageDeletionJob.findMany({
    where: {
      status: KnowledgeDocumentStorageDeletionJobStatus.PROCESSING,
      processingStartedAt: { lt: staleBefore },
    },
    orderBy: { processingStartedAt: "asc" },
    take: env.KNOWLEDGE_DOCUMENT_CLEANUP_BATCH_SIZE,
  });
  for (const job of jobs) {
    if (!job.processingStartedAt) continue;
    await failJob({
      id: job.id,
      businessId: job.businessId,
      documentId: job.documentId,
      versionId: job.versionId,
      attemptCount: job.attemptCount,
      processingStartedAt: job.processingStartedAt,
    }, new AppError(503, "A stale storage deletion attempt was recovered.", "KNOWLEDGE_DOCUMENT_STORAGE_DELETION_STALE"));
  }
  return jobs.length;
}

export const knowledgeDocumentStorageCleanupService = {
  async processDueJobs(limit = env.KNOWLEDGE_DOCUMENT_CLEANUP_BATCH_SIZE) {
    await recoverStaleJobs();
    let processed = 0;
    for (; processed < Math.max(1, Math.min(100, Math.trunc(limit))); processed += 1) {
      if (!await processKnowledgeDocumentStorageDeletionJob()) break;
    }
    return processed;
  },
};

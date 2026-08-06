import {
  BusinessRole,
  KnowledgeDocumentProcessingJobStatus,
  KnowledgeDocumentMalwareScanStatus,
  KnowledgeDocumentProcessingStatus,
  KnowledgeDocumentStatus,
} from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { isDatabaseUnavailableError } from "../../utils/database-error";
import { AppError } from "../../utils/errors";
import { invalidateAiBusinessContext } from "../ai-context-builder.service";
import { knowledgeEmbeddingService } from "../knowledge-embedding.service";
import { realtimeService } from "../realtime.service";
import { storageService } from "../storage.service";
import { getKnowledgeDocumentProcessor } from "./knowledge-document-processor";
import { knowledgeDocumentStorageCleanupService } from "./knowledge-document-storage-cleanup.service";
import { knowledgeStorageMigrationService } from "../knowledge-storage-migration.service";
import { knowledgeDocumentUploadReconciliationService } from "./knowledge-document-upload-reconciliation.service";
import {
  canRetryKnowledgeDocumentJob,
  knowledgeDocumentJobOwnershipMatches,
  knowledgeDocumentRetryAt,
} from "./knowledge-document-worker-policy";

let timer: NodeJS.Timeout | null = null;
let running = false;

function safeFailure(error: unknown) {
  if (error instanceof AppError) return { code: error.code, message: error.message.slice(0, 300) };
  return {
    code: "KNOWLEDGE_DOCUMENT_PROCESSING_FAILED",
    message: "The document could not be processed.",
  };
}

async function quarantineScopeMismatch(jobId: string) {
  const now = new Date();
  await prisma.knowledgeDocumentProcessingJob.updateMany({
    where: {
      id: jobId,
      status: { in: [KnowledgeDocumentProcessingJobStatus.QUEUED, KnowledgeDocumentProcessingJobStatus.FAILED] },
    },
    data: {
      status: KnowledgeDocumentProcessingJobStatus.FAILED,
      attemptCount: env.KNOWLEDGE_DOCUMENT_WORKER_MAX_ATTEMPTS,
      nextAttemptAt: null,
      completedAt: now,
      errorCode: "KNOWLEDGE_DOCUMENT_PROCESSING_SCOPE_MISMATCH",
      errorMessage: "The processing job failed its ownership validation.",
    },
  });
  console.error("Knowledge document processing ownership mismatch", { jobId });
}

async function claimNextJob() {
  const now = new Date();
  const candidates = await prisma.knowledgeDocumentProcessingJob.findMany({
    where: {
      attemptCount: { lt: env.KNOWLEDGE_DOCUMENT_WORKER_MAX_ATTEMPTS },
      OR: [
        {
          status: KnowledgeDocumentProcessingJobStatus.QUEUED,
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        {
          status: KnowledgeDocumentProcessingJobStatus.FAILED,
          nextAttemptAt: { lte: now },
        },
      ],
      document: { deletedAt: null, status: { not: KnowledgeDocumentStatus.DELETED } },
    },
    include: { document: true, version: true },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: Math.max(2, Math.min(20, env.KNOWLEDGE_DOCUMENT_WORKER_BATCH_SIZE * 2)),
  });

  for (const candidate of candidates) {
    const ownershipMatches = knowledgeDocumentJobOwnershipMatches({
      jobBusinessId: candidate.businessId,
      jobDocumentId: candidate.documentId,
      jobVersionId: candidate.versionId,
      documentBusinessId: candidate.document.businessId,
      activeVersionId: candidate.document.activeVersionId,
      versionBusinessId: candidate.version.businessId,
      versionDocumentId: candidate.version.documentId,
      versionId: candidate.version.id,
      versionIsActive: candidate.version.isActive,
    });
    if (!ownershipMatches) {
      await quarantineScopeMismatch(candidate.id);
      continue;
    }

    const claimed = await prisma.$transaction(async (tx) => {
      const job = await tx.knowledgeDocumentProcessingJob.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          attemptCount: candidate.attemptCount,
          updatedAt: candidate.updatedAt,
        },
        data: {
          status: KnowledgeDocumentProcessingJobStatus.PROCESSING,
          attemptCount: { increment: 1 },
          processingStartedAt: now,
          completedAt: null,
          nextAttemptAt: null,
          errorCode: null,
          errorMessage: null,
        },
      });
      if (job.count !== 1) return false;

      const document = await tx.knowledgeDocument.updateMany({
        where: {
          id: candidate.documentId,
          businessId: candidate.businessId,
          activeVersionId: candidate.versionId,
          deletedAt: null,
          status: { not: KnowledgeDocumentStatus.DELETED },
          processingStatus: { in: [KnowledgeDocumentProcessingStatus.QUEUED, KnowledgeDocumentProcessingStatus.FAILED] },
        },
        data: {
          processingStatus: KnowledgeDocumentProcessingStatus.PROCESSING,
          processingErrorCode: null,
          processingErrorMessage: null,
        },
      });
      const version = await tx.knowledgeDocumentVersion.updateMany({
        where: {
          id: candidate.versionId,
          documentId: candidate.documentId,
          businessId: candidate.businessId,
          isActive: true,
          processingStatus: { in: [KnowledgeDocumentProcessingStatus.QUEUED, KnowledgeDocumentProcessingStatus.FAILED] },
        },
        data: {
          processingStatus: KnowledgeDocumentProcessingStatus.PROCESSING,
          processingErrorCode: null,
          processingErrorMessage: null,
        },
      });
      if (document.count !== 1 || version.count !== 1) {
        throw new AppError(409, "Knowledge document processing state changed.", "KNOWLEDGE_DOCUMENT_PROCESSING_STATE_CHANGED");
      }
      return true;
    }).catch((error) => {
      if (error instanceof AppError && error.code === "KNOWLEDGE_DOCUMENT_PROCESSING_STATE_CHANGED") return false;
      throw error;
    });
    if (claimed) {
      return {
        ...candidate,
        attemptCount: candidate.attemptCount + 1,
        processingStartedAt: now,
      };
    }
  }
  return null;
}

async function failProcessingJob(
  jobId: string,
  expectedProcessingStartedAt: Date,
  error: unknown,
  staleRecovery = false,
) {
  const current = await prisma.knowledgeDocumentProcessingJob.findFirst({
    where: {
      id: jobId,
      status: KnowledgeDocumentProcessingJobStatus.PROCESSING,
      processingStartedAt: expectedProcessingStartedAt,
    },
  });
  if (!current) return false;
  const failure = safeFailure(error);
  const nonRetryable = error instanceof AppError && error.code === "KNOWLEDGE_DOCUMENT_MALWARE_SCAN_REQUIRED";
  const retry = !nonRetryable
    && canRetryKnowledgeDocumentJob(current.attemptCount, env.KNOWLEDGE_DOCUMENT_WORKER_MAX_ATTEMPTS);
  const now = new Date();
  const changed = await prisma.$transaction(async (tx) => {
    const job = await tx.knowledgeDocumentProcessingJob.updateMany({
      where: {
        id: current.id,
        status: KnowledgeDocumentProcessingJobStatus.PROCESSING,
        processingStartedAt: expectedProcessingStartedAt,
        updatedAt: current.updatedAt,
      },
      data: {
        status: KnowledgeDocumentProcessingJobStatus.FAILED,
        processingStartedAt: null,
        completedAt: retry ? null : now,
        nextAttemptAt: retry ? knowledgeDocumentRetryAt(current.attemptCount, now) : null,
        errorCode: staleRecovery ? "KNOWLEDGE_DOCUMENT_PROCESSING_STALE" : failure.code,
        errorMessage: staleRecovery ? "The stale processing attempt was recovered for retry." : failure.message,
      },
    });
    if (job.count !== 1) return false;
    await Promise.all([
      tx.knowledgeDocument.updateMany({
        where: {
          id: current.documentId,
          businessId: current.businessId,
          activeVersionId: current.versionId,
          processingStatus: KnowledgeDocumentProcessingStatus.PROCESSING,
        },
        data: {
          processingStatus: KnowledgeDocumentProcessingStatus.FAILED,
          processingErrorCode: staleRecovery ? "KNOWLEDGE_DOCUMENT_PROCESSING_STALE" : failure.code,
          processingErrorMessage: staleRecovery ? "Processing will be retried." : failure.message,
        },
      }),
      tx.knowledgeDocumentVersion.updateMany({
        where: {
          id: current.versionId,
          documentId: current.documentId,
          businessId: current.businessId,
          isActive: true,
          processingStatus: KnowledgeDocumentProcessingStatus.PROCESSING,
        },
        data: {
          processingStatus: KnowledgeDocumentProcessingStatus.FAILED,
          processingErrorCode: staleRecovery ? "KNOWLEDGE_DOCUMENT_PROCESSING_STALE" : failure.code,
          processingErrorMessage: staleRecovery ? "Processing will be retried." : failure.message,
        },
      }),
    ]);
    return true;
  });
  if (changed) {
    console.error("Knowledge document processing failed", {
      jobId: current.id,
      businessId: current.businessId,
      documentId: current.documentId,
      errorCode: staleRecovery ? "KNOWLEDGE_DOCUMENT_PROCESSING_STALE" : failure.code,
      retryScheduled: retry,
    });
  }
  return changed;
}

async function processClaimedJob(job: NonNullable<Awaited<ReturnType<typeof claimNextJob>>>) {
  try {
    const current = await prisma.knowledgeDocumentProcessingJob.findFirst({
      where: {
        id: job.id,
        status: KnowledgeDocumentProcessingJobStatus.PROCESSING,
        processingStartedAt: job.processingStartedAt,
      },
      include: { document: true, version: true },
    });
    if (!current) return;
    if (!knowledgeDocumentJobOwnershipMatches({
      jobBusinessId: current.businessId,
      jobDocumentId: current.documentId,
      jobVersionId: current.versionId,
      documentBusinessId: current.document.businessId,
      activeVersionId: current.document.activeVersionId,
      versionBusinessId: current.version.businessId,
      versionDocumentId: current.version.documentId,
      versionId: current.version.id,
      versionIsActive: current.version.isActive,
    })) {
      throw new AppError(409, "The processing job failed its ownership validation.", "KNOWLEDGE_DOCUMENT_PROCESSING_SCOPE_MISMATCH");
    }
    if (current.document.deletedAt || current.document.status === KnowledgeDocumentStatus.DELETED) {
      throw new AppError(409, "The document was deleted during processing.", "KNOWLEDGE_DOCUMENT_DELETED");
    }
    if (
      env.NODE_ENV === "production"
      && current.version.malwareScanStatus !== KnowledgeDocumentMalwareScanStatus.CLEAN
    ) {
      throw new AppError(
        409,
        "The document cannot be processed until malware scanning succeeds.",
        "KNOWLEDGE_DOCUMENT_MALWARE_SCAN_REQUIRED",
      );
    }
    const objectKey = current.version.storageObjectKey;
    if (!objectKey) throw new AppError(409, "The stored document is unavailable.", "KNOWLEDGE_DOCUMENT_STORAGE_OBJECT_MISSING");
    const object = await storageService.statFile(objectKey, current.version.storageProvider);
    if (object.fileSize !== current.version.fileSize) {
      throw new AppError(409, "The stored document failed its integrity check.", "KNOWLEDGE_DOCUMENT_STORED_SIZE_MISMATCH");
    }

    const result = await getKnowledgeDocumentProcessor()({
      businessId: current.businessId,
      documentId: current.documentId,
      versionId: current.versionId,
      versionNumber: current.version.versionNumber,
      storageProvider: current.version.storageProvider,
      storageObjectKey: objectKey,
      originalFileName: current.version.originalFileName,
      safeFileName: current.version.safeFileName,
      fileExtension: current.version.fileExtension,
      mimeType: current.version.mimeType,
      fileSize: current.version.fileSize,
      checksum: current.version.checksum,
    });
    if (
      result.processingStatus !== KnowledgeDocumentProcessingStatus.READY
      && result.processingStatus !== KnowledgeDocumentProcessingStatus.NEEDS_REVIEW
    ) {
      throw new AppError(500, "The document processor returned an invalid status.", "KNOWLEDGE_DOCUMENT_PROCESSOR_RESULT_INVALID");
    }
    if (result.processingStatus === KnowledgeDocumentProcessingStatus.READY && result.chunks.length === 0) {
      throw new AppError(500, "The document processor returned no usable content.", "KNOWLEDGE_DOCUMENT_PROCESSOR_RESULT_INVALID");
    }

    const completed = await prisma.$transaction(async (tx) => {
      const claimed = await tx.knowledgeDocumentProcessingJob.updateMany({
        where: {
          id: current.id,
          status: KnowledgeDocumentProcessingJobStatus.PROCESSING,
          attemptCount: current.attemptCount,
          processingStartedAt: job.processingStartedAt,
        },
        data: {
          status: KnowledgeDocumentProcessingJobStatus.COMPLETED,
          processingStartedAt: null,
          completedAt: new Date(),
          nextAttemptAt: null,
          errorCode: null,
          errorMessage: null,
        },
      });
      if (claimed.count !== 1) return false;
      const document = await tx.knowledgeDocument.updateMany({
        where: {
          id: current.documentId,
          businessId: current.businessId,
          activeVersionId: current.versionId,
          deletedAt: null,
          status: { not: KnowledgeDocumentStatus.DELETED },
          processingStatus: KnowledgeDocumentProcessingStatus.PROCESSING,
        },
        data: {
          processingStatus: result.processingStatus,
          processingErrorCode: result.statusCode ?? null,
          processingErrorMessage: result.statusMessage ?? null,
        },
      });
      const version = await tx.knowledgeDocumentVersion.updateMany({
        where: {
          id: current.versionId,
          documentId: current.documentId,
          businessId: current.businessId,
          isActive: true,
          processingStatus: KnowledgeDocumentProcessingStatus.PROCESSING,
        },
        data: {
          processingStatus: result.processingStatus,
          processingErrorCode: result.statusCode ?? null,
          processingErrorMessage: result.statusMessage ?? null,
        },
      });
      if (document.count !== 1 || version.count !== 1) {
        throw new AppError(409, "Knowledge document changed during processing.", "KNOWLEDGE_DOCUMENT_PROCESSING_STATE_CHANGED");
      }
      await tx.knowledgeDocumentChunk.deleteMany({
        where: { businessId: current.businessId, documentId: current.documentId },
      });
      if (result.chunks.length) {
        await tx.knowledgeDocumentChunk.createMany({
          data: result.chunks.map((chunk) => ({
            businessId: current.businessId,
            documentId: current.documentId,
            chunkText: chunk.chunkText,
            pageNumber: chunk.pageNumber,
            tokenCount: chunk.tokenCount,
          })),
        });
      }
      return true;
    });
    if (!completed) return;

    await Promise.allSettled([
      invalidateAiBusinessContext(current.businessId),
      knowledgeEmbeddingService.syncDocument(current.documentId),
    ]);
    realtimeService.publish({
      type: "business.knowledge.document.updated",
      businessId: current.businessId,
      roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
      payload: {
        documentId: current.documentId,
        versionId: current.versionId,
        processingStatus: result.processingStatus,
      },
    });
  } catch (error) {
    await failProcessingJob(job.id, job.processingStartedAt, error);
  }
}

async function recoverStaleJobs() {
  const staleBefore = new Date(Date.now() - env.KNOWLEDGE_DOCUMENT_WORKER_STALE_SECONDS * 1_000);
  const jobs = await prisma.knowledgeDocumentProcessingJob.findMany({
    where: {
      status: KnowledgeDocumentProcessingJobStatus.PROCESSING,
      processingStartedAt: { lt: staleBefore },
    },
    select: { id: true, processingStartedAt: true },
    orderBy: { processingStartedAt: "asc" },
    take: env.KNOWLEDGE_DOCUMENT_WORKER_BATCH_SIZE,
  });
  for (const job of jobs) {
    if (job.processingStartedAt) {
      await failProcessingJob(job.id, job.processingStartedAt, new Error("STALE_PROCESSING"), true);
    }
  }
  return jobs.length;
}

export const knowledgeDocumentWorkerService = {
  async tick() {
    if (running) return;
    running = true;
    try {
      const staleUploadBefore = new Date(Date.now() - env.KNOWLEDGE_DOCUMENT_STALE_UPLOAD_MINUTES * 60_000);
      await knowledgeDocumentUploadReconciliationService.reconcile(
        staleUploadBefore,
        env.KNOWLEDGE_DOCUMENT_WORKER_BATCH_SIZE,
      );
      await knowledgeDocumentStorageCleanupService.processDueJobs();
      await knowledgeStorageMigrationService.tick();
      await recoverStaleJobs();
      for (let processed = 0; processed < env.KNOWLEDGE_DOCUMENT_WORKER_BATCH_SIZE; processed += 1) {
        const job = await claimNextJob();
        if (!job) break;
        await processClaimedJob(job);
      }
    } catch (error) {
      if (!isDatabaseUnavailableError(error)) console.error("Knowledge document worker tick failed", error);
    } finally {
      running = false;
    }
  },

  start() {
    if (!env.KNOWLEDGE_DOCUMENT_WORKER_ENABLED || timer) return;
    timer = setInterval(() => void this.tick(), env.KNOWLEDGE_DOCUMENT_WORKER_INTERVAL_SECONDS * 1_000);
    timer.unref?.();
    void this.tick();
    console.info("Knowledge document worker started", {
      intervalSeconds: env.KNOWLEDGE_DOCUMENT_WORKER_INTERVAL_SECONDS,
      batchSize: env.KNOWLEDGE_DOCUMENT_WORKER_BATCH_SIZE,
    });
  },

  stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  },
};

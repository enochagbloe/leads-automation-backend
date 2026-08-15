import {
  AuditAction,
  BusinessStatus,
  BusinessRole,
  KnowledgeDocumentAnalysisStatus,
  KnowledgeDocumentExtractionStatus,
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
import { aiUsageService } from "../ai-usage.service";
import { auditService } from "../audit.service";
import { realtimeService } from "../realtime.service";
import { storageService } from "../storage.service";
import {
  getKnowledgeDocumentAnalyzer,
  getKnowledgeDocumentExtractor,
  KnowledgeDocumentProcessingInput,
} from "./knowledge-document-processor";
import {
  KNOWLEDGE_DOCUMENT_EXTRACTION_POLICY_VERSION,
  knowledgeDocumentExtractionIsReusable,
} from "./knowledge-document-extraction-policy";
import { KnowledgeTextExtractionResult } from "./knowledge-document-text-extraction.service";
import { knowledgeDocumentStorageCleanupService } from "./knowledge-document-storage-cleanup.service";
import { knowledgeStorageMigrationService } from "../knowledge-storage-migration.service";
import { knowledgeDocumentUploadReconciliationService } from "./knowledge-document-upload-reconciliation.service";
import {
  canRetryKnowledgeDocumentJob,
  knowledgeDocumentBusinessIsProcessable,
  knowledgeDocumentCompletionUpdatesSucceeded,
  knowledgeDocumentProcessingJobIdFromBatchId,
  knowledgeDocumentProcessingFailureIsRetryable,
  knowledgeDocumentJobOwnershipMatches,
  processKnowledgeDocumentBusinessFairBatch,
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

async function claimNextJob(excludedBusinessIds: ReadonlySet<string> = new Set()) {
  const now = new Date();
  const candidates = await prisma.knowledgeDocumentProcessingJob.findMany({
    where: {
      ...(excludedBusinessIds.size ? { businessId: { notIn: [...excludedBusinessIds] } } : {}),
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
      business: { status: BusinessStatus.ACTIVE, deletedAt: null },
      document: { deletedAt: null, status: { not: KnowledgeDocumentStatus.DELETED } },
    },
    include: { business: true, document: true, version: true },
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
          business: { status: BusinessStatus.ACTIVE, deletedAt: null },
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
  const nonRetryable = error instanceof AppError && !knowledgeDocumentProcessingFailureIsRetryable(error.code);
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
          processingStatus: KnowledgeDocumentProcessingStatus.PROCESSING,
        },
        data: {
          processingStatus: KnowledgeDocumentProcessingStatus.FAILED,
          processingErrorCode: staleRecovery ? "KNOWLEDGE_DOCUMENT_PROCESSING_STALE" : failure.code,
          processingErrorMessage: staleRecovery ? "Processing will be retried." : failure.message,
        },
      }),
      tx.knowledgeDocumentAnalysis.updateMany({
        where: {
          versionId: current.versionId,
          businessId: current.businessId,
          documentId: current.documentId,
          status: KnowledgeDocumentAnalysisStatus.PROCESSING,
        },
        data: {
          status: KnowledgeDocumentAnalysisStatus.FAILED,
          errorCode: staleRecovery ? "KNOWLEDGE_DOCUMENT_PROCESSING_STALE" : failure.code,
          errorMessage: staleRecovery ? "Processing will be retried from its durable checkpoint." : failure.message,
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
    const extraction = await prisma.knowledgeDocumentExtraction.findUnique({
      where: { versionId: current.versionId },
      select: { status: true },
    }).catch(() => null);
    const action = extraction?.status === KnowledgeDocumentExtractionStatus.COMPLETED
      ? AuditAction.KNOWLEDGE_DOCUMENT_ANALYSIS_FAILED
      : AuditAction.KNOWLEDGE_DOCUMENT_TEXT_EXTRACTION_FAILED;
    await auditService.log({
      action,
      businessId: current.businessId,
      metadata: {
        documentId: current.documentId,
        versionId: current.versionId,
        jobId: current.id,
        errorCode: staleRecovery ? "KNOWLEDGE_DOCUMENT_PROCESSING_STALE" : failure.code,
        retryScheduled: retry,
      },
    });
    realtimeService.publish({
      type: "business.knowledge.document.failed",
      businessId: current.businessId,
      roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
      payload: {
        documentId: current.documentId,
        versionId: current.versionId,
        errorCode: staleRecovery ? "KNOWLEDGE_DOCUMENT_PROCESSING_STALE" : failure.code,
        retryScheduled: retry,
      },
    });
  }
  return changed;
}

function extractionFromRecord(record: Awaited<ReturnType<typeof loadCompletedExtraction>>): KnowledgeTextExtractionResult | null {
  if (!record || !knowledgeDocumentExtractionIsReusable(record)) return null;
  return {
    status: "COMPLETED",
    normalizedText: record.normalizedText!,
    contentHash: record.contentHash!,
    language: record.language,
    characterCount: record.characterCount,
    wordCount: record.wordCount,
    pageCount: record.pageCount,
    sheetCount: record.sheetCount,
    slideCount: record.slideCount,
    warnings: record.warnings,
    extractorName: record.extractorName ?? "unknown",
    extractorVersion: record.extractorVersion ?? "unknown",
    statusCode: null,
    statusMessage: null,
    sections: record.sections.map((item) => ({
      ordinal: item.ordinal,
      sourceKind: item.sourceKind,
      sourceLabel: item.sourceLabel,
      pageNumber: item.pageNumber,
      sheetName: item.sheetName,
      slideNumber: item.slideNumber,
      paragraphIndex: item.paragraphIndex,
      rowNumber: item.rowNumber,
      text: item.text,
    })),
  };
}

async function queueOutdatedCompletedExtractions() {
  const candidates = await prisma.knowledgeDocumentExtraction.findMany({
    where: {
      status: KnowledgeDocumentExtractionStatus.COMPLETED,
      OR: [
        { extractorVersion: null },
        { extractorVersion: { not: KNOWLEDGE_DOCUMENT_EXTRACTION_POLICY_VERSION } },
      ],
      business: { status: BusinessStatus.ACTIVE, deletedAt: null },
      document: {
        status: KnowledgeDocumentStatus.ACTIVE,
        deletedAt: null,
        processingStatus: {
          in: [KnowledgeDocumentProcessingStatus.READY, KnowledgeDocumentProcessingStatus.NEEDS_REVIEW],
        },
      },
      version: {
        isActive: true,
        processingStatus: {
          in: [KnowledgeDocumentProcessingStatus.READY, KnowledgeDocumentProcessingStatus.NEEDS_REVIEW],
        },
        processingJob: { status: KnowledgeDocumentProcessingJobStatus.COMPLETED },
      },
    },
    select: {
      id: true,
      businessId: true,
      documentId: true,
      versionId: true,
      extractorVersion: true,
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: env.KNOWLEDGE_DOCUMENT_WORKER_BATCH_SIZE,
  });

  let queued = 0;
  for (const candidate of candidates) {
    const changed = await prisma.$transaction(async (tx) => {
      const job = await tx.knowledgeDocumentProcessingJob.updateMany({
        where: {
          versionId: candidate.versionId,
          documentId: candidate.documentId,
          businessId: candidate.businessId,
          status: KnowledgeDocumentProcessingJobStatus.COMPLETED,
        },
        data: {
          status: KnowledgeDocumentProcessingJobStatus.QUEUED,
          attemptCount: 0,
          nextAttemptAt: new Date(),
          processingStartedAt: null,
          completedAt: null,
          errorCode: null,
          errorMessage: null,
        },
      });
      const document = await tx.knowledgeDocument.updateMany({
        where: {
          id: candidate.documentId,
          businessId: candidate.businessId,
          activeVersionId: candidate.versionId,
          status: KnowledgeDocumentStatus.ACTIVE,
          deletedAt: null,
          processingStatus: {
            in: [KnowledgeDocumentProcessingStatus.READY, KnowledgeDocumentProcessingStatus.NEEDS_REVIEW],
          },
        },
        data: {
          processingStatus: KnowledgeDocumentProcessingStatus.QUEUED,
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
          processingStatus: {
            in: [KnowledgeDocumentProcessingStatus.READY, KnowledgeDocumentProcessingStatus.NEEDS_REVIEW],
          },
        },
        data: {
          processingStatus: KnowledgeDocumentProcessingStatus.QUEUED,
          processingErrorCode: null,
          processingErrorMessage: null,
        },
      });
      const extraction = await tx.knowledgeDocumentExtraction.updateMany({
        where: {
          id: candidate.id,
          versionId: candidate.versionId,
          documentId: candidate.documentId,
          businessId: candidate.businessId,
          status: KnowledgeDocumentExtractionStatus.COMPLETED,
          OR: [
            { extractorVersion: null },
            { extractorVersion: { not: KNOWLEDGE_DOCUMENT_EXTRACTION_POLICY_VERSION } },
          ],
        },
        data: {
          status: KnowledgeDocumentExtractionStatus.PENDING,
          extractorName: null,
          extractorVersion: null,
          normalizedText: null,
          contentHash: null,
          language: null,
          characterCount: 0,
          wordCount: 0,
          pageCount: null,
          sheetCount: null,
          slideCount: null,
          warnings: [],
          errorCode: null,
          errorMessage: null,
          extractionStartedAt: null,
          extractedAt: null,
        },
      });
      if (job.count !== 1 || document.count !== 1 || version.count !== 1 || extraction.count !== 1) {
        throw new AppError(
          409,
          "Knowledge document extraction changed during policy invalidation.",
          "KNOWLEDGE_DOCUMENT_EXTRACTION_POLICY_STATE_CHANGED",
        );
      }
      await tx.knowledgeDocumentAnalysis.deleteMany({
        where: {
          versionId: candidate.versionId,
          documentId: candidate.documentId,
          businessId: candidate.businessId,
        },
      });
      await tx.knowledgeDocumentExtractedSection.deleteMany({
        where: {
          extractionId: candidate.id,
          versionId: candidate.versionId,
          documentId: candidate.documentId,
          businessId: candidate.businessId,
        },
      });
      return true;
    }).catch((error) => {
      if (error instanceof AppError && error.code === "KNOWLEDGE_DOCUMENT_EXTRACTION_POLICY_STATE_CHANGED") return false;
      throw error;
    });
    if (changed) queued += 1;
  }
  if (queued) {
    console.info("Knowledge document extractions queued for policy refresh", {
      count: queued,
      extractorVersion: KNOWLEDGE_DOCUMENT_EXTRACTION_POLICY_VERSION,
    });
  }
  return queued;
}

function loadCompletedExtraction(versionId: string) {
  return prisma.knowledgeDocumentExtraction.findUnique({
    where: { versionId },
    include: { sections: { orderBy: { ordinal: "asc" } } },
  });
}

async function recordAudit(action: AuditAction, input: KnowledgeDocumentProcessingInput, metadata: Record<string, unknown> = {}) {
  await auditService.log({
    action,
    businessId: input.businessId,
    metadata: {
      documentId: input.documentId,
      versionId: input.versionId,
      versionNumber: input.versionNumber,
      ...metadata,
    },
  });
}

function publishProcessingEvent(
  type:
    | "business.knowledge.document.processing_started"
    | "business.knowledge.document.extraction_completed"
    | "business.knowledge.document.analysis_completed"
    | "business.knowledge.document.ready"
    | "business.knowledge.document.needs_review"
    | "business.knowledge.document.failed",
  input: Pick<KnowledgeDocumentProcessingInput, "businessId" | "documentId" | "versionId">,
  payload: Record<string, unknown> = {},
) {
  realtimeService.publish({
    type,
    businessId: input.businessId,
    roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
    payload: { documentId: input.documentId, versionId: input.versionId, ...payload },
  });
}

async function persistExtraction(
  job: NonNullable<Awaited<ReturnType<typeof claimNextJob>>>,
  input: KnowledgeDocumentProcessingInput,
  extraction: KnowledgeTextExtractionResult,
) {
  return prisma.$transaction(async (tx) => {
    const stillClaimed = await tx.knowledgeDocumentProcessingJob.findFirst({
      where: {
        id: job.id,
        businessId: input.businessId,
        documentId: input.documentId,
        versionId: input.versionId,
        status: KnowledgeDocumentProcessingJobStatus.PROCESSING,
        processingStartedAt: job.processingStartedAt,
        business: { status: BusinessStatus.ACTIVE, deletedAt: null },
        document: { activeVersionId: input.versionId, deletedAt: null },
      },
      select: { id: true },
    });
    if (!stillClaimed) throw new AppError(409, "Knowledge document changed during extraction.", "KNOWLEDGE_DOCUMENT_PROCESSING_STATE_CHANGED");
    const saved = await tx.knowledgeDocumentExtraction.upsert({
      where: { versionId: input.versionId },
      create: {
        businessId: input.businessId,
        documentId: input.documentId,
        versionId: input.versionId,
        status: extraction.status === "COMPLETED"
          ? KnowledgeDocumentExtractionStatus.COMPLETED
          : KnowledgeDocumentExtractionStatus.UNSUPPORTED,
        extractorName: extraction.extractorName,
        extractorVersion: extraction.extractorVersion,
        normalizedText: extraction.normalizedText || null,
        contentHash: extraction.contentHash || null,
        language: extraction.language,
        characterCount: extraction.characterCount,
        wordCount: extraction.wordCount,
        pageCount: extraction.pageCount,
        sheetCount: extraction.sheetCount,
        slideCount: extraction.slideCount,
        warnings: extraction.warnings,
        errorCode: extraction.statusCode,
        errorMessage: extraction.statusMessage,
        extractionStartedAt: job.processingStartedAt,
        extractedAt: new Date(),
      },
      update: {
        status: extraction.status === "COMPLETED"
          ? KnowledgeDocumentExtractionStatus.COMPLETED
          : KnowledgeDocumentExtractionStatus.UNSUPPORTED,
        extractorName: extraction.extractorName,
        extractorVersion: extraction.extractorVersion,
        normalizedText: extraction.normalizedText || null,
        contentHash: extraction.contentHash || null,
        language: extraction.language,
        characterCount: extraction.characterCount,
        wordCount: extraction.wordCount,
        pageCount: extraction.pageCount,
        sheetCount: extraction.sheetCount,
        slideCount: extraction.slideCount,
        warnings: extraction.warnings,
        errorCode: extraction.statusCode,
        errorMessage: extraction.statusMessage,
        extractionStartedAt: job.processingStartedAt,
        extractedAt: new Date(),
      },
    });
    await tx.knowledgeDocumentExtractedSection.deleteMany({ where: { extractionId: saved.id } });
    if (extraction.sections.length) {
      await tx.knowledgeDocumentExtractedSection.createMany({
        data: extraction.sections.map((item) => ({
          ...item,
          businessId: input.businessId,
          documentId: input.documentId,
          versionId: input.versionId,
          extractionId: saved.id,
        })),
      });
    }
    return saved;
  });
}

async function completeWithoutAnalysis(
  job: NonNullable<Awaited<ReturnType<typeof claimNextJob>>>,
  input: KnowledgeDocumentProcessingInput,
  extraction: KnowledgeTextExtractionResult,
) {
  return prisma.$transaction(async (tx) => {
    const document = await tx.knowledgeDocument.updateMany({
      where: {
        id: input.documentId,
        businessId: input.businessId,
        activeVersionId: input.versionId,
        status: KnowledgeDocumentStatus.ACTIVE,
        deletedAt: null,
        processingStatus: KnowledgeDocumentProcessingStatus.PROCESSING,
      },
      data: {
        processingStatus: KnowledgeDocumentProcessingStatus.NEEDS_REVIEW,
        processingErrorCode: extraction.statusCode,
        processingErrorMessage: extraction.statusMessage,
      },
    });
    const version = await tx.knowledgeDocumentVersion.updateMany({
      where: {
        id: input.versionId,
        documentId: input.documentId,
        businessId: input.businessId,
        isActive: true,
        processingStatus: KnowledgeDocumentProcessingStatus.PROCESSING,
      },
      data: {
        processingStatus: KnowledgeDocumentProcessingStatus.NEEDS_REVIEW,
        processingErrorCode: extraction.statusCode,
        processingErrorMessage: extraction.statusMessage,
      },
    });
    if (document.count !== 1 || version.count !== 1) {
      throw new AppError(
        409,
        "Knowledge document changed during unsupported extraction completion.",
        "KNOWLEDGE_DOCUMENT_PROCESSING_STATE_CHANGED",
      );
    }
    const changed = await tx.knowledgeDocumentProcessingJob.updateMany({
      where: {
        id: job.id,
        businessId: input.businessId,
        documentId: input.documentId,
        versionId: input.versionId,
        status: KnowledgeDocumentProcessingJobStatus.PROCESSING,
        attemptCount: job.attemptCount,
        processingStartedAt: job.processingStartedAt,
        business: { status: BusinessStatus.ACTIVE, deletedAt: null },
      },
      data: {
        status: KnowledgeDocumentProcessingJobStatus.COMPLETED,
        processingStartedAt: null,
        completedAt: new Date(),
        nextAttemptAt: null,
        errorCode: extraction.statusCode,
        errorMessage: extraction.statusMessage,
      },
    });
    if (!knowledgeDocumentCompletionUpdatesSucceeded({
      jobCount: changed.count,
      documentCount: document.count,
      versionCount: version.count,
    })) {
      throw new AppError(
        409,
        "Knowledge document changed during unsupported extraction completion.",
        "KNOWLEDGE_DOCUMENT_PROCESSING_STATE_CHANGED",
      );
    }
    return true;
  });
}

async function processClaimedJob(job: NonNullable<Awaited<ReturnType<typeof claimNextJob>>>) {
  try {
    const current = await prisma.knowledgeDocumentProcessingJob.findFirst({
      where: {
        id: job.id,
        status: KnowledgeDocumentProcessingJobStatus.PROCESSING,
        processingStartedAt: job.processingStartedAt,
      },
      include: { business: true, document: true, version: true },
    });
    if (!current) return;
    if (!knowledgeDocumentBusinessIsProcessable(current.business)) {
      throw new AppError(
        409,
        "Knowledge document processing is unavailable while the business is inactive.",
        "KNOWLEDGE_DOCUMENT_BUSINESS_INACTIVE",
      );
    }
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

    const processingInput: KnowledgeDocumentProcessingInput = {
      processingJobId: current.id,
      processingAttempt: current.attemptCount,
      processingLeaseId: current.processingStartedAt!.toISOString(),
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
    };
    publishProcessingEvent("business.knowledge.document.processing_started", processingInput);

    let extraction = extractionFromRecord(await loadCompletedExtraction(current.versionId));
    if (!extraction) {
      await recordAudit(AuditAction.KNOWLEDGE_DOCUMENT_TEXT_EXTRACTION_STARTED, processingInput);
      await prisma.knowledgeDocumentExtraction.upsert({
        where: { versionId: current.versionId },
        create: {
          businessId: current.businessId,
          documentId: current.documentId,
          versionId: current.versionId,
          status: KnowledgeDocumentExtractionStatus.PROCESSING,
          extractionStartedAt: job.processingStartedAt,
        },
        update: {
          status: KnowledgeDocumentExtractionStatus.PROCESSING,
          normalizedText: null,
          contentHash: null,
          language: null,
          characterCount: 0,
          wordCount: 0,
          pageCount: null,
          sheetCount: null,
          slideCount: null,
          warnings: [],
          extractionStartedAt: job.processingStartedAt,
          extractedAt: null,
          errorCode: null,
          errorMessage: null,
        },
      });
      await prisma.knowledgeDocumentExtractedSection.deleteMany({ where: { versionId: current.versionId } });
      try {
        extraction = await getKnowledgeDocumentExtractor()(processingInput);
      } catch (error) {
        const failure = safeFailure(error);
        await prisma.knowledgeDocumentExtraction.upsert({
          where: { versionId: current.versionId },
          create: {
            businessId: current.businessId,
            documentId: current.documentId,
            versionId: current.versionId,
            status: KnowledgeDocumentExtractionStatus.FAILED,
            extractionStartedAt: job.processingStartedAt,
            errorCode: failure.code,
            errorMessage: failure.message,
          },
          update: {
            status: KnowledgeDocumentExtractionStatus.FAILED,
            extractionStartedAt: job.processingStartedAt,
            extractedAt: null,
            errorCode: failure.code,
            errorMessage: failure.message,
          },
        });
        throw error;
      }
      await persistExtraction(job, processingInput, extraction);
      await recordAudit(AuditAction.KNOWLEDGE_DOCUMENT_TEXT_EXTRACTION_COMPLETED, processingInput, {
        extractionStatus: extraction.status,
        characterCount: extraction.characterCount,
        wordCount: extraction.wordCount,
        warnings: extraction.warnings,
      });
      publishProcessingEvent("business.knowledge.document.extraction_completed", processingInput, {
        extractionStatus: extraction.status,
        warningCodes: extraction.warnings,
      });
    }

    if (extraction.status !== "COMPLETED") {
      if (await completeWithoutAnalysis(job, processingInput, extraction)) {
        await recordAudit(AuditAction.KNOWLEDGE_DOCUMENT_NEEDS_REVIEW, processingInput, {
          reason: extraction.statusCode,
        });
        publishProcessingEvent("business.knowledge.document.needs_review", processingInput, {
          reason: extraction.statusCode,
        });
        realtimeService.publish({
          type: "business.knowledge.document.updated",
          businessId: current.businessId,
          roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
          payload: {
            documentId: current.documentId,
            versionId: current.versionId,
            processingStatus: KnowledgeDocumentProcessingStatus.NEEDS_REVIEW,
            extractionStatus: extraction.status,
          },
        });
      }
      return;
    }

    const extractionRecord = await prisma.knowledgeDocumentExtraction.findUnique({
      where: { versionId: current.versionId },
      select: { id: true },
    });
    if (!extractionRecord) throw new AppError(500, "Extracted content was not persisted.", "KNOWLEDGE_DOCUMENT_EXTRACTION_RECORD_MISSING");
    await prisma.knowledgeDocumentAnalysis.upsert({
      where: { versionId: current.versionId },
      create: {
        businessId: current.businessId,
        documentId: current.documentId,
        versionId: current.versionId,
        extractionId: extractionRecord.id,
        status: KnowledgeDocumentAnalysisStatus.PROCESSING,
        analysisStartedAt: new Date(),
      },
      update: {
        status: KnowledgeDocumentAnalysisStatus.PROCESSING,
        analysisStartedAt: new Date(),
        analyzedAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    await recordAudit(AuditAction.KNOWLEDGE_DOCUMENT_ANALYSIS_STARTED, processingInput);

    let analysis;
    try {
      analysis = await getKnowledgeDocumentAnalyzer()({ ...processingInput, extraction });
    } catch (error) {
      const failure = safeFailure(error);
      await prisma.knowledgeDocumentAnalysis.updateMany({
        where: { versionId: current.versionId, status: KnowledgeDocumentAnalysisStatus.PROCESSING },
        data: {
          status: KnowledgeDocumentAnalysisStatus.FAILED,
          errorCode: failure.code,
          errorMessage: failure.message,
        },
      });
      throw error;
    }
    const finalStatus = analysis.requiresHumanReview
      ? KnowledgeDocumentProcessingStatus.NEEDS_REVIEW
      : KnowledgeDocumentProcessingStatus.READY;

    const completed = await prisma.$transaction(async (tx) => {
      const claimed = await tx.knowledgeDocumentProcessingJob.updateMany({
        where: {
          id: current.id,
          status: KnowledgeDocumentProcessingJobStatus.PROCESSING,
          attemptCount: current.attemptCount,
          processingStartedAt: job.processingStartedAt,
          business: { status: BusinessStatus.ACTIVE, deletedAt: null },
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
          processingStatus: finalStatus,
          processingErrorCode: analysis.requiresHumanReview ? "KNOWLEDGE_DOCUMENT_REVIEW_REQUIRED" : null,
          processingErrorMessage: analysis.requiresHumanReview ? "Review the extracted document analysis before customer use." : null,
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
          processingStatus: finalStatus,
          processingErrorCode: analysis.requiresHumanReview ? "KNOWLEDGE_DOCUMENT_REVIEW_REQUIRED" : null,
          processingErrorMessage: analysis.requiresHumanReview ? "Review the extracted document analysis before customer use." : null,
        },
      });
      if (document.count !== 1 || version.count !== 1) {
        throw new AppError(409, "Knowledge document changed during processing.", "KNOWLEDGE_DOCUMENT_PROCESSING_STATE_CHANGED");
      }
      await tx.knowledgeDocumentChunk.deleteMany({
        where: { businessId: current.businessId, documentId: current.documentId },
      });
      const savedAnalysis = await tx.knowledgeDocumentAnalysis.update({
        where: { versionId: current.versionId },
        data: {
          status: KnowledgeDocumentAnalysisStatus.COMPLETED,
          suggestedTitle: analysis.suggestedTitle,
          detectedDocumentType: analysis.detectedDocumentType,
          shortSummary: analysis.shortSummary,
          detectedPurpose: analysis.detectedPurpose,
          likelyAudience: analysis.likelyAudience,
          recommendedClassification: analysis.recommendedClassification,
          classificationReason: analysis.classificationReason,
          classificationConfidence: analysis.classificationConfidence,
          analysisConfidence: analysis.analysisConfidence,
          requiresHumanReview: analysis.requiresHumanReview,
          topics: analysis.topics,
          relatedServiceSuggestions: analysis.relatedServiceSuggestions,
          warnings: analysis.warnings,
          analyzerName: analysis.analyzerName,
          analyzerVersion: analysis.analyzerVersion,
          provider: analysis.provider,
          model: analysis.model,
          promptTokens: analysis.promptTokens,
          completionTokens: analysis.completionTokens,
          totalTokens: analysis.totalTokens,
          errorCode: null,
          errorMessage: null,
          analyzedAt: new Date(),
        },
      });
      await tx.knowledgeDocumentFact.deleteMany({ where: { analysisId: savedAnalysis.id } });
      if (analysis.facts.length) {
        await tx.knowledgeDocumentFact.createMany({
          data: analysis.facts.map((fact) => ({
            ...fact,
            businessId: current.businessId,
            documentId: current.documentId,
            versionId: current.versionId,
            analysisId: savedAnalysis.id,
          })),
        });
      }
      return true;
    });
    if (!completed) return;

    await invalidateAiBusinessContext(current.businessId).catch(() => undefined);
    await recordAudit(AuditAction.KNOWLEDGE_DOCUMENT_ANALYSIS_COMPLETED, processingInput, {
      processingStatus: finalStatus,
      requiresHumanReview: analysis.requiresHumanReview,
      warningCodes: analysis.warnings,
      factCount: analysis.facts.length,
      analyzerVersion: analysis.analyzerVersion,
    });
    publishProcessingEvent("business.knowledge.document.analysis_completed", processingInput, {
      requiresHumanReview: analysis.requiresHumanReview,
      factCount: analysis.facts.length,
    });
    if (analysis.requiresHumanReview) {
      await recordAudit(AuditAction.KNOWLEDGE_DOCUMENT_NEEDS_REVIEW, processingInput, {
        warningCodes: analysis.warnings,
      });
    }
    publishProcessingEvent(
      analysis.requiresHumanReview
        ? "business.knowledge.document.needs_review"
        : "business.knowledge.document.ready",
      processingInput,
      { warningCodes: analysis.warnings },
    );
    realtimeService.publish({
      type: "business.knowledge.document.updated",
      businessId: current.businessId,
      roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
      payload: {
        documentId: current.documentId,
        versionId: current.versionId,
        processingStatus: finalStatus,
        extractionStatus: KnowledgeDocumentExtractionStatus.COMPLETED,
        analysisStatus: KnowledgeDocumentAnalysisStatus.COMPLETED,
        requiresHumanReview: analysis.requiresHumanReview,
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

async function recoverUsageReconciledJobs(processingBatchIds: string[]) {
  const jobIds = [...new Set(
    processingBatchIds
      .map(knowledgeDocumentProcessingJobIdFromBatchId)
      .filter((jobId): jobId is string => Boolean(jobId)),
  )];
  if (!jobIds.length) return 0;
  const recovered = await prisma.knowledgeDocumentProcessingJob.updateMany({
    where: {
      id: { in: jobIds },
      status: KnowledgeDocumentProcessingJobStatus.FAILED,
      errorCode: "KNOWLEDGE_DOCUMENT_AI_RESULT_RECONCILIATION_REQUIRED",
      attemptCount: { lt: env.KNOWLEDGE_DOCUMENT_WORKER_MAX_ATTEMPTS },
    },
    data: { nextAttemptAt: new Date(), completedAt: null },
  });
  return recovered.count;
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
      await queueOutdatedCompletedExtractions();
      const usageReconciliation = await aiUsageService.reconcileStaleKnowledgeDocumentAnalysisReservations(
        new Date(Date.now() - env.KNOWLEDGE_DOCUMENT_WORKER_STALE_SECONDS * 1_000),
      );
      await recoverUsageReconciledJobs(usageReconciliation.recoverableProcessingBatchIds);
      await processKnowledgeDocumentBusinessFairBatch({
        limit: env.KNOWLEDGE_DOCUMENT_WORKER_BATCH_SIZE,
        claim: claimNextJob,
        process: processClaimedJob,
      });
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

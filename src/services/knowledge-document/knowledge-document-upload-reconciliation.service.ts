import {
  AuditAction,
  BusinessRole,
  KnowledgeDocumentProcessingJobStatus,
  KnowledgeDocumentProcessingStatus,
  KnowledgeDocumentStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { auditService } from "../audit.service";
import { realtimeService } from "../realtime.service";
import { isStorageObjectNotFoundError, storageService } from "../storage.service";
import { knowledgeDocumentStorageKey } from "./knowledge-document-storage-key";
import {
  decideStaleUploadReconciliation,
  StaleUploadReconciliationDecision,
} from "./knowledge-document-upload-reconciliation-policy";
import { knowledgeDocumentUploadOperationService } from "./knowledge-document-upload-operation.service";
import { activateKnowledgeDocumentReplacement } from "./knowledge-document-version.service";

type StaleUpload = Prisma.KnowledgeDocumentVersionGetPayload<{
  include: { document: true };
}>;

async function auditReconciliation(
  upload: StaleUpload,
  action: AuditAction,
  metadata: Record<string, unknown>,
) {
  await auditService.log({
    action,
    businessId: upload.businessId,
    userId: upload.uploadedByUserId,
    actorMembershipId: upload.uploadedByMembershipId,
    metadata: {
      documentId: upload.documentId,
      versionId: upload.id,
      reconciledStaleUpload: true,
      ...metadata,
    } as Prisma.InputJsonValue,
  });
}

function publish(upload: StaleUpload, type: "knowledge.document.queued" | "knowledge.document.failed", payload: Record<string, unknown>) {
  realtimeService.publish({
    type,
    businessId: upload.businessId,
    roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
    payload: { documentId: upload.documentId, versionId: upload.id, ...payload },
  });
}

async function queueRecoveredUpload(upload: StaleUpload, objectKey: string) {
  return prisma.$transaction(async (tx) => {
    const isReplacement = Boolean(
      upload.document.activeVersionId
      && upload.document.activeVersionId !== upload.id,
    );
    if (isReplacement) {
      const recoveredDocument = await activateKnowledgeDocumentReplacement(tx, {
        businessId: upload.businessId,
        documentId: upload.documentId,
        versionId: upload.id,
        previousActiveVersionId: upload.document.activeVersionId!,
        storageProvider: upload.storageProvider,
        storageObjectKey: objectKey,
      });
      await knowledgeDocumentUploadOperationService.completeByVersion(tx, {
        businessId: upload.businessId,
        versionId: upload.id,
        response: {
          document: recoveredDocument,
          duplicate: false,
          duplicateWarning: null,
          idempotentReplay: false,
        },
      });
      return true;
    }
    const version = await tx.knowledgeDocumentVersion.updateMany({
      where: {
        id: upload.id,
        documentId: upload.documentId,
        businessId: upload.businessId,
        processingStatus: KnowledgeDocumentProcessingStatus.UPLOADING,
        storageObjectKey: objectKey,
      },
      data: {
        processingStatus: KnowledgeDocumentProcessingStatus.QUEUED,
        processingErrorCode: null,
        processingErrorMessage: null,
        isActive: true,
      },
    });
    if (version.count !== 1) return false;

    const document = await tx.knowledgeDocument.updateMany({
      where: {
        id: upload.documentId,
        businessId: upload.businessId,
        status: { not: KnowledgeDocumentStatus.DELETED },
        deletedAt: null,
        processingStatus: KnowledgeDocumentProcessingStatus.UPLOADING,
        storageObjectKey: objectKey,
      },
      data: {
        fileKey: objectKey,
        activeVersionId: upload.id,
        processingStatus: KnowledgeDocumentProcessingStatus.QUEUED,
        processingErrorCode: null,
        processingErrorMessage: null,
      },
    });
    if (document.count !== 1) throw new Error("KNOWLEDGE_DOCUMENT_STALE_UPLOAD_STATE_CHANGED");

    await tx.knowledgeDocumentProcessingJob.upsert({
      where: { versionId: upload.id },
      create: {
        businessId: upload.businessId,
        documentId: upload.documentId,
        versionId: upload.id,
        status: KnowledgeDocumentProcessingJobStatus.QUEUED,
        nextAttemptAt: new Date(),
      },
      update: {
        status: KnowledgeDocumentProcessingJobStatus.QUEUED,
        nextAttemptAt: new Date(),
        processingStartedAt: null,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    const recoveredDocument = await tx.knowledgeDocument.findUniqueOrThrow({
      where: { id: upload.documentId },
      include: { activeVersion: true },
    });
    const operation = await tx.knowledgeDocumentUploadOperation.findFirst({
      where: { businessId: upload.businessId, versionId: upload.id },
      select: { duplicateDocumentId: true },
    });
    await knowledgeDocumentUploadOperationService.completeByVersion(tx, {
      businessId: upload.businessId,
      versionId: upload.id,
      response: {
        document: recoveredDocument,
        duplicate: Boolean(operation?.duplicateDocumentId),
        duplicateWarning: operation?.duplicateDocumentId
          ? {
            code: "KNOWLEDGE_DOCUMENT_DUPLICATE_FILE",
            existingDocumentId: operation.duplicateDocumentId,
          }
          : null,
        idempotentReplay: false,
      },
    });
    return true;
  });
}

async function failCorruptUpload(
  upload: StaleUpload,
  decision: Extract<StaleUploadReconciliationDecision, { action: "FAIL" }>,
  expectedObjectKey: string,
  actualSize: number | null,
) {
  let cleanupFailed = false;
  if (decision.deleteExpectedObject) {
    try {
      await storageService.deleteFile(expectedObjectKey, upload.storageProvider);
    } catch (error) {
      cleanupFailed = true;
      console.error("Stale Knowledge document object cleanup failed", {
        businessId: upload.businessId,
        documentId: upload.documentId,
        versionId: upload.id,
        error,
      });
    }
  }
  const changed = await prisma.$transaction(async (tx) => {
    const isReplacement = Boolean(
      upload.document.activeVersionId
      && upload.document.activeVersionId !== upload.id,
    );
    const version = await tx.knowledgeDocumentVersion.updateMany({
      where: {
        id: upload.id,
        businessId: upload.businessId,
        processingStatus: KnowledgeDocumentProcessingStatus.UPLOADING,
      },
      data: {
        processingStatus: KnowledgeDocumentProcessingStatus.FAILED,
        processingErrorCode: decision.errorCode,
        processingErrorMessage: "The stored file failed upload integrity validation.",
      },
    });
    if (version.count !== 1) return false;
    if (!isReplacement) {
      const document = await tx.knowledgeDocument.updateMany({
        where: {
          id: upload.documentId,
          businessId: upload.businessId,
          processingStatus: KnowledgeDocumentProcessingStatus.UPLOADING,
        },
        data: {
          processingStatus: KnowledgeDocumentProcessingStatus.FAILED,
          processingErrorCode: decision.errorCode,
          processingErrorMessage: "The stored file failed upload integrity validation.",
        },
      });
      if (document.count !== 1) throw new Error("KNOWLEDGE_DOCUMENT_STALE_UPLOAD_STATE_CHANGED");
    }
    await knowledgeDocumentUploadOperationService.failByVersion(tx, {
      businessId: upload.businessId,
      versionId: upload.id,
      statusCode: 409,
      code: decision.errorCode,
      message: "The stored file failed upload integrity validation.",
    });
    return true;
  });
  if (!changed) return false;
  await auditReconciliation(upload, AuditAction.KNOWLEDGE_DOCUMENT_UPLOAD_FAILED, {
    failureCode: decision.errorCode,
    expectedSize: upload.fileSize,
    actualSize,
    cleanupFailed,
  });
  publish(upload, "knowledge.document.failed", {
    failureCode: decision.errorCode,
  });
  return true;
}

async function removeMissingUpload(upload: StaleUpload) {
  const deleted = await prisma.$transaction(async (tx) => {
    if (upload.document.activeVersionId && upload.document.activeVersionId !== upload.id) {
      await knowledgeDocumentUploadOperationService.failByVersion(tx, {
        businessId: upload.businessId,
        versionId: upload.id,
        statusCode: 503,
        code: "KNOWLEDGE_DOCUMENT_STALE_UPLOAD_OBJECT_MISSING",
        message: "The replacement upload did not finish storing the document.",
      });
      return tx.knowledgeDocumentVersion.deleteMany({
        where: {
          id: upload.id,
          documentId: upload.documentId,
          businessId: upload.businessId,
          processingStatus: KnowledgeDocumentProcessingStatus.UPLOADING,
          isActive: false,
        },
      });
    }
    const removed = await tx.knowledgeDocument.deleteMany({
      where: {
        id: upload.documentId,
        businessId: upload.businessId,
        processingStatus: KnowledgeDocumentProcessingStatus.UPLOADING,
        activeVersionId: null,
      },
    });
    if (removed.count !== 1) return removed;
    await knowledgeDocumentUploadOperationService.failByVersion(tx, {
      businessId: upload.businessId,
      versionId: upload.id,
      statusCode: 503,
      code: "KNOWLEDGE_DOCUMENT_STALE_UPLOAD_OBJECT_MISSING",
      message: "The original upload did not finish storing the document.",
    });
    return removed;
  });
  if (deleted.count !== 1) return false;
  await auditReconciliation(upload, AuditAction.KNOWLEDGE_DOCUMENT_UPLOAD_FAILED, {
    failureCode: "KNOWLEDGE_DOCUMENT_STALE_UPLOAD_OBJECT_MISSING",
    incompleteRecordRemoved: true,
  });
  publish(upload, "knowledge.document.failed", {
    failureCode: "KNOWLEDGE_DOCUMENT_STALE_UPLOAD_OBJECT_MISSING",
  });
  return true;
}

export const knowledgeDocumentUploadReconciliationService = {
  async reconcile(staleBefore: Date, limit: number) {
    const uploads = await prisma.knowledgeDocumentVersion.findMany({
      where: {
        processingStatus: KnowledgeDocumentProcessingStatus.UPLOADING,
        updatedAt: { lt: staleBefore },
        document: {
          deletedAt: null,
          status: { not: KnowledgeDocumentStatus.DELETED },
        },
      },
      include: { document: true },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: Math.max(1, Math.min(100, Math.trunc(limit))),
    });

    let queued = 0;
    let removed = 0;
    let failed = 0;
    let deferred = 0;
    for (const upload of uploads) {
      const expectedKey = knowledgeDocumentStorageKey({
        businessId: upload.businessId,
        documentId: upload.documentId,
        versionId: upload.id,
        safeFileName: upload.safeFileName,
      });
      const initialDecision = decideStaleUploadReconciliation({
        ownershipMatches: upload.document.businessId === upload.businessId,
        expectedObjectKey: expectedKey,
        documentObjectKey: upload.document.storageObjectKey,
        versionObjectKey: upload.storageObjectKey,
        requireDocumentObjectKeyMatch: !upload.document.activeVersionId
          || upload.document.activeVersionId === upload.id,
        expectedFileSize: upload.fileSize,
        storage: { state: "UNAVAILABLE" },
      });
      if (initialDecision.action === "FAIL") {
        if (await failCorruptUpload(upload, initialDecision, expectedKey, null)) failed += 1;
        continue;
      }

      try {
        const object = await storageService.statFile(expectedKey, upload.storageProvider);
        const decision = decideStaleUploadReconciliation({
          ownershipMatches: true,
          expectedObjectKey: expectedKey,
          documentObjectKey: upload.document.storageObjectKey,
          versionObjectKey: upload.storageObjectKey,
          requireDocumentObjectKeyMatch: !upload.document.activeVersionId
            || upload.document.activeVersionId === upload.id,
          expectedFileSize: upload.fileSize,
          storage: { state: "PRESENT", fileSize: object.fileSize },
        });
        if (decision.action === "FAIL") {
          if (await failCorruptUpload(upload, decision, expectedKey, object.fileSize)) failed += 1;
          continue;
        }
        if (decision.action === "QUEUE" && await queueRecoveredUpload(upload, expectedKey)) {
          queued += 1;
          await Promise.all([
            auditReconciliation(upload, AuditAction.KNOWLEDGE_DOCUMENT_UPLOAD_COMPLETED, {
              processingStatus: KnowledgeDocumentProcessingStatus.QUEUED,
            }),
            auditReconciliation(upload, AuditAction.KNOWLEDGE_DOCUMENT_PROCESSING_QUEUED, {
              processingStatus: KnowledgeDocumentProcessingStatus.QUEUED,
            }),
          ]);
          publish(upload, "knowledge.document.queued", {
            processingStatus: KnowledgeDocumentProcessingStatus.QUEUED,
          });
        }
      } catch (error) {
        if (isStorageObjectNotFoundError(error)) {
          const decision = decideStaleUploadReconciliation({
            ownershipMatches: true,
            expectedObjectKey: expectedKey,
            documentObjectKey: upload.document.storageObjectKey,
            versionObjectKey: upload.storageObjectKey,
            requireDocumentObjectKeyMatch: !upload.document.activeVersionId
              || upload.document.activeVersionId === upload.id,
            expectedFileSize: upload.fileSize,
            storage: { state: "MISSING" },
          });
          if (decision.action === "REMOVE_INCOMPLETE" && await removeMissingUpload(upload)) removed += 1;
          continue;
        }
        deferred += 1;
        console.error("Stale Knowledge document upload reconciliation deferred", {
          businessId: upload.businessId,
          documentId: upload.documentId,
          versionId: upload.id,
          error,
        });
      }
    }
    return { inspected: uploads.length, queued, removed, failed, deferred };
  },
};

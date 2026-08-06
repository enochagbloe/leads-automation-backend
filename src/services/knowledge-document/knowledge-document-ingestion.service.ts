import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  AuditAction,
  BusinessRole,
  KnowledgeAssetVisibility,
  KnowledgeDocumentProcessingStatus,
  KnowledgeDocumentStatus,
  Prisma,
  KnowledgeStorageProvider,
} from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { UploadKnowledgeDocumentMetadataInput } from "../../validation/knowledge.schemas";
import { AuditInput, auditService } from "../audit.service";
import { realtimeService } from "../realtime.service";
import { reconcileKnowledgeArticlePdfSizes } from "../knowledge-storage-usage.service";
import { configuredKnowledgeStorageProvider, storageService } from "../storage.service";
import { validateKnowledgeDocumentFile } from "./knowledge-document-file-policy";
import { scanKnowledgeDocument } from "./knowledge-document-malware-scanner.service";
import { knowledgeDocumentStorageKey } from "./knowledge-document-storage-key";
import {
  knowledgeDocumentUploadOperationService,
  KnowledgeDocumentUploadResponse,
  resolveKnowledgeDocumentUploadReplay,
} from "./knowledge-document-upload-operation.service";
import {
  assertKnowledgeDocumentCapacity,
  currentKnowledgePlan,
  maximumKnowledgeFileSize,
} from "./knowledge-document-quota.service";
import {
  assertCanManageKnowledgeDocuments,
  KnowledgeDocumentActor,
} from "./knowledge-document.types";

function safeFailure(error: unknown) {
  if (error instanceof AppError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message.slice(0, 300) };
  }
  return {
    statusCode: 500,
    code: "KNOWLEDGE_DOCUMENT_UPLOAD_FAILED",
    message: "The document upload could not be completed.",
  };
}

function audit(
  actor: KnowledgeDocumentActor,
  context: Omit<AuditInput, "action">,
  action: AuditAction,
  metadata: Record<string, unknown>,
) {
  return auditService.log({
    ...context,
    action,
    businessId: actor.businessId,
    userId: actor.userId,
    actorMembershipId: actor.membershipId,
    metadata: JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonValue,
  });
}

function publish(actor: KnowledgeDocumentActor, type: "knowledge.document.uploaded" | "knowledge.document.queued" | "knowledge.document.failed", payload: Record<string, unknown>) {
  realtimeService.publish({
    type,
    businessId: actor.businessId,
    roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
    payload,
  });
}

export const knowledgeDocumentIngestionService = {
  async upload(
    actor: KnowledgeDocumentActor,
    input: UploadKnowledgeDocumentMetadataInput,
    uploadedFile: Express.Multer.File,
    context: Omit<AuditInput, "action">,
    idempotencyKey?: string | null,
  ) {
    let documentId: string | null = null;
    let versionId: string | null = null;
    let objectKey: string | null = null;
    let uploadOperationId: string | null = null;
    let storageCompleted = false;
    let storedFile: Awaited<ReturnType<typeof storageService.uploadBuffer>> | null = null;
    try {
      await assertCanManageKnowledgeDocuments(actor, context, "KNOWLEDGE_DOCUMENT_UPLOAD");
      const subscription = await prisma.$transaction((tx) => currentKnowledgePlan(actor, tx));
      const validated = await validateKnowledgeDocumentFile(
        uploadedFile,
        maximumKnowledgeFileSize(subscription.plan.code),
      );
      const malwareScan = await scanKnowledgeDocument({
        businessId: actor.businessId,
        fileName: validated.originalFileName,
        mimeType: validated.mimeType,
        checksum: validated.checksum,
        filePath: validated.filePath,
        fileSize: validated.fileSize,
      });
      await reconcileKnowledgeArticlePdfSizes(actor.businessAccountId);
      const normalizedIdempotencyKey = idempotencyKey?.trim().slice(0, 160) || null;
      const prepared = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('knowledge_document_upload'), hashtext(${actor.businessId}))`;
        if (normalizedIdempotencyKey) {
          const operation = await knowledgeDocumentUploadOperationService.find(
            tx,
            actor.businessId,
            normalizedIdempotencyKey,
          );
          if (operation) return { replayOperation: operation };

          const legacyReplay = await tx.knowledgeDocumentVersion.findUnique({
            where: {
              businessId_uploadIdempotencyKey: {
                businessId: actor.businessId,
                uploadIdempotencyKey: normalizedIdempotencyKey,
              },
            },
            include: { document: { include: { activeVersion: true } } },
          });
          if (legacyReplay && legacyReplay.checksum !== validated.checksum) {
            throw new AppError(409, "This idempotency key was already used for a different file.", "KNOWLEDGE_DOCUMENT_IDEMPOTENCY_CONFLICT");
          }
          if (legacyReplay) {
            const legacyResponse: KnowledgeDocumentUploadResponse = {
              document: legacyReplay.document,
              duplicate: false,
              duplicateWarning: null,
              idempotentReplay: false,
            };
            const replayOperation = await tx.knowledgeDocumentUploadOperation.create({
              data: {
                businessId: actor.businessId,
                idempotencyKey: normalizedIdempotencyKey,
                requestChecksum: validated.checksum,
                documentId: legacyReplay.documentId,
                versionId: legacyReplay.id,
                status: legacyReplay.processingStatus === KnowledgeDocumentProcessingStatus.UPLOADING
                  ? "UPLOADING"
                  : legacyReplay.processingStatus === KnowledgeDocumentProcessingStatus.FAILED
                    ? "FAILED"
                    : "COMPLETED",
                resultSnapshot: legacyReplay.processingStatus === KnowledgeDocumentProcessingStatus.UPLOADING
                  || legacyReplay.processingStatus === KnowledgeDocumentProcessingStatus.FAILED
                  ? undefined
                  : JSON.parse(JSON.stringify(legacyResponse)) as Prisma.InputJsonValue,
                failureStatusCode: legacyReplay.processingStatus === KnowledgeDocumentProcessingStatus.FAILED ? 503 : null,
                failureCode: legacyReplay.processingStatus === KnowledgeDocumentProcessingStatus.FAILED
                  ? legacyReplay.processingErrorCode ?? "KNOWLEDGE_DOCUMENT_UPLOAD_FAILED"
                  : null,
                failureMessage: legacyReplay.processingStatus === KnowledgeDocumentProcessingStatus.FAILED
                  ? legacyReplay.processingErrorMessage ?? "The document upload failed."
                  : null,
                completedAt: legacyReplay.processingStatus === KnowledgeDocumentProcessingStatus.UPLOADING
                  ? null
                  : new Date(),
              },
            });
            return { replayOperation };
          }
        }
        await assertKnowledgeDocumentCapacity(tx, actor, validated.fileSize);
        if (input.relatedServiceIds.length) {
          const relatedServices = await tx.service.count({
            where: { businessId: actor.businessId, id: { in: input.relatedServiceIds }, isArchived: false },
          });
          if (relatedServices !== new Set(input.relatedServiceIds).size) {
            throw new AppError(422, "One or more related services are invalid.", "KNOWLEDGE_DOCUMENT_RELATED_SERVICE_INVALID");
          }
        }
        const duplicate = await tx.knowledgeDocumentVersion.findFirst({
          where: {
            businessId: actor.businessId,
            checksum: validated.checksum,
            document: { status: { not: KnowledgeDocumentStatus.DELETED }, deletedAt: null },
          },
          select: { documentId: true },
          orderBy: { createdAt: "desc" },
        });
        const nextDocumentId = crypto.randomUUID();
        const nextVersionId = crypto.randomUUID();
        const nextUploadOperationId = normalizedIdempotencyKey ? crypto.randomUUID() : null;
        const nextObjectKey = knowledgeDocumentStorageKey({
          businessId: actor.businessId,
          documentId: nextDocumentId,
          versionId: nextVersionId,
          safeFileName: validated.safeFileName,
        });
        const document = await tx.knowledgeDocument.create({
          data: {
            id: nextDocumentId,
            businessId: actor.businessId,
            title: input.title,
            description: input.description ?? null,
            category: input.category ?? null,
            tags: input.tags,
            relatedServiceIds: input.relatedServiceIds,
            visibility: input.visibility ?? KnowledgeAssetVisibility.INTERNAL_ONLY,
            fileUrl: `/api/business/knowledge/documents/${nextDocumentId}/download`,
            fileKey: nextObjectKey,
            fileName: validated.safeFileName,
            mimeType: validated.mimeType,
            fileSize: validated.fileSize,
            status: KnowledgeDocumentStatus.ACTIVE,
            processingStatus: KnowledgeDocumentProcessingStatus.UPLOADING,
            originalFileName: validated.originalFileName,
            safeFileName: validated.safeFileName,
            fileExtension: validated.extension,
            checksum: validated.checksum,
            storageObjectKey: nextObjectKey,
            uploadedByMembershipId: actor.membershipId,
            uploadedByUserId: actor.userId,
            versions: {
              create: {
                id: nextVersionId,
                versionNumber: 1,
                originalFileName: validated.originalFileName,
                safeFileName: validated.safeFileName,
                fileExtension: validated.extension,
                storageProvider: env.KNOWLEDGE_STORAGE_PROVIDER === "s3"
                  ? KnowledgeStorageProvider.S3_COMPATIBLE
                  : KnowledgeStorageProvider.LOCAL_PRIVATE,
                fileSize: validated.fileSize,
                mimeType: validated.mimeType,
                checksum: validated.checksum,
                malwareScanStatus: malwareScan.status === "CLEAN" ? "CLEAN" : "NOT_SCANNED",
                malwareScannedAt: malwareScan.status === "CLEAN" ? new Date() : null,
                malwareScanner: malwareScan.status === "CLEAN" ? malwareScan.scanner ?? null : null,
                storageObjectKey: nextObjectKey,
                uploadedByUserId: actor.userId,
                uploadedByMembershipId: actor.membershipId,
                processingStatus: KnowledgeDocumentProcessingStatus.UPLOADING,
                uploadIdempotencyKey: normalizedIdempotencyKey,
              },
            },
          },
        });
        if (normalizedIdempotencyKey && nextUploadOperationId) {
          await knowledgeDocumentUploadOperationService.create(tx, {
            id: nextUploadOperationId,
            businessId: actor.businessId,
            idempotencyKey: normalizedIdempotencyKey,
            requestChecksum: validated.checksum,
            documentId: nextDocumentId,
            versionId: nextVersionId,
            duplicateDocumentId: duplicate?.documentId ?? null,
          });
        }
        return {
          replayOperation: null,
          document,
          versionId: nextVersionId,
          objectKey: nextObjectKey,
          uploadOperationId: nextUploadOperationId,
          duplicate: Boolean(duplicate),
          duplicateDocumentId: duplicate?.documentId ?? null,
          validated,
        };
      }, { timeout: 15_000 });

      if (prepared.replayOperation) {
        return resolveKnowledgeDocumentUploadReplay(prepared.replayOperation, validated.checksum);
      }
      documentId = prepared.document.id;
      versionId = prepared.versionId;
      objectKey = prepared.objectKey;
      uploadOperationId = prepared.uploadOperationId;
      await audit(actor, context, AuditAction.KNOWLEDGE_DOCUMENT_UPLOAD_STARTED, {
        documentId,
        versionId,
        fileType: prepared.validated.extension,
        fileSize: prepared.validated.fileSize,
      }).catch(() => undefined);

      const stored = await storageService.uploadFile({
        businessId: actor.businessId,
        fileName: prepared.validated.safeFileName,
        contentType: prepared.validated.mimeType,
        sourcePath: prepared.validated.filePath,
        fileSize: prepared.validated.fileSize,
        objectKey,
      });
      storedFile = stored;
      storageCompleted = true;

      const queued = await prisma.$transaction(async (tx) => {
        const version = await tx.knowledgeDocumentVersion.updateMany({
          where: {
            id: versionId!,
            businessId: actor.businessId,
            processingStatus: KnowledgeDocumentProcessingStatus.UPLOADING,
          },
          data: {
            storageProvider: stored.storageProvider,
            storageObjectKey: stored.fileKey,
            processingStatus: KnowledgeDocumentProcessingStatus.QUEUED,
            isActive: true,
          },
        });
        if (version.count !== 1) throw new Error("KNOWLEDGE_DOCUMENT_UPLOAD_STATE_CHANGED");
        const document = await tx.knowledgeDocument.update({
          where: { id: documentId! },
          data: {
            fileKey: stored.fileKey,
            storageProvider: stored.storageProvider,
            storageObjectKey: stored.fileKey,
            processingStatus: KnowledgeDocumentProcessingStatus.QUEUED,
            activeVersionId: versionId,
          },
          include: { activeVersion: true },
        });
        await tx.knowledgeDocumentProcessingJob.create({
          data: {
            id: crypto.randomUUID(),
            businessId: actor.businessId,
            documentId: documentId!,
            versionId: versionId!,
            status: "QUEUED",
            nextAttemptAt: new Date(),
          },
        });
        const response: KnowledgeDocumentUploadResponse = {
          document,
          duplicate: prepared.duplicate,
          duplicateWarning: prepared.duplicate
            ? { code: "KNOWLEDGE_DOCUMENT_DUPLICATE_FILE", existingDocumentId: prepared.duplicateDocumentId }
            : null,
          idempotentReplay: false,
        };
        if (uploadOperationId) {
          await knowledgeDocumentUploadOperationService.complete(tx, uploadOperationId, response);
        }
        return { document, response };
      });

      await Promise.allSettled([
        audit(actor, context, AuditAction.KNOWLEDGE_DOCUMENT_UPLOAD_COMPLETED, {
          documentId,
          versionId,
          processingStatus: queued.document.processingStatus,
          fileType: prepared.validated.extension,
          fileSize: prepared.validated.fileSize,
        }),
        audit(actor, context, AuditAction.KNOWLEDGE_DOCUMENT_PROCESSING_QUEUED, {
          documentId,
          versionId,
          processingStatus: queued.document.processingStatus,
        }),
        prepared.duplicate
          ? audit(actor, context, AuditAction.KNOWLEDGE_DOCUMENT_DUPLICATE_DETECTED, {
            documentId,
            versionId,
            duplicateDocumentId: prepared.duplicateDocumentId,
          })
          : Promise.resolve(),
      ]);
      publish(actor, "knowledge.document.uploaded", { documentId, versionId });
      publish(actor, "knowledge.document.queued", { documentId, versionId, processingStatus: queued.document.processingStatus });
      return {
        statusCode: 201 as const,
        response: queued.response,
      };
    } catch (error) {
      if (uploadOperationId) {
        const settledOperation = await prisma.knowledgeDocumentUploadOperation.findFirst({
          where: { id: uploadOperationId, businessId: actor.businessId },
        }).catch(() => null);
        if (settledOperation?.status === "COMPLETED") {
          return resolveKnowledgeDocumentUploadReplay(
            settledOperation,
            settledOperation.requestChecksum,
          );
        }
      }
      const failure = safeFailure(error);
      if (documentId && versionId) {
        const failedDocumentId = documentId;
        const failedVersionId = versionId;
        if (storageCompleted) {
          const recovery = await prisma.$transaction(async (tx) => {
            const document = await tx.knowledgeDocument.updateMany({
              where: {
                id: failedDocumentId,
                businessId: actor.businessId,
                processingStatus: KnowledgeDocumentProcessingStatus.UPLOADING,
              },
              data: {
                fileKey: storedFile?.fileKey ?? objectKey,
                storageProvider: storedFile?.storageProvider,
                storageObjectKey: storedFile?.fileKey ?? objectKey,
                activeVersionId: versionId,
                processingStatus: KnowledgeDocumentProcessingStatus.FAILED,
                processingErrorCode: "KNOWLEDGE_DOCUMENT_QUEUE_UNAVAILABLE",
                processingErrorMessage: "The stored document could not be queued. Retry processing without uploading it again.",
              },
            });
            const version = await tx.knowledgeDocumentVersion.updateMany({
              where: {
                id: failedVersionId,
                businessId: actor.businessId,
                processingStatus: KnowledgeDocumentProcessingStatus.UPLOADING,
              },
              data: {
                storageProvider: storedFile?.storageProvider,
                storageObjectKey: storedFile?.fileKey ?? objectKey,
                isActive: true,
                processingStatus: KnowledgeDocumentProcessingStatus.FAILED,
                processingErrorCode: "KNOWLEDGE_DOCUMENT_QUEUE_UNAVAILABLE",
                processingErrorMessage: "Processing queue creation failed.",
              },
            });
            if (document.count !== version.count) {
              throw new Error("KNOWLEDGE_DOCUMENT_UPLOAD_FAILURE_STATE_CHANGED");
            }
            if (document.count === 1) return { recordsExist: true };
            const existing = await tx.knowledgeDocumentVersion.findFirst({
              where: {
                id: failedVersionId,
                documentId: failedDocumentId,
                businessId: actor.businessId,
                storageObjectKey: storedFile?.fileKey ?? objectKey,
              },
              select: { id: true },
            });
            return { recordsExist: Boolean(existing) };
          }).catch(() => ({ recordsExist: true }));
          if (!recovery.recordsExist && (storedFile?.fileKey ?? objectKey)) {
            await storageService.deleteFile(
              (storedFile?.fileKey ?? objectKey)!,
              storedFile?.storageProvider,
            ).catch((cleanupError) => {
              console.error("Orphaned Knowledge document object cleanup failed", {
                businessId: actor.businessId,
                documentId,
                versionId,
                cleanupError,
              });
            });
          }
        } else {
          if (objectKey) {
            await storageService.deleteFile(objectKey, configuredKnowledgeStorageProvider()).catch(() => undefined);
          }
          await prisma.knowledgeDocument.deleteMany({
            where: { id: documentId, businessId: actor.businessId, processingStatus: KnowledgeDocumentProcessingStatus.UPLOADING },
          }).catch(() => undefined);
        }
        await audit(actor, context, AuditAction.KNOWLEDGE_DOCUMENT_UPLOAD_FAILED, {
          documentId,
          versionId,
          failureCode: failure.code,
        }).catch(() => undefined);
        publish(actor, "knowledge.document.failed", { documentId, versionId, failureCode: failure.code });
      }
      const terminalFailure = documentId && storageCompleted
        ? {
          statusCode: 503,
          code: "KNOWLEDGE_DOCUMENT_PROCESSING_QUEUE_UNAVAILABLE",
          message: "The document was stored but could not be queued. Retry processing shortly.",
        }
        : documentId
          ? {
            statusCode: 503,
            code: "KNOWLEDGE_DOCUMENT_STORAGE_UNAVAILABLE",
            message: "The document could not be stored. Please try again.",
          }
          : failure;
      await knowledgeDocumentUploadOperationService.fail({
        operationId: uploadOperationId,
        businessId: actor.businessId,
        ...terminalFailure,
      }).catch((operationError) => {
        console.error("Knowledge document upload operation settlement failed", {
          businessId: actor.businessId,
          documentId,
          versionId,
          uploadOperationId,
          operationError,
        });
      });
      if (documentId && storageCompleted) {
        throw new AppError(
          503,
          "The document was stored but could not be queued. Retry processing shortly.",
          "KNOWLEDGE_DOCUMENT_PROCESSING_QUEUE_UNAVAILABLE",
          { documentId, retryable: true },
        );
      }
      if (documentId) {
        throw new AppError(
          503,
          "The document could not be stored. Please try again.",
          "KNOWLEDGE_DOCUMENT_STORAGE_UNAVAILABLE",
          { retryable: true },
        );
      }
      throw error;
    } finally {
      await unlink(uploadedFile.path).catch(() => undefined);
    }
  },
};

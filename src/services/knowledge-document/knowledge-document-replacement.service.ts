import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  AuditAction,
  BusinessRole,
  KnowledgeStorageProvider,
  Prisma,
} from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { ReplaceKnowledgeDocumentMetadataInput } from "../../validation/knowledge.schemas";
import { AuditInput, auditService } from "../audit.service";
import { lockKnowledgeHubQuota } from "../knowledge-hub-capability.service";
import { reconcileKnowledgeArticlePdfSizes } from "../knowledge-storage-usage.service";
import { realtimeService } from "../realtime.service";
import { configuredKnowledgeStorageProvider, storageService } from "../storage.service";
import { validateKnowledgeDocumentFile } from "./knowledge-document-file-policy";
import { scanKnowledgeDocument } from "./knowledge-document-malware-scanner.service";
import {
  assertKnowledgeDocumentCapacity,
  currentKnowledgePlan,
  maximumKnowledgeFileSize,
} from "./knowledge-document-quota.service";
import { knowledgeDocumentStorageKey } from "./knowledge-document-storage-key";
import {
  knowledgeDocumentUploadOperationService,
  KnowledgeDocumentUploadResponse,
  resolveKnowledgeDocumentUploadReplay,
} from "./knowledge-document-upload-operation.service";
import {
  activateKnowledgeDocumentReplacement,
  allocateKnowledgeDocumentReplacement,
  runKnowledgeDocumentVersionTransaction,
} from "./knowledge-document-version.service";
import {
  assertCanManageKnowledgeDocuments,
  KnowledgeDocumentActor,
  throwKnowledgeDocumentNotFound,
} from "./knowledge-document.types";

function replacementIdempotencyKey(documentId: string, value?: string | null) {
  const normalized = value?.trim();
  if (!normalized) return null;
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 40);
  return `replace:${documentId}:${digest}`;
}

function safeFailure(error: unknown) {
  if (error instanceof AppError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message.slice(0, 300) };
  }
  return {
    statusCode: 500,
    code: "KNOWLEDGE_DOCUMENT_REPLACEMENT_FAILED",
    message: "The document replacement could not be completed.",
  };
}

async function audit(
  actor: KnowledgeDocumentActor,
  context: Omit<AuditInput, "action">,
  action: AuditAction,
  metadata: Record<string, unknown>,
) {
  await auditService.log({
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

export const knowledgeDocumentReplacementService = {
  async replace(
    actor: KnowledgeDocumentActor,
    documentId: string,
    _input: ReplaceKnowledgeDocumentMetadataInput,
    uploadedFile: Express.Multer.File,
    context: Omit<AuditInput, "action">,
    idempotencyKey?: string | null,
  ) {
    let versionId: string | null = null;
    let objectKey: string | null = null;
    let operationId: string | null = null;
    let storageCompleted = false;
    try {
      await assertCanManageKnowledgeDocuments(actor, context, "KNOWLEDGE_DOCUMENT_REPLACEMENT");
      const ownedDocument = await prisma.knowledgeDocument.findFirst({
        where: { id: documentId, businessId: actor.businessId },
        select: { id: true },
      });
      if (!ownedDocument) {
        await throwKnowledgeDocumentNotFound(actor, documentId, context, "KNOWLEDGE_DOCUMENT_REPLACEMENT");
      }
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
      const normalizedIdempotencyKey = replacementIdempotencyKey(documentId, idempotencyKey);
      const nextVersionId = crypto.randomUUID();
      const nextObjectKey = knowledgeDocumentStorageKey({
        businessId: actor.businessId,
        documentId,
        versionId: nextVersionId,
        safeFileName: validated.safeFileName,
      });
      const prepared = await runKnowledgeDocumentVersionTransaction(async (tx) => {
        await lockKnowledgeHubQuota(tx, actor.businessAccountId);
        if (normalizedIdempotencyKey) {
          const operation = await knowledgeDocumentUploadOperationService.find(
            tx,
            actor.businessId,
            normalizedIdempotencyKey,
          );
          if (operation) return { replayOperation: operation };
        }
        await assertKnowledgeDocumentCapacity(tx, actor, validated.fileSize, { assets: 0, documents: 0 });
        const allocated = await allocateKnowledgeDocumentReplacement(tx, {
          businessId: actor.businessId,
          documentId,
          uploadedByUserId: actor.userId,
          uploadedByMembershipId: actor.membershipId,
          uploadIdempotencyKey: normalizedIdempotencyKey,
          versionId: nextVersionId,
          file: {
            originalFileName: validated.originalFileName,
            safeFileName: validated.safeFileName,
            extension: validated.extension,
            mimeType: validated.mimeType,
            fileSize: validated.fileSize,
            checksum: validated.checksum,
            malwareScanStatus: malwareScan.status === "CLEAN" ? "CLEAN" : "NOT_SCANNED",
            malwareScannedAt: malwareScan.status === "CLEAN" ? new Date() : null,
            malwareScanner: malwareScan.status === "CLEAN" ? malwareScan.scanner ?? null : null,
            storageProvider: env.KNOWLEDGE_STORAGE_PROVIDER === "s3"
              ? KnowledgeStorageProvider.S3_COMPATIBLE
              : KnowledgeStorageProvider.LOCAL_PRIVATE,
            storageObjectKey: nextObjectKey,
          },
        });
        const nextOperationId = normalizedIdempotencyKey ? crypto.randomUUID() : null;
        if (normalizedIdempotencyKey && nextOperationId) {
          await knowledgeDocumentUploadOperationService.create(tx, {
            id: nextOperationId,
            businessId: actor.businessId,
            idempotencyKey: normalizedIdempotencyKey,
            requestChecksum: validated.checksum,
            documentId,
            versionId: allocated.version.id,
            duplicateDocumentId: null,
          });
        }
        return {
          replayOperation: null,
          version: allocated.version,
          previousActiveVersionId: allocated.previousActiveVersionId,
          operationId: nextOperationId,
        };
      });

      if (prepared.replayOperation) {
        return resolveKnowledgeDocumentUploadReplay(prepared.replayOperation, validated.checksum);
      }
      versionId = prepared.version.id;
      objectKey = nextObjectKey;
      operationId = prepared.operationId;
      await audit(actor, context, AuditAction.KNOWLEDGE_DOCUMENT_UPLOAD_STARTED, {
        documentId,
        versionId,
        versionNumber: prepared.version.versionNumber,
        replacement: true,
      }).catch(() => undefined);

      const stored = await storageService.uploadFile({
        businessId: actor.businessId,
        fileName: validated.safeFileName,
        contentType: validated.mimeType,
        sourcePath: validated.filePath,
        fileSize: validated.fileSize,
        objectKey,
      });
      storageCompleted = true;
      const queued = await runKnowledgeDocumentVersionTransaction(async (tx) => {
        const document = await activateKnowledgeDocumentReplacement(tx, {
          businessId: actor.businessId,
          documentId,
          versionId: versionId!,
          previousActiveVersionId: prepared.previousActiveVersionId,
          storageProvider: stored.storageProvider,
          storageObjectKey: stored.fileKey,
        });
        const response: KnowledgeDocumentUploadResponse = {
          document,
          duplicate: false,
          duplicateWarning: null,
          idempotentReplay: false,
        };
        if (operationId) await knowledgeDocumentUploadOperationService.complete(tx, operationId, response);
        return { document, response };
      });

      await Promise.allSettled([
        audit(actor, context, AuditAction.KNOWLEDGE_DOCUMENT_UPLOAD_COMPLETED, {
          documentId,
          versionId,
          versionNumber: prepared.version.versionNumber,
          replacement: true,
        }),
        audit(actor, context, AuditAction.KNOWLEDGE_DOCUMENT_PROCESSING_QUEUED, {
          documentId,
          versionId,
          replacement: true,
        }),
      ]);
      publish(actor, "knowledge.document.uploaded", { documentId, versionId, replacement: true });
      publish(actor, "knowledge.document.queued", { documentId, versionId, replacement: true });
      return { statusCode: 201 as const, response: queued.response };
    } catch (error) {
      if (operationId) {
        const completed = await prisma.knowledgeDocumentUploadOperation.findFirst({
          where: { id: operationId, businessId: actor.businessId, status: "COMPLETED" },
        }).catch(() => null);
        if (completed) return resolveKnowledgeDocumentUploadReplay(completed, completed.requestChecksum);
      }
      const failure = safeFailure(error);
      const terminalStateConflict = error instanceof AppError
        && error.code === "KNOWLEDGE_DOCUMENT_REPLACEMENT_STATE_CHANGED";
      if (versionId && (!storageCompleted || terminalStateConflict)) {
        if (objectKey) {
          await storageService.deleteFile(objectKey, configuredKnowledgeStorageProvider()).catch(() => undefined);
        }
        await prisma.knowledgeDocumentVersion.deleteMany({
          where: {
            id: versionId,
            documentId,
            businessId: actor.businessId,
            isActive: false,
            processingStatus: { in: ["UPLOADING", "FAILED"] },
          },
        }).catch(() => undefined);
        await knowledgeDocumentUploadOperationService.fail({
          operationId,
          businessId: actor.businessId,
          ...failure,
        }).catch(() => undefined);
      }
      await audit(actor, context, AuditAction.KNOWLEDGE_DOCUMENT_UPLOAD_FAILED, {
        documentId,
        versionId,
        replacement: true,
        failureCode: failure.code,
      }).catch(() => undefined);
      publish(actor, "knowledge.document.failed", { documentId, versionId, replacement: true, failureCode: failure.code });
      if (versionId && storageCompleted && !terminalStateConflict) {
        throw new AppError(
          503,
          "The replacement was stored but could not be queued. Reconciliation will retry it.",
          "KNOWLEDGE_DOCUMENT_REPLACEMENT_RECONCILIATION_REQUIRED",
          { documentId, versionId, retryable: true },
        );
      }
      throw error;
    } finally {
      await unlink(uploadedFile.path).catch(() => undefined);
    }
  },
};

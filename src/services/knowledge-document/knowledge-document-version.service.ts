import crypto from "node:crypto";
import {
  KnowledgeDocumentProcessingStatus,
  KnowledgeDocumentMalwareScanStatus,
  KnowledgeDocumentStatus,
  KnowledgeStorageProvider,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";

export const KNOWLEDGE_DOCUMENT_VERSION_TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 15_000,
} as const;

const VERSION_LOCK_MAX_ATTEMPTS = 6;
const VERSION_LOCK_RETRY_BASE_DELAY_MS = 25;

function isVersionLockBusy(error: unknown) {
  return error instanceof AppError && error.code === "KNOWLEDGE_DOCUMENT_VERSION_LOCK_BUSY";
}

function versionLockRetryDelay(attempt: number) {
  return Math.min(VERSION_LOCK_RETRY_BASE_DELAY_MS * 2 ** attempt, 250);
}

export async function runKnowledgeDocumentVersionTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  for (let attempt = 0; attempt < VERSION_LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(operation, KNOWLEDGE_DOCUMENT_VERSION_TRANSACTION_OPTIONS);
    } catch (error) {
      if (!isVersionLockBusy(error) || attempt === VERSION_LOCK_MAX_ATTEMPTS - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, versionLockRetryDelay(attempt)));
    }
  }
  throw new AppError(
    409,
    "Another document version operation is in progress.",
    "KNOWLEDGE_DOCUMENT_VERSION_LOCK_BUSY",
    { retryable: true },
  );
}

type ReplacementFile = {
  originalFileName: string;
  safeFileName: string;
  extension: string;
  mimeType: string;
  fileSize: number;
  checksum: string;
  malwareScanStatus: KnowledgeDocumentMalwareScanStatus;
  malwareScannedAt: Date | null;
  malwareScanner: string | null;
  storageProvider: KnowledgeStorageProvider;
  storageObjectKey: string;
};

export async function lockKnowledgeDocumentVersion(
  tx: Prisma.TransactionClient,
  documentId: string,
) {
  const [result] = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_xact_lock(
      hashtext('knowledge_document_version'),
      hashtext(${documentId})
    ) AS locked
  `;
  if (!result?.locked) {
    throw new AppError(
      409,
      "Another document version operation is in progress.",
      "KNOWLEDGE_DOCUMENT_VERSION_LOCK_BUSY",
      { retryable: true },
    );
  }
}

export async function allocateKnowledgeDocumentReplacement(
  tx: Prisma.TransactionClient,
  input: {
    businessId: string;
    documentId: string;
    uploadedByUserId: string;
    uploadedByMembershipId: string;
    uploadIdempotencyKey: string | null;
    versionId?: string;
    file: ReplacementFile;
  },
) {
  await lockKnowledgeDocumentVersion(tx, input.documentId);
  const document = await tx.knowledgeDocument.findFirst({
    where: {
      id: input.documentId,
      businessId: input.businessId,
      status: KnowledgeDocumentStatus.ACTIVE,
      deletedAt: null,
    },
    include: { activeVersion: true },
  });
  if (!document?.activeVersionId || !document.activeVersion) {
    throw new AppError(404, "Active knowledge document not found.", "KNOWLEDGE_DOCUMENT_NOT_FOUND");
  }
  if (
    document.processingStatus === KnowledgeDocumentProcessingStatus.UPLOADING
    || document.processingStatus === KnowledgeDocumentProcessingStatus.QUEUED
    || document.processingStatus === KnowledgeDocumentProcessingStatus.PROCESSING
  ) {
    throw new AppError(409, "Wait for the current document processing to finish before replacing it.", "KNOWLEDGE_DOCUMENT_REPLACEMENT_NOT_READY");
  }
  const pendingReplacement = await tx.knowledgeDocumentVersion.findFirst({
    where: {
      documentId: input.documentId,
      businessId: input.businessId,
      id: { not: document.activeVersionId },
      processingStatus: {
        in: [
          KnowledgeDocumentProcessingStatus.UPLOADING,
          KnowledgeDocumentProcessingStatus.QUEUED,
          KnowledgeDocumentProcessingStatus.PROCESSING,
        ],
      },
    },
    select: { id: true },
  });
  if (pendingReplacement) {
    throw new AppError(409, "A replacement upload is already in progress.", "KNOWLEDGE_DOCUMENT_REPLACEMENT_IN_PROGRESS");
  }
  const latest = await tx.knowledgeDocumentVersion.aggregate({
    where: { documentId: input.documentId, businessId: input.businessId },
    _max: { versionNumber: true },
  });
  const versionId = input.versionId ?? crypto.randomUUID();
  const version = await tx.knowledgeDocumentVersion.create({
    data: {
      id: versionId,
      documentId: input.documentId,
      businessId: input.businessId,
      versionNumber: (latest._max.versionNumber ?? 0) + 1,
      originalFileName: input.file.originalFileName,
      safeFileName: input.file.safeFileName,
      fileExtension: input.file.extension,
      storageProvider: input.file.storageProvider,
      storageObjectKey: input.file.storageObjectKey,
      fileSize: input.file.fileSize,
      mimeType: input.file.mimeType,
      checksum: input.file.checksum,
      malwareScanStatus: input.file.malwareScanStatus,
      malwareScannedAt: input.file.malwareScannedAt,
      malwareScanner: input.file.malwareScanner,
      uploadedByUserId: input.uploadedByUserId,
      uploadedByMembershipId: input.uploadedByMembershipId,
      uploadIdempotencyKey: input.uploadIdempotencyKey,
      processingStatus: KnowledgeDocumentProcessingStatus.UPLOADING,
      isActive: false,
    },
  });
  return { document, version, previousActiveVersionId: document.activeVersionId };
}

export async function activateKnowledgeDocumentReplacement(
  tx: Prisma.TransactionClient,
  input: {
    businessId: string;
    documentId: string;
    versionId: string;
    previousActiveVersionId: string;
    storageProvider: KnowledgeStorageProvider;
    storageObjectKey: string;
  },
) {
  await lockKnowledgeDocumentVersion(tx, input.documentId);
  const version = await tx.knowledgeDocumentVersion.findFirst({
    where: {
      id: input.versionId,
      documentId: input.documentId,
      businessId: input.businessId,
      processingStatus: KnowledgeDocumentProcessingStatus.UPLOADING,
      isActive: false,
    },
  });
  if (!version) {
    throw new AppError(409, "The replacement version changed before activation.", "KNOWLEDGE_DOCUMENT_REPLACEMENT_STATE_CHANGED");
  }
  const newerVersion = await tx.knowledgeDocumentVersion.findFirst({
    where: {
      documentId: input.documentId,
      businessId: input.businessId,
      versionNumber: { gt: version.versionNumber },
    },
    select: { id: true },
  });
  if (newerVersion) {
    throw new AppError(409, "A newer document version already exists.", "KNOWLEDGE_DOCUMENT_REPLACEMENT_STATE_CHANGED");
  }
  const currentDocument = await tx.knowledgeDocument.findFirst({
    where: {
      id: input.documentId,
      businessId: input.businessId,
      activeVersionId: input.previousActiveVersionId,
      status: KnowledgeDocumentStatus.ACTIVE,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!currentDocument) {
    throw new AppError(409, "The document changed before replacement activation.", "KNOWLEDGE_DOCUMENT_REPLACEMENT_STATE_CHANGED");
  }

  await tx.knowledgeDocumentVersion.updateMany({
    where: { documentId: input.documentId, businessId: input.businessId, isActive: true },
    data: { isActive: false },
  });
  await tx.knowledgeDocumentVersion.update({
    where: { id: input.versionId },
    data: {
      storageProvider: input.storageProvider,
      storageObjectKey: input.storageObjectKey,
      processingStatus: KnowledgeDocumentProcessingStatus.QUEUED,
      processingErrorCode: null,
      processingErrorMessage: null,
      isActive: true,
    },
  });
  const changedDocument = await tx.knowledgeDocument.updateMany({
    where: {
      id: input.documentId,
      businessId: input.businessId,
      activeVersionId: input.previousActiveVersionId,
      status: KnowledgeDocumentStatus.ACTIVE,
      deletedAt: null,
    },
    data: {
      fileUrl: `/api/business/knowledge/documents/${input.documentId}/download`,
      fileKey: input.storageObjectKey,
      fileName: version.safeFileName,
      mimeType: version.mimeType,
      fileSize: version.fileSize,
      originalFileName: version.originalFileName,
      safeFileName: version.safeFileName,
      fileExtension: version.fileExtension,
      storageProvider: input.storageProvider,
      storageObjectKey: input.storageObjectKey,
      checksum: version.checksum,
      processingStatus: KnowledgeDocumentProcessingStatus.QUEUED,
      processingErrorCode: null,
      processingErrorMessage: null,
      activeVersionId: input.versionId,
    },
  });
  if (changedDocument.count !== 1) {
    throw new AppError(409, "The document changed before replacement activation.", "KNOWLEDGE_DOCUMENT_REPLACEMENT_STATE_CHANGED");
  }
  await tx.knowledgeDocumentProcessingJob.create({
    data: {
      businessId: input.businessId,
      documentId: input.documentId,
      versionId: input.versionId,
      status: "QUEUED",
      nextAttemptAt: new Date(),
    },
  });
  return tx.knowledgeDocument.findUniqueOrThrow({
    where: { id: input.documentId },
    include: { activeVersion: true },
  });
}

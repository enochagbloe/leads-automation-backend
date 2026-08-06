import crypto from "node:crypto";
import {
  AuditAction,
  BusinessRole,
  KnowledgeDocumentProcessingJobStatus,
  KnowledgeDocumentProcessingStatus,
  KnowledgeDocumentRetentionStatus,
  KnowledgeDocumentStorageDeletionJobStatus,
  KnowledgeDocumentStatus,
} from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { invalidateAiBusinessContext } from "../ai-context-builder.service";
import { AuditInput, auditService } from "../audit.service";
import { knowledgeEmbeddingService } from "../knowledge-embedding.service";
import { realtimeService } from "../realtime.service";
import { assertKnowledgeDocumentCapacity } from "./knowledge-document-quota.service";
import {
  assertCanManageKnowledgeDocuments,
  KnowledgeDocumentActor,
  throwKnowledgeDocumentNotFound,
} from "./knowledge-document.types";

async function assertDocumentScope(
  actor: KnowledgeDocumentActor,
  documentId: string,
  context: Omit<AuditInput, "action">,
  operation: string,
) {
  const document = await prisma.knowledgeDocument.findFirst({
    where: { id: documentId, businessId: actor.businessId },
    select: { id: true },
  });
  if (!document) await throwKnowledgeDocumentNotFound(actor, documentId, context, operation);
}

function publish(actor: KnowledgeDocumentActor, type: "knowledge.document.archived" | "knowledge.document.restored" | "knowledge.document.deleted" | "knowledge.document.queued", documentId: string) {
  realtimeService.publish({
    type,
    businessId: actor.businessId,
    roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
    payload: { documentId },
  });
}

async function log(actor: KnowledgeDocumentActor, context: Omit<AuditInput, "action">, action: AuditAction, documentId: string) {
  await auditService.log({
    ...context,
    action,
    businessId: actor.businessId,
    userId: actor.userId,
    actorMembershipId: actor.membershipId,
    metadata: { documentId },
  }).catch((error) => {
    console.error("Knowledge document audit failed after lifecycle change", {
      businessId: actor.businessId,
      documentId,
      action,
      error,
    });
  });
}

async function refreshRuntimeKnowledge(actor: KnowledgeDocumentActor, documentId: string) {
  const results = await Promise.allSettled([
    invalidateAiBusinessContext(actor.businessId),
    knowledgeEmbeddingService.syncDocument(documentId),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Knowledge runtime refresh failed after lifecycle change", {
        businessId: actor.businessId,
        documentId,
        error: result.reason,
      });
    }
  }
}

export const knowledgeDocumentLifecycleService = {
  async archive(actor: KnowledgeDocumentActor, documentId: string, context: Omit<AuditInput, "action">) {
    await assertCanManageKnowledgeDocuments(actor, context, "KNOWLEDGE_DOCUMENT_ARCHIVE");
    await assertDocumentScope(actor, documentId, context, "KNOWLEDGE_DOCUMENT_ARCHIVE");
    const changed = await prisma.knowledgeDocument.updateMany({
      where: { id: documentId, businessId: actor.businessId, status: KnowledgeDocumentStatus.ACTIVE, deletedAt: null },
      data: { status: KnowledgeDocumentStatus.ARCHIVED, archivedAt: new Date() },
    });
    if (changed.count !== 1) throw new AppError(404, "Active knowledge document not found.", "KNOWLEDGE_DOCUMENT_NOT_FOUND");
    await log(actor, context, AuditAction.KNOWLEDGE_DOCUMENT_ARCHIVED, documentId);
    await refreshRuntimeKnowledge(actor, documentId);
    publish(actor, "knowledge.document.archived", documentId);
    return { id: documentId, status: KnowledgeDocumentStatus.ARCHIVED };
  },

  async restore(actor: KnowledgeDocumentActor, documentId: string, context: Omit<AuditInput, "action">) {
    await assertCanManageKnowledgeDocuments(actor, context, "KNOWLEDGE_DOCUMENT_RESTORE");
    await assertDocumentScope(actor, documentId, context, "KNOWLEDGE_DOCUMENT_RESTORE");
    const restored = await prisma.$transaction(async (tx) => {
      const document = await tx.knowledgeDocument.findFirst({
        where: { id: documentId, businessId: actor.businessId, status: KnowledgeDocumentStatus.ARCHIVED, deletedAt: null },
        select: { id: true, fileSize: true },
      });
      if (!document) throw new AppError(404, "Archived knowledge document not found.", "KNOWLEDGE_DOCUMENT_NOT_FOUND");
      await assertKnowledgeDocumentCapacity(tx, actor, 0);
      return tx.knowledgeDocument.update({
        where: { id: document.id },
        data: { status: KnowledgeDocumentStatus.ACTIVE, archivedAt: null },
      });
    });
    await log(actor, context, AuditAction.KNOWLEDGE_DOCUMENT_RESTORED, documentId);
    await refreshRuntimeKnowledge(actor, documentId);
    publish(actor, "knowledge.document.restored", documentId);
    return restored;
  },

  async softDelete(actor: KnowledgeDocumentActor, documentId: string, context: Omit<AuditInput, "action">) {
    await assertCanManageKnowledgeDocuments(actor, context, "KNOWLEDGE_DOCUMENT_DELETE");
    await assertDocumentScope(actor, documentId, context, "KNOWLEDGE_DOCUMENT_DELETE");
    const changed = await prisma.$transaction(async (tx) => {
      const existing = await tx.knowledgeDocument.findFirst({
        where: {
          id: documentId,
          businessId: actor.businessId,
          status: { not: KnowledgeDocumentStatus.DELETED },
          deletedAt: null,
        },
        include: {
          versions: {
            where: { storageObjectKey: { not: null }, storageDeletedAt: null },
            select: { id: true, storageProvider: true, storageObjectKey: true },
          },
        },
      });
      if (!existing) return { count: 0 };
      const deletedAt = new Date();
      const retentionExpiresAt = new Date(
        deletedAt.getTime() + env.KNOWLEDGE_DOCUMENT_RETENTION_DAYS * 24 * 60 * 60_000,
      );
      const document = await tx.knowledgeDocument.updateMany({
        where: {
          id: documentId,
          businessId: actor.businessId,
          status: { not: KnowledgeDocumentStatus.DELETED },
          deletedAt: null,
        },
        data: {
          status: KnowledgeDocumentStatus.DELETED,
          deletedAt,
          archivedAt: null,
          retentionStatus: existing.versions.length
            ? KnowledgeDocumentRetentionStatus.PENDING_DELETION
            : KnowledgeDocumentRetentionStatus.PURGED,
          retentionExpiresAt,
          storageDeletedAt: existing.versions.length ? null : deletedAt,
          processingStatus: KnowledgeDocumentProcessingStatus.FAILED,
          processingErrorCode: "KNOWLEDGE_DOCUMENT_DELETED",
          processingErrorMessage: "Processing stopped because the document was deleted.",
        },
      });
      if (document.count !== 1) return document;
      if (existing.versions.length) {
        await tx.knowledgeDocumentStorageDeletionJob.createMany({
          data: existing.versions.map((version) => ({
            id: crypto.randomUUID(),
            businessId: actor.businessId,
            documentId,
            versionId: version.id,
            storageProvider: version.storageProvider,
            storageObjectKey: version.storageObjectKey!,
            status: KnowledgeDocumentStorageDeletionJobStatus.SCHEDULED,
            scheduledFor: retentionExpiresAt,
            nextAttemptAt: retentionExpiresAt,
          })),
          skipDuplicates: true,
        });
      } else {
        await tx.knowledgeDocument.update({
          where: { id: documentId },
          data: { activeVersionId: null, fileKey: null, storageObjectKey: null },
        });
        await tx.knowledgeDocumentVersion.updateMany({
          where: { businessId: actor.businessId, documentId },
          data: { isActive: false, storageDeletedAt: deletedAt },
        });
      }
      await tx.knowledgeDocumentVersion.updateMany({
        where: {
          businessId: actor.businessId,
          documentId,
          processingStatus: {
            in: [
              KnowledgeDocumentProcessingStatus.UPLOADING,
              KnowledgeDocumentProcessingStatus.QUEUED,
              KnowledgeDocumentProcessingStatus.PROCESSING,
            ],
          },
        },
        data: {
          processingStatus: KnowledgeDocumentProcessingStatus.FAILED,
          processingErrorCode: "KNOWLEDGE_DOCUMENT_DELETED",
          processingErrorMessage: "Processing stopped because the document was deleted.",
        },
      });
      await tx.knowledgeDocumentProcessingJob.updateMany({
        where: {
          businessId: actor.businessId,
          documentId,
          status: { in: [KnowledgeDocumentProcessingJobStatus.QUEUED, KnowledgeDocumentProcessingJobStatus.PROCESSING] },
        },
        data: {
          status: KnowledgeDocumentProcessingJobStatus.FAILED,
          nextAttemptAt: null,
          processingStartedAt: null,
          completedAt: new Date(),
          errorCode: "KNOWLEDGE_DOCUMENT_DELETED",
          errorMessage: "Processing stopped because the document was deleted.",
        },
      });
      await tx.knowledgeDocumentUploadOperation.updateMany({
        where: {
          businessId: actor.businessId,
          documentId,
          status: "UPLOADING",
        },
        data: {
          status: "FAILED",
          failureStatusCode: 409,
          failureCode: "KNOWLEDGE_DOCUMENT_DELETED",
          failureMessage: "The document was deleted while its upload was in progress.",
          completedAt: new Date(),
        },
      });
      return document;
    });
    if (changed.count !== 1) throw new AppError(404, "Knowledge document not found.", "KNOWLEDGE_DOCUMENT_NOT_FOUND");
    await log(actor, context, AuditAction.KNOWLEDGE_DOCUMENT_DELETED, documentId);
    await refreshRuntimeKnowledge(actor, documentId);
    publish(actor, "knowledge.document.deleted", documentId);
    return { id: documentId, status: KnowledgeDocumentStatus.DELETED };
  },

  async retryProcessing(actor: KnowledgeDocumentActor, documentId: string, context: Omit<AuditInput, "action">) {
    await assertCanManageKnowledgeDocuments(actor, context, "KNOWLEDGE_DOCUMENT_RETRY_PROCESSING");
    await assertDocumentScope(actor, documentId, context, "KNOWLEDGE_DOCUMENT_RETRY_PROCESSING");
    const result = await prisma.$transaction(async (tx) => {
      const document = await tx.knowledgeDocument.findFirst({
        where: {
          id: documentId,
          businessId: actor.businessId,
          deletedAt: null,
          status: { not: KnowledgeDocumentStatus.DELETED },
          processingStatus: KnowledgeDocumentProcessingStatus.FAILED,
        },
        include: { activeVersion: true },
      });
      if (!document?.activeVersion?.storageObjectKey) {
        throw new AppError(409, "This document has no stored version available for retry.", "KNOWLEDGE_DOCUMENT_RETRY_UNAVAILABLE");
      }
      await tx.knowledgeDocumentProcessingJob.upsert({
        where: { versionId: document.activeVersion.id },
        create: {
          businessId: actor.businessId,
          documentId,
          versionId: document.activeVersion.id,
          status: KnowledgeDocumentProcessingJobStatus.QUEUED,
          nextAttemptAt: new Date(),
        },
        update: {
          status: KnowledgeDocumentProcessingJobStatus.QUEUED,
          attemptCount: 0,
          nextAttemptAt: new Date(),
          processingStartedAt: null,
          completedAt: null,
          errorCode: null,
          errorMessage: null,
        },
      });
      await tx.knowledgeDocumentVersion.update({
        where: { id: document.activeVersion.id },
        data: { processingStatus: KnowledgeDocumentProcessingStatus.QUEUED, processingErrorCode: null, processingErrorMessage: null },
      });
      return tx.knowledgeDocument.update({
        where: { id: documentId },
        data: { processingStatus: KnowledgeDocumentProcessingStatus.QUEUED, processingErrorCode: null, processingErrorMessage: null },
      });
    });
    await log(actor, context, AuditAction.KNOWLEDGE_DOCUMENT_PROCESSING_RETRY_REQUESTED, documentId);
    publish(actor, "knowledge.document.queued", documentId);
    return result;
  },
};

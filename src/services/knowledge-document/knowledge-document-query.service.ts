import {
  AuditAction,
  BusinessRole,
  KnowledgeAssetVisibility,
  KnowledgeDocumentProcessingStatus,
  KnowledgeDocumentStatus,
  Prisma,
} from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import {
  KnowledgeDocumentListQuery,
  KnowledgeDocumentVersionListQuery,
} from "../../validation/knowledge.schemas";
import { AuditInput, auditService } from "../audit.service";
import { storageService } from "../storage.service";
import {
  canManageKnowledgeDocuments,
  KnowledgeDocumentActor,
  resolveKnowledgeDocumentAccess,
  throwKnowledgeDocumentNotFound,
} from "./knowledge-document.types";

function accessWhere(actor: KnowledgeDocumentActor, documentId?: string): Prisma.KnowledgeDocumentWhereInput {
  return {
    businessId: actor.businessId,
    ...(documentId ? { id: documentId } : {}),
    deletedAt: null,
    status: { not: KnowledgeDocumentStatus.DELETED },
    ...(actor.role === BusinessRole.STAFF
      ? {
        status: KnowledgeDocumentStatus.ACTIVE,
        processingStatus: KnowledgeDocumentProcessingStatus.READY,
        visibility: KnowledgeAssetVisibility.CLIENT_SENDABLE,
      }
      : {}),
  };
}

function availableActions(canManage: boolean, status: KnowledgeDocumentStatus, processingStatus: string) {
  if (!canManage) return ["VIEW", "DOWNLOAD"];
  return [
    "VIEW",
    "DOWNLOAD",
    ...(status === KnowledgeDocumentStatus.ACTIVE ? ["ARCHIVE"] : ["RESTORE"]),
    "DELETE",
    ...(processingStatus === "FAILED" ? ["RETRY_PROCESSING"] : []),
    "VIEW_VERSIONS",
  ];
}

function storageKeyBelongsToBusiness(businessId: string, objectKey: string) {
  return objectKey.startsWith(`businesses/${businessId}/`) || objectKey.startsWith(`${businessId}/`);
}

async function documentNotFound(
  actor: KnowledgeDocumentActor,
  documentId: string,
  context?: Omit<AuditInput, "action">,
): Promise<never> {
  return throwKnowledgeDocumentNotFound(actor, documentId, context, "KNOWLEDGE_DOCUMENT_READ");
}

export const knowledgeDocumentQueryService = {
  async list(actor: KnowledgeDocumentActor, query: KnowledgeDocumentListQuery) {
    const access = await resolveKnowledgeDocumentAccess(actor);
    const canManage = canManageKnowledgeDocuments(access);
    const filters: Prisma.KnowledgeDocumentWhereInput[] = [accessWhere(actor)];
    if (query.search) filters.push({
      OR: [
        { title: { contains: query.search, mode: "insensitive" } },
        { originalFileName: { contains: query.search, mode: "insensitive" } },
        { fileName: { contains: query.search, mode: "insensitive" } },
      ],
    });
    if (query.status) filters.push({ status: query.status });
    if (query.processingStatus) filters.push({ processingStatus: query.processingStatus });
    if (query.uploaderId) filters.push({ uploadedByUserId: query.uploaderId });
    if (query.visibility) filters.push({ visibility: query.visibility });
    if (query.category) filters.push({ category: { equals: query.category, mode: "insensitive" } });
    const where: Prisma.KnowledgeDocumentWhereInput = { AND: filters };
    const orderBy: Prisma.KnowledgeDocumentOrderByWithRelationInput[] = [
      { [query.sortBy]: query.sortOrder },
      { id: query.sortOrder },
    ];
    const [data, total] = await prisma.$transaction([
      prisma.knowledgeDocument.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          activeVersion: true,
          uploadedBy: { select: { id: true, role: true, user: { select: { id: true, firstName: true, lastName: true } } } },
          _count: { select: { versions: true } },
        },
      }),
      prisma.knowledgeDocument.count({ where }),
    ]);
    return {
      data: data.map((document) => ({
        ...document,
        availableActions: availableActions(canManage, document.status, document.processingStatus),
      })),
      pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  },

  async detail(actor: KnowledgeDocumentActor, documentId: string) {
    const [access, document] = await Promise.all([
      resolveKnowledgeDocumentAccess(actor),
      prisma.knowledgeDocument.findFirst({
        where: accessWhere(actor, documentId),
        include: {
          activeVersion: true,
          uploadedBy: { select: { id: true, role: true, user: { select: { id: true, firstName: true, lastName: true } } } },
          versions: {
            orderBy: { versionNumber: "desc" },
            take: 10,
            select: {
              id: true,
              versionNumber: true,
              originalFileName: true,
              fileSize: true,
              mimeType: true,
              checksum: true,
              processingStatus: true,
              isActive: true,
              createdAt: true,
            },
          },
        },
      }),
    ]);
    if (!document) return documentNotFound(actor, documentId);
    return {
      ...document,
      processingError: document.processingErrorCode
        ? { code: document.processingErrorCode, message: document.processingErrorMessage }
        : null,
      availableActions: availableActions(canManageKnowledgeDocuments(access), document.status, document.processingStatus),
    };
  },

  async versions(actor: KnowledgeDocumentActor, documentId: string, query: KnowledgeDocumentVersionListQuery) {
    const document = await prisma.knowledgeDocument.findFirst({ where: accessWhere(actor, documentId), select: { id: true } });
    if (!document) return documentNotFound(actor, documentId);
    const where = { businessId: actor.businessId, documentId };
    const [data, total] = await prisma.$transaction([
      prisma.knowledgeDocumentVersion.findMany({
        where,
        orderBy: { versionNumber: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.knowledgeDocumentVersion.count({ where }),
    ]);
    return { data, pagination: { ...query, total, totalPages: Math.ceil(total / query.limit) } };
  },

  async downloadUrl(actor: KnowledgeDocumentActor, documentId: string, context: Omit<AuditInput, "action">) {
    const document = await prisma.knowledgeDocument.findFirst({
      where: accessWhere(actor, documentId),
      include: { activeVersion: true },
    });
    if (!document?.activeVersion?.storageObjectKey) {
      if (!document) return documentNotFound(actor, documentId, context);
      throw new AppError(404, "Document file is unavailable.", "KNOWLEDGE_DOCUMENT_FILE_NOT_FOUND");
    }
    if (!storageKeyBelongsToBusiness(actor.businessId, document.activeVersion.storageObjectKey)) {
      throw new AppError(409, "Document storage ownership is invalid.", "KNOWLEDGE_DOCUMENT_STORAGE_SCOPE_MISMATCH");
    }
    const signedUrl = await storageService.createSignedDownloadUrl(
      document.activeVersion.storageObjectKey,
      document.activeVersion.safeFileName,
      document.activeVersion.storageProvider,
    );
    const expiresAt = new Date(Date.now() + env.KNOWLEDGE_DOWNLOAD_URL_TTL_SECONDS * 1000);
    await auditService.log({
      ...context,
      action: AuditAction.KNOWLEDGE_DOCUMENT_DOWNLOADED,
      businessId: actor.businessId,
      userId: actor.userId,
      actorMembershipId: actor.membershipId,
      metadata: { documentId, versionId: document.activeVersion.id },
    }).catch(() => undefined);
    return {
      url: signedUrl ?? `/api/business/knowledge/documents/${documentId}/download`,
      expiresAt: signedUrl ? expiresAt.toISOString() : null,
      authenticated: !signedUrl,
    };
  },

  async download(actor: KnowledgeDocumentActor, documentId: string, context: Omit<AuditInput, "action">) {
    const document = await prisma.knowledgeDocument.findFirst({
      where: accessWhere(actor, documentId),
      include: { activeVersion: true },
    });
    const version = document?.activeVersion;
    if (!document || !version?.storageObjectKey) {
      if (!document) return documentNotFound(actor, documentId, context);
      throw new AppError(404, "Document file is unavailable.", "KNOWLEDGE_DOCUMENT_FILE_NOT_FOUND");
    }
    if (!storageKeyBelongsToBusiness(actor.businessId, version.storageObjectKey)) {
      throw new AppError(409, "Document storage ownership is invalid.", "KNOWLEDGE_DOCUMENT_STORAGE_SCOPE_MISMATCH");
    }
    const redirectUrl = await storageService.createSignedDownloadUrl(
      version.storageObjectKey,
      version.safeFileName,
      version.storageProvider,
    );
    await auditService.log({
      ...context,
      action: AuditAction.KNOWLEDGE_DOCUMENT_DOWNLOADED,
      businessId: actor.businessId,
      userId: actor.userId,
      actorMembershipId: actor.membershipId,
      metadata: { documentId, versionId: version.id, authenticatedDownload: true, signedRedirect: Boolean(redirectUrl) },
    }).catch(() => undefined);
    if (redirectUrl) {
      return {
        redirectUrl,
        fileName: version.safeFileName,
        mimeType: version.mimeType,
        fileSize: version.fileSize,
      };
    }
    const buffer = await storageService.readBuffer(version.storageObjectKey, version.storageProvider);
    return { buffer, fileName: version.safeFileName, mimeType: version.mimeType, fileSize: version.fileSize };
  },
};

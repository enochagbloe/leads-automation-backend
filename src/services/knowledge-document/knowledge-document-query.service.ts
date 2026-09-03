import {
  AuditAction,
  BusinessRole,
  KnowledgeAssetVisibility,
  KnowledgeDocumentProcessingStatus,
  KnowledgeDocumentStatus,
  KnowledgeGovernanceStatus,
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
import { allowedKnowledgeGovernanceActions } from "./knowledge-governance-resolution-policy";
import { customerSafeKnowledgeDocumentWhere } from "./knowledge-document-runtime-policy";

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
        governanceStatus: KnowledgeGovernanceStatus.APPROVED,
        visibility: KnowledgeAssetVisibility.CLIENT_SENDABLE,
        ...customerSafeKnowledgeDocumentWhere,
      }
      : {}),
  };
}

function availableActions(
  canManage: boolean,
  status: KnowledgeDocumentStatus,
  processingStatus: string,
  reviewApprovable = false,
) {
  if (!canManage) return ["VIEW", "DOWNLOAD"];
  return [
    "VIEW",
    "DOWNLOAD",
    ...(status === KnowledgeDocumentStatus.ACTIVE ? ["ARCHIVE"] : ["RESTORE"]),
    "DELETE",
    ...(processingStatus === "NEEDS_REVIEW" && reviewApprovable ? ["APPROVE_REVIEW"] : []),
    ...(processingStatus === "NEEDS_REVIEW" ? ["REJECT_REVIEW"] : []),
    ...(processingStatus === "FAILED" ? ["RETRY_PROCESSING"] : []),
    "VIEW_VERSIONS",
  ];
}

function storageKeyBelongsToBusiness(businessId: string, objectKey: string) {
  return objectKey.startsWith(`businesses/${businessId}/`) || objectKey.startsWith(`${businessId}/`);
}

const publicUploaderSelect = {
  id: true,
  role: true,
  user: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.BusinessMemberSelect;

const publicVersionSummarySelect = {
  id: true,
  versionNumber: true,
  originalFileName: true,
  fileSize: true,
  mimeType: true,
  processingStatus: true,
  governanceStatus: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  extraction: { select: { status: true, extractedAt: true } },
  analysis: { select: { status: true, requiresHumanReview: true, analyzedAt: true } },
} satisfies Prisma.KnowledgeDocumentVersionSelect;

const publicDocumentFields = {
  id: true,
  title: true,
  description: true,
  category: true,
  tags: true,
  relatedServiceIds: true,
  fileName: true,
  originalFileName: true,
  mimeType: true,
  fileSize: true,
  status: true,
  visibility: true,
  processingStatus: true,
  governanceStatus: true,
  archivedAt: true,
  archiveReason: true,
  replacesDocumentId: true,
  supersededByDocumentId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.KnowledgeDocumentSelect;

const publicActiveVersionListSelect = {
  ...publicVersionSummarySelect,
} satisfies Prisma.KnowledgeDocumentVersionSelect;

const publicFactSelect = {
  id: true,
  factType: true,
  label: true,
  valueText: true,
  currency: true,
  numericValue: true,
  sourceKind: true,
  sourceLabel: true,
  pageNumber: true,
  sheetName: true,
  slideNumber: true,
  paragraphIndex: true,
  rowNumber: true,
  confidence: true,
  sourceExcerpt: true,
  governanceStatus: true,
  governedAt: true,
} satisfies Prisma.KnowledgeDocumentFactSelect;

const publicActiveVersionDetailSelect = {
  id: true,
  versionNumber: true,
  originalFileName: true,
  fileSize: true,
  mimeType: true,
  processingStatus: true,
  governanceStatus: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  extraction: {
    select: {
      status: true,
      language: true,
      characterCount: true,
      wordCount: true,
      pageCount: true,
      sheetCount: true,
      slideCount: true,
      warnings: true,
      errorCode: true,
      errorMessage: true,
      extractedAt: true,
    },
  },
  analysis: {
    select: {
      status: true,
      suggestedTitle: true,
      detectedDocumentType: true,
      shortSummary: true,
      detectedPurpose: true,
      likelyAudience: true,
      recommendedClassification: true,
      classificationReason: true,
      classificationConfidence: true,
      analysisConfidence: true,
      requiresHumanReview: true,
      topics: true,
      relatedServiceSuggestions: true,
      warnings: true,
      errorCode: true,
      errorMessage: true,
      analyzedAt: true,
      facts: {
        orderBy: [{ factType: "asc" }, { createdAt: "asc" }],
        select: publicFactSelect,
      },
    },
  },
} satisfies Prisma.KnowledgeDocumentVersionSelect;

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
        select: {
          ...publicDocumentFields,
          activeVersion: { select: publicActiveVersionListSelect },
          uploadedBy: { select: publicUploaderSelect },
          _count: { select: { versions: true } },
        },
      }),
      prisma.knowledgeDocument.count({ where }),
    ]);
    return {
      data: data.map((document) => ({
        ...document,
        availableActions: availableActions(
          canManage,
          document.status,
          document.processingStatus,
          document.activeVersion?.extraction?.status === "COMPLETED"
            && document.activeVersion.analysis?.status === "COMPLETED"
            && document.activeVersion.analysis.requiresHumanReview,
        ),
      })),
      pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  },

  async detail(actor: KnowledgeDocumentActor, documentId: string) {
    const [access, document] = await Promise.all([
      resolveKnowledgeDocumentAccess(actor),
      prisma.knowledgeDocument.findFirst({
        where: accessWhere(actor, documentId),
        select: {
          ...publicDocumentFields,
          processingErrorCode: true,
          processingErrorMessage: true,
          activeVersion: { select: publicActiveVersionDetailSelect },
          uploadedBy: { select: publicUploaderSelect },
          versions: {
            orderBy: { versionNumber: "desc" },
            take: 10,
            select: publicVersionSummarySelect,
          },
        },
      }),
    ]);
    if (!document) return documentNotFound(actor, documentId);
    const canManage = canManageKnowledgeDocuments(access);
    const governanceReviews = canManage && document.activeVersion
      ? await prisma.knowledgeGovernanceReview.findMany({
        where: {
          businessId: actor.businessId,
          documentId,
          versionId: document.activeVersion.id,
        },
        orderBy: [{ reviewStatus: "asc" }, { priority: "asc" }, { detectedAt: "asc" }],
        select: {
          id: true,
          factId: true,
          comparisonType: true,
          priority: true,
          reviewStatus: true,
          canonicalEntityType: true,
          canonicalEntityId: true,
          canonicalField: true,
          existingValue: true,
          documentValue: true,
          normalizedExistingValue: true,
          normalizedDocumentValue: true,
          requiresHumanReview: true,
          blocksAiUse: true,
          relatedDocumentId: true,
          relatedVersionId: true,
          detectedAt: true,
          reviewedAt: true,
          resolutionAction: true,
          resolutionReason: true,
        },
      })
      : [];
    const unresolvedGovernanceReviews = governanceReviews.filter(
      (review) => review.requiresHumanReview && review.reviewStatus !== "RESOLVED",
    );
    const { processingErrorCode, processingErrorMessage, ...publicDocument } = document;
    return {
      ...publicDocument,
      ...(canManage ? {
        governance: {
          status: document.governanceStatus,
          reviewCount: governanceReviews.length,
          unresolvedReviewCount: unresolvedGovernanceReviews.length,
          criticalUnresolvedCount: unresolvedGovernanceReviews.filter((review) => review.priority === "CRITICAL").length,
          reviews: governanceReviews.map((review) => ({
            ...review,
            allowedResolutionActions: review.reviewStatus === "PENDING_REVIEW"
              ? allowedKnowledgeGovernanceActions(review)
              : [],
          })),
        },
      } : {}),
      processingError: processingErrorCode
        ? { code: processingErrorCode, message: processingErrorMessage }
        : null,
      availableActions: availableActions(
        canManage,
        document.status,
        document.processingStatus,
        document.activeVersion?.extraction?.status === "COMPLETED"
          && document.activeVersion.analysis?.status === "COMPLETED"
          && document.activeVersion.analysis.requiresHumanReview,
      ),
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
        select: publicVersionSummarySelect,
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

export const knowledgeDocumentQueryPolicy = {
  publicDocumentFields,
  publicVersionSummarySelect,
  publicActiveVersionDetailSelect,
};

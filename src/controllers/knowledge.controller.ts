import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { knowledgeService } from "../services/knowledge.service";
import { knowledgeDocumentIngestionService } from "../services/knowledge-document/knowledge-document-ingestion.service";
import { knowledgeDocumentLifecycleService } from "../services/knowledge-document/knowledge-document-lifecycle.service";
import { knowledgeDocumentQueryService } from "../services/knowledge-document/knowledge-document-query.service";
import { knowledgeDocumentReplacementService } from "../services/knowledge-document/knowledge-document-replacement.service";
import { knowledgeDocumentReviewService } from "../services/knowledge-document/knowledge-document-review.service";
import { knowledgeGovernanceResolutionService } from "../services/knowledge-document/knowledge-governance-resolution.service";
import { AppError } from "../utils/errors";
import { requestMetadata } from "../utils/request";
import {
  ApproveKnowledgeDocumentReviewInput,
  CompleteKnowledgeDocumentReplacementInput,
  KnowledgeArticleListQuery,
  KnowledgeDocumentListQuery,
  KnowledgeDocumentVersionListQuery,
  KnowledgeSearchQuery,
  RejectKnowledgeDocumentReviewInput,
  ResolveKnowledgeGovernanceReviewBatchInput,
  ResolveKnowledgeGovernanceReviewInput,
} from "../validation/knowledge.schemas";

function actor(req: Request) {
  return {
    userId: req.auth!.userId,
    businessAccountId: req.auth!.businessAccountId!,
    businessId: req.auth!.businessId!,
    membershipId: req.auth!.membershipId!,
    role: req.auth!.role as BusinessRole,
  };
}

function param(req: Request, key: string) {
  const value = req.params[key];
  return Array.isArray(value) ? value[0]! : value!;
}

function sendDownload(
  res: Parameters<RequestHandler>[1],
  file: {
    fileName: string;
    mimeType: string;
    fileSize: number;
    buffer?: Buffer;
    redirectUrl?: string;
  },
) {
  if (file.redirectUrl) {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.redirect(302, file.redirectUrl);
    return;
  }
  if (!file.buffer) throw new AppError(503, "Document file is unavailable.", "KNOWLEDGE_ASSET_FILE_NOT_FOUND");
  res.type(file.mimeType);
  res.attachment(file.fileName);
  res.setHeader("Content-Length", file.buffer.byteLength || file.fileSize);
  res.send(file.buffer);
}

function wantsSse(req: Request) {
  return req.get("accept")?.split(",").some((entry) => entry.trim().toLowerCase().startsWith("text/event-stream")) ?? false;
}

function writeSse(res: Parameters<RequestHandler>[1], event: string, data: Record<string, unknown>) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function safeStreamError(error: unknown) {
  const code = error instanceof AppError ? error.code : "AI_PROVIDER_FAILED";
  const message = error instanceof AppError ? error.message : "AI could not draft the article. Please try again.";
  return { success: false, reason: code, message };
}

export const knowledgeController = {
  stats: async (req, res) => res.json(await knowledgeService.stats(actor(req))),

  listArticles: async (req, res) => res.json(await knowledgeService.listArticles(actor(req), res.locals.validatedQuery as KnowledgeArticleListQuery)),
  createArticle: async (req, res) => res.status(201).json(await knowledgeService.createArticle(actor(req), req.body, requestMetadata(req))),
  articleDetail: async (req, res) => res.json(await knowledgeService.detailArticle(actor(req), param(req, "articleId"))),
  downloadArticlePdf: async (req, res) => sendDownload(res, await knowledgeService.downloadArticlePdf(actor(req), param(req, "articleId"))),
  updateArticle: async (req, res) => res.json(await knowledgeService.updateArticle(actor(req), param(req, "articleId"), req.body, requestMetadata(req))),
  updateArticleStatus: async (req, res) => res.json(await knowledgeService.updateArticleStatus(actor(req), param(req, "articleId"), req.body.status, requestMetadata(req))),
  archiveArticle: async (req, res) => res.json(await knowledgeService.archiveArticle(actor(req), param(req, "articleId"), requestMetadata(req))),
  draftArticle: async (req, res, next) => {
    const currentActor = actor(req);
    if (!wantsSse(req)) {
      const article = await knowledgeService.draftArticle(currentActor, req.body, requestMetadata(req));
      res.status(201).json({ success: true, article });
      return;
    }
    try {
      await knowledgeService.assertCanDraftArticle(currentActor, req.body);
    } catch (error) {
      next(error);
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    try {
      await knowledgeService.streamDraftArticle(currentActor, req.body, requestMetadata(req), (event, data) => {
        writeSse(res, event, data);
      });
      res.end();
    } catch (error) {
      writeSse(res, "draft_error", safeStreamError(error));
      res.end();
    }
  },
  generateStarterArticles: async (req, res) => res.status(201).json(await knowledgeService.generateStarterArticles(actor(req), req.body, requestMetadata(req))),

  listDocuments: async (req, res) => res.json(await knowledgeDocumentQueryService.list(actor(req), res.locals.validatedQuery as KnowledgeDocumentListQuery)),
  uploadDocument: async (req, res) => {
    const result = await knowledgeDocumentIngestionService.upload(
      actor(req),
      req.body,
      req.file!,
      requestMetadata(req),
      req.get("Idempotency-Key"),
    );
    res.status(result.statusCode).json(result.response);
  },
  replaceDocument: async (req, res) => {
    const result = await knowledgeDocumentReplacementService.replace(
      actor(req),
      param(req, "documentId"),
      req.body,
      req.file!,
      requestMetadata(req),
      req.get("Idempotency-Key"),
    );
    res.status(result.statusCode).json(result.response);
  },
  documentDetail: async (req, res) => res.json(await knowledgeDocumentQueryService.detail(actor(req), param(req, "documentId"))),
  documentVersions: async (req, res) => res.json(await knowledgeDocumentQueryService.versions(
    actor(req),
    param(req, "documentId"),
    res.locals.validatedQuery as KnowledgeDocumentVersionListQuery,
  )),
  documentDownloadUrl: async (req, res) => res.json(await knowledgeDocumentQueryService.downloadUrl(actor(req), param(req, "documentId"), requestMetadata(req))),
  downloadDocument: async (req, res) => sendDownload(res, await knowledgeDocumentQueryService.download(actor(req), param(req, "documentId"), requestMetadata(req))),
  updateDocument: async (req, res) => res.json(await knowledgeService.updateDocument(actor(req), param(req, "documentId"), req.body, requestMetadata(req))),
  updateDocumentStatus: async (req, res) => {
    const status = req.body.status as string;
    if (status === "ARCHIVED") return res.json(await knowledgeDocumentLifecycleService.archive(actor(req), param(req, "documentId"), requestMetadata(req)));
    if (status === "ACTIVE") return res.json(await knowledgeDocumentLifecycleService.restore(actor(req), param(req, "documentId"), requestMetadata(req)));
    if (status === "DELETED") return res.json(await knowledgeDocumentLifecycleService.softDelete(actor(req), param(req, "documentId"), requestMetadata(req)));
    throw new AppError(422, "Unsupported document status transition.", "KNOWLEDGE_DOCUMENT_STATUS_TRANSITION_INVALID");
  },
  archiveDocument: async (req, res) => res.json(await knowledgeDocumentLifecycleService.archive(actor(req), param(req, "documentId"), requestMetadata(req))),
  restoreDocument: async (req, res) => res.json(await knowledgeDocumentLifecycleService.restore(actor(req), param(req, "documentId"), requestMetadata(req))),
  deleteDocument: async (req, res) => res.json(await knowledgeDocumentLifecycleService.softDelete(actor(req), param(req, "documentId"), requestMetadata(req))),
  retryDocumentProcessing: async (req, res) => res.json(await knowledgeDocumentLifecycleService.retryProcessing(actor(req), param(req, "documentId"), requestMetadata(req))),
  approveDocumentReview: async (req, res) => res.json(await knowledgeDocumentReviewService.approve(
    actor(req),
    param(req, "documentId"),
    req.body as ApproveKnowledgeDocumentReviewInput,
    requestMetadata(req),
  )),
  rejectDocumentReview: async (req, res) => res.json(await knowledgeDocumentReviewService.reject(
    actor(req),
    param(req, "documentId"),
    req.body as RejectKnowledgeDocumentReviewInput,
    requestMetadata(req),
  )),
  resolveGovernanceReview: async (req, res) => res.json(await knowledgeGovernanceResolutionService.resolve(
    actor(req),
    param(req, "reviewId"),
    req.body as ResolveKnowledgeGovernanceReviewInput,
    req.get("Idempotency-Key"),
    requestMetadata(req),
  )),
  resolveGovernanceReviewsBatch: async (req, res) => res.json(await knowledgeGovernanceResolutionService.resolveBatch(
    actor(req),
    req.body as ResolveKnowledgeGovernanceReviewBatchInput,
    requestMetadata(req),
  )),
  completeDocumentReplacement: async (req, res) => res.json(await knowledgeGovernanceResolutionService.completeReplacement(
    actor(req),
    param(req, "documentId"),
    req.body as CompleteKnowledgeDocumentReplacementInput,
    requestMetadata(req),
  )),
  permanentlyDeleteDocument: async (req, res) => res.json(await knowledgeDocumentLifecycleService.permanentlyDelete(
    actor(req),
    param(req, "documentId"),
    req.body.confirmPermanentDelete,
    requestMetadata(req),
  )),
  compareDocumentReplacement: async (req, res) => res.json(await knowledgeGovernanceResolutionService.compareReplacement(
    actor(req),
    param(req, "documentId"),
    param(req, "reviewId"),
    requestMetadata(req),
  )),
  documentReviewDetails: async (req, res) => res.json(await knowledgeGovernanceResolutionService.reviewDetails(
    actor(req),
    param(req, "documentId"),
    requestMetadata(req),
  )),

  search: async (req, res) => res.json(await knowledgeService.search(actor(req), res.locals.validatedQuery as KnowledgeSearchQuery)),
  sendToConversation: async (req, res) => res.json(await knowledgeService.sendToConversation(actor(req), param(req, "id"), req.body, requestMetadata(req))),
} satisfies Record<string, RequestHandler>;

import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { knowledgeService } from "../services/knowledge.service";
import { AppError } from "../utils/errors";
import { requestMetadata } from "../utils/request";
import {
  KnowledgeArticleListQuery,
  KnowledgeDocumentListQuery,
  KnowledgeSearchQuery,
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

function sendDownload(res: Parameters<RequestHandler>[1], file: { buffer: Buffer; fileName: string; mimeType: string; fileSize: number }) {
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

  listDocuments: async (req, res) => res.json(await knowledgeService.listDocuments(actor(req), res.locals.validatedQuery as KnowledgeDocumentListQuery)),
  uploadDocument: async (req, res) => res.status(201).json(await knowledgeService.uploadDocument(actor(req), req.body, req.file!, requestMetadata(req))),
  documentDetail: async (req, res) => res.json(await knowledgeService.detailDocument(actor(req), param(req, "documentId"))),
  downloadDocument: async (req, res) => sendDownload(res, await knowledgeService.downloadDocument(actor(req), param(req, "documentId"))),
  updateDocument: async (req, res) => res.json(await knowledgeService.updateDocument(actor(req), param(req, "documentId"), req.body, requestMetadata(req))),
  updateDocumentStatus: async (req, res) => res.json(await knowledgeService.updateDocumentStatus(actor(req), param(req, "documentId"), req.body.status, requestMetadata(req))),
  archiveDocument: async (req, res) => res.json(await knowledgeService.archiveDocument(actor(req), param(req, "documentId"), requestMetadata(req))),

  search: async (req, res) => res.json(await knowledgeService.search(actor(req), res.locals.validatedQuery as KnowledgeSearchQuery)),
  sendToConversation: async (req, res) => res.json(await knowledgeService.sendToConversation(actor(req), param(req, "id"), req.body, requestMetadata(req))),
} satisfies Record<string, RequestHandler>;

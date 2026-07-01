import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { knowledgeService } from "../services/knowledge.service";
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

export const knowledgeController = {
  stats: async (req, res) => res.json(await knowledgeService.stats(actor(req))),

  listArticles: async (req, res) => res.json(await knowledgeService.listArticles(actor(req), res.locals.validatedQuery as KnowledgeArticleListQuery)),
  createArticle: async (req, res) => res.status(201).json(await knowledgeService.createArticle(actor(req), req.body, requestMetadata(req))),
  articleDetail: async (req, res) => res.json(await knowledgeService.detailArticle(actor(req), param(req, "articleId"))),
  downloadArticlePdf: async (req, res) => sendDownload(res, await knowledgeService.downloadArticlePdf(actor(req), param(req, "articleId"))),
  updateArticle: async (req, res) => res.json(await knowledgeService.updateArticle(actor(req), param(req, "articleId"), req.body, requestMetadata(req))),
  updateArticleStatus: async (req, res) => res.json(await knowledgeService.updateArticleStatus(actor(req), param(req, "articleId"), req.body.status, requestMetadata(req))),
  archiveArticle: async (req, res) => res.json(await knowledgeService.archiveArticle(actor(req), param(req, "articleId"), requestMetadata(req))),
  draftArticle: async (req, res) => res.status(201).json(await knowledgeService.draftArticle(actor(req), req.body, requestMetadata(req))),
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

import { Router } from "express";
import { knowledgeController } from "../controllers/knowledge.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness } from "../middleware/rbac";
import { validate, validateQuery } from "../middleware/validate";
import { uploadKnowledgePdf, validateKnowledgeUploadMetadata } from "../middleware/knowledge-upload";
import {
  createKnowledgeArticleSchema,
  draftKnowledgeArticleSchema,
  generateStarterArticlesSchema,
  knowledgeArticleListQuerySchema,
  knowledgeDocumentListQuerySchema,
  knowledgeSearchQuerySchema,
  updateKnowledgeArticleSchema,
  updateKnowledgeArticleStatusSchema,
  updateKnowledgeDocumentSchema,
  updateKnowledgeDocumentStatusSchema,
} from "../validation/knowledge.schemas";

export const knowledgeRouter = Router();

knowledgeRouter.use(authenticate, requireBusiness);

knowledgeRouter.get("/stats", knowledgeController.stats);
knowledgeRouter.get("/search", validateQuery(knowledgeSearchQuerySchema), knowledgeController.search);
knowledgeRouter.post("/articles/generate-starter", mutationLimiter, validate(generateStarterArticlesSchema), knowledgeController.generateStarterArticles);
knowledgeRouter.post("/articles/draft", mutationLimiter, validate(draftKnowledgeArticleSchema), knowledgeController.draftArticle);
knowledgeRouter.get("/articles", validateQuery(knowledgeArticleListQuerySchema), knowledgeController.listArticles);
knowledgeRouter.post("/articles", mutationLimiter, validate(createKnowledgeArticleSchema), knowledgeController.createArticle);
knowledgeRouter.get("/articles/:articleId/download", knowledgeController.downloadArticlePdf);
knowledgeRouter.get("/articles/:articleId", knowledgeController.articleDetail);
knowledgeRouter.patch("/articles/:articleId", mutationLimiter, validate(updateKnowledgeArticleSchema), knowledgeController.updateArticle);
knowledgeRouter.patch("/articles/:articleId/status", mutationLimiter, validate(updateKnowledgeArticleStatusSchema), knowledgeController.updateArticleStatus);
knowledgeRouter.delete("/articles/:articleId", mutationLimiter, knowledgeController.archiveArticle);

knowledgeRouter.get("/documents", validateQuery(knowledgeDocumentListQuerySchema), knowledgeController.listDocuments);
knowledgeRouter.post("/documents/upload", mutationLimiter, uploadKnowledgePdf, validateKnowledgeUploadMetadata, knowledgeController.uploadDocument);
knowledgeRouter.get("/documents/:documentId/download", knowledgeController.downloadDocument);
knowledgeRouter.get("/documents/:documentId", knowledgeController.documentDetail);
knowledgeRouter.patch("/documents/:documentId", mutationLimiter, validate(updateKnowledgeDocumentSchema), knowledgeController.updateDocument);
knowledgeRouter.patch("/documents/:documentId/status", mutationLimiter, validate(updateKnowledgeDocumentStatusSchema), knowledgeController.updateDocumentStatus);
knowledgeRouter.delete("/documents/:documentId", mutationLimiter, knowledgeController.archiveDocument);

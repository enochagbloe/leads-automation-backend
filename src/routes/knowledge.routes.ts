import { Router } from "express";
import { knowledgeController } from "../controllers/knowledge.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness } from "../middleware/rbac";
import { validate, validateQuery } from "../middleware/validate";
import {
  uploadKnowledgeDocument,
  validateKnowledgeReplacementMetadata,
  validateKnowledgeUploadMetadata,
} from "../middleware/knowledge-upload";
import {
  approveKnowledgeDocumentReviewSchema,
  completeKnowledgeDocumentReplacementSchema,
  createKnowledgeArticleSchema,
  draftKnowledgeArticleSchema,
  generateStarterArticlesSchema,
  knowledgeArticleListQuerySchema,
  knowledgeDocumentListQuerySchema,
  knowledgeDocumentVersionListQuerySchema,
  knowledgeSearchQuerySchema,
  knowledgeGovernanceReviewQueueQuerySchema,
  rejectKnowledgeDocumentReviewSchema,
  permanentlyDeleteKnowledgeDocumentSchema,
  resolveKnowledgeGovernanceReviewBatchSchema,
  resolveKnowledgeGovernanceReviewSchema,
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
knowledgeRouter.get("/documents/reviews/summary", knowledgeController.governanceSummary);
knowledgeRouter.get("/documents/reviews", validateQuery(knowledgeGovernanceReviewQueueQuerySchema), knowledgeController.governanceQueue);
knowledgeRouter.post("/documents/upload", mutationLimiter, uploadKnowledgeDocument, validateKnowledgeUploadMetadata, knowledgeController.uploadDocument);
knowledgeRouter.post("/documents/:documentId/versions", mutationLimiter, uploadKnowledgeDocument, validateKnowledgeReplacementMetadata, knowledgeController.replaceDocument);
knowledgeRouter.get("/documents/:documentId/versions", validateQuery(knowledgeDocumentVersionListQuerySchema), knowledgeController.documentVersions);
knowledgeRouter.get("/documents/:documentId/reviews", knowledgeController.documentReviewDetails);
knowledgeRouter.get("/documents/:documentId/download-url", knowledgeController.documentDownloadUrl);
knowledgeRouter.get("/documents/:documentId/download", knowledgeController.downloadDocument);
knowledgeRouter.get("/documents/:documentId", knowledgeController.documentDetail);
knowledgeRouter.patch("/documents/:documentId", mutationLimiter, validate(updateKnowledgeDocumentSchema), knowledgeController.updateDocument);
knowledgeRouter.patch("/documents/:documentId/status", mutationLimiter, validate(updateKnowledgeDocumentStatusSchema), knowledgeController.updateDocumentStatus);
knowledgeRouter.post("/documents/:documentId/archive", mutationLimiter, knowledgeController.archiveDocument);
knowledgeRouter.post("/documents/:documentId/restore", mutationLimiter, knowledgeController.restoreDocument);
knowledgeRouter.post("/documents/:documentId/retry-processing", mutationLimiter, knowledgeController.retryDocumentProcessing);
knowledgeRouter.post("/documents/:documentId/review/approve", mutationLimiter, validate(approveKnowledgeDocumentReviewSchema), knowledgeController.approveDocumentReview);
knowledgeRouter.post("/documents/:documentId/review/reject", mutationLimiter, validate(rejectKnowledgeDocumentReviewSchema), knowledgeController.rejectDocumentReview);
knowledgeRouter.post("/documents/reviews/resolve-batch", mutationLimiter, validate(resolveKnowledgeGovernanceReviewBatchSchema), knowledgeController.resolveGovernanceReviewsBatch);
knowledgeRouter.post("/documents/reviews/:reviewId/resolve", mutationLimiter, validate(resolveKnowledgeGovernanceReviewSchema), knowledgeController.resolveGovernanceReview);
knowledgeRouter.get("/documents/:documentId/replacement/:reviewId/compare", knowledgeController.compareDocumentReplacement);
knowledgeRouter.post("/documents/:documentId/replacement/complete", mutationLimiter, validate(completeKnowledgeDocumentReplacementSchema), knowledgeController.completeDocumentReplacement);
knowledgeRouter.delete("/documents/:documentId/permanent", mutationLimiter, validate(permanentlyDeleteKnowledgeDocumentSchema), knowledgeController.permanentlyDeleteDocument);
knowledgeRouter.delete("/documents/:documentId", mutationLimiter, knowledgeController.deleteDocument);

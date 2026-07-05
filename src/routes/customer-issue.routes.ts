import { Router } from "express";
import { customerIssueController } from "../controllers/customer-issue.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness } from "../middleware/rbac";
import { validate, validateQuery } from "../middleware/validate";
import {
  complaintInsightQuerySchema,
  customerIssueListQuerySchema,
  customerIssueMetricsQuerySchema,
  generateComplaintInsightSchema,
  updateCustomerIssueIntelligenceSchema,
  updateCustomerIssueStatusSchema,
} from "../validation/customer-issue.schemas";

export const customerIssueRouter = Router();

customerIssueRouter.use(authenticate, requireBusiness);
customerIssueRouter.get("/metrics", validateQuery(customerIssueMetricsQuerySchema), customerIssueController.metrics);
customerIssueRouter.get("/insights", validateQuery(complaintInsightQuerySchema), customerIssueController.listInsights);
customerIssueRouter.get("/insights/latest", validateQuery(complaintInsightQuerySchema), customerIssueController.latestInsight);
customerIssueRouter.get("/insights/memory", customerIssueController.insightMemory);
customerIssueRouter.post("/insights/generate", mutationLimiter, validate(generateComplaintInsightSchema), customerIssueController.generateInsight);
customerIssueRouter.get("/", validateQuery(customerIssueListQuerySchema), customerIssueController.list);
customerIssueRouter.get("/:issueId", customerIssueController.detail);
customerIssueRouter.patch("/:issueId/intelligence", mutationLimiter, validate(updateCustomerIssueIntelligenceSchema), customerIssueController.updateIntelligence);
customerIssueRouter.patch("/:issueId/status", mutationLimiter, validate(updateCustomerIssueStatusSchema), customerIssueController.updateStatus);

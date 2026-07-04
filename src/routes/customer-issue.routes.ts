import { Router } from "express";
import { customerIssueController } from "../controllers/customer-issue.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness } from "../middleware/rbac";
import { validate, validateQuery } from "../middleware/validate";
import { customerIssueListQuerySchema, customerIssueMetricsQuerySchema, updateCustomerIssueIntelligenceSchema, updateCustomerIssueStatusSchema } from "../validation/customer-issue.schemas";

export const customerIssueRouter = Router();

customerIssueRouter.use(authenticate, requireBusiness);
customerIssueRouter.get("/metrics", validateQuery(customerIssueMetricsQuerySchema), customerIssueController.metrics);
customerIssueRouter.get("/", validateQuery(customerIssueListQuerySchema), customerIssueController.list);
customerIssueRouter.get("/:issueId", customerIssueController.detail);
customerIssueRouter.patch("/:issueId/intelligence", mutationLimiter, validate(updateCustomerIssueIntelligenceSchema), customerIssueController.updateIntelligence);
customerIssueRouter.patch("/:issueId/status", mutationLimiter, validate(updateCustomerIssueStatusSchema), customerIssueController.updateStatus);

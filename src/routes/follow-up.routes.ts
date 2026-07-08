import { Router } from "express";
import { followUpController } from "../controllers/follow-up.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness } from "../middleware/rbac";
import { validate, validateQuery } from "../middleware/validate";
import {
  followUpJobCancelSchema,
  followUpJobListQuerySchema,
  followUpJobRetrySchema,
  followUpLogListQuerySchema,
  followUpRuleCreateSchema,
  followUpRuleListQuerySchema,
  followUpRuleUpdateSchema,
  followUpSettingsSchema,
  followUpTestTriggerSchema,
} from "../validation/follow-up.schemas";

export const followUpRouter = Router();

followUpRouter.use(authenticate, requireBusiness);

followUpRouter.get("/settings", followUpController.settings);
followUpRouter.patch("/settings", mutationLimiter, validate(followUpSettingsSchema), followUpController.updateSettings);

followUpRouter.get("/rules", validateQuery(followUpRuleListQuerySchema), followUpController.listRules);
followUpRouter.post("/rules", mutationLimiter, validate(followUpRuleCreateSchema), followUpController.createRule);
followUpRouter.get("/rules/:ruleId", followUpController.getRule);
followUpRouter.patch("/rules/:ruleId", mutationLimiter, validate(followUpRuleUpdateSchema), followUpController.updateRule);
followUpRouter.delete("/rules/:ruleId", mutationLimiter, followUpController.deleteRule);

followUpRouter.get("/jobs", validateQuery(followUpJobListQuerySchema), followUpController.listJobs);
followUpRouter.get("/jobs/:jobId", followUpController.getJob);
followUpRouter.patch("/jobs/:jobId/cancel", mutationLimiter, validate(followUpJobCancelSchema), followUpController.cancelJob);
followUpRouter.patch("/jobs/:jobId/retry", mutationLimiter, validate(followUpJobRetrySchema), followUpController.retryJob);

followUpRouter.get("/logs", validateQuery(followUpLogListQuerySchema), followUpController.listLogs);
followUpRouter.get("/logs/:logId", followUpController.getLog);

followUpRouter.post("/triggers/test", mutationLimiter, validate(followUpTestTriggerSchema), followUpController.testTrigger);

import { BusinessRole } from "@prisma/client";
import { Router } from "express";
import { aiController } from "../controllers/ai.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness, requireRole } from "../middleware/rbac";

export const aiRouter = Router();

aiRouter.use(authenticate, requireBusiness);
aiRouter.post(
  "/conversations/:conversationId/ai/process-latest",
  mutationLimiter,
  requireRole(BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER),
  aiController.processLatest,
);

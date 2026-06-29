import { BusinessRole } from "@prisma/client";
import { Router } from "express";
import { aiController } from "../controllers/ai.controller";
import { aiHumanReviewController } from "../controllers/ai-human-review.controller";
import { appointmentController } from "../controllers/appointment.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness, requireRole } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { conversationHandoffReasonSchema } from "../validation/conversation.schemas";
import { appointmentAutoConfirmSettingsSchema } from "../validation/appointment.schemas";

export const aiRouter = Router();

aiRouter.use(authenticate, requireBusiness);
aiRouter.get("/ai/auto-confirm-settings", appointmentController.getAutoConfirmSettings);
aiRouter.patch(
  "/ai/auto-confirm-settings",
  mutationLimiter,
  requireRole(BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER),
  validate(appointmentAutoConfirmSettingsSchema),
  appointmentController.updateAutoConfirmSettings,
);
aiRouter.post(
  "/conversations/:conversationId/ai/process-latest",
  mutationLimiter,
  requireRole(BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER),
  aiController.processLatest,
);
aiRouter.patch(
  "/conversations/:conversationId/take-over",
  mutationLimiter,
  validate(conversationHandoffReasonSchema),
  aiHumanReviewController.takeOver,
);
aiRouter.patch(
  "/conversations/:conversationId/resume-ai",
  mutationLimiter,
  validate(conversationHandoffReasonSchema),
  aiHumanReviewController.resumeAi,
);

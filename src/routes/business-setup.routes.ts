import { Router } from "express";
import { businessSetupController } from "../controllers/business-setup.controller";
import { businessProfileController } from "../controllers/business-profile.controller";
import { businessKnowledgeController } from "../controllers/business-knowledge.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { updateBusinessProfileSchema } from "../validation/business.schemas";

export const businessSetupRouter = Router();

businessSetupRouter.get("/knowledge-preview", authenticate, requireBusiness, businessKnowledgeController.get);
businessSetupRouter.get("/setup-status", authenticate, requireBusiness, businessSetupController.status);
businessSetupRouter.get("/profile", authenticate, requireBusiness, businessProfileController.get);
businessSetupRouter.patch("/profile", authenticate, requireBusiness, mutationLimiter, validate(updateBusinessProfileSchema), businessProfileController.update);

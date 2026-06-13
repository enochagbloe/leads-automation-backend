import { Router } from "express";
import { businessSetupController } from "../controllers/business-setup.controller";
import { authenticate } from "../middleware/auth";
import { requireBusiness } from "../middleware/rbac";

export const businessSetupRouter = Router();

businessSetupRouter.get("/setup-status", authenticate, requireBusiness, businessSetupController.status);

import { BusinessRole } from "@prisma/client";
import { Router } from "express";
import { subscriptionController } from "../controllers/subscription.controller";
import { authenticate } from "../middleware/auth";
import { requireBusiness, requireRole } from "../middleware/rbac";

export const subscriptionRouter = Router();

subscriptionRouter.get("/current", authenticate, requireBusiness, subscriptionController.current);
subscriptionRouter.post("/change-plan", authenticate, requireBusiness, requireRole(BusinessRole.BUSINESS_OWNER), subscriptionController.changePlan);

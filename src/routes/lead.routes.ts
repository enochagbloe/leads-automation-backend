import { Router } from "express";
import { leadController } from "../controllers/lead.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness } from "../middleware/rbac";
import { validate, validateQuery } from "../middleware/validate";
import {
  assignLeadSchema,
  createLeadSchema,
  leadListQuerySchema,
  updateLeadSchema,
  updateLeadStatusSchema,
} from "../validation/lead.schemas";

export const leadRouter = Router();

leadRouter.use(authenticate, requireBusiness);
leadRouter.get("/stats", leadController.stats);
leadRouter.get("/", validateQuery(leadListQuerySchema), leadController.list);
leadRouter.post("/", mutationLimiter, validate(createLeadSchema), leadController.create);
leadRouter.get("/:id", leadController.detail);
leadRouter.patch("/:id", mutationLimiter, validate(updateLeadSchema), leadController.update);
leadRouter.patch("/:id/assign", mutationLimiter, validate(assignLeadSchema), leadController.assign);
leadRouter.patch("/:id/claim", mutationLimiter, leadController.claim);
leadRouter.patch("/:id/status", mutationLimiter, validate(updateLeadStatusSchema), leadController.updateStatus);
leadRouter.delete("/:id", mutationLimiter, leadController.remove);

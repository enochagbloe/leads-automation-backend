import { BusinessRole } from "@prisma/client";
import { Router } from "express";
import { businessInvitationController } from "../controllers/business-invitation.controller";
import { authenticate } from "../middleware/auth";
import { emailLimiter, mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness, requireRole } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { inviteMemberSchema } from "../validation/auth.schemas";

export const businessInvitationRouter = Router();

businessInvitationRouter.use(
  authenticate,
  requireBusiness,
  requireRole(BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER),
);
businessInvitationRouter.get("/", businessInvitationController.list);
businessInvitationRouter.post("/", emailLimiter, validate(inviteMemberSchema), businessInvitationController.create);
businessInvitationRouter.patch("/:invitationId/revoke", mutationLimiter, businessInvitationController.revoke);

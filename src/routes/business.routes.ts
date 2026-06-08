import { BusinessRole } from "@prisma/client";
import { Router } from "express";
import { businessController } from "../controllers/business.controller";
import { authenticate } from "../middleware/auth";
import { requireBusiness, requireRole } from "../middleware/rbac";
import { emailLimiter, mutationLimiter } from "../middleware/rate-limit";
import { validate } from "../middleware/validate";
import { acceptInvitationSchema, inviteMemberSchema } from "../validation/auth.schemas";
import { createBusinessSchema } from "../validation/business.schemas";

export const businessRouter = Router();

businessRouter.get("/", authenticate, businessController.listMine);
businessRouter.post("/", authenticate, mutationLimiter, validate(createBusinessSchema), businessController.create);
businessRouter.post("/invitations/accept", emailLimiter, validate(acceptInvitationSchema), businessController.acceptInvitation);
businessRouter.post(
  "/invitations",
  authenticate,
  requireBusiness,
  requireRole(BusinessRole.BUSINESS_OWNER),
  emailLimiter,
  validate(inviteMemberSchema),
  businessController.inviteMember,
);

import { Router } from "express";
import { businessMemberController } from "../controllers/business-member.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { memberAccessReasonSchema, memberOperationalProfileSchema } from "../validation/business.schemas";

export const businessMemberRouter = Router();

businessMemberRouter.use(authenticate, requireBusiness);
businessMemberRouter.get("/", businessMemberController.list);
businessMemberRouter.patch("/:memberId/disable", mutationLimiter, validate(memberAccessReasonSchema), businessMemberController.disable);
businessMemberRouter.patch("/:memberId/restore", mutationLimiter, businessMemberController.restore);
businessMemberRouter.patch("/:memberId/remove", mutationLimiter, validate(memberAccessReasonSchema), businessMemberController.remove);
businessMemberRouter.patch("/:memberId/operational-profile", mutationLimiter, validate(memberOperationalProfileSchema), businessMemberController.updateOperationalProfile);

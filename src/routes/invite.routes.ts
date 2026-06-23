import { Router } from "express";
import { inviteController } from "../controllers/invite.controller";
import { authenticateUser } from "../middleware/auth";
import { emailLimiter, mutationLimiter } from "../middleware/rate-limit";
import { validate } from "../middleware/validate";
import { inviteSignupSchema } from "../validation/auth.schemas";

export const inviteRouter = Router();

inviteRouter.get("/:token", emailLimiter, inviteController.validate);
inviteRouter.post("/:token/accept", authenticateUser, mutationLimiter, inviteController.accept);
inviteRouter.post("/:token/signup", emailLimiter, validate(inviteSignupSchema), inviteController.signup);

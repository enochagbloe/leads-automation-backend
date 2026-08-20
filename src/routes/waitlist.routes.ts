import { Router } from "express";
import { waitlistController } from "../controllers/waitlist.controller";
import { waitlistConfirmationLimiter, waitlistResendLimiter, waitlistSignupLimiter } from "../middleware/rate-limit";
import { validate } from "../middleware/validate";
import { waitlistConfirmationSchema, waitlistEmailSchema, waitlistSignupSchema } from "../validation/waitlist.schemas";

export const waitlistRouter = Router();

waitlistRouter.post("/", waitlistSignupLimiter, validate(waitlistSignupSchema), waitlistController.signup);
waitlistRouter.post("/confirm", waitlistConfirmationLimiter, validate(waitlistConfirmationSchema), waitlistController.confirm);
waitlistRouter.post("/resend", waitlistResendLimiter, validate(waitlistEmailSchema), waitlistController.resend);

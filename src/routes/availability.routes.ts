import { Router } from "express";
import { availabilityController } from "../controllers/availability.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { upsertAvailabilitySchema } from "../validation/availability.schemas";

export const availabilityRouter = Router();

availabilityRouter.use(authenticate, requireBusiness);
availabilityRouter.get("/summary", availabilityController.summary);
availabilityRouter.get("/", availabilityController.get);
availabilityRouter.put("/", mutationLimiter, validate(upsertAvailabilitySchema), availabilityController.upsert);

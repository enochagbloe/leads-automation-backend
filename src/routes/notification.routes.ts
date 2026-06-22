import { Router } from "express";
import { notificationController } from "../controllers/notification.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness } from "../middleware/rbac";
import { validateQuery } from "../middleware/validate";
import { notificationListQuerySchema } from "../validation/notification.schemas";

export const notificationRouter = Router();

notificationRouter.use(authenticate, requireBusiness);
notificationRouter.get("/", validateQuery(notificationListQuerySchema), notificationController.list);
notificationRouter.get("/counts", notificationController.counts);
notificationRouter.patch("/:notificationId/read", mutationLimiter, notificationController.read);
notificationRouter.patch("/:notificationId/dismiss", mutationLimiter, notificationController.dismiss);
notificationRouter.patch("/:notificationId/actioned", mutationLimiter, notificationController.actioned);

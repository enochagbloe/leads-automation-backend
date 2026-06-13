import { Router } from "express";
import { serviceController } from "../controllers/service.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness } from "../middleware/rbac";
import { validate, validateQuery } from "../middleware/validate";
import {
  createServiceSchema,
  reorderServicesSchema,
  serviceListQuerySchema,
  updateServiceSchema,
} from "../validation/service.schemas";

export const serviceRouter = Router();

serviceRouter.use(authenticate, requireBusiness);
serviceRouter.get("/summary", serviceController.summary);
serviceRouter.patch("/reorder", mutationLimiter, validate(reorderServicesSchema), serviceController.reorder);
serviceRouter.get("/", validateQuery(serviceListQuerySchema), serviceController.list);
serviceRouter.post("/", mutationLimiter, validate(createServiceSchema), serviceController.create);
serviceRouter.get("/:serviceId", serviceController.detail);
serviceRouter.patch("/:serviceId", mutationLimiter, validate(updateServiceSchema), serviceController.update);
serviceRouter.delete("/:serviceId", mutationLimiter, serviceController.archive);
serviceRouter.post("/:serviceId/restore", mutationLimiter, serviceController.restore);

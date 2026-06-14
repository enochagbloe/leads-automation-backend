import { Router } from "express";
import { policyController } from "../controllers/policy.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness } from "../middleware/rbac";
import { validate, validateQuery } from "../middleware/validate";
import {
  createPolicySchema,
  policyListQuerySchema,
  reorderPoliciesSchema,
  updatePolicySchema,
} from "../validation/policy.schemas";

export const policyRouter = Router();

policyRouter.use(authenticate, requireBusiness);
policyRouter.get("/summary", policyController.summary);
policyRouter.patch("/reorder", mutationLimiter, validate(reorderPoliciesSchema), policyController.reorder);
policyRouter.get("/", validateQuery(policyListQuerySchema), policyController.list);
policyRouter.post("/", mutationLimiter, validate(createPolicySchema), policyController.create);
policyRouter.get("/:policyId", policyController.detail);
policyRouter.patch("/:policyId", mutationLimiter, validate(updatePolicySchema), policyController.update);
policyRouter.delete("/:policyId", mutationLimiter, policyController.archive);
policyRouter.post("/:policyId/restore", mutationLimiter, policyController.restore);

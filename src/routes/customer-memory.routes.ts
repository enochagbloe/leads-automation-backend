import { BusinessRole } from "@prisma/client";
import { Router } from "express";
import { customerMemoryController } from "../controllers/customer-memory.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness, requireRole } from "../middleware/rbac";
import { validate, validateParams, validateQuery } from "../middleware/validate";
import {
  correctCustomerMemorySchema,
  customerMemoryConversationParamsSchema,
  customerMemoryDetailQuerySchema,
  customerMemoryItemParamsSchema,
  customerMemoryParamsSchema,
} from "../validation/customer-memory.schemas";

export const customerMemoryRouter = Router();

customerMemoryRouter.use(authenticate, requireBusiness, requireRole(BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER));
customerMemoryRouter.get("/leads/:leadId", validateParams(customerMemoryParamsSchema), validateQuery(customerMemoryDetailQuerySchema), customerMemoryController.detail);
customerMemoryRouter.patch("/leads/:leadId/items/:memoryId", mutationLimiter, validateParams(customerMemoryItemParamsSchema), validate(correctCustomerMemorySchema), customerMemoryController.correct);
customerMemoryRouter.post("/leads/:leadId/items/:memoryId/archive", mutationLimiter, validateParams(customerMemoryItemParamsSchema), customerMemoryController.archiveItem);
customerMemoryRouter.delete("/leads/:leadId/items/:memoryId", mutationLimiter, validateParams(customerMemoryItemParamsSchema), customerMemoryController.deleteItem);
customerMemoryRouter.delete("/leads/:leadId/conversations/:conversationId", mutationLimiter, validateParams(customerMemoryConversationParamsSchema), customerMemoryController.deleteConversation);
customerMemoryRouter.post("/leads/:leadId/summary/regenerate", mutationLimiter, validateParams(customerMemoryParamsSchema), customerMemoryController.regenerateSummary);
customerMemoryRouter.delete("/leads/:leadId", mutationLimiter, validateParams(customerMemoryParamsSchema), customerMemoryController.deleteCustomer);

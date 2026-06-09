import { Router } from "express";
import { conversationController } from "../controllers/conversation.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness } from "../middleware/rbac";
import { validate, validateQuery } from "../middleware/validate";
import {
  assignConversationSchema,
  conversationDetailQuerySchema,
  conversationListQuerySchema,
  createConversationSchema,
  createMessageSchema,
  updateConversationStatusSchema,
  updateConversationWorkspaceSchema,
} from "../validation/conversation.schemas";

export const conversationRouter = Router();

conversationRouter.use(authenticate, requireBusiness);
conversationRouter.get("/stats", conversationController.stats);
conversationRouter.get("/", validateQuery(conversationListQuerySchema), conversationController.list);
conversationRouter.post("/", mutationLimiter, validate(createConversationSchema), conversationController.create);
conversationRouter.get("/:id", validateQuery(conversationDetailQuerySchema), conversationController.detail);
conversationRouter.post("/:id/messages", mutationLimiter, validate(createMessageSchema), conversationController.message);
conversationRouter.patch("/:id", mutationLimiter, validate(updateConversationWorkspaceSchema), conversationController.updateWorkspace);
conversationRouter.patch("/:id/assign", mutationLimiter, validate(assignConversationSchema), conversationController.assign);
conversationRouter.patch("/:id/status", mutationLimiter, validate(updateConversationStatusSchema), conversationController.updateStatus);
conversationRouter.patch("/:id/read", mutationLimiter, conversationController.markRead);
conversationRouter.delete("/:id", mutationLimiter, conversationController.remove);

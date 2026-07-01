import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { conversationService } from "../services/conversation.service";
import { knowledgeService } from "../services/knowledge.service";
import { messageService } from "../services/message.service";
import { requestMetadata } from "../utils/request";
import { ConversationDetailQuery, ConversationListQuery } from "../validation/conversation.schemas";

function actor(req: Request) {
  return {
    userId: req.auth!.userId,
    businessAccountId: req.auth!.businessAccountId!,
    businessId: req.auth!.businessId!,
    membershipId: req.auth!.membershipId!,
    role: req.auth!.role as BusinessRole,
  };
}

function conversationId(req: Request) {
  const value = req.params.id;
  return Array.isArray(value) ? value[0]! : value!;
}

function messageId(req: Request) {
  const value = req.params.messageId;
  return Array.isArray(value) ? value[0]! : value!;
}

export const conversationController = {
  create: async (req, res) => res.status(201).json(await conversationService.create(actor(req), req.body, requestMetadata(req))),
  list: async (req, res) => res.json(await conversationService.list(actor(req), res.locals.validatedQuery as ConversationListQuery)),
  stats: async (req, res) => res.json(await conversationService.stats(actor(req))),
  detail: async (req, res) => res.json(await conversationService.detail(actor(req), conversationId(req), res.locals.validatedQuery as ConversationDetailQuery)),
  message: async (req, res) => res.status(201).json(await messageService.createStaffMessage(actor(req), conversationId(req), req.body, requestMetadata(req))),
  sendKnowledge: async (req, res) => res.json(await knowledgeService.sendToConversation(actor(req), conversationId(req), req.body, requestMetadata(req))),
  retryMessage: async (req, res) => res.json(await messageService.retryWhatsAppMessage(actor(req), conversationId(req), messageId(req), requestMetadata(req))),
  updateWorkspace: async (req, res) => res.json(await conversationService.updateWorkspace(actor(req), conversationId(req), req.body)),
  assign: async (req, res) => res.json(await conversationService.assign(actor(req), conversationId(req), req.body.assignedStaffId, requestMetadata(req))),
  claim: async (req, res) => res.json(await conversationService.claim(actor(req), conversationId(req), requestMetadata(req))),
  updateStatus: async (req, res) => res.json(await conversationService.updateStatus(actor(req), conversationId(req), req.body.status, requestMetadata(req))),
  end: async (req, res) => res.json(await conversationService.end(actor(req), conversationId(req), requestMetadata(req))),
  markRead: async (req, res) => res.json(await conversationService.markRead(actor(req), conversationId(req), requestMetadata(req))),
  remove: async (req, res) => res.json(await conversationService.remove(actor(req), conversationId(req), requestMetadata(req))),
} satisfies Record<string, RequestHandler>;

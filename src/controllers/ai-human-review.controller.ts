import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { aiHumanReviewService } from "../services/ai-human-review.service";
import { requestMetadata } from "../utils/request";

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
  const value = req.params.conversationId;
  return Array.isArray(value) ? value[0]! : value!;
}

function reason(req: Request) {
  return typeof req.body?.reason === "string" ? req.body.reason : null;
}

export const aiHumanReviewController = {
  takeOver: async (req, res) => res.json(await aiHumanReviewService.takeOverConversation(actor(req), conversationId(req), reason(req), requestMetadata(req))),
  resumeAi: async (req, res) => res.json(await aiHumanReviewService.resumeAiConversation(actor(req), conversationId(req), reason(req), requestMetadata(req))),
} satisfies Record<string, RequestHandler>;

import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { aiReplyEngine } from "../services/ai-reply-engine.service";

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

export const aiController = {
  processLatest: async (req, res) => res.json(await aiReplyEngine.processLatestForActor(actor(req), conversationId(req))),
} satisfies Record<string, RequestHandler>;

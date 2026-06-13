import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { businessProfileService } from "../services/business-profile.service";
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

export const businessProfileController = {
  get: async (req, res) => res.json(await businessProfileService.get(actor(req))),
  update: async (req, res) => res.json(await businessProfileService.update(actor(req), req.body, requestMetadata(req))),
} satisfies Record<string, RequestHandler>;

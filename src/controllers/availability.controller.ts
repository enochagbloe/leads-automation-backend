import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { availabilityService } from "../services/availability.service";
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

export const availabilityController = {
  get: async (req, res) => res.json(await availabilityService.get(actor(req))),
  summary: async (req, res) => res.json(await availabilityService.summary(actor(req))),
  upsert: async (req, res) => res.json(await availabilityService.upsert(actor(req), req.body, requestMetadata(req))),
} satisfies Record<string, RequestHandler>;

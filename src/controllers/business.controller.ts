import { RequestHandler } from "express";
import { businessService } from "../services/business.service";
import { requestMetadata } from "../utils/request";

export const businessController = {
  listMine: async (req, res) => res.json(await businessService.listMemberships(req.auth!.userId)),
  create: async (req, res) => res.status(201).json(
    await businessService.create(req.auth!.userId, req.auth!.businessAccountId, req.body, requestMetadata(req)),
  ),
  inviteMember: async (req, res) => res.status(201).json(
    await businessService.inviteMember(req.auth!.businessId!, req.auth!.userId, req.body, requestMetadata(req)),
  ),
  acceptInvitation: async (req, res) => res.json(await businessService.acceptInvitation(req.body, requestMetadata(req))),
} satisfies Record<string, RequestHandler>;

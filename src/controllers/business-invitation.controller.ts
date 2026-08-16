import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { businessInvitationManagementService } from "../services/business-invitation-management.service";
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

function invitationId(req: Request) {
  const value = req.params.invitationId;
  return Array.isArray(value) ? value[0]! : value!;
}

export const businessInvitationController = {
  list: async (req, res) => res.json(await businessInvitationManagementService.list(actor(req))),
  create: async (req, res) => res.status(201).json(await businessInvitationManagementService.create(actor(req), req.body, requestMetadata(req))),
  revoke: async (req, res) => res.json(await businessInvitationManagementService.revoke(actor(req), invitationId(req), requestMetadata(req))),
} satisfies Record<string, RequestHandler>;

import { Request, RequestHandler } from "express";
import { businessService } from "../services/business.service";
import { businessInviteAcceptanceService } from "../services/business-invite-acceptance.service";
import { businessInvitationManagementService } from "../services/business-invitation-management.service";
import { requestMetadata } from "../utils/request";

function invitationActor(req: Request) {
  return {
    userId: req.auth!.userId,
    businessAccountId: req.auth!.businessAccountId!,
    businessId: req.auth!.businessId!,
    membershipId: req.auth!.membershipId!,
    role: req.auth!.role as import("@prisma/client").BusinessRole,
  };
}

export const businessController = {
  listMine: async (req, res) => res.json(await businessService.listMemberships(req.auth!.userId)),
  create: async (req, res) => res.status(201).json(
    await businessService.create(req.auth!.userId, req.auth!.businessAccountId, req.body, requestMetadata(req)),
  ),
  inviteMember: async (req, res) => res.status(201).json(
    await businessInvitationManagementService.create(invitationActor(req), req.body, requestMetadata(req)),
  ),
  acceptInvitation: async (req, res) => res.json(await businessInviteAcceptanceService.acceptLegacySignup({
    ...req.body,
    context: requestMetadata(req),
  })),
} satisfies Record<string, RequestHandler>;

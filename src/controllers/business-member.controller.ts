import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { businessMemberAccessService } from "../services/business-member-access.service";
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

function memberId(req: Request) {
  const value = req.params.memberId;
  return Array.isArray(value) ? value[0]! : value!;
}

export const businessMemberController = {
  list: async (req, res) => res.json(await businessMemberAccessService.listMembers(actor(req))),
  disable: async (req, res) => res.json(await businessMemberAccessService.disableMember(actor(req), memberId(req), req.body, requestMetadata(req))),
  restore: async (req, res) => res.json(await businessMemberAccessService.restoreDisabledMember(actor(req), memberId(req), requestMetadata(req))),
  remove: async (req, res) => res.json(await businessMemberAccessService.removeMember(actor(req), memberId(req), req.body, requestMetadata(req))),
  updateOperationalProfile: async (req, res) => res.json(await businessMemberAccessService.updateOperationalProfile(actor(req), memberId(req), req.body, requestMetadata(req))),
} satisfies Record<string, RequestHandler>;

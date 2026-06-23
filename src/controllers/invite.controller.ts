import { Request, RequestHandler } from "express";
import { businessInviteAcceptanceService } from "../services/business-invite-acceptance.service";
import { requestMetadata } from "../utils/request";

function inviteToken(req: Request) {
  const value = req.params.token;
  return Array.isArray(value) ? value[0]! : value!;
}

export const inviteController = {
  validate: async (req, res) => res.json(await businessInviteAcceptanceService.validateInviteToken(inviteToken(req), requestMetadata(req))),
  accept: async (req, res) => res.json(await businessInviteAcceptanceService.acceptInviteForExistingUser({
    token: inviteToken(req),
    actorUserId: req.auth!.userId,
    context: requestMetadata(req),
  })),
  signup: async (req, res) => res.status(201).json(await businessInviteAcceptanceService.signupAndAcceptInvite({
    token: inviteToken(req),
    name: req.body.name,
    password: req.body.password,
    context: requestMetadata(req),
  })),
} satisfies Record<string, RequestHandler>;

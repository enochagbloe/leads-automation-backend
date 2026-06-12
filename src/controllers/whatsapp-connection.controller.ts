import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { whatsappConnectionService } from "../services/whatsapp-connection.service";
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

export const whatsappConnectionController = {
  status: async (req, res) => res.json(await whatsappConnectionService.status(actor(req))),
  start: async (req, res) => res.status(201).json(await whatsappConnectionService.start(actor(req), req.body, requestMetadata(req))),
  complete: async (req, res) => res.status(201).json(await whatsappConnectionService.complete(actor(req), req.body, requestMetadata(req))),
  deactivate: async (req, res) => res.json(await whatsappConnectionService.deactivate(actor(req), req.body.reason, requestMetadata(req))),
  startChange: async (req, res) => res.json(await whatsappConnectionService.startChange(actor(req), requestMetadata(req))),
  health: async (req, res) => res.json(await whatsappConnectionService.health(actor(req))),
} satisfies Record<string, RequestHandler>;

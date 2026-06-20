import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { notificationService } from "../services/notification.service";
import { requestMetadata } from "../utils/request";
import { NotificationListQuery } from "../validation/notification.schemas";

function actor(req: Request) {
  return {
    userId: req.auth!.userId,
    businessAccountId: req.auth!.businessAccountId!,
    businessId: req.auth!.businessId!,
    membershipId: req.auth!.membershipId!,
    role: req.auth!.role as BusinessRole,
  };
}

function notificationId(req: Request) {
  const value = req.params.notificationId;
  return Array.isArray(value) ? value[0]! : value!;
}

export const notificationController = {
  list: async (req, res) => res.json(await notificationService.list(actor(req), res.locals.validatedQuery as NotificationListQuery)),
  counts: async (req, res) => res.json(await notificationService.counts(actor(req))),
  read: async (req, res) => res.json(await notificationService.markRead(actor(req), notificationId(req), requestMetadata(req))),
  dismiss: async (req, res) => res.json(await notificationService.dismiss(actor(req), notificationId(req), requestMetadata(req))),
  actioned: async (req, res) => res.json(await notificationService.markActioned(actor(req), notificationId(req), requestMetadata(req))),
} satisfies Record<string, RequestHandler>;

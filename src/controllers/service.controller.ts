import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { serviceService } from "../services/service.service";
import { requestMetadata } from "../utils/request";
import { ServiceListQuery } from "../validation/service.schemas";

function actor(req: Request) {
  return {
    userId: req.auth!.userId,
    businessAccountId: req.auth!.businessAccountId!,
    businessId: req.auth!.businessId!,
    membershipId: req.auth!.membershipId!,
    role: req.auth!.role as BusinessRole,
  };
}

function serviceId(req: Request) {
  const value = req.params.serviceId;
  return Array.isArray(value) ? value[0]! : value!;
}

export const serviceController = {
  list: async (req, res) => res.json(await serviceService.list(actor(req), res.locals.validatedQuery as ServiceListQuery)),
  summary: async (req, res) => res.json(await serviceService.summary(actor(req))),
  detail: async (req, res) => res.json(await serviceService.detail(actor(req), serviceId(req))),
  create: async (req, res) => res.status(201).json(await serviceService.create(actor(req), req.body, requestMetadata(req))),
  update: async (req, res) => res.json(await serviceService.update(actor(req), serviceId(req), req.body, requestMetadata(req))),
  archive: async (req, res) => res.json(await serviceService.archive(actor(req), serviceId(req), requestMetadata(req))),
  restore: async (req, res) => res.json(await serviceService.restore(actor(req), serviceId(req), requestMetadata(req))),
  reorder: async (req, res) => res.json(await serviceService.reorder(actor(req), req.body, requestMetadata(req))),
} satisfies Record<string, RequestHandler>;

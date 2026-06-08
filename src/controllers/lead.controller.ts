import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { leadService } from "../services/lead.service";
import { requestMetadata } from "../utils/request";
import { LeadListQuery } from "../validation/lead.schemas";

function actor(req: Request) {
  return {
    userId: req.auth!.userId,
    businessId: req.auth!.businessId!,
    membershipId: req.auth!.membershipId!,
    role: req.auth!.role as BusinessRole,
  };
}

function leadId(req: Request) {
  const value = req.params.id;
  return Array.isArray(value) ? value[0]! : value!;
}

export const leadController = {
  create: async (req, res) => res.status(201).json(await leadService.create(actor(req), req.body, requestMetadata(req))),
  list: async (req, res) => res.json(await leadService.list(actor(req), res.locals.validatedQuery as LeadListQuery)),
  stats: async (req, res) => res.json(await leadService.stats(actor(req))),
  detail: async (req, res) => res.json(await leadService.detail(actor(req), leadId(req))),
  update: async (req, res) => res.json(await leadService.update(actor(req), leadId(req), req.body, requestMetadata(req))),
  assign: async (req, res) => res.json(await leadService.assign(actor(req), leadId(req), req.body.assignedStaffId, requestMetadata(req))),
  updateStatus: async (req, res) => res.json(await leadService.updateStatus(actor(req), leadId(req), req.body.status, requestMetadata(req))),
  remove: async (req, res) => res.json(await leadService.remove(actor(req), leadId(req), requestMetadata(req))),
} satisfies Record<string, RequestHandler>;

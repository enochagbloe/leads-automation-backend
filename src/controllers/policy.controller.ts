import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { policyService } from "../services/policy.service";
import { requestMetadata } from "../utils/request";
import { PolicyListQuery } from "../validation/policy.schemas";

function actor(req: Request) {
  return {
    userId: req.auth!.userId,
    businessAccountId: req.auth!.businessAccountId!,
    businessId: req.auth!.businessId!,
    membershipId: req.auth!.membershipId!,
    role: req.auth!.role as BusinessRole,
  };
}

function policyId(req: Request) {
  const value = req.params.policyId;
  return Array.isArray(value) ? value[0]! : value!;
}

export const policyController = {
  list: async (req, res) => res.json(await policyService.list(actor(req), res.locals.validatedQuery as PolicyListQuery)),
  summary: async (req, res) => res.json(await policyService.summary(actor(req))),
  detail: async (req, res) => res.json(await policyService.detail(actor(req), policyId(req))),
  create: async (req, res) => res.status(201).json(await policyService.create(actor(req), req.body, requestMetadata(req))),
  update: async (req, res) => res.json(await policyService.update(actor(req), policyId(req), req.body, requestMetadata(req))),
  archive: async (req, res) => res.json(await policyService.archive(actor(req), policyId(req), requestMetadata(req))),
  restore: async (req, res) => res.json(await policyService.restore(actor(req), policyId(req), requestMetadata(req))),
  reorder: async (req, res) => res.json(await policyService.reorder(actor(req), req.body, requestMetadata(req))),
} satisfies Record<string, RequestHandler>;

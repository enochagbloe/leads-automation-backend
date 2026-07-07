import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler } from "express";
import { followUpCancellationService, followUpService } from "../services/follow-up.service";
import {
  FollowUpJobListQuery,
  FollowUpLogListQuery,
  FollowUpRuleListQuery,
} from "../validation/follow-up.schemas";

function actor(req: Request) {
  return {
    userId: req.auth!.userId,
    businessAccountId: req.auth!.businessAccountId!,
    businessId: req.auth!.businessId!,
    membershipId: req.auth!.membershipId!,
    role: req.auth!.role as BusinessRole,
  };
}

function param(req: Request, key: string) {
  const value = req.params[key];
  return Array.isArray(value) ? value[0]! : value!;
}

export const followUpController = {
  settings: async (req, res) => res.json(await followUpService.getSettings(actor(req))),
  updateSettings: async (req, res) => res.json(await followUpService.updateSettings(actor(req), req.body)),
  listRules: async (req, res) => res.json(await followUpService.listRules(actor(req), res.locals.validatedQuery as FollowUpRuleListQuery)),
  getRule: async (req, res) => res.json(await followUpService.getRule(actor(req), param(req, "ruleId"))),
  createRule: async (req, res) => res.status(201).json(await followUpService.createRule(actor(req), req.body)),
  updateRule: async (req, res) => res.json(await followUpService.updateRule(actor(req), param(req, "ruleId"), req.body)),
  deleteRule: async (req, res) => res.json(await followUpService.deleteRule(actor(req), param(req, "ruleId"))),
  listJobs: async (req, res) => res.json(await followUpService.listJobs(actor(req), res.locals.validatedQuery as FollowUpJobListQuery)),
  getJob: async (req, res) => res.json(await followUpService.getJob(actor(req), param(req, "jobId"))),
  cancelJob: async (req, res) => res.json(await followUpCancellationService.cancelJob(actor(req), param(req, "jobId"), req.body.reason)),
  listLogs: async (req, res) => res.json(await followUpService.listLogs(actor(req), res.locals.validatedQuery as FollowUpLogListQuery)),
  getLog: async (req, res) => res.json(await followUpService.getLog(actor(req), param(req, "logId"))),
  testTrigger: async (req, res) => res.status(201).json(await followUpService.testTrigger(actor(req), req.body)),
} satisfies Record<string, RequestHandler>;

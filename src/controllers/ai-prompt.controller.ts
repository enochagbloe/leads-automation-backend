import { BusinessRole } from "@prisma/client";
import { Request, RequestHandler, Response } from "express";
import { aiPromptManagementService } from "../services/ai-prompt/core/ai-prompt-management.service";
import { aiPromptPreviewService } from "../services/ai-prompt/preview/ai-prompt-preview.service";
import {
  AiPromptDraftAutosaveInput,
  AiPromptDraftConflictResolutionInput,
  AiPromptListQuery,
  AiPromptPreviewInput,
  AiPromptScopeParam,
  AiPromptVersionListQuery,
} from "../validation/ai-prompt.schemas";

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

function scopeParam(res: Response) {
  return (res.locals.validatedParams as AiPromptScopeParam).scope;
}

export const aiPromptController = {
  list: async (req, res) => res.json(await aiPromptManagementService.list(actor(req), res.locals.validatedQuery as AiPromptListQuery)),
  get: async (req, res) => res.json(await aiPromptManagementService.get(actor(req), param(req, "configurationId"))),
  createDraft: async (req, res) => res.status(201).json(await aiPromptManagementService.createDraft(actor(req), req.body)),
  createVersion: async (req, res) => res.status(201).json(await aiPromptManagementService.createVersion(actor(req), param(req, "configurationId"), req.body)),
  updateDraft: async (req, res) => res.json(await aiPromptManagementService.updateDraft(actor(req), param(req, "versionId"), req.body)),
  autosaveDraft: async (req, res) => res.json(await aiPromptManagementService.autosaveDraft(actor(req), param(req, "versionId"), req.body as AiPromptDraftAutosaveInput)),
  resolveDraftConflict: async (req, res) => res.json(await aiPromptManagementService.resolveDraftConflict(actor(req), param(req, "versionId"), req.body as AiPromptDraftConflictResolutionInput)),
  validateVersion: async (req, res) => res.json(await aiPromptManagementService.validateVersion(actor(req), param(req, "versionId"))),
  activate: async (req, res) => res.json(await aiPromptManagementService.activate(actor(req), param(req, "versionId"))),
  deactivate: async (req, res) => res.json(await aiPromptManagementService.deactivate(actor(req), param(req, "configurationId"))),
  archive: async (req, res) => res.json(await aiPromptManagementService.archive(actor(req), param(req, "configurationId"))),
  listVersions: async (req, res) => res.json(await aiPromptManagementService.listVersions(actor(req), param(req, "configurationId"), res.locals.validatedQuery as AiPromptVersionListQuery)),
  availableScopes: async (req, res) => res.json(await aiPromptManagementService.availableScopes(actor(req))),
  capabilities: async (req, res) => res.json(await aiPromptManagementService.capabilities(actor(req), scopeParam(res))),
  preview: async (req, res) => res.json(await aiPromptPreviewService.preview(actor(req), scopeParam(res), req.body as AiPromptPreviewInput)),
} satisfies Record<string, RequestHandler>;

import { Router } from "express";
import { aiPromptController } from "../controllers/ai-prompt.controller";
import { authenticate } from "../middleware/auth";
import { aiPromptAutosaveLimiter, mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness } from "../middleware/rbac";
import { validate, validateParams, validateQuery } from "../middleware/validate";
import {
  aiPromptCreateDraftSchema,
  aiPromptCreateVersionSchema,
  aiPromptDraftAutosaveSchema,
  aiPromptDraftConflictResolutionSchema,
  aiPromptListQuerySchema,
  aiPromptPreviewSchema,
  aiPromptScopeParamSchema,
  aiPromptUpdateDraftSchema,
  aiPromptVersionListQuerySchema,
} from "../validation/ai-prompt.schemas";

export const aiPromptRouter = Router();

aiPromptRouter.use(authenticate, requireBusiness);

aiPromptRouter.get("/scopes", aiPromptController.availableScopes);
aiPromptRouter.get("/capabilities/:scope", validateParams(aiPromptScopeParamSchema), aiPromptController.capabilities);
aiPromptRouter.post("/preview/:scope", mutationLimiter, validateParams(aiPromptScopeParamSchema), validate(aiPromptPreviewSchema), aiPromptController.preview);

aiPromptRouter.get("/", validateQuery(aiPromptListQuerySchema), aiPromptController.list);
aiPromptRouter.post("/", mutationLimiter, validate(aiPromptCreateDraftSchema), aiPromptController.createDraft);
aiPromptRouter.get("/:configurationId", aiPromptController.get);
aiPromptRouter.post("/:configurationId/versions", mutationLimiter, validate(aiPromptCreateVersionSchema), aiPromptController.createVersion);
aiPromptRouter.get("/:configurationId/versions", validateQuery(aiPromptVersionListQuerySchema), aiPromptController.listVersions);
aiPromptRouter.patch("/versions/:versionId", mutationLimiter, validate(aiPromptUpdateDraftSchema), aiPromptController.updateDraft);
aiPromptRouter.patch("/versions/:versionId/autosave", aiPromptAutosaveLimiter, validate(aiPromptDraftAutosaveSchema), aiPromptController.autosaveDraft);
aiPromptRouter.post("/versions/:versionId/resolve-conflict", mutationLimiter, validate(aiPromptDraftConflictResolutionSchema), aiPromptController.resolveDraftConflict);
aiPromptRouter.post("/versions/:versionId/validate", mutationLimiter, aiPromptController.validateVersion);
aiPromptRouter.post("/versions/:versionId/activate", mutationLimiter, aiPromptController.activate);
aiPromptRouter.post("/:configurationId/deactivate", mutationLimiter, aiPromptController.deactivate);
aiPromptRouter.post("/:configurationId/archive", mutationLimiter, aiPromptController.archive);

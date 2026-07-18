import { AiPromptScope, AiPromptStatus, AuditAction, BusinessRole, Prisma } from "@prisma/client";
import { prisma } from "../../../config/prisma";
import { auditService } from "../../audit.service";
import { realtimeService } from "../../realtime.service";
import { subscriptionService } from "../../subscription.service";
import { AppError } from "../../../utils/errors";
import {
  AiPromptCreateDraftInput,
  AiPromptCreateVersionInput,
  AiPromptDraftAutosaveInput,
  AiPromptDraftConflictResolutionInput,
  AiPromptListQuery,
  AiPromptUpdateDraftInput,
  AiPromptVersionListQuery,
} from "../../../validation/ai-prompt.schemas";
import { aiPromptCapabilityService } from "../capability/ai-prompt-capability.service";
import { AI_PROMPT_COMPILER_VERSION, AiPromptActor, AiPromptValidationResult } from "./ai-prompt.types";
import { aiPromptValidationService } from "../validation/ai-prompt-validation.service";

const ACTIVE_KEY = "ACTIVE";
const VALIDATION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_VERSIONS_PER_CONFIGURATION = 100;

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function assertCanManagePrompts(actor: AiPromptActor) {
  if (actor.role !== BusinessRole.BUSINESS_OWNER && actor.role !== BusinessRole.MANAGER) {
    throw new AppError(403, "You do not have permission to manage AI prompts.", "FORBIDDEN");
  }
}

export function assertCanReadAiPrompts(actor: AiPromptActor) {
  if (actor.role !== BusinessRole.BUSINESS_OWNER && actor.role !== BusinessRole.MANAGER) {
    throw new AppError(403, "You do not have permission to view AI prompt configuration.", "FORBIDDEN");
  }
}

async function currentPlan(actor: AiPromptActor) {
  const subscription = await subscriptionService.getCurrentRecord(actor.businessAccountId);
  return subscription.plan.code;
}

function validationData(result: AiPromptValidationResult) {
  return {
    compiled: json(result.compiled),
    validationResult: json({ valid: result.valid, issues: result.issues }),
    unsupportedIssues: json(result.unsupportedIssues),
    safetyIssues: json(result.safetyIssues),
    capabilityIssues: json(result.capabilityIssues),
    conflictIssues: json(result.conflictIssues),
    compilerVersion: result.compiled.compilerVersion,
    validationFailureCode: null,
    validationFailureAt: null,
  };
}

function clearValidationData() {
  return {
    status: AiPromptStatus.DRAFT,
    compiled: Prisma.JsonNull,
    validationResult: Prisma.JsonNull,
    unsupportedIssues: Prisma.JsonNull,
    safetyIssues: Prisma.JsonNull,
    capabilityIssues: Prisma.JsonNull,
    conflictIssues: Prisma.JsonNull,
    compilerVersion: null,
    validatedAt: null,
    validatedRevision: null,
    validationFailureCode: null,
    validationFailureAt: null,
  };
}

function errorCode(error: unknown) {
  return error instanceof AppError ? error.code : error instanceof Error && error.name ? error.name : "AI_PROMPT_VALIDATION_FAILED";
}

async function recoverStaleValidations(businessId: string) {
  const cutoff = new Date(Date.now() - VALIDATION_TIMEOUT_MS);
  await prisma.aiPromptVersion.updateMany({
    where: {
      businessId,
      status: AiPromptStatus.VALIDATING,
      updatedAt: { lt: cutoff },
      archivedAt: null,
    },
    data: {
      ...clearValidationData(),
      status: AiPromptStatus.INVALID,
      validationFailureCode: "STALE_VALIDATION_RECOVERED",
      validationFailureAt: new Date(),
      validationResult: json({
        valid: false,
        issues: [{
          code: "STALE_VALIDATION_RECOVERED",
          message: "Prompt validation did not complete and was recovered. Validate again.",
          severity: "ERROR",
          source: "MODULE",
        }],
      }),
    },
  });
}

async function lockPromptScope(tx: Prisma.TransactionClient, businessId: string, scope: AiPromptScope) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${businessId}), hashtext(${scope}))`;
}

function versionLimitError(currentVersionCount: number) {
  return new AppError(
    403,
    `This prompt configuration has reached the ${MAX_VERSIONS_PER_CONFIGURATION} version limit.`,
    "AI_PROMPT_VERSION_LIMIT_REACHED",
    { currentVersionCount, versionLimit: MAX_VERSIONS_PER_CONFIGURATION },
  );
}

async function assertVersionLimitAvailable(tx: Prisma.TransactionClient, businessId: string, configurationId: string) {
  const versionCount = await tx.aiPromptVersion.count({
    where: { configurationId, businessId },
  });
  if (versionCount >= MAX_VERSIONS_PER_CONFIGURATION) throw versionLimitError(versionCount);
}

async function publish(type: Parameters<typeof realtimeService.publish>[0]["type"], businessId: string, payload: Record<string, unknown>) {
  realtimeService.publish({
    type,
    businessId,
    payload,
    roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
  });
}

async function audit(actor: AiPromptActor, action: AuditAction, metadata: Record<string, unknown>) {
  await auditService.log({
    action,
    businessId: actor.businessId,
    userId: actor.userId,
    actorMembershipId: actor.membershipId,
    metadata: json(metadata),
  });
}

async function getConfigForActor(actor: AiPromptActor, configurationId: string) {
  const config = await prisma.aiPromptConfiguration.findFirst({
    where: { id: configurationId, businessId: actor.businessId },
  });
  if (!config) throw new AppError(404, "AI prompt configuration not found.", "AI_PROMPT_NOT_FOUND");
  return config;
}

async function getVersionForActor(actor: AiPromptActor, versionId: string) {
  const version = await prisma.aiPromptVersion.findFirst({
    where: { id: versionId, businessId: actor.businessId },
  });
  if (!version) throw new AppError(404, "AI prompt version not found.", "AI_PROMPT_VERSION_NOT_FOUND");
  return version;
}

async function assertBusinessContext(actor: AiPromptActor) {
  const business = await prisma.business.findFirst({
    where: {
      id: actor.businessId,
      businessAccountId: actor.businessAccountId,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!business) {
    throw new AppError(404, "Business prompt context not found.", "AI_PROMPT_BUSINESS_CONTEXT_NOT_FOUND");
  }
}

function assertEditableVersion(version: { status: AiPromptStatus; archivedAt: Date | null }) {
  if (version.archivedAt || version.status === AiPromptStatus.ARCHIVED) {
    throw new AppError(409, "Archived prompt versions cannot be edited.", "AI_PROMPT_VERSION_ARCHIVED");
  }
  if (version.status !== AiPromptStatus.DRAFT && version.status !== AiPromptStatus.INVALID) {
    throw new AppError(409, "Only draft or invalid prompt versions can be edited.", "AI_PROMPT_VERSION_NOT_EDITABLE", {
      status: version.status,
    });
  }
}

async function assertPromptTextAllowed(actor: AiPromptActor, scope: AiPromptScope, promptText: string) {
  const plan = await currentPlan(actor);
  const capabilities = aiPromptCapabilityService.forPlan(plan, scope);
  if (!capabilities.implemented || !capabilities.canActivate) {
    throw new AppError(403, "This prompt scope is not available on your current plan.", capabilities.implemented ? "PLAN_UPGRADE_REQUIRED" : "AI_PROMPT_SCOPE_NOT_IMPLEMENTED", {
      scope,
      plan,
    });
  }
  if (!promptText.trim()) {
    throw new AppError(422, "Prompt instructions cannot be empty.", "PROMPT_EMPTY");
  }
  if (promptText.length > capabilities.maxPromptLength) {
    throw new AppError(422, `Prompt instructions must be ${capabilities.maxPromptLength} characters or fewer.`, "AI_PROMPT_TOO_LONG", {
      maxPromptLength: capabilities.maxPromptLength,
    });
  }
}

function draftConflict(version: {
  id: string;
  revision: number;
  updatedAt: Date;
  promptText: string;
  changeSummary: string | null;
}, baseRevision: number) {
  return new AppError(
    409,
    "This prompt was changed elsewhere. Review the latest server draft before replacing it.",
    "AI_PROMPT_DRAFT_CONFLICT",
    {
      versionId: version.id,
      clientBaseRevision: baseRevision,
      serverRevision: version.revision,
      serverUpdatedAt: version.updatedAt.toISOString(),
      serverPromptText: version.promptText,
      serverChangeSummary: version.changeSummary,
    },
  );
}

function autosaveResponse(input: {
  duplicate: boolean;
  clientMutationId: string;
  appliedRevision: number;
  version: {
    id: string;
    configurationId: string;
    scope: AiPromptScope;
    status: AiPromptStatus;
    revision: number;
    promptText: string;
    changeSummary: string | null;
    updatedAt: Date | string;
  };
}) {
  return {
    saved: true,
    duplicate: input.duplicate,
    version: {
      ...input.version,
      updatedAt: input.version.updatedAt instanceof Date ? input.version.updatedAt.toISOString() : input.version.updatedAt,
    },
    sync: {
      clientMutationId: input.clientMutationId,
      appliedRevision: input.appliedRevision,
    },
  };
}

function mutationResultSnapshot(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.saved !== true || !snapshot.version || !snapshot.sync) return null;
  return snapshot;
}

function legacyMutationResponse(input: {
  duplicate: boolean;
  clientMutationId: string;
  appliedRevision: number;
  version: {
    id: string;
    configurationId: string;
    scope: AiPromptScope;
    status: AiPromptStatus;
    revision: number;
    promptText: string;
    changeSummary: string | null;
    updatedAt: Date | string;
  };
}) {
  return autosaveResponse(input);
}

function validationResultIsValid(value: Prisma.JsonValue | null) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && "valid" in value
    && value.valid === true,
  );
}

export const aiPromptManagementService = {
  async list(actor: AiPromptActor, query: AiPromptListQuery) {
    assertCanReadAiPrompts(actor);
    const where: Prisma.AiPromptConfigurationWhereInput = {
      businessId: actor.businessId,
      ...(query.scope ? { scope: query.scope } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(!query.includeArchived ? { archivedAt: null } : {}),
    };
    const [data, total] = await prisma.$transaction([
      prisma.aiPromptConfiguration.findMany({
        where,
        include: { activeVersion: true, versions: { orderBy: { versionNumber: "desc" }, take: 1 } },
        orderBy: [{ scope: "asc" }, { updatedAt: "desc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.aiPromptConfiguration.count({ where }),
    ]);
    return { data, total, page: query.page, limit: query.limit };
  },

  async get(actor: AiPromptActor, configurationId: string) {
    assertCanReadAiPrompts(actor);
    return prisma.aiPromptConfiguration.findFirstOrThrow({
      where: { id: configurationId, businessId: actor.businessId },
      include: {
        activeVersion: true,
        versions: { orderBy: { versionNumber: "desc" }, take: 5 },
      },
    }).catch(() => {
      throw new AppError(404, "AI prompt configuration not found.", "AI_PROMPT_NOT_FOUND");
    });
  },

  async createDraft(actor: AiPromptActor, input: AiPromptCreateDraftInput) {
    assertCanManagePrompts(actor);
    await assertBusinessContext(actor);
    await assertPromptTextAllowed(actor, input.scope, input.promptText);

    const result = await prisma.$transaction(async (tx) => {
      await lockPromptScope(tx, actor.businessId, input.scope);
      const existing = await tx.aiPromptConfiguration.findUnique({
        where: { businessId_scope: { businessId: actor.businessId, scope: input.scope } },
        select: { id: true, archivedAt: true },
      });
      if (existing && !existing.archivedAt) {
        throw new AppError(409, "A prompt configuration already exists for this scope. Create a new version instead.", "AI_PROMPT_SCOPE_ALREADY_EXISTS", {
          configurationId: existing.id,
        });
      }

      const config = existing
        ? await (async () => {
          await assertVersionLimitAvailable(tx, actor.businessId, existing.id);
          return tx.aiPromptConfiguration.update({
            where: { id: existing.id },
            data: {
              name: input.name,
              description: input.description ?? null,
              status: AiPromptStatus.DRAFT,
              archivedAt: null,
              updatedByMembershipId: actor.membershipId,
              latestVersionNumber: { increment: 1 },
            },
          });
        })()
        : await tx.aiPromptConfiguration.create({
          data: {
            businessId: actor.businessId,
            scope: input.scope,
            name: input.name,
            description: input.description ?? null,
            status: AiPromptStatus.DRAFT,
            createdByMembershipId: actor.membershipId,
            latestVersionNumber: 1,
          },
        });

      const versionNumber = existing ? config.latestVersionNumber : 1;
      const version = await tx.aiPromptVersion.create({
        data: {
          businessId: actor.businessId,
          configurationId: config.id,
          scope: input.scope,
          versionNumber,
          promptText: input.promptText,
          changeSummary: input.changeSummary ?? null,
          status: AiPromptStatus.DRAFT,
          createdByMembershipId: actor.membershipId,
        },
      });
      return { config, version };
    });

    await audit(actor, AuditAction.AI_PROMPT_CREATED, { configurationId: result.config.id, versionId: result.version.id, scope: input.scope });
    await publish("business.ai_prompt.created", actor.businessId, { configurationId: result.config.id, versionId: result.version.id, scope: input.scope });
    return result;
  },

  async createVersion(actor: AiPromptActor, configurationId: string, input: AiPromptCreateVersionInput) {
    assertCanManagePrompts(actor);
    await assertBusinessContext(actor);
    const config = await getConfigForActor(actor, configurationId);
    if (config.archivedAt) throw new AppError(409, "Archived prompt configurations cannot be edited.", "AI_PROMPT_ARCHIVED");
    await assertPromptTextAllowed(actor, config.scope, input.promptText);
    const version = await prisma.$transaction(async (tx) => {
      await lockPromptScope(tx, actor.businessId, config.scope);
      await assertVersionLimitAvailable(tx, actor.businessId, config.id);
      const currentConfig = await tx.aiPromptConfiguration.findFirst({
        where: { id: config.id, businessId: actor.businessId, archivedAt: null },
      });
      if (!currentConfig) throw new AppError(409, "Archived prompt configurations cannot be edited.", "AI_PROMPT_ARCHIVED");
      const updated = await tx.aiPromptConfiguration.update({
        where: { id: currentConfig.id },
        data: { latestVersionNumber: { increment: 1 }, status: currentConfig.activeVersionId ? currentConfig.status : AiPromptStatus.DRAFT, updatedByMembershipId: actor.membershipId },
      });
      return tx.aiPromptVersion.create({
        data: {
          businessId: actor.businessId,
          configurationId: currentConfig.id,
          scope: currentConfig.scope,
          versionNumber: updated.latestVersionNumber,
          previousVersionId: currentConfig.activeVersionId,
          promptText: input.promptText,
          changeSummary: input.changeSummary ?? null,
          createdByMembershipId: actor.membershipId,
        },
      });
    });
    await audit(actor, AuditAction.AI_PROMPT_VERSION_CREATED, { configurationId: config.id, versionId: version.id, scope: config.scope });
    await publish("business.ai_prompt.updated", actor.businessId, { configurationId: config.id, versionId: version.id, scope: config.scope });
    return version;
  },

  async updateDraft(actor: AiPromptActor, versionId: string, input: AiPromptUpdateDraftInput) {
    assertCanManagePrompts(actor);
    await assertBusinessContext(actor);
    const version = await getVersionForActor(actor, versionId);
    assertEditableVersion(version);
    if (input.promptText !== undefined) {
      if (input.baseRevision === undefined) {
        throw new AppError(422, "baseRevision is required when updating prompt text.", "AI_PROMPT_BASE_REVISION_REQUIRED");
      }
      await assertPromptTextAllowed(actor, version.scope, input.promptText);
    }
    const baseRevision = input.promptText !== undefined ? input.baseRevision : undefined;
    const data: Prisma.AiPromptVersionUpdateInput = {
      ...(input.promptText !== undefined ? {
        promptText: input.promptText,
        revision: { increment: 1 },
        ...clearValidationData(),
      } : {}),
      ...(input.changeSummary !== undefined ? { changeSummary: input.changeSummary } : {}),
    };
    const updated = await prisma.$transaction(async (tx) => {
      if (input.name !== undefined || input.description !== undefined) {
        await tx.aiPromptConfiguration.update({
          where: { id: version.configurationId },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            updatedByMembershipId: actor.membershipId,
          },
        });
      }
      const changed = await tx.aiPromptVersion.updateMany({
        where: {
          id: version.id,
          businessId: actor.businessId,
          configuration: { archivedAt: null },
          status: version.status,
          ...(input.promptText !== undefined ? { revision: baseRevision } : { updatedAt: version.updatedAt }),
          archivedAt: null,
        },
        data,
      });
      if (changed.count !== 1) {
        const latest = await tx.aiPromptVersion.findFirst({
          where: { id: version.id, businessId: actor.businessId },
          select: { id: true, revision: true, updatedAt: true, promptText: true, changeSummary: true, status: true, archivedAt: true },
        });
        if (!latest) throw new AppError(404, "AI prompt version not found.", "AI_PROMPT_VERSION_NOT_FOUND");
        if (latest.archivedAt || latest.status === AiPromptStatus.ARCHIVED) {
          throw new AppError(409, "Archived prompt versions cannot be edited.", "AI_PROMPT_VERSION_ARCHIVED");
        }
        if (latest.status !== AiPromptStatus.DRAFT && latest.status !== AiPromptStatus.INVALID) {
          throw new AppError(409, "Only draft or invalid prompt versions can be edited.", "AI_PROMPT_VERSION_NOT_EDITABLE", { status: latest.status });
        }
        if (input.promptText !== undefined && baseRevision !== undefined && latest.revision !== baseRevision) {
          throw draftConflict(latest, baseRevision);
        }
        throw new AppError(
          409,
          "Prompt version changed. Refresh and edit the latest draft again.",
          "AI_PROMPT_VERSION_CHANGED",
        );
      }
      return tx.aiPromptVersion.findUniqueOrThrow({ where: { id: version.id } });
    });
    await audit(actor, AuditAction.AI_PROMPT_UPDATED, { configurationId: version.configurationId, versionId: version.id, scope: version.scope });
    await publish("business.ai_prompt.updated", actor.businessId, { configurationId: version.configurationId, versionId: version.id, scope: version.scope });
    return updated;
  },

  async autosaveDraft(actor: AiPromptActor, versionId: string, input: AiPromptDraftAutosaveInput) {
    assertCanManagePrompts(actor);
    await assertBusinessContext(actor);
    const duplicate = await prisma.aiPromptDraftMutation.findUnique({
      where: { businessId_clientMutationId: { businessId: actor.businessId, clientMutationId: input.clientMutationId } },
      include: {
        version: {
          select: {
            id: true,
            configurationId: true,
            scope: true,
            status: true,
            revision: true,
            promptText: true,
            changeSummary: true,
            updatedAt: true,
          },
        },
      },
    });
    if (duplicate) {
      if (duplicate.versionId !== versionId) {
        throw new AppError(409, "This client mutation ID was already used for another prompt version.", "AI_PROMPT_MUTATION_ID_REUSED", {
          clientMutationId: input.clientMutationId,
          existingVersionId: duplicate.versionId,
        });
      }
      await audit(actor, AuditAction.AI_PROMPT_DRAFT_SYNC_DUPLICATE, {
        versionId,
        clientMutationId: input.clientMutationId,
        appliedRevision: duplicate.appliedRevision,
      });
      const snapshot = mutationResultSnapshot(duplicate.resultSnapshot);
      if (snapshot) return snapshot;
      return legacyMutationResponse({
        duplicate: true,
        clientMutationId: input.clientMutationId,
        appliedRevision: duplicate.appliedRevision,
        version: duplicate.version,
      });
    }

    const version = await getVersionForActor(actor, versionId);
    assertEditableVersion(version);
    await assertPromptTextAllowed(actor, version.scope, input.promptText);

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${actor.businessId}), hashtext(${input.clientMutationId}))`;
      const replay = await tx.aiPromptDraftMutation.findUnique({
        where: { businessId_clientMutationId: { businessId: actor.businessId, clientMutationId: input.clientMutationId } },
        include: {
          version: {
            select: {
              id: true,
              configurationId: true,
              scope: true,
              status: true,
              revision: true,
              promptText: true,
              changeSummary: true,
              updatedAt: true,
            },
          },
        },
      });
      if (replay) {
        if (replay.versionId !== versionId) {
          throw new AppError(409, "This client mutation ID was already used for another prompt version.", "AI_PROMPT_MUTATION_ID_REUSED", {
            clientMutationId: input.clientMutationId,
            existingVersionId: replay.versionId,
          });
        }
        const snapshot = mutationResultSnapshot(replay.resultSnapshot);
        return { updated: replay.version, mutation: replay, previousRevision: input.baseRevision, duplicate: true, responseSnapshot: snapshot };
      }
      const changed = await tx.aiPromptVersion.updateMany({
        where: {
          id: version.id,
          businessId: actor.businessId,
          configurationId: version.configurationId,
          configuration: { archivedAt: null },
          revision: input.baseRevision,
          status: { in: [AiPromptStatus.DRAFT, AiPromptStatus.INVALID] },
          archivedAt: null,
        },
        data: {
          promptText: input.promptText,
          ...(input.changeSummary !== undefined ? { changeSummary: input.changeSummary } : {}),
          revision: { increment: 1 },
          ...clearValidationData(),
        },
      });
      if (changed.count !== 1) {
        const latest = await tx.aiPromptVersion.findFirst({
          where: { id: version.id, businessId: actor.businessId },
          select: { id: true, revision: true, updatedAt: true, promptText: true, changeSummary: true, status: true, archivedAt: true },
        });
        if (!latest) throw new AppError(404, "AI prompt version not found.", "AI_PROMPT_VERSION_NOT_FOUND");
        if (latest.archivedAt || latest.status === AiPromptStatus.ARCHIVED) {
          throw new AppError(409, "Archived prompt versions cannot be edited.", "AI_PROMPT_VERSION_ARCHIVED");
        }
        if (latest.status !== AiPromptStatus.DRAFT && latest.status !== AiPromptStatus.INVALID) {
          throw new AppError(409, "Only draft or invalid prompt versions can be edited.", "AI_PROMPT_VERSION_NOT_EDITABLE", { status: latest.status });
        }
        if (latest.revision !== input.baseRevision) throw draftConflict(latest, input.baseRevision);
        throw new AppError(409, "Prompt version changed. Refresh and edit the latest draft again.", "AI_PROMPT_VERSION_CHANGED");
      }
      const updated = await tx.aiPromptVersion.findUniqueOrThrow({
        where: { id: version.id },
        select: {
          id: true,
          configurationId: true,
          scope: true,
          status: true,
          revision: true,
          promptText: true,
          changeSummary: true,
          updatedAt: true,
        },
      });
      const responseSnapshot = autosaveResponse({
        duplicate: false,
        clientMutationId: input.clientMutationId,
        appliedRevision: updated.revision,
        version: updated,
      });
      const mutation = await tx.aiPromptDraftMutation.create({
        data: {
          businessId: actor.businessId,
          versionId: version.id,
          clientMutationId: input.clientMutationId,
          clientUpdatedAt: input.clientUpdatedAt,
          appliedRevision: updated.revision,
          resultSnapshot: json(responseSnapshot),
        },
      });
      await tx.aiPromptConfiguration.update({
        where: { id: version.configurationId },
        data: { updatedByMembershipId: actor.membershipId },
      });
      return { updated, mutation, previousRevision: input.baseRevision, duplicate: false, responseSnapshot };
    }).catch(async (error) => {
      if (error instanceof AppError && error.code === "AI_PROMPT_DRAFT_CONFLICT") {
        await audit(actor, AuditAction.AI_PROMPT_DRAFT_CONFLICT_DETECTED, {
          versionId,
          clientMutationId: input.clientMutationId,
          clientUpdatedAt: input.clientUpdatedAt.toISOString(),
          clientBaseRevision: input.baseRevision,
          serverRevision: error.context?.serverRevision,
        });
      }
      throw error;
    });

    if (result.duplicate) {
      await audit(actor, AuditAction.AI_PROMPT_DRAFT_SYNC_DUPLICATE, {
        versionId,
        clientMutationId: input.clientMutationId,
        appliedRevision: result.mutation.appliedRevision,
      });
      if (result.responseSnapshot) return result.responseSnapshot;
    } else {
      await audit(actor, AuditAction.AI_PROMPT_DRAFT_AUTOSAVED, {
        configurationId: result.updated.configurationId,
        versionId: result.updated.id,
        scope: result.updated.scope,
        previousRevision: result.previousRevision,
        newRevision: result.updated.revision,
        clientMutationId: input.clientMutationId,
        clientUpdatedAt: input.clientUpdatedAt.toISOString(),
      });
      await publish("business.ai_prompt.draft.saved", actor.businessId, {
        configurationId: result.updated.configurationId,
        versionId: result.updated.id,
        scope: result.updated.scope,
        revision: result.updated.revision,
        updatedAt: result.updated.updatedAt,
        updatedByMembershipId: actor.membershipId,
      });
    }
    return result.responseSnapshot ?? legacyMutationResponse({
      duplicate: result.duplicate,
      clientMutationId: result.mutation.clientMutationId,
      appliedRevision: result.mutation.appliedRevision,
      version: result.updated,
    });
  },

  async resolveDraftConflict(actor: AiPromptActor, versionId: string, input: AiPromptDraftConflictResolutionInput) {
    assertCanManagePrompts(actor);
    await assertBusinessContext(actor);
    if (input.resolution !== "REPLACE_SERVER_DRAFT") {
      throw new AppError(422, "Unsupported conflict resolution.", "AI_PROMPT_DRAFT_CONFLICT_RESOLUTION_UNSUPPORTED");
    }
    const duplicate = await prisma.aiPromptDraftMutation.findUnique({
      where: { businessId_clientMutationId: { businessId: actor.businessId, clientMutationId: input.clientMutationId } },
      include: {
        version: {
          select: {
            id: true,
            configurationId: true,
            scope: true,
            status: true,
            revision: true,
            promptText: true,
            changeSummary: true,
            updatedAt: true,
          },
        },
      },
    });
    if (duplicate) {
      if (duplicate.versionId !== versionId) {
        throw new AppError(409, "This client mutation ID was already used for another prompt version.", "AI_PROMPT_MUTATION_ID_REUSED", {
          clientMutationId: input.clientMutationId,
          existingVersionId: duplicate.versionId,
        });
      }
      await audit(actor, AuditAction.AI_PROMPT_DRAFT_SYNC_DUPLICATE, {
        versionId,
        clientMutationId: input.clientMutationId,
        appliedRevision: duplicate.appliedRevision,
        conflictResolution: input.resolution,
      });
      const snapshot = mutationResultSnapshot(duplicate.resultSnapshot);
      if (snapshot) return snapshot;
      return legacyMutationResponse({
        duplicate: true,
        clientMutationId: input.clientMutationId,
        appliedRevision: duplicate.appliedRevision,
        version: duplicate.version,
      });
    }

    const version = await getVersionForActor(actor, versionId);
    assertEditableVersion(version);
    await assertPromptTextAllowed(actor, version.scope, input.promptText);

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${actor.businessId}), hashtext(${input.clientMutationId}))`;
      const replay = await tx.aiPromptDraftMutation.findUnique({
        where: { businessId_clientMutationId: { businessId: actor.businessId, clientMutationId: input.clientMutationId } },
        include: {
          version: {
            select: {
              id: true,
              configurationId: true,
              scope: true,
              status: true,
              revision: true,
              promptText: true,
              changeSummary: true,
              updatedAt: true,
            },
          },
        },
      });
      if (replay) {
        if (replay.versionId !== versionId) {
          throw new AppError(409, "This client mutation ID was already used for another prompt version.", "AI_PROMPT_MUTATION_ID_REUSED", {
            clientMutationId: input.clientMutationId,
            existingVersionId: replay.versionId,
          });
        }
        const snapshot = mutationResultSnapshot(replay.resultSnapshot);
        return { updated: replay.version, mutation: replay, duplicate: true, responseSnapshot: snapshot };
      }
      const changed = await tx.aiPromptVersion.updateMany({
        where: {
          id: version.id,
          businessId: actor.businessId,
          configurationId: version.configurationId,
          configuration: { archivedAt: null },
          revision: input.expectedServerRevision,
          status: { in: [AiPromptStatus.DRAFT, AiPromptStatus.INVALID] },
          archivedAt: null,
        },
        data: {
          promptText: input.promptText,
          ...(input.changeSummary !== undefined ? { changeSummary: input.changeSummary } : {}),
          revision: { increment: 1 },
          ...clearValidationData(),
        },
      });
      if (changed.count !== 1) {
        const latest = await tx.aiPromptVersion.findFirst({
          where: { id: version.id, businessId: actor.businessId },
          select: { id: true, revision: true, updatedAt: true, promptText: true, changeSummary: true, status: true, archivedAt: true },
        });
        if (!latest) throw new AppError(404, "AI prompt version not found.", "AI_PROMPT_VERSION_NOT_FOUND");
        if (latest.revision !== input.expectedServerRevision) {
          throw new AppError(
            409,
            "The server draft changed again. Review the latest server draft before replacing it.",
            "AI_PROMPT_DRAFT_CONFLICT_CHANGED",
            {
              versionId: latest.id,
              expectedServerRevision: input.expectedServerRevision,
              serverRevision: latest.revision,
              serverUpdatedAt: latest.updatedAt.toISOString(),
              serverPromptText: latest.promptText,
              serverChangeSummary: latest.changeSummary,
            },
          );
        }
        if (latest.archivedAt || latest.status === AiPromptStatus.ARCHIVED) {
          throw new AppError(409, "Archived prompt versions cannot be edited.", "AI_PROMPT_VERSION_ARCHIVED");
        }
        if (latest.status !== AiPromptStatus.DRAFT && latest.status !== AiPromptStatus.INVALID) {
          throw new AppError(409, "Only draft or invalid prompt versions can be edited.", "AI_PROMPT_VERSION_NOT_EDITABLE", { status: latest.status });
        }
        throw new AppError(409, "Prompt version changed. Refresh and edit the latest draft again.", "AI_PROMPT_VERSION_CHANGED");
      }
      const updated = await tx.aiPromptVersion.findUniqueOrThrow({
        where: { id: version.id },
        select: {
          id: true,
          configurationId: true,
          scope: true,
          status: true,
          revision: true,
          promptText: true,
          changeSummary: true,
          updatedAt: true,
        },
      });
      const responseSnapshot = autosaveResponse({
        duplicate: false,
        clientMutationId: input.clientMutationId,
        appliedRevision: updated.revision,
        version: updated,
      });
      const mutation = await tx.aiPromptDraftMutation.create({
        data: {
          businessId: actor.businessId,
          versionId: version.id,
          clientMutationId: input.clientMutationId,
          clientUpdatedAt: input.clientUpdatedAt ?? null,
          appliedRevision: updated.revision,
          resultSnapshot: json(responseSnapshot),
        },
      });
      await tx.aiPromptConfiguration.update({
        where: { id: version.configurationId },
        data: { updatedByMembershipId: actor.membershipId },
      });
      return { updated, mutation, duplicate: false, responseSnapshot };
    });

    if (result.duplicate) {
      await audit(actor, AuditAction.AI_PROMPT_DRAFT_SYNC_DUPLICATE, {
        versionId,
        clientMutationId: input.clientMutationId,
        appliedRevision: result.mutation.appliedRevision,
        conflictResolution: input.resolution,
      });
      if (result.responseSnapshot) return result.responseSnapshot;
    } else {
      await audit(actor, AuditAction.AI_PROMPT_DRAFT_CONFLICT_RESOLVED, {
        configurationId: result.updated.configurationId,
        versionId: result.updated.id,
        scope: result.updated.scope,
        previousRevision: input.expectedServerRevision,
        newRevision: result.updated.revision,
        clientMutationId: input.clientMutationId,
        clientUpdatedAt: input.clientUpdatedAt?.toISOString() ?? null,
        conflictResolution: input.resolution,
      });
      await publish("business.ai_prompt.draft.saved", actor.businessId, {
        configurationId: result.updated.configurationId,
        versionId: result.updated.id,
        scope: result.updated.scope,
        revision: result.updated.revision,
        updatedAt: result.updated.updatedAt,
        updatedByMembershipId: actor.membershipId,
      });
    }
    return result.responseSnapshot ?? legacyMutationResponse({
      duplicate: result.duplicate,
      clientMutationId: result.mutation.clientMutationId,
      appliedRevision: result.mutation.appliedRevision,
      version: result.updated,
    });
  },

  async validateVersion(actor: AiPromptActor, versionId: string) {
    assertCanManagePrompts(actor);
    await recoverStaleValidations(actor.businessId);
    const version = await getVersionForActor(actor, versionId);
    if (version.archivedAt) throw new AppError(409, "Archived prompt versions cannot be validated.", "AI_PROMPT_VERSION_ARCHIVED");
    if (
      version.status !== AiPromptStatus.DRAFT
      && version.status !== AiPromptStatus.INVALID
      && version.status !== AiPromptStatus.VALID
    ) {
      throw new AppError(
        409,
        "This prompt version cannot be validated in its current state.",
        "AI_PROMPT_VERSION_NOT_VALIDATABLE",
        { status: version.status },
      );
    }
    await audit(actor, AuditAction.AI_PROMPT_VALIDATION_STARTED, { configurationId: version.configurationId, versionId: version.id, scope: version.scope });
    const claimed = await prisma.aiPromptVersion.updateMany({
      where: {
        id: version.id,
        businessId: actor.businessId,
        status: version.status,
        updatedAt: version.updatedAt,
        promptText: version.promptText,
        revision: version.revision,
        archivedAt: null,
      },
      data: { status: AiPromptStatus.VALIDATING },
    });
    if (claimed.count !== 1) {
      throw new AppError(
        409,
        "Prompt changed before validation could start. Validate the latest version again.",
        "AI_PROMPT_VERSION_CHANGED",
      );
    }
    try {
      const plan = await currentPlan(actor);
      const result = aiPromptValidationService.validate({ scope: version.scope, promptText: version.promptText, plan });
      const completed = await prisma.aiPromptVersion.updateMany({
        where: {
          id: version.id,
          businessId: actor.businessId,
          status: AiPromptStatus.VALIDATING,
          promptText: version.promptText,
          revision: version.revision,
        },
        data: {
          status: result.status,
          validatedAt: new Date(),
          validatedRevision: version.revision,
          ...validationData(result),
        },
      });
      if (completed.count !== 1) {
        throw new AppError(
          409,
          "Prompt changed during validation. Validate the latest version again.",
          "AI_PROMPT_VERSION_CHANGED",
        );
      }
      const updated = await prisma.aiPromptVersion.findUniqueOrThrow({ where: { id: version.id } });
      await audit(actor, result.valid ? AuditAction.AI_PROMPT_VALIDATION_SUCCEEDED : AuditAction.AI_PROMPT_VALIDATION_FAILED, {
        configurationId: version.configurationId,
        versionId: version.id,
        scope: version.scope,
        issueCodes: result.issues.map((issue) => issue.code),
      });
      if (result.safetyIssues.length) await audit(actor, AuditAction.AI_PROMPT_BLOCKED_BY_SAFETY, { versionId: version.id, issueCodes: result.safetyIssues.map((issue) => issue.code) });
      if (result.capabilityIssues.length) await audit(actor, AuditAction.AI_PROMPT_BLOCKED_BY_PLAN, { versionId: version.id, issueCodes: result.capabilityIssues.map((issue) => issue.code) });
      if (result.conflictIssues.length) await audit(actor, AuditAction.AI_PROMPT_BLOCKED_BY_CONFLICT, { versionId: version.id, issueCodes: result.conflictIssues.map((issue) => issue.code) });
      await publish("business.ai_prompt.validation_completed", actor.businessId, {
        configurationId: version.configurationId,
        versionId: version.id,
        scope: version.scope,
        valid: result.valid,
        issueCodes: result.issues.map((issue) => issue.code),
        issueCount: result.issues.length,
      });
      return updated;
    } catch (error) {
      const code = errorCode(error);
      await prisma.aiPromptVersion.updateMany({
        where: {
          id: version.id,
          businessId: actor.businessId,
          status: AiPromptStatus.VALIDATING,
          promptText: version.promptText,
          revision: version.revision,
        },
        data: {
          status: AiPromptStatus.INVALID,
          validatedRevision: null,
          validationFailureCode: code,
          validationFailureAt: new Date(),
          validationResult: json({
            valid: false,
            issues: [{
              code,
              message: "Prompt validation failed before it could complete. Validate again.",
              severity: "ERROR",
              source: "MODULE",
            }],
          }),
        },
      });
      await audit(actor, AuditAction.AI_PROMPT_VALIDATION_FAILED, {
        configurationId: version.configurationId,
        versionId: version.id,
        scope: version.scope,
        issueCodes: [code],
        recoveredFromValidating: true,
      });
      throw error;
    }
  },

  async activate(actor: AiPromptActor, versionId: string) {
    assertCanManagePrompts(actor);
    const version = await getVersionForActor(actor, versionId);
    if (version.status !== AiPromptStatus.VALID) {
      throw new AppError(409, "Only valid prompt versions can be activated.", "AI_PROMPT_VERSION_NOT_VALID");
    }
    if (
      version.validatedRevision !== version.revision
      || !version.compiled
      || !validationResultIsValid(version.validationResult)
      || version.compilerVersion !== AI_PROMPT_COMPILER_VERSION
    ) {
      throw new AppError(
        409,
        "This prompt changed after validation. Validate it again before activation.",
        "AI_PROMPT_REVALIDATION_REQUIRED",
        {
          revision: version.revision,
          validatedRevision: version.validatedRevision,
          compilerVersion: version.compilerVersion,
          currentCompilerVersion: AI_PROMPT_COMPILER_VERSION,
        },
      );
    }
    const plan = await currentPlan(actor);
    const capabilities = aiPromptCapabilityService.forPlan(plan, version.scope);
    if (!capabilities.canActivate) {
      throw new AppError(
        403,
        "This prompt scope is not implemented yet.",
        "AI_PROMPT_SCOPE_NOT_IMPLEMENTED",
        { scope: version.scope },
      );
    }
    const validation = aiPromptValidationService.validate({ scope: version.scope, promptText: version.promptText, plan });
    if (!validation.valid) {
      await prisma.aiPromptVersion.update({
        where: { id: version.id },
        data: {
          status: AiPromptStatus.INVALID,
          validatedAt: new Date(),
          validatedRevision: version.revision,
          ...validationData(validation),
        },
      });
      await audit(actor, AuditAction.AI_PROMPT_BLOCKED_BY_PLAN, {
        configurationId: version.configurationId,
        versionId: version.id,
        scope: version.scope,
        plan,
        issueCodes: validation.issues.map((issue) => issue.code),
      });
      throw new AppError(
        403,
        "This prompt is no longer valid for the current plan. Review and validate it again.",
        "AI_PROMPT_PLAN_CAPABILITY_CHANGED",
        { issueCodes: validation.issues.map((issue) => issue.code) },
      );
    }
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      await lockPromptScope(tx, actor.businessId, version.scope);
      const config = await tx.aiPromptConfiguration.findFirst({
        where: { id: version.configurationId, businessId: actor.businessId, scope: version.scope, archivedAt: null },
        select: { id: true, activeVersionId: true },
      });
      if (!config) {
        throw new AppError(404, "AI prompt configuration not found.", "AI_PROMPT_NOT_FOUND");
      }
      const previousActiveId = config.activeVersionId;
      await tx.aiPromptVersion.updateMany({
        where: {
          businessId: actor.businessId,
          scope: version.scope,
          activeKey: ACTIVE_KEY,
        },
        data: { status: AiPromptStatus.INACTIVE, activeKey: null, deactivatedAt: now },
      });
      const active = await tx.aiPromptVersion.update({
        where: { id: version.id },
        data: {
          status: AiPromptStatus.ACTIVE,
          activeKey: ACTIVE_KEY,
          activatedAt: now,
          deactivatedAt: null,
          validatedAt: now,
          validatedRevision: version.revision,
          ...validationData(validation),
        },
      });
      await tx.aiPromptConfiguration.update({
        where: { id: version.configurationId },
        data: { status: AiPromptStatus.ACTIVE, activeVersionId: version.id, updatedByMembershipId: actor.membershipId },
      });
      return { active, previousActiveId };
    });
    await audit(actor, AuditAction.AI_PROMPT_ACTIVATED, {
      configurationId: version.configurationId,
      versionId: version.id,
      scope: version.scope,
      previousActiveVersionId: result.previousActiveId,
    });
    await publish("business.ai_prompt.activated", actor.businessId, { configurationId: version.configurationId, versionId: version.id, scope: version.scope });
    return result.active;
  },

  async deactivate(actor: AiPromptActor, configurationId: string) {
    assertCanManagePrompts(actor);
    const config = await getConfigForActor(actor, configurationId);
    if (!config.activeVersionId) return config;
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      await lockPromptScope(tx, actor.businessId, config.scope);
      const current = await tx.aiPromptConfiguration.findFirst({
        where: { id: config.id, businessId: actor.businessId },
        select: { id: true, activeVersionId: true, scope: true },
      });
      if (!current?.activeVersionId) return config;
      await tx.aiPromptVersion.updateMany({
        where: { businessId: actor.businessId, scope: current.scope, activeKey: ACTIVE_KEY },
        data: { status: AiPromptStatus.INACTIVE, activeKey: null, deactivatedAt: now },
      });
      return tx.aiPromptConfiguration.update({
        where: { id: config.id },
        data: { status: AiPromptStatus.INACTIVE, activeVersionId: null, updatedByMembershipId: actor.membershipId },
      });
    });
    await audit(actor, AuditAction.AI_PROMPT_DEACTIVATED, { configurationId, scope: config.scope, previousActiveVersionId: config.activeVersionId });
    await publish("business.ai_prompt.deactivated", actor.businessId, { configurationId, scope: config.scope });
    return updated;
  },

  async archive(actor: AiPromptActor, configurationId: string) {
    assertCanManagePrompts(actor);
    const config = await getConfigForActor(actor, configurationId);
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      await lockPromptScope(tx, actor.businessId, config.scope);
      await tx.aiPromptVersion.updateMany({
        where: { businessId: actor.businessId, scope: config.scope, activeKey: ACTIVE_KEY },
        data: { status: AiPromptStatus.INACTIVE, activeKey: null, deactivatedAt: now },
      });
      await tx.aiPromptVersion.updateMany({
        where: { configurationId: config.id, archivedAt: null, status: { not: AiPromptStatus.ARCHIVED } },
        data: { archivedAt: now, status: AiPromptStatus.ARCHIVED, activeKey: null },
      });
      return tx.aiPromptConfiguration.update({
        where: { id: config.id },
        data: { status: AiPromptStatus.ARCHIVED, activeVersionId: null, archivedAt: now, updatedByMembershipId: actor.membershipId },
      });
    });
    await audit(actor, AuditAction.AI_PROMPT_ARCHIVED, { configurationId, scope: config.scope });
    await publish("business.ai_prompt.archived", actor.businessId, { configurationId, scope: config.scope });
    return updated;
  },

  async listVersions(actor: AiPromptActor, configurationId: string, query: AiPromptVersionListQuery) {
    assertCanReadAiPrompts(actor);
    await getConfigForActor(actor, configurationId);
    const where: Prisma.AiPromptVersionWhereInput = {
      configurationId,
      businessId: actor.businessId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.createdBy ? { createdByMembershipId: query.createdBy } : {}),
      ...(query.createdFrom || query.createdTo ? {
        createdAt: {
          ...(query.createdFrom ? { gte: query.createdFrom } : {}),
          ...(query.createdTo ? { lte: query.createdTo } : {}),
        },
      } : {}),
    };
    const [data, total] = await prisma.$transaction([
      prisma.aiPromptVersion.findMany({
        where,
        orderBy: { versionNumber: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.aiPromptVersion.count({ where }),
    ]);
    return { data, total, page: query.page, limit: query.limit };
  },

  async availableScopes(actor: AiPromptActor) {
    assertCanReadAiPrompts(actor);
    const plan = await currentPlan(actor);
    return aiPromptCapabilityService.scopesForPlan(plan);
  },

  async capabilities(actor: AiPromptActor, scope: AiPromptScope) {
    assertCanReadAiPrompts(actor);
    const plan = await currentPlan(actor);
    return aiPromptCapabilityService.forPlan(plan, scope);
  },
};

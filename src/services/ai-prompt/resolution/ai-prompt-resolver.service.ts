import { AiPromptScope, AiPromptStatus, AuditAction, Prisma } from "@prisma/client";
import { prisma } from "../../../config/prisma";
import { subscriptionService } from "../../subscription.service";
import { aiPromptCapabilityService } from "../capability/ai-prompt-capability.service";
import { ResolvedAiPrompt } from "../core/ai-prompt.types";
import { AppError } from "../../../utils/errors";
import { sanitizeCompiledPromptForRuntime } from "./ai-prompt-runtime-sanitizer.service";

const PLATFORM_RULES = [
  "Do not override customer opt-out requests.",
  "Do not bypass human takeover, complaint escalation, business isolation, or permissions.",
  "Do not invent prices, policies, services, availability, discounts, refunds, or timelines.",
  "Do not confirm appointments without backend confirmation.",
];

const PRODUCT_RULES = [
  "Prompts configure behavior; subscription plans authorize capabilities.",
  "Hard backend state and deterministic product rules override business prompt text.",
  "If no prompt is active, use safe module defaults.",
];

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function auditRuntimeWarningsOnce(input: {
  businessId: string;
  scope: AiPromptScope;
  plan: string;
  versionId: string | null;
  warnings: Array<{ code: string; message: string; metadata?: Record<string, unknown> }>;
}) {
  const uniqueWarnings = new Map(input.warnings.map((warning) => [warning.code, warning]));
  for (const warning of uniqueWarnings.values()) {
    const dedupeKey = [
      "ai_prompt_runtime_warning",
      input.businessId,
      input.scope,
      input.versionId ?? "no-version",
      input.plan,
      warning.code,
    ].join(":");

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${input.businessId}), hashtext(${dedupeKey}))`;
      const existing = await tx.auditLog.findFirst({
        where: {
          businessId: input.businessId,
          action: AuditAction.AI_PROMPT_BLOCKED_BY_PLAN,
          metadata: {
            path: ["dedupeKey"],
            equals: dedupeKey,
          },
        },
        select: { id: true },
      });
      if (existing) return;

      await tx.auditLog.create({
        data: {
          action: AuditAction.AI_PROMPT_BLOCKED_BY_PLAN,
          businessId: input.businessId,
          metadata: json({
            dedupeKey,
            scope: input.scope,
            plan: input.plan,
            warningCode: warning.code,
            warningMessage: warning.message,
            warningMetadata: warning.metadata ?? null,
            versionId: input.versionId,
          }),
        },
      });
    }).catch((error) => {
      console.error("AI prompt runtime warning audit failed", error);
    });
  }
}

async function activeVersion(businessId: string, scope: AiPromptScope) {
  const configuration = await prisma.aiPromptConfiguration.findFirst({
    where: {
      businessId,
      scope,
      archivedAt: null,
    },
    select: {
      activeVersion: {
        select: {
          id: true,
          versionNumber: true,
          status: true,
          activeKey: true,
          archivedAt: true,
          compiled: true,
        },
      },
    },
  });
  const active = configuration?.activeVersion;
  if (!active || active.status !== AiPromptStatus.ACTIVE || active.activeKey !== "ACTIVE" || active.archivedAt) return null;
  return active;
}

export const aiPromptResolverService = {
  async resolve(input: {
    businessId: string;
    businessAccountId: string;
    scope: AiPromptScope;
    auditWarnings?: boolean;
  }): Promise<ResolvedAiPrompt> {
    const business = await prisma.business.findFirst({
      where: {
        id: input.businessId,
        businessAccountId: input.businessAccountId,
        deletedAt: null,
      },
      select: { id: true, businessAccountId: true },
    });
    if (!business) {
      throw new AppError(
        404,
        "Business prompt context not found.",
        "AI_PROMPT_BUSINESS_CONTEXT_NOT_FOUND",
      );
    }
    const subscription = await subscriptionService.getCurrentRecord(input.businessAccountId);
    const capabilities = aiPromptCapabilityService.forPlan(subscription.plan.code, input.scope);
    const [globalPrompt, modulePrompt] = await Promise.all([
      input.scope === AiPromptScope.GLOBAL ? Promise.resolve(null) : activeVersion(input.businessId, AiPromptScope.GLOBAL),
      activeVersion(input.businessId, input.scope),
    ]);
    const sanitizedGlobal = globalPrompt
      ? sanitizeCompiledPromptForRuntime(globalPrompt.compiled, aiPromptCapabilityService.forPlan(subscription.plan.code, AiPromptScope.GLOBAL))
      : { compiled: null, warnings: [] };
    const sanitizedModule = modulePrompt
      ? sanitizeCompiledPromptForRuntime(modulePrompt.compiled, capabilities)
      : { compiled: null, warnings: [] };
    const warnings = [...sanitizedGlobal.warnings, ...sanitizedModule.warnings];
    if (input.auditWarnings !== false && sanitizedGlobal.warnings.length) {
      await auditRuntimeWarningsOnce({
        businessId: input.businessId,
        scope: AiPromptScope.GLOBAL,
        plan: subscription.plan.code,
        versionId: globalPrompt?.id ?? null,
        warnings: sanitizedGlobal.warnings,
      });
    }
    if (input.auditWarnings !== false && sanitizedModule.warnings.length) {
      await auditRuntimeWarningsOnce({
        businessId: input.businessId,
        scope: input.scope,
        plan: subscription.plan.code,
        versionId: modulePrompt?.id ?? null,
        warnings: sanitizedModule.warnings,
      });
    }
    return {
      scope: input.scope,
      plan: subscription.plan.code,
      capabilities,
      globalPrompt: globalPrompt ? {
        versionId: globalPrompt.id,
        versionNumber: globalPrompt.versionNumber,
        compiled: sanitizedGlobal.compiled as Prisma.JsonValue | null,
      } : null,
      modulePrompt: modulePrompt ? {
        versionId: modulePrompt.id,
        versionNumber: modulePrompt.versionNumber,
        compiled: sanitizedModule.compiled as Prisma.JsonValue | null,
      } : null,
      platformRules: PLATFORM_RULES,
      productRules: PRODUCT_RULES,
      warnings,
    };
  },
};

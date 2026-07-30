import { AiPromptScope } from "@prisma/client";
import { z } from "zod";
import { AI_PROMPT_COMPILER_VERSION, AiPromptCapabilities, AiPromptCompiled } from "../core/ai-prompt.types";

export type SanitizedPrompt = {
  compiled: AiPromptCompiled | null;
  warnings: Array<{
    code: string;
    message: string;
    metadata?: Record<string, unknown>;
  }>;
};

const MIN_FOLLOW_UP_DELAY_MINUTES = 5;
const MAX_FOLLOW_UP_DELAY_MINUTES = 30 * 24 * 60;
const MAX_PROHIBITED_PHRASES = 20;
const MAX_PROHIBITED_PHRASE_LENGTH = 120;

const coverageSchema = z.object({
  recognizedInstructions: z.array(z.string().max(160)).max(100).default([]),
  unsupportedInstructions: z.array(z.string().max(500)).max(100).default([]),
  ignoredText: z.array(z.string().max(500)).max(100).default([]),
  effectiveBehavior: z.record(z.string(), z.unknown()).default({}),
}).partial().optional();

const globalInstructionsSchema = z.object({
  tone: z.enum(["friendly", "professional"]).optional(),
  responseLength: z.enum(["short"]).optional(),
}).strict();

const followUpSchema = z.object({
  tone: z.enum(["professional", "friendly", "polite", "concise"]).optional(),
  responseLength: z.enum(["short", "medium"]).optional(),
  maximumAttempts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  defaultDelayMinutes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  needsApprovalDelayMinutes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  allowAdaptiveTiming: z.boolean().optional(),
  allowGoalAwareSequencing: z.boolean().optional(),
  allowObjectionAwareSequencing: z.boolean().optional(),
  stopOnHumanTakeover: z.boolean().optional(),
  stopOnComplaint: z.boolean().optional(),
  prohibitedPhrases: z.array(z.string().trim().min(1).max(5_000)).max(500).optional(),
}).strict();

const compiledSchema = z.object({
  scope: z.nativeEnum(AiPromptScope),
  compilerVersion: z.string().min(1),
  coverage: coverageSchema,
  globalInstructions: globalInstructionsSchema.optional(),
  followUp: followUpSchema.optional(),
}).strict();

function asCompiled(value: unknown): AiPromptCompiled | null {
  const parsed = compiledSchema.safeParse(value);
  return parsed.success ? parsed.data as AiPromptCompiled : null;
}

function invalidShapeWarning() {
  return {
    compiled: null,
    warnings: [{
      code: "AI_PROMPT_COMPILED_SHAPE_INVALID",
      message: "Stored prompt configuration was ignored because its compiled shape is invalid.",
    }],
  } satisfies SanitizedPrompt;
}

function clampDelay(input: {
  value: number | undefined;
  field: "defaultDelayMinutes" | "needsApprovalDelayMinutes";
  warnings: SanitizedPrompt["warnings"];
}) {
  if (input.value === undefined) return undefined;
  if (input.value < MIN_FOLLOW_UP_DELAY_MINUTES) {
    input.warnings.push({
      code: "AI_PROMPT_FOLLOW_UP_DELAY_CLAMPED",
      message: "Stored follow-up delay was below the runtime minimum and was clamped.",
      metadata: { field: input.field, stored: input.value, clamped: MIN_FOLLOW_UP_DELAY_MINUTES },
    });
    return MIN_FOLLOW_UP_DELAY_MINUTES;
  }
  if (input.value > MAX_FOLLOW_UP_DELAY_MINUTES) {
    input.warnings.push({
      code: "AI_PROMPT_FOLLOW_UP_DELAY_CLAMPED",
      message: "Stored follow-up delay exceeded the runtime maximum and was clamped.",
      metadata: { field: input.field, stored: input.value, clamped: MAX_FOLLOW_UP_DELAY_MINUTES },
    });
    return MAX_FOLLOW_UP_DELAY_MINUTES;
  }
  return input.value;
}

function sanitizeProhibitedPhrases(value: string[] | undefined, warnings: SanitizedPrompt["warnings"]) {
  if (!value) return undefined;
  const sanitized = value
    .map((phrase) => phrase.trim())
    .filter(Boolean)
    .slice(0, MAX_PROHIBITED_PHRASES)
    .map((phrase) => phrase.slice(0, MAX_PROHIBITED_PHRASE_LENGTH));
  if (sanitized.length !== value.length || sanitized.some((phrase, index) => phrase !== value[index]?.trim())) {
    warnings.push({
      code: "AI_PROMPT_PROHIBITED_PHRASES_CLAMPED",
      message: "Stored prohibited phrases exceeded runtime limits and were clamped.",
      metadata: {
        storedCount: value.length,
        currentLimit: MAX_PROHIBITED_PHRASES,
        maxPhraseLength: MAX_PROHIBITED_PHRASE_LENGTH,
      },
    });
  }
  return sanitized;
}

export function sanitizeCompiledPromptForRuntime(value: unknown, capabilities: AiPromptCapabilities): SanitizedPrompt {
  const compiled = asCompiled(value);
  if (!compiled) return invalidShapeWarning();

  const warnings: SanitizedPrompt["warnings"] = [];
  if (compiled.scope !== capabilities.scope) {
    return {
      compiled: null,
      warnings: [{
        code: "AI_PROMPT_COMPILED_SCOPE_MISMATCH",
        message: "Stored prompt configuration was ignored because its compiled scope does not match the runtime scope.",
        metadata: { compiledScope: compiled.scope, runtimeScope: capabilities.scope },
      }],
    };
  }

  if (compiled.compilerVersion !== AI_PROMPT_COMPILER_VERSION) {
    return {
      compiled: null,
      warnings: [{
        code: "AI_PROMPT_COMPILER_VERSION_OUTDATED",
        message: "The active prompt must be revalidated before it can be used.",
        metadata: {
          storedCompilerVersion: compiled.compilerVersion,
          currentCompilerVersion: AI_PROMPT_COMPILER_VERSION,
        },
      }],
    };
  }

  if (compiled.scope === AiPromptScope.FOLLOW_UP && compiled.followUp) {
    const followUp = { ...compiled.followUp };
    if (typeof capabilities.maxFollowUpAttempts === "number") {
      const stored = followUp.maximumAttempts;
      followUp.maximumAttempts = Math.max(0, Math.min(stored ?? capabilities.maxFollowUpAttempts, capabilities.maxFollowUpAttempts));
      if (stored !== undefined && stored !== followUp.maximumAttempts) {
        warnings.push({
          code: "AI_PROMPT_FOLLOW_UP_ATTEMPTS_CLAMPED",
          message: "Stored follow-up prompt attempts exceeded runtime limits and were clamped.",
          metadata: { stored, clamped: followUp.maximumAttempts, currentLimit: capabilities.maxFollowUpAttempts },
        });
      }
    } else if (typeof followUp.maximumAttempts === "number") {
      followUp.maximumAttempts = Math.max(0, followUp.maximumAttempts);
    }
    followUp.defaultDelayMinutes = clampDelay({ value: followUp.defaultDelayMinutes, field: "defaultDelayMinutes", warnings });
    followUp.needsApprovalDelayMinutes = clampDelay({ value: followUp.needsApprovalDelayMinutes, field: "needsApprovalDelayMinutes", warnings });
    followUp.prohibitedPhrases = sanitizeProhibitedPhrases(followUp.prohibitedPhrases, warnings);
    if (followUp.allowAdaptiveTiming && !capabilities.adaptiveTiming) {
      warnings.push({ code: "AI_PROMPT_ADAPTIVE_TIMING_DISABLED_BY_PLAN", message: "Adaptive follow-up timing is not available on the current plan." });
      followUp.allowAdaptiveTiming = false;
    }
    if (followUp.allowGoalAwareSequencing && !capabilities.goalAwareSequencing) {
      warnings.push({ code: "AI_PROMPT_GOAL_AWARE_DISABLED_BY_PLAN", message: "Goal-aware follow-up sequencing is not available on the current plan." });
      followUp.allowGoalAwareSequencing = false;
    }
    if (followUp.allowObjectionAwareSequencing && !capabilities.objectionAwareSequencing) {
      warnings.push({ code: "AI_PROMPT_OBJECTION_AWARE_DISABLED_BY_PLAN", message: "Objection-aware follow-up sequencing is not available on the current plan." });
      followUp.allowObjectionAwareSequencing = false;
    }
    followUp.stopOnHumanTakeover = true;
    followUp.stopOnComplaint = true;
    return { compiled: { ...compiled, followUp }, warnings };
  }

  return { compiled, warnings };
}

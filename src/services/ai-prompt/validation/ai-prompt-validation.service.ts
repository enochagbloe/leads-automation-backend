import { AiPromptScope, AiPromptStatus } from "@prisma/client";
import { aiPromptCapabilityService } from "../capability/ai-prompt-capability.service";
import { aiPromptCompilerService } from "../compilation/ai-prompt-compiler.service";
import { AiPromptIssue, AiPromptValidationResult } from "../core/ai-prompt.types";
import { aiPromptSafetyService } from "./ai-prompt-safety.service";

function syntaxIssues(promptText: string, maxPromptLength: number): AiPromptIssue[] {
  const issues: AiPromptIssue[] = [];
  if (!promptText.trim()) {
    issues.push({
      code: "PROMPT_EMPTY",
      message: "Prompt instructions cannot be empty.",
      severity: "ERROR",
      source: "SYNTAX",
    });
  }
  if (promptText.length > maxPromptLength) {
    issues.push({
      code: "PROMPT_TOO_LONG",
      message: `Prompt instructions must be ${maxPromptLength} characters or fewer.`,
      severity: "ERROR",
      source: "SYNTAX",
      metadata: { maxPromptLength },
    });
  }
  return issues;
}

function conflictIssues(promptText: string): AiPromptIssue[] {
  const issues: AiPromptIssue[] = [];
  if (/\bfollow up after (?:one|1) day\b/i.test(promptText) && /\bnever follow up before (?:seven|7) days\b/i.test(promptText)) {
    issues.push({
      code: "CONFLICTING_FOLLOW_UP_DELAY",
      message: "Prompt gives conflicting follow-up timing instructions.",
      severity: "ERROR",
      source: "CONFLICT",
    });
  }
  if (/\bsend (?:three|3) follow[- ]?ups?\b/i.test(promptText) && /\bnever (?:send )?more than (?:one|1) follow[- ]?up\b/i.test(promptText)) {
    issues.push({
      code: "CONFLICTING_FOLLOW_UP_ATTEMPTS",
      message: "Prompt gives conflicting maximum follow-up attempt instructions.",
      severity: "ERROR",
      source: "CONFLICT",
    });
  }
  return issues;
}

function implementationIssues(scope: AiPromptScope, implemented: boolean): AiPromptIssue[] {
  if (implemented) return [];
  return [{
    code: "AI_PROMPT_SCOPE_NOT_IMPLEMENTED",
    message: `${scope} prompt configuration is not implemented yet.`,
    severity: "ERROR",
    source: "MODULE",
    metadata: { scope },
  }];
}

export const aiPromptValidationService = {
  validate(input: {
    scope: AiPromptScope;
    promptText: string;
    plan: import("@prisma/client").PlanCode;
  }): AiPromptValidationResult {
    const capabilities = aiPromptCapabilityService.forPlan(input.plan, input.scope);
    const syntax = syntaxIssues(input.promptText, capabilities.maxPromptLength);
    const safety = aiPromptSafetyService.validate(input.promptText);
    const conflicts = conflictIssues(input.promptText);
    const implementation = implementationIssues(input.scope, capabilities.implemented);
    const compiled = aiPromptCompilerService.compile(input.scope, input.promptText, capabilities);
    const allIssues = [...syntax, ...safety, ...conflicts, ...implementation, ...compiled.issues];
    const valid = !allIssues.some((issue) => issue.severity === "ERROR");
    const unsupportedIssues = compiled.issues.filter((issue) => issue.source === "CAPABILITY");

    return {
      valid,
      status: valid ? AiPromptStatus.VALID : AiPromptStatus.INVALID,
      issues: allIssues,
      unsupportedIssues,
      safetyIssues: safety,
      capabilityIssues: compiled.issues.filter((issue) => issue.source === "CAPABILITY"),
      conflictIssues: conflicts,
      moduleIssues: [...implementation, ...compiled.issues.filter((issue) => issue.source === "MODULE")],
      compiled: compiled.compiled,
    };
  },
};

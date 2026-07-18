import { AiPromptScope } from "@prisma/client";
import { AI_PROMPT_COMPILER_VERSION, AiPromptCapabilities, AiPromptCompiled, AiPromptIssue } from "../core/ai-prompt.types";
import { compileFollowUpPrompt } from "../scopes/follow-up/follow-up-prompt.compiler";

function globalClauses(promptText: string) {
  return promptText
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .split(/\n+|(?<=[.!?;])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isTrivialGlobalClause(text: string) {
  return text.length < 8 || /^(please|thanks?|thank you|and|also)$/i.test(text);
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function compileGlobalPrompt(promptText: string): { compiled: AiPromptCompiled; issues: AiPromptIssue[] } {
  const issues: AiPromptIssue[] = [];
  const recognizedInstructions: string[] = [];
  const unsupportedInstructions: string[] = [];
  const ignoredText: string[] = [];
  const globalInstructions = {
    tone: /\bfriendly|warm\b/i.test(promptText) ? "friendly" : /\bprofessional\b/i.test(promptText) ? "professional" : undefined,
    responseLength: /\bshort|brief|concise\b/i.test(promptText) ? "short" : undefined,
  };
  if (globalInstructions.tone) recognizedInstructions.push("tone");
  if (globalInstructions.responseLength) recognizedInstructions.push("response_length");

  for (const clause of globalClauses(promptText)) {
    const recognizedByClause = [
      /\bfriendly|warm|professional\b/i,
      /\bshort|brief|concise\b/i,
    ].some((pattern) => pattern.test(clause));
    if (!recognizedByClause && !isTrivialGlobalClause(clause)) unsupportedInstructions.push(clause);
  }

  for (const instruction of unique(unsupportedInstructions)) {
    issues.push({
      code: "GLOBAL_PROMPT_UNSUPPORTED_INSTRUCTION",
      message: "This global prompt instruction is not supported by the current prompt compiler and will not be applied.",
      severity: "ERROR",
      source: "MODULE",
      metadata: { instruction },
    });
  }

  return {
    compiled: {
      scope: AiPromptScope.GLOBAL,
      compilerVersion: AI_PROMPT_COMPILER_VERSION,
      coverage: {
        recognizedInstructions: unique(recognizedInstructions),
        unsupportedInstructions: unique(unsupportedInstructions),
        ignoredText,
        effectiveBehavior: globalInstructions,
      },
      globalInstructions,
    },
    issues,
  };
}

export const aiPromptCompilerService = {
  compile(scope: AiPromptScope, promptText: string, capabilities: AiPromptCapabilities): { compiled: AiPromptCompiled; issues: AiPromptIssue[] } {
    if (scope === AiPromptScope.FOLLOW_UP) return compileFollowUpPrompt(promptText, capabilities);
    if (scope === AiPromptScope.GLOBAL) return compileGlobalPrompt(promptText);
    return {
      compiled: {
        scope,
        compilerVersion: AI_PROMPT_COMPILER_VERSION,
      },
      issues: [],
    };
  },
};

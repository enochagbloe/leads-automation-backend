import { AiPromptScope, BusinessRole, PlanCode, Prisma } from "@prisma/client";

export type AiPromptActor = {
  userId: string;
  businessAccountId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

export type AiPromptIssueSeverity = "ERROR" | "WARNING" | "INFO";
export type AiPromptIssueSource = "SYNTAX" | "SAFETY" | "CAPABILITY" | "CONFLICT" | "MODULE";

export type AiPromptIssue = {
  code: string;
  message: string;
  severity: AiPromptIssueSeverity;
  source: AiPromptIssueSource;
  metadata?: Record<string, unknown>;
};

export type FollowUpPromptCompiled = {
  tone?: "professional" | "friendly" | "polite" | "concise";
  responseLength?: "short" | "medium";
  maximumAttempts?: number;
  defaultDelayMinutes?: number;
  needsApprovalDelayMinutes?: number;
  allowAdaptiveTiming?: boolean;
  allowGoalAwareSequencing?: boolean;
  allowObjectionAwareSequencing?: boolean;
  stopOnHumanTakeover?: boolean;
  stopOnComplaint?: boolean;
  prohibitedPhrases?: string[];
};

export type AiPromptCompiled = {
  scope: AiPromptScope;
  compilerVersion: string;
  coverage?: {
    recognizedInstructions: string[];
    unsupportedInstructions: string[];
    ignoredText: string[];
    effectiveBehavior: Record<string, unknown>;
  };
  followUp?: FollowUpPromptCompiled;
  globalInstructions?: {
    tone?: string;
    responseLength?: string;
  };
};

export type AiPromptValidationResult = {
  valid: boolean;
  status: "VALID" | "INVALID";
  issues: AiPromptIssue[];
  unsupportedIssues: AiPromptIssue[];
  safetyIssues: AiPromptIssue[];
  capabilityIssues: AiPromptIssue[];
  conflictIssues: AiPromptIssue[];
  moduleIssues: AiPromptIssue[];
  compiled: AiPromptCompiled;
};

export type AiPromptCapabilities = {
  plan: PlanCode;
  scope: AiPromptScope;
  implemented: boolean;
  maxPromptLength: number;
  maxFollowUpAttempts?: number;
  postAppointmentFollowUp?: boolean;
  staleLeadRecovery?: boolean;
  adaptiveTiming?: boolean;
  goalAwareSequencing?: boolean;
  objectionAwareSequencing?: boolean;
  priorityLeadRecovery?: boolean;
  aiRewrite?: boolean;
  canActivate: boolean;
};

export type ResolvedAiPrompt = {
  scope: AiPromptScope;
  plan: PlanCode;
  capabilities: AiPromptCapabilities;
  globalPrompt: {
    versionId: string;
    versionNumber: number;
    compiled: Prisma.JsonValue | null;
  } | null;
  modulePrompt: {
    versionId: string;
    versionNumber: number;
    compiled: Prisma.JsonValue | null;
  } | null;
  platformRules: string[];
  productRules: string[];
  warnings?: Array<{
    code: string;
    message: string;
    metadata?: Record<string, unknown>;
  }>;
};

export const AI_PROMPT_COMPILER_VERSION = "2026-07-14.v1";

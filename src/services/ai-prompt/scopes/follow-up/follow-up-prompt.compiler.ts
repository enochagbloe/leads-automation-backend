import { AiPromptScope } from "@prisma/client";
import {
  AI_PROMPT_COMPILER_VERSION,
  AiPromptCapabilities,
  AiPromptCompiled,
  AiPromptIssue,
  FollowUpPromptCompiled,
} from "../../core/ai-prompt.types";

const MIN_FOLLOW_UP_DELAY_MINUTES = 5;
const MAX_FOLLOW_UP_DELAY_MINUTES = 30 * 24 * 60;
const MAX_APPROVAL_DELAY_MINUTES = 30 * 24 * 60;

function firstNumber(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  if (!match?.[1]) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function delayMinutes(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  if (!match?.[1]) return null;
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2]?.toLowerCase() ?? "day";
  if (unit.startsWith("hour")) return amount * 60;
  if (unit.startsWith("week")) return amount * 7 * 24 * 60;
  return amount * 24 * 60;
}

function addDelayIssue(input: {
  issues: AiPromptIssue[];
  code: string;
  message: string;
  value: number;
  min?: number;
  max?: number;
}) {
  input.issues.push({
    code: input.code,
    message: input.message,
    severity: "ERROR",
    source: "MODULE",
    metadata: {
      valueMinutes: input.value,
      ...(input.min !== undefined ? { minMinutes: input.min } : {}),
      ...(input.max !== undefined ? { maxMinutes: input.max } : {}),
    },
  });
}

function tone(text: string): FollowUpPromptCompiled["tone"] {
  if (/\bconcise|brief|short\b/i.test(text)) return "concise";
  if (/\bpolite|respectful\b/i.test(text)) return "polite";
  if (/\bfriendly|warm\b/i.test(text)) return "friendly";
  if (/\bprofessional\b/i.test(text)) return "professional";
  return undefined;
}

function wantsToContinueThroughHumanTakeover(text: string) {
  return /\b(continue|keep|still|do not stop|don't stop).{0,80}\b(message|text|follow up|following up|automation).{0,80}\b(human|staff|manager|agent|takeover|handoff)\b/i.test(text)
    || /\b(human|staff|manager|agent|takeover|handoff).{0,80}\b(continue|keep|still|do not stop|don't stop).{0,80}\b(message|text|follow up|following up|automation)\b/i.test(text);
}

function wantsToContinueThroughComplaint(text: string) {
  return /\b(continue|keep|still|do not stop|don't stop).{0,80}\b(message|text|follow up|following up|automation).{0,80}\b(complaint|complain|angry|upset|escalat|refund issue)\b/i.test(text)
    || /\b(complaint|complain|angry|upset|escalat|refund issue).{0,80}\b(continue|keep|still|do not stop|don't stop).{0,80}\b(message|text|follow up|following up|automation)\b/i.test(text);
}

function clauses(promptText: string) {
  return promptText
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .split(/\n+|(?<=[.!?;])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isTrivialClause(text: string) {
  return text.length < 8 || /^(please|thanks?|thank you|and|also)$/i.test(text);
}

function unique(values: string[]) {
  return [...new Set(values)];
}

export function compileFollowUpPrompt(promptText: string, capabilities: AiPromptCapabilities) {
  const issues: AiPromptIssue[] = [];
  const recognizedInstructions: string[] = [];
  const unsupportedInstructions: string[] = [];
  const ignoredText: string[] = [];
  const compiled: FollowUpPromptCompiled = {
    tone: tone(promptText),
    responseLength: /\b(short|brief|concise)\b/i.test(promptText) ? "short" : undefined,
    stopOnHumanTakeover: true,
    stopOnComplaint: true,
  };

  if (wantsToContinueThroughHumanTakeover(promptText)) {
    recognizedInstructions.push("hard_stop_human_takeover_attempted");
    issues.push({
      code: "HUMAN_TAKEOVER_STOP_REQUIRED",
      message: "Follow-up automation must stop when a human takes over. This rule cannot be changed by prompt instructions.",
      severity: "ERROR",
      source: "MODULE",
    });
  }

  if (wantsToContinueThroughComplaint(promptText)) {
    recognizedInstructions.push("hard_stop_complaint_attempted");
    issues.push({
      code: "COMPLAINT_STOP_REQUIRED",
      message: "Follow-up automation must stop or defer when a customer complaint is detected. This rule cannot be changed by prompt instructions.",
      severity: "ERROR",
      source: "MODULE",
    });
  }

  const requestedAttempts = firstNumber(promptText, /\b(?:send|use|up to|maximum|max|never more than)\s+(\d+)\s+(?:automated\s+)?follow[- ]?ups?\b/i);
  if (requestedAttempts !== null) {
    recognizedInstructions.push("maximum_attempts");
    const limit = capabilities.maxFollowUpAttempts ?? 1;
    if (requestedAttempts > limit) {
      issues.push({
        code: "FOLLOW_UP_ATTEMPTS_EXCEED_PLAN",
        message: `Your current plan allows up to ${limit} automated follow-up attempt${limit === 1 ? "" : "s"}.`,
        severity: "ERROR",
        source: "CAPABILITY",
        metadata: { requestedAttempts, limit },
      });
    }
    compiled.maximumAttempts = Math.min(requestedAttempts, limit);
  }

  const defaultDelay = delayMinutes(promptText, /\b(?:follow up|message|text).{0,30}\bafter\s+(\d+)\s+(hour|hours|day|days|week|weeks)\b/i);
  if (defaultDelay !== null) {
    recognizedInstructions.push("default_delay");
    if (defaultDelay < MIN_FOLLOW_UP_DELAY_MINUTES) {
      addDelayIssue({
        issues,
        code: "FOLLOW_UP_DELAY_TOO_SHORT",
        message: `Follow-up delay must be at least ${MIN_FOLLOW_UP_DELAY_MINUTES} minutes.`,
        value: defaultDelay,
        min: MIN_FOLLOW_UP_DELAY_MINUTES,
      });
    } else if (defaultDelay > MAX_FOLLOW_UP_DELAY_MINUTES) {
      addDelayIssue({
        issues,
        code: "FOLLOW_UP_DELAY_TOO_LONG",
        message: "Follow-up delay cannot be more than 30 days.",
        value: defaultDelay,
        max: MAX_FOLLOW_UP_DELAY_MINUTES,
      });
    } else {
      compiled.defaultDelayMinutes = defaultDelay;
    }
  }

  const approvalDelay = delayMinutes(promptText, /\b(?:approval|discuss|wife|husband|partner|boss|manager).{0,80}\b(?:wait|follow up after|message after)\s+(\d+)\s+(hour|hours|day|days|week|weeks)\b/i);
  if (approvalDelay !== null) {
    recognizedInstructions.push("needs_approval_delay");
    if (approvalDelay < MIN_FOLLOW_UP_DELAY_MINUTES) {
      addDelayIssue({
        issues,
        code: "FOLLOW_UP_APPROVAL_DELAY_TOO_SHORT",
        message: `Approval-related follow-up delay must be at least ${MIN_FOLLOW_UP_DELAY_MINUTES} minutes.`,
        value: approvalDelay,
        min: MIN_FOLLOW_UP_DELAY_MINUTES,
      });
    } else if (approvalDelay > MAX_APPROVAL_DELAY_MINUTES) {
      addDelayIssue({
        issues,
        code: "FOLLOW_UP_APPROVAL_DELAY_TOO_LONG",
        message: "Approval-related follow-up delay cannot be more than 30 days.",
        value: approvalDelay,
        max: MAX_APPROVAL_DELAY_MINUTES,
      });
    } else {
      compiled.needsApprovalDelayMinutes = approvalDelay;
    }
  }

  if (/\badaptive|choose.+best time|customer timing|preferred follow[- ]?up time\b/i.test(promptText)) {
    recognizedInstructions.push("adaptive_timing");
    if (!capabilities.adaptiveTiming) {
      issues.push({
        code: "ADAPTIVE_TIMING_NOT_AVAILABLE",
        message: "Adaptive follow-up timing is not available on your current plan.",
        severity: "ERROR",
        source: "CAPABILITY",
      });
    }
    compiled.allowAdaptiveTiming = Boolean(capabilities.adaptiveTiming);
  }

  if (/\bgoal[- ]?aware|customer goal|what the customer wants\b/i.test(promptText)) {
    recognizedInstructions.push("goal_aware_sequencing");
    if (!capabilities.goalAwareSequencing) {
      issues.push({
        code: "GOAL_AWARE_FOLLOW_UP_NOT_AVAILABLE",
        message: "Goal-aware follow-up sequencing is not available on your current plan.",
        severity: "ERROR",
        source: "CAPABILITY",
      });
    }
    compiled.allowGoalAwareSequencing = Boolean(capabilities.goalAwareSequencing);
  }

  if (/\bobjection|price concern|competitor|waiting for approval|lack of trust\b/i.test(promptText)) {
    recognizedInstructions.push("objection_aware_sequencing");
    if (!capabilities.objectionAwareSequencing) {
      issues.push({
        code: "OBJECTION_AWARE_FOLLOW_UP_NOT_AVAILABLE",
        message: "Objection-aware follow-up sequencing is not available on your current plan.",
        severity: "ERROR",
        source: "CAPABILITY",
      });
    }
    compiled.allowObjectionAwareSequencing = Boolean(capabilities.objectionAwareSequencing);
  }

  if (/\bstale lead|inactive lead|lead recovery\b/i.test(promptText) && !capabilities.staleLeadRecovery) {
    recognizedInstructions.push("stale_lead_recovery");
    issues.push({
      code: "STALE_LEAD_RECOVERY_NOT_AVAILABLE",
      message: "Stale lead recovery is not available on your current plan.",
      severity: "ERROR",
      source: "CAPABILITY",
    });
  }

  if (/\bpost[- ]?appointment|after appointment|feedback\b/i.test(promptText) && !capabilities.postAppointmentFollowUp) {
    recognizedInstructions.push("post_appointment_follow_up");
    issues.push({
      code: "POST_APPOINTMENT_FOLLOW_UP_NOT_AVAILABLE",
      message: "Post-appointment follow-up is not available on your current plan.",
      severity: "ERROR",
      source: "CAPABILITY",
    });
  }

  const prohibited = promptText.match(/\b(?:avoid|do not say|don't say|prohibited phrases?)[:\s]+([^\n.]+)/i)?.[1];
  if (prohibited) {
    recognizedInstructions.push("prohibited_phrases");
    compiled.prohibitedPhrases = prohibited.split(/,|;/).map((item) => item.trim()).filter(Boolean).slice(0, 20);
  }

  if (compiled.tone) recognizedInstructions.push("tone");
  if (compiled.responseLength) recognizedInstructions.push("response_length");

  for (const clause of clauses(promptText)) {
    const recognizedByClause = [
      /\bconcise|brief|short|polite|respectful|friendly|warm|professional\b/i,
      /\b(?:send|use|up to|maximum|max|never more than)\s+\d+\s+(?:automated\s+)?follow[- ]?ups?\b/i,
      /\b(?:follow up|message|text).{0,30}\bafter\s+\d+\s+(hour|hours|day|days|week|weeks)\b/i,
      /\b(?:approval|discuss|wife|husband|partner|boss|manager).{0,80}\b(?:wait|follow up after|message after)\s+\d+\s+(hour|hours|day|days|week|weeks)\b/i,
      /\badaptive|choose.+best time|customer timing|preferred follow[- ]?up time\b/i,
      /\bgoal[- ]?aware|customer goal|what the customer wants\b/i,
      /\bobjection|price concern|competitor|waiting for approval|lack of trust\b/i,
      /\bstale lead|inactive lead|lead recovery\b/i,
      /\bpost[- ]?appointment|after appointment|feedback\b/i,
      /\b(?:avoid|do not say|don't say|prohibited phrases?)[:\s]+/i,
    ].some((pattern) => pattern.test(clause))
      || wantsToContinueThroughHumanTakeover(clause)
      || wantsToContinueThroughComplaint(clause);
    if (!recognizedByClause && !isTrivialClause(clause)) unsupportedInstructions.push(clause);
  }

  for (const instruction of unique(unsupportedInstructions)) {
    issues.push({
      code: "FOLLOW_UP_UNSUPPORTED_INSTRUCTION",
      message: "This follow-up instruction is not supported by the current prompt compiler and will not be applied.",
      severity: "ERROR",
      source: "MODULE",
      metadata: { instruction },
    });
  }

  return {
    compiled: {
      scope: AiPromptScope.FOLLOW_UP,
      compilerVersion: AI_PROMPT_COMPILER_VERSION,
      coverage: {
        recognizedInstructions: unique(recognizedInstructions),
        unsupportedInstructions: unique(unsupportedInstructions),
        ignoredText: unique(ignoredText),
        effectiveBehavior: {
          ...compiled,
          stopOnHumanTakeover: true,
          stopOnComplaint: true,
        },
      },
      followUp: compiled,
    } satisfies AiPromptCompiled,
    issues,
  };
}

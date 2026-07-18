import { AiPromptIssue } from "../core/ai-prompt.types";

type SafetyIntentRule = {
  code: string;
  message: string;
  action: RegExp;
  target: RegExp;
  safeIntent?: RegExp;
};

const ZERO_WIDTH_CHARS = /[\u200B-\u200D\uFEFF]/g;

const INTENT_RULES: SafetyIntentRule[] = [
  {
    code: "CUSTOMER_OPT_OUT_OVERRIDE",
    action: /\b(ignore|disregard|override|bypass|skip|dismiss|do not honor|don't honor|keep messaging|continue messaging|keep contacting|continue contacting)\b/i,
    target: /\b(stop requests?|stop contacting|do not contact|don't contact|unsubscribe|opts?[- ]?out|opted[- ]?out|no more messages?|stop messaging)\b/i,
    safeIntent: /\b(do not|don't|dont|never|must not|should not)\s+(ignore|disregard|override|bypass|skip|dismiss)\b.{0,80}\b(stop requests?|stop contacting|do not contact|don't contact|unsubscribe|opts?[- ]?out|opted[- ]?out|no more messages?|stop messaging)\b/i,
    message: "Prompts cannot override customer opt-out or stop requests.",
  },
  {
    code: "BYPASS_HUMAN_TAKEOVER",
    action: /\b(ignore|disregard|override|bypass|skip|dismiss|keep messaging|continue messaging|keep following up|continue following up)\b/i,
    target: /\b(human|staff|manager|agent|team member|takes? control|takes? over|takeover|handoff|hand off)\b/i,
    safeIntent: /\b(do not|don't|dont|never|must not|should not)\s+(ignore|disregard|override|bypass|skip|dismiss|continue messaging|keep messaging|continue following up|keep following up)\b.{0,80}\b(human|staff|manager|agent|team member|takes? control|takes? over|takeover|handoff|hand off)\b/i,
    message: "Prompts cannot bypass human takeover or handoff rules.",
  },
  {
    code: "HIDE_COMPLAINTS",
    action: /\b(ignore|disregard|hide|suppress|do not escalate|don't escalate|avoid escalating|keep messaging|continue messaging|keep following up|continue following up)\b/i,
    target: /\b(complaint|complains?|angry|upset|refund issue|manager request|escalation)\b/i,
    safeIntent: /\b(do not|don't|dont|never|must not|should not)\s+(ignore|disregard|hide|suppress|continue messaging|keep messaging|continue following up|keep following up)\b.{0,80}\b(complaint|complains?|angry|upset|refund issue|manager request|escalation)\b/i,
    message: "Prompts cannot hide, suppress, or continue normal automation through complaints.",
  },
  {
    code: "SPAM_REPEATEDLY",
    action: /\b(keep|continue|always|repeatedly|forever)\b/i,
    target: /\b(message|text|follow up|following up|contact).{0,80}\b(until|forever|no matter|regardless)\b/i,
    safeIntent: /\b(do not|don't|dont|never|must not|should not)\s+(keep|continue|always|repeatedly)\b.{0,80}\b(message|text|follow up|following up|contact)\b/i,
    message: "Prompts cannot instruct the AI to keep messaging indefinitely.",
  },
  {
    code: "INVENT_BUSINESS_FACTS",
    action: /\b(invent|make up|fabricate|guess|assume)\b/i,
    target: /\b(price|pricing|policy|service|availability|timeline|discount|refund|deliverable)\b/i,
    safeIntent: /\b(do not|don't|dont|never|must not|should not)\s+(invent|make up|fabricate|guess|assume)\b.{0,80}\b(price|pricing|policy|service|availability|timeline|discount|refund|deliverable)\b/i,
    message: "Prompts cannot tell AI to invent business facts.",
  },
  {
    code: "UNAUTHORIZED_DISCOUNTS",
    action: /\b(always|automatically|freely|without approval|without asking)\b/i,
    target: /\b(discount|refund|waive|free|coupon|price reduction)\b/i,
    safeIntent: /\b(do not|don't|dont|never|must not|should not)\s+(always|automatically|freely)\b.{0,80}\b(discount|refund|waive|free|coupon|price reduction)\b/i,
    message: "Prompts cannot authorize discounts, refunds, or waived fees without backend truth.",
  },
  {
    code: "CONFIRM_APPOINTMENT_WITHOUT_BACKEND",
    action: /\b(confirm|guarantee|promise)\b/i,
    target: /\b(appointment|booking).{0,80}\b(without|before).{0,40}\b(backend|team|staff|availability|confirmation)\b/i,
    safeIntent: /\b(do not|don't|dont|never|must not|should not)\s+(confirm|guarantee|promise)\b.{0,80}\b(appointment|booking).{0,80}\b(without|before).{0,40}\b(backend|team|staff|availability|confirmation)\b/i,
    message: "Prompts cannot confirm appointments without backend confirmation.",
  },
];

function normalizePromptText(promptText: string) {
  return promptText
    .normalize("NFKC")
    .replace(ZERO_WIDTH_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSafetySentences(promptText: string) {
  return normalizePromptText(promptText)
    .split(/(?<=[.!?;:])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function issueForRule(sentence: string, rule: SafetyIntentRule): AiPromptIssue | null {
  const actionMatch = rule.action.exec(sentence);
  if (!actionMatch || actionMatch.index === undefined) return null;
  if (!rule.target.test(sentence)) return null;
  if (rule.safeIntent?.test(sentence)) return null;
  return {
    code: rule.code,
    message: rule.message,
    severity: "ERROR",
    source: "SAFETY",
    metadata: { matchedText: sentence.slice(0, 240) },
  };
}

function semanticSafetyIssues(promptText: string) {
  const issues: AiPromptIssue[] = [];
  for (const sentence of splitSafetySentences(promptText)) {
    for (const rule of INTENT_RULES) {
      const issue = issueForRule(sentence, rule);
      if (issue && !issues.some((existing) => existing.code === issue.code)) issues.push(issue);
    }
  }
  return issues;
}

export const aiPromptSafetyService = {
  normalizePromptText,
  validate(promptText: string): AiPromptIssue[] {
    return semanticSafetyIssues(promptText);
  },
};

import { PremiumFollowUpSequenceStage } from "@prisma/client";

const MAX_MESSAGE_LENGTH = 500;
const INTERNAL_LANGUAGE = [
  /\b(?:AI|RAG|model|decision engine|internal status|confidence score|system prompt)\b/i,
  /\b(?:escalated because|complaint detected|provider failed)\b/i,
];
const PRESSURE_LANGUAGE = [
  /\blast chance\b/i,
  /\bact now\b/i,
  /\byou(?:'ll| will) lose\b/i,
  /\bmust respond\b/i,
  /\burgent offer\b/i,
];
const UNSUPPORTED_COMMERCIAL_FACT = [
  /\b\d+(?:\.\d+)?%\s*(?:off|discount)\b/i,
  /\b(?:special|exclusive|guaranteed)\s+(?:discount|offer|saving)\b/i,
  /(?:GHS|USD|EUR|GBP|GH₵|\$|€|£)\s*\d/i,
  /\b(?:free|complimentary)\s+(?:service|consultation|delivery)\b/i,
];
const UNSUPPORTED_FACT_CLAIMS = [
  {
    issue: "UNSUPPORTED_AVAILABILITY_CLAIM",
    patterns: [
      /\b(?:we|our team|our staff|a technician|an? installer)\s+(?:are|is|will be)\s+available\s+(?:today|tomorrow|now|immediately|on|at|from|until|this|next)\b/i,
      /\b(?:appointments?|slots?|openings?|times?)\s+(?:are|is|remain)\s+(?:currently\s+)?available\b/i,
      /\bwe\s+(?:have|can offer)\s+(?:an?\s+)?(?:slot|opening)\b/i,
      /\bavailability\s+(?:is|has been)\s+(?:confirmed|guaranteed|reserved)\b/i,
      /\bwe(?:'re| are)\s+open\s+(?:today|tomorrow|on|from|until|between)\b/i,
    ],
  },
  {
    issue: "UNSUPPORTED_SERVICE_FEATURE_CLAIM",
    patterns: [
      /\b(?:our|the)\s+(?:service|package|plan|installation|consultation)\s+(?:includes?|comes with|provides?|offers?|covers?)\b/i,
      /\bwe\s+(?:include|provide|offer)\s+(?:free\s+)?(?:support|maintenance|materials?|equipment|installation|training|consultation|inspection)\b/i,
      /\bfeatures?\s+(?:include|are|consist of)\b/i,
      /\b(?:included|built-in|complimentary)\s+(?:feature|support|maintenance|installation|delivery)\b/i,
    ],
  },
  {
    issue: "UNSUPPORTED_DELIVERY_CLAIM",
    patterns: [
      /\b(?:we|our team)\s+(?:will|can)\s+(?:deliver|complete|finish|install)\s+(?:by|on|within|in)\b/i,
      /\b(?:delivery|completion|installation|turnaround)\s+(?:is|takes?|will take|will be)\s+(?:by|on|within|in|\d)\b/i,
      /\b(?:your|the)\s+(?:order|project|service|work)\s+(?:will be|is)\s+(?:delivered|completed|finished|ready)\s+(?:by|on|within|in)\b/i,
      /\b(?:delivered|completed|finished|ready)\s+by\s+\b/i,
    ],
  },
  {
    issue: "UNSUPPORTED_GUARANTEE_CLAIM",
    patterns: [
      /\bwe\s+(?:guarantee|promise|assure)\b/i,
      /\b(?:guaranteed|assured)\s+(?:result|outcome|success|delivery|completion|quality|approval)\b/i,
      /\b100%\s+(?:guaranteed|effective|successful|safe)\b/i,
      /\brisk[- ]free\b/i,
      /\b(?:our|the)\s+(?:service|work|product|result)\s+(?:is|comes)\s+(?:fully\s+)?guaranteed\b/i,
    ],
  },
  {
    issue: "UNSUPPORTED_POLICY_CLAIM",
    patterns: [
      /\b(?:our|the|company)\s+(?:refund|return|cancellation|payment|deposit|warranty|privacy)\s+policy\b/i,
      /\baccording to\s+(?:our|the company)\s+policy\b/i,
      /\b(?:refunds?|returns?|cancellations?)\s+(?:are|must|will|can|cannot|can't|won't)\b/i,
      /\b(?:a\s+)?(?:deposit|full payment|payment)\s+(?:is\s+)?(?:required|mandatory|non[- ]refundable|due)\b/i,
      /\b(?:terms|policy)\s+(?:require|allow|prohibit|state)\b/i,
    ],
  },
] as const;

function normalizedWords(value: string) {
  return new Set(
    value.toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2),
  );
}

export function messageSimilarity(left: string, right: string) {
  const a = normalizedWords(left);
  const b = normalizedWords(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((word) => b.has(word)).length;
  return intersection / Math.max(a.size, b.size);
}

export function validatePremiumFollowUpMessage(input: {
  message: string;
  sequenceStage: PremiumFollowUpSequenceStage;
  prohibitedPhrases: string[];
  previousMessages: string[];
  appointmentStatus: string | null;
  appointmentTimeText: string | null;
}) {
  const message = input.message.replace(/\s+/g, " ").trim();
  const issues: string[] = [];
  if (message.length < 8) issues.push("MESSAGE_TOO_SHORT");
  if (message.length > MAX_MESSAGE_LENGTH) issues.push("MESSAGE_TOO_LONG");
  if ((message.match(/\?/g) ?? []).length > 1) issues.push("TOO_MANY_QUESTIONS");
  if (INTERNAL_LANGUAGE.some((pattern) => pattern.test(message))) issues.push("INTERNAL_INFORMATION_EXPOSED");
  if (PRESSURE_LANGUAGE.some((pattern) => pattern.test(message))) issues.push("PRESSURE_LANGUAGE_NOT_ALLOWED");
  if (UNSUPPORTED_COMMERCIAL_FACT.some((pattern) => pattern.test(message))) {
    issues.push("UNSUPPORTED_COMMERCIAL_FACT");
  }
  for (const claim of UNSUPPORTED_FACT_CLAIMS) {
    if (claim.patterns.some((pattern) => pattern.test(message))) {
      issues.push(claim.issue);
    }
  }
  if (
    input.prohibitedPhrases.some((phrase) => (
      phrase.trim() && message.toLowerCase().includes(phrase.trim().toLowerCase())
    ))
  ) {
    issues.push("PROHIBITED_PHRASE_USED");
  }
  if (
    input.previousMessages.some((previous) => messageSimilarity(message, previous) >= 0.78)
  ) {
    issues.push("MESSAGE_SUBSTANTIALLY_DUPLICATED");
  }
  if (
    input.appointmentStatus
    && !["CONFIRMED", "RESCHEDULED"].includes(input.appointmentStatus)
    && /\b(?:confirmed|scheduled for|see you at|appointment is set)\b/i.test(message)
  ) {
    issues.push("APPOINTMENT_FALSELY_CONFIRMED");
  }
  if (
    input.appointmentTimeText
    && /\b(?:appointment|booking)\b/i.test(message)
    && /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(message)
    && !message.toLowerCase().includes(input.appointmentTimeText.toLowerCase())
  ) {
    issues.push("APPOINTMENT_TIME_NOT_CURRENT");
  }
  if (
    input.sequenceStage === PremiumFollowUpSequenceStage.FINAL_POLITE_FOLLOW_UP
    && !/\b(?:final|whenever|when you(?:'re| are) ready|if you still need help)\b/i.test(message)
  ) {
    issues.push("FINAL_STAGE_PURPOSE_MISMATCH");
  }
  return { valid: issues.length === 0, message, issues };
}

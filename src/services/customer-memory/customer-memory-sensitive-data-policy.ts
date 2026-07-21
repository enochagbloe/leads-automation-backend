import {
  CustomerMemoryCategory,
  CustomerMemorySensitiveDataPolicy,
  CustomerMemorySourceType,
  Prisma,
} from "@prisma/client";
import { ExtractedMemory } from "./customer-memory.types";

export const CUSTOMER_MEMORY_SENSITIVE_DATA_POLICY_VERSION = "customer-memory-sensitive-v1";

export function usableCustomerMemoryPolicyWhere(now = new Date()) {
  return {
    sensitiveDataPolicyVersion: CUSTOMER_MEMORY_SENSITIVE_DATA_POLICY_VERSION,
    OR: [
      { retentionExpiresAt: null },
      { retentionExpiresAt: { gt: now } },
    ],
  } satisfies Prisma.CustomerMemoryItemWhereInput;
}

const REDACTED = {
  email: "[EMAIL_REDACTED]",
  phone: "[PHONE_REDACTED]",
  location: "[PRECISE_LOCATION_REDACTED]",
} as const;

const HARD_SECRET_PATTERNS = [
  /\b(?:password|passwd|passcode|login secret|private key|secret key)\s*(?:is|:|=)\s*\S+/i,
  /\b(?:otp|one[- ]?time (?:password|code)|verification code|authentication code|security code)\s*(?:is|:|=)?\s*\d{4,8}\b/i,
  /\b(?:cvv|cvc|card security code)\s*(?:is|:|=)?\s*\d{3,4}\b/i,
  /\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|bearer token|client secret)\s*(?:is|:|=)\s*[A-Za-z0-9._~+\/-]{8,}\b/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{10,}\b/i,
  /\b(?:sk|pk|rk|ghp|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{12,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:bank account|account number|routing number|sort code)\s*(?:is|:|=)?\s*\d(?:[\d -]?){5,33}\b/i,
  /\b(?:iban|swift code)\s*(?:is|:|=)?\s*[A-Z]{2,4}[A-Z0-9 -]{6,30}\b/i,
  /https?:\/\/\S+(?:token|signature|sig|secret|auth|key|password|reset|invite)=?\S*/i,
  /https?:\/\/\S+\/(?:reset|invite|magic|verify|private|access)\/[A-Za-z0-9_-]{8,}\b/i,
];

const EXPLICIT_CONFIGURATION_PATTERNS = [
  /\b(?:passport|national id|identity card|driver'?s licen[cs]e|social security|ssn|ghana card)\s*(?:number|no\.?|is|:|=)?\s*[A-Z0-9-]{5,}\b/i,
  /\b(?:diagnosed|diagnosis|medical condition|health condition|prescription|medication|allergy|patient id|medical record)\b/i,
];

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const INTERNATIONAL_PHONE_PATTERN = /(?<!\w)\+\d(?:[\s().-]?\d){7,14}(?!\d)/g;
const LOCAL_PHONE_PATTERN = /\b0\d{9}\b/g;
const LABELED_PHONE_PATTERN = /\b(?:phone|mobile|whatsapp|telephone|contact number)\s*(?:is|:|=)?\s*\+?\d(?:[\s().-]?\d){7,14}\b/gi;
const PRECISE_ADDRESS_PATTERN = /\b\d{1,6}\s+[A-Za-z0-9.' -]{2,60}\s(?:street|st|road|rd|avenue|ave|lane|ln|close|drive|dr|highway|hwy|house|apartment|apt|flat)\b[^,.;]*/gi;
const LABELED_PRECISE_ADDRESS_PATTERN = /\b(?:home|street|full|residential|delivery|service)?\s*address\s*(?:is|:|=)\s*(?=[^;\n]{0,100}\d)[^;\n]{1,160}/gi;
const NUMBERED_PRECISE_LOCATION_PATTERN = /\b(?:house|plot|block|apartment|apt|flat)\s*(?:no\.?|number|#)?\s*[A-Za-z0-9-]{1,12}\b[^;.\n]{0,100}/gi;
const COORDINATE_PATTERN = /(?<!\d)-?\d{1,2}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}(?!\d)/g;

const HARD_SECRET_KEYS = /(?:password|passwd|passcode|otp|one_time|verification_code|auth(?:entication)?_?token|access_?token|api_?key|client_?secret|private_?key|cvv|cvc|card_?number|bank_?account|routing_?number|iban|swift)/i;
const EXPLICIT_CONFIGURATION_KEYS = /(?:passport|national_?id|identity|driver.*licen[cs]e|social_?security|medical|health|diagnosis|prescription|medication|patient)/i;
const EMAIL_KEYS = /(?:^|_)(?:email|email_address)(?:$|_)/i;
const PHONE_KEYS = /(?:^|_)(?:phone|mobile|whatsapp|telephone|contact_number)(?:$|_)/i;
const PRECISE_LOCATION_KEYS = /(?:street_?address|full_?address|home_?address|gps|coordinates|latitude|longitude)/i;

function luhnValid(value: string) {
  let sum = 0;
  let doubleDigit = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function containsPaymentCard(value: string) {
  const candidates = value.match(/(?:\d[ -]?){13,19}/g) ?? [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
  });
}

function classifyText(value: string) {
  if (HARD_SECRET_PATTERNS.some((pattern) => pattern.test(value)) || containsPaymentCard(value)) {
    return { policy: CustomerMemorySensitiveDataPolicy.DO_NOT_STORE, value: "" };
  }
  if (EXPLICIT_CONFIGURATION_PATTERNS.some((pattern) => pattern.test(value))) {
    return { policy: CustomerMemorySensitiveDataPolicy.REQUIRES_EXPLICIT_BUSINESS_CONFIGURATION, value: "" };
  }
  const redacted = value
    .replace(EMAIL_PATTERN, REDACTED.email)
    .replace(LABELED_PHONE_PATTERN, REDACTED.phone)
    .replace(INTERNATIONAL_PHONE_PATTERN, REDACTED.phone)
    .replace(LOCAL_PHONE_PATTERN, REDACTED.phone)
    .replace(PRECISE_ADDRESS_PATTERN, REDACTED.location)
    .replace(LABELED_PRECISE_ADDRESS_PATTERN, REDACTED.location)
    .replace(NUMBERED_PRECISE_LOCATION_PATTERN, REDACTED.location)
    .replace(COORDINATE_PATTERN, REDACTED.location);
  return {
    policy: redacted === value ? CustomerMemorySensitiveDataPolicy.ALLOWED : CustomerMemorySensitiveDataPolicy.REDACT,
    value: redacted,
  };
}

function strongerPolicy(left: CustomerMemorySensitiveDataPolicy, right: CustomerMemorySensitiveDataPolicy) {
  const priority: Record<CustomerMemorySensitiveDataPolicy, number> = {
    ALLOWED: 0,
    REDACT: 1,
    REQUIRES_EXPLICIT_BUSINESS_CONFIGURATION: 2,
    DO_NOT_STORE: 3,
  };
  return priority[right] > priority[left] ? right : left;
}

function sanitizeStructuredSensitiveData(value: unknown, key = "", depth = 0): {
  policy: CustomerMemorySensitiveDataPolicy;
  value: unknown;
} {
  if (depth > 6 || value === undefined) return { policy: CustomerMemorySensitiveDataPolicy.ALLOWED, value: null };
  if (HARD_SECRET_KEYS.test(key)) return { policy: CustomerMemorySensitiveDataPolicy.DO_NOT_STORE, value: null };
  if (EXPLICIT_CONFIGURATION_KEYS.test(key)) {
    return { policy: CustomerMemorySensitiveDataPolicy.REQUIRES_EXPLICIT_BUSINESS_CONFIGURATION, value: null };
  }
  if (typeof value === "string") {
    if (EMAIL_KEYS.test(key)) return { policy: CustomerMemorySensitiveDataPolicy.REDACT, value: REDACTED.email };
    if (PHONE_KEYS.test(key)) return { policy: CustomerMemorySensitiveDataPolicy.REDACT, value: REDACTED.phone };
    if (PRECISE_LOCATION_KEYS.test(key)) return { policy: CustomerMemorySensitiveDataPolicy.REDACT, value: REDACTED.location };
    return classifyText(value);
  }
  if (typeof value === "number" && Number.isInteger(value) && containsPaymentCard(String(value))) {
    return { policy: CustomerMemorySensitiveDataPolicy.DO_NOT_STORE, value: null };
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return { policy: CustomerMemorySensitiveDataPolicy.ALLOWED, value };
  }
  if (Array.isArray(value)) {
    let policy: CustomerMemorySensitiveDataPolicy = CustomerMemorySensitiveDataPolicy.ALLOWED;
    const sanitized = value.slice(0, 50).map((entry) => {
      const result = sanitizeStructuredSensitiveData(entry, key, depth + 1);
      policy = strongerPolicy(policy, result.policy);
      return result.value;
    });
    return { policy, value: sanitized };
  }
  if (typeof value === "object") {
    let policy: CustomerMemorySensitiveDataPolicy = CustomerMemorySensitiveDataPolicy.ALLOWED;
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 50).map(([entryKey, entryValue]) => {
      const result = sanitizeStructuredSensitiveData(entryValue, entryKey, depth + 1);
      policy = strongerPolicy(policy, result.policy);
      return [entryKey, result.value] as const;
    });
    return { policy, value: Object.fromEntries(entries) };
  }
  return { policy: CustomerMemorySensitiveDataPolicy.ALLOWED, value: null };
}

function retentionDays(memory: ExtractedMemory, policy: CustomerMemorySensitiveDataPolicy) {
  if (policy === CustomerMemorySensitiveDataPolicy.REDACT) return 30;
  if (/budget/i.test(memory.memoryKey)) return 180;
  if (/(?:location|address|city|region)/i.test(memory.memoryKey)) return 90;
  if (
    memory.category === CustomerMemoryCategory.MISSING_DETAIL
    || memory.category === CustomerMemoryCategory.UNRESOLVED_REQUEST
  ) return 30;
  if (
    memory.category === CustomerMemoryCategory.TIMING_STATEMENT
    || memory.category === CustomerMemoryCategory.LAST_CUSTOMER_ACTION
    || memory.category === CustomerMemoryCategory.LAST_STAFF_ACTION
  ) return 90;
  if (
    memory.sourceType === CustomerMemorySourceType.LEAD
    || memory.sourceType === CustomerMemorySourceType.APPOINTMENT
    || memory.sourceType === CustomerMemorySourceType.SYSTEM_EVENT
  ) return 30;
  return 365;
}

export function applyCustomerMemorySensitiveDataPolicy(memory: ExtractedMemory, retainedFrom = new Date()) {
  const keyPolicy = HARD_SECRET_KEYS.test(memory.memoryKey)
    ? CustomerMemorySensitiveDataPolicy.DO_NOT_STORE
    : EXPLICIT_CONFIGURATION_KEYS.test(memory.memoryKey)
      ? CustomerMemorySensitiveDataPolicy.REQUIRES_EXPLICIT_BUSINESS_CONFIGURATION
      : CustomerMemorySensitiveDataPolicy.ALLOWED;
  let text = classifyText(memory.valueText);
  if (text.policy === CustomerMemorySensitiveDataPolicy.ALLOWED && EMAIL_KEYS.test(memory.memoryKey)) {
    text = { policy: CustomerMemorySensitiveDataPolicy.REDACT, value: REDACTED.email };
  } else if (text.policy === CustomerMemorySensitiveDataPolicy.ALLOWED && PHONE_KEYS.test(memory.memoryKey)) {
    text = { policy: CustomerMemorySensitiveDataPolicy.REDACT, value: REDACTED.phone };
  }
  const source = memory.sourceStatement ? classifyText(memory.sourceStatement) : null;
  const structured = memory.structuredValue === undefined
    ? { policy: CustomerMemorySensitiveDataPolicy.ALLOWED, value: undefined }
    : sanitizeStructuredSensitiveData(memory.structuredValue);
  const policy = [keyPolicy, source?.policy, structured.policy]
    .filter((value): value is CustomerMemorySensitiveDataPolicy => Boolean(value))
    .reduce(strongerPolicy, text.policy);

  if (
    policy === CustomerMemorySensitiveDataPolicy.DO_NOT_STORE
    || policy === CustomerMemorySensitiveDataPolicy.REQUIRES_EXPLICIT_BUSINESS_CONFIGURATION
  ) {
    return { policy, memory: null, retentionExpiresAt: null };
  }

  const days = retentionDays(memory, policy);
  return {
    policy,
    memory: {
      ...memory,
      valueText: text.value,
      structuredValue: structured.value === undefined ? undefined : structured.value as Prisma.InputJsonValue,
      sourceStatement: source?.value || undefined,
    },
    retentionExpiresAt: new Date(retainedFrom.getTime() + days * 24 * 60 * 60 * 1_000),
  };
}

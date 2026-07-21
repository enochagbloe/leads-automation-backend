import { Prisma } from "@prisma/client";
import { ExtractedMemory } from "./customer-memory.types";

const ZERO_WIDTH_AND_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
const ROLE_DELIMITER = /<\|\s*(?:system|assistant|developer|user)[^|]*\|>|^\s*(?:system|developer|assistant)\s*:/im;

const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b.{0,80}\b(?:previous|prior|above|all|system|developer|business|safety)\b.{0,40}\b(?:instruction|prompt|rule|policy|message)s?\b/i,
  /\b(?:previous|prior|above|system|developer|safety)\b.{0,40}\b(?:instruction|prompt|rule|policy|message)s?\b.{0,40}\b(?:ignore|disregard|forget|override|bypass)\b/i,
  /\b(?:reveal|show|print|repeat|expose|leak)\b.{0,80}\b(?:system prompt|developer message|instruction|secret|credential|access token|api key)s?\b/i,
  /\b(?:you are now|act as|behave as|change your role|assume the role)\b/i,
  /\b(?:when you reply|when responding|in future replies|for every response|output only|return only)\b/i,
  /\b(?:ai|assistant|chatbot|bot|model)\s+(?:must|should|shall|has to)\b/i,
  /\b(?:do not|don't|dont|never)\s+(?:follow|obey|respect|apply)\b.{0,60}\b(?:instruction|rule|policy|safety|guardrail)s?\b/i,
  /\b(?:treat|use)\s+(?:this|the)\s+(?:memory|text|message)\s+as\s+(?:an?\s+)?(?:instruction|prompt|command)\b/i,
];

export type CustomerMemoryTextSafety = {
  safe: boolean;
  value: string;
  reason?: "EMPTY" | "INSTRUCTION_LIKE";
};

export function sanitizeCustomerMemoryText(value: string, maxLength = 600): CustomerMemoryTextSafety {
  const canonical = value
    .normalize("NFKC")
    .replace(ZERO_WIDTH_AND_CONTROL, "")
    .replace(/\s+/g, " ")
    .trim();
  const normalized = canonical
    .replace(/```+/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

  if (!normalized) return { safe: false, value: "", reason: "EMPTY" };
  if (ROLE_DELIMITER.test(canonical) || INSTRUCTION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { safe: false, value: "", reason: "INSTRUCTION_LIKE" };
  }
  return { safe: true, value: normalized };
}

function sanitizeStructuredValue(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === undefined) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const sanitized = sanitizeCustomerMemoryText(value, 600);
    return sanitized.safe ? sanitized.value : null;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeStructuredValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50).flatMap(([key, entryValue]) => {
      const safeKey = key.normalize("NFKC").replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80);
      return safeKey ? [[safeKey, sanitizeStructuredValue(entryValue, depth + 1)]] : [];
    }));
  }
  return null;
}

export function sanitizeExtractedCustomerMemory(memory: ExtractedMemory): ExtractedMemory | null {
  const valueText = sanitizeCustomerMemoryText(memory.valueText, 600);
  if (!valueText.safe) return null;
  const memoryKey = memory.memoryKey
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  if (!memoryKey) return null;
  const sourceStatement = memory.sourceStatement
    ? sanitizeCustomerMemoryText(memory.sourceStatement, 600)
    : null;
  return {
    ...memory,
    memoryKey,
    valueText: valueText.value,
    structuredValue: memory.structuredValue === undefined
      ? undefined
      : sanitizeStructuredValue(memory.structuredValue) as Prisma.InputJsonValue,
    sourceStatement: sourceStatement?.safe ? sourceStatement.value : undefined,
  };
}

export const CUSTOMER_MEMORY_TRUST_CLASSIFICATION = "UNTRUSTED_CUSTOMER_DERIVED_DATA" as const;

import { AppError } from "../utils/errors";

export const providerCategories = ["MISSING_CREDENTIALS", "MISSING_MODEL", "INSUFFICIENT_CREDITS", "AUTHENTICATION", "RATE_LIMIT", "MODEL_UNAVAILABLE", "REQUEST_REJECTED", "PROVIDER_UNAVAILABLE", "EMPTY_RESPONSE", "INVALID_RESPONSE", "REFUSAL", "TIMEOUT", "ABORTED", "TRANSPORT"] as const;
export type ProviderCategory = typeof providerCategories[number];
export type ProviderAttempt = { model: string; httpStatus: number | null; category: ProviderCategory };
export function diagnosticModel(model: string) {
  return /^[a-zA-Z0-9_./:@+-]{1,180}$/.test(model) ? model : "UNKNOWN";
}
export function httpCategory(status: number): ProviderCategory {
  if (status === 402) return "INSUFFICIENT_CREDITS";
  if (status === 401 || status === 403) return "AUTHENTICATION";
  if (status === 429) return "RATE_LIMIT";
  if (status === 404) return "MODEL_UNAVAILABLE";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  return "REQUEST_REJECTED";
}

/** Whitelist diagnostics at each logging boundary; never spread provider/error payloads. */
export function safeProviderDiagnostics(error: unknown) {
  if (!(error instanceof AppError)) return undefined;
  const value = error.context?.providerDiagnostics as Record<string, unknown> | undefined;
  if (!value || typeof value !== "object") return undefined;
  return {
    provider: "OPENROUTER",
    primaryModel: diagnosticModel(typeof value.primaryModel === "string" ? value.primaryModel : ""),
    providerRequestCount: typeof value.providerRequestCount === "number" && Number.isFinite(value.providerRequestCount) ? Math.max(0, Math.min(11, value.providerRequestCount)) : 0,
    fallbackOutcome: ["DISABLED_BY_CALLER", "EXHAUSTED", "NOT_CONFIGURED", "SKIPPED_BILLING", "ABORTED"].includes(String(value.fallbackOutcome)) ? value.fallbackOutcome : "NOT_CONFIGURED",
    attempts: (Array.isArray(value.attempts) ? value.attempts : []).slice(0, 11).map((item: unknown) => {
      const attempt = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        model: diagnosticModel(typeof attempt.model === "string" ? attempt.model : ""),
        httpStatus: typeof attempt.httpStatus === "number" && Number.isInteger(attempt.httpStatus) && attempt.httpStatus >= 100 && attempt.httpStatus <= 599 ? attempt.httpStatus : null,
        category: providerCategories.includes(attempt.category as ProviderCategory) ? attempt.category : "INVALID_RESPONSE",
      };
    }),
  };
}

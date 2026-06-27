import "dotenv/config";
import { z } from "zod";

const optionalString = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());
const credentialKeyId = z.string().regex(/^[A-Za-z0-9_-]+$/).default("primary");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  DB_CONNECTION_LIMIT: z.coerce.number().int().positive().default(3),
  DB_POOL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
  DB_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(15),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN_DAYS: z.coerce.number().int().positive().default(30),
  APP_URL: z.string().url().default("http://localhost:3000"),
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  REDIS_URL: optionalString,
  CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(5000),
  CACHE_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  RESEND_API_KEY: optionalString,
  EMAIL_FROM: z.string().min(1),
  WHATSAPP_PROVIDER_MODE: z.enum(["mock", "live"]).default("mock"),
  MOCK_WHATSAPP_FORCE_FAILURE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  ENABLE_DEV_TOOLS: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  META_WHATSAPP_ACCESS_TOKEN: optionalString,
  META_WHATSAPP_PHONE_NUMBER_ID: optionalString,
  META_WHATSAPP_BUSINESS_ACCOUNT_ID: optionalString,
  META_WHATSAPP_VERIFY_TOKEN: optionalString,
  META_APP_ID: optionalString,
  META_APP_SECRET: optionalString,
  META_API_VERSION: z.string().min(1).default("v20.0"),
  WHATSAPP_CREDENTIAL_KEY_ID: credentialKeyId,
  WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: optionalString,
  WHATSAPP_CREDENTIAL_DECRYPTION_KEYS: optionalString,
  OPENROUTER_API_KEY: optionalString,
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_DEFAULT_MODEL: optionalString,
  OPENROUTER_FALLBACK_MODELS: z.string().default("").transform((value) =>
    value.split(",").map((model) => model.trim()).filter(Boolean)),
  OPENROUTER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  OPENROUTER_MAX_FALLBACK_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(2),
  OPENROUTER_APP_NAME: z.string().min(1).default("BizReply AI"),
  OPENROUTER_APP_URL: optionalString,
  AI_REPLY_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  AI_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.75),
  AI_MAX_CONTEXT_MESSAGES: z.coerce.number().int().positive().max(50).default(12),
  AI_MAX_BUSINESS_CONTEXT_TOKENS: z.coerce.number().int().positive().default(6000),
}).superRefine((value, context) => {
  if (value.NODE_ENV === "production" && !value.RESEND_API_KEY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["RESEND_API_KEY"],
      message: "RESEND_API_KEY is required in production",
    });
  }
  if (value.WHATSAPP_PROVIDER_MODE === "live") {
    const required = [
      "META_WHATSAPP_VERIFY_TOKEN",
      "META_APP_ID",
      "META_APP_SECRET",
    ] as const;
    for (const key of required) {
      if (!value[key]) context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required in live WhatsApp mode` });
    }
    if (!value.WHATSAPP_CREDENTIAL_ENCRYPTION_KEY || value.WHATSAPP_CREDENTIAL_ENCRYPTION_KEY.length < 32) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WHATSAPP_CREDENTIAL_ENCRYPTION_KEY"],
        message: "WHATSAPP_CREDENTIAL_ENCRYPTION_KEY must be at least 32 characters in live WhatsApp mode",
      });
    }
  }
  if (value.WHATSAPP_CREDENTIAL_DECRYPTION_KEYS) {
    try {
      const keys = JSON.parse(value.WHATSAPP_CREDENTIAL_DECRYPTION_KEYS) as unknown;
      if (!keys || typeof keys !== "object" || Array.isArray(keys) || Object.values(keys).some((key) => typeof key !== "string" || key.length < 32)) {
        throw new Error("Invalid keyring");
      }
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WHATSAPP_CREDENTIAL_DECRYPTION_KEYS"],
        message: "WHATSAPP_CREDENTIAL_DECRYPTION_KEYS must be a JSON object of key IDs to keys of at least 32 characters",
      });
    }
  }
  if (value.AI_REPLY_ENABLED && !value.OPENROUTER_API_KEY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["OPENROUTER_API_KEY"],
      message: "OPENROUTER_API_KEY is required when AI_REPLY_ENABLED=true",
    });
  }
  if (value.AI_REPLY_ENABLED && !value.OPENROUTER_DEFAULT_MODEL) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["OPENROUTER_DEFAULT_MODEL"],
      message: "OPENROUTER_DEFAULT_MODEL is required when AI_REPLY_ENABLED=true",
    });
  }
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const corsOrigins = env.CORS_ORIGINS.split(",").map((origin) => origin.trim());

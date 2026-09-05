import "dotenv/config";
import { z } from "zod";
import {
  STORAGE_ENVIRONMENTS,
  type StorageEnvironment,
  validateStorageEnvironment,
} from "./storage-environment-policy";

const optionalString = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());
const credentialKeyId = z.string().regex(/^[A-Za-z0-9_-]+$/).default("primary");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DEPLOYMENT_ENVIRONMENT: z.enum(STORAGE_ENVIRONMENTS).optional(),
  DEMO_ENABLED: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  DEMO_SESSION_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(60),
  DEMO_MAX_ACTIVE_SESSIONS_PER_IP: z.coerce.number().int().min(1).max(20).default(3),
  DEMO_CLEANUP_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
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
  WAITLIST_CONFIRMATION_URL: z.string().url().default("https://bizreplyhq.com/waitlist/confirm"),
  WAITLIST_CONFIRMATION_EXPIRY_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  WAITLIST_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(30).max(3600).default(60),
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
  OPENROUTER_EMBEDDING_MODEL: optionalString,
  OPENROUTER_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  OPENROUTER_FALLBACK_MODELS: z.string().default("").transform((value) =>
    value.split(",").map((model) => model.trim()).filter(Boolean)),
  OPENROUTER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  OPENROUTER_MAX_FALLBACK_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(2),
  OPENROUTER_APP_NAME: z.string().min(1).default("BizReply AI"),
  OPENROUTER_APP_URL: optionalString,
  AI_REPLY_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  AI_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.75),
  AI_AUTO_CONFIRM_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.85),
  PREMIUM_APPOINTMENT_AUTO_CONFIRM_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  AI_MAX_CONTEXT_MESSAGES: z.coerce.number().int().positive().max(50).default(12),
  AI_MAX_BUSINESS_CONTEXT_TOKENS: z.coerce.number().int().positive().default(6000),
  KNOWLEDGE_BASIC_ASSET_LIMIT: z.coerce.number().int().nonnegative().default(5),
  KNOWLEDGE_PLUS_ASSET_LIMIT: z.coerce.number().int().nonnegative().default(50),
  KNOWLEDGE_PREMIUM_ASSET_LIMIT: z.coerce.number().int().nonnegative().default(200),
  KNOWLEDGE_BASIC_AI_DRAFT_LIMIT: z.coerce.number().int().nonnegative().default(0),
  KNOWLEDGE_PLUS_AI_DRAFT_LIMIT: z.coerce.number().int().nonnegative().default(20),
  KNOWLEDGE_PREMIUM_AI_DRAFT_LIMIT: z.coerce.number().int().nonnegative().default(100),
  KNOWLEDGE_BASIC_MONTHLY_AI_ANALYSIS_REQUEST_LIMIT: z.coerce.number().int().nonnegative().default(30),
  KNOWLEDGE_PLUS_MONTHLY_AI_ANALYSIS_REQUEST_LIMIT: z.coerce.number().int().nonnegative().default(150),
  KNOWLEDGE_PREMIUM_MONTHLY_AI_ANALYSIS_REQUEST_LIMIT: z.coerce.number().int().nonnegative().default(750),
  KNOWLEDGE_BASIC_PDF_UPLOAD_LIMIT: z.coerce.number().int().nonnegative().default(10),
  KNOWLEDGE_PLUS_PDF_UPLOAD_LIMIT: z.coerce.number().int().nonnegative().default(50),
  KNOWLEDGE_PREMIUM_PDF_UPLOAD_LIMIT: z.coerce.number().int().nonnegative().default(250),
  KNOWLEDGE_BASIC_STORAGE_LIMIT_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
  KNOWLEDGE_PLUS_STORAGE_LIMIT_BYTES: z.coerce.number().int().positive().default(1024 * 1024 * 1024),
  KNOWLEDGE_PREMIUM_STORAGE_LIMIT_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024 * 1024),
  KNOWLEDGE_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  KNOWLEDGE_STORAGE_DIR: z.string().min(1).default("storage/knowledge"),
  KNOWLEDGE_STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
  KNOWLEDGE_S3_ENDPOINT: optionalString,
  KNOWLEDGE_S3_REGION: z.string().min(1).default("auto"),
  KNOWLEDGE_S3_BUCKET: optionalString,
  KNOWLEDGE_S3_ACCESS_KEY_ID: optionalString,
  KNOWLEDGE_S3_SECRET_ACCESS_KEY: optionalString,
  KNOWLEDGE_S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  KNOWLEDGE_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  AWS_REGION: optionalString,
  AWS_S3_BUCKET: optionalString,
  AWS_S3_BUCKET_ENVIRONMENT: z.enum(STORAGE_ENVIRONMENTS).optional(),
  AWS_ACCESS_KEY_ID: optionalString,
  AWS_SECRET_ACCESS_KEY: optionalString,
  AWS_S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).optional(),
  KNOWLEDGE_MALWARE_SCANNER_MODE: z.enum(["disabled", "clamav"]).default("disabled"),
  KNOWLEDGE_CLAMAV_HOST: optionalString,
  KNOWLEDGE_CLAMAV_PORT: z.coerce.number().int().positive().max(65_535).default(3310),
  KNOWLEDGE_CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  KNOWLEDGE_DOCUMENT_WORKER_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  KNOWLEDGE_DOCUMENT_WORKER_INTERVAL_SECONDS: z.coerce.number().int().positive().max(3600).default(30),
  KNOWLEDGE_DOCUMENT_WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(10),
  KNOWLEDGE_DOCUMENT_WORKER_STALE_SECONDS: z.coerce.number().int().min(60).max(86_400).default(600),
  KNOWLEDGE_DOCUMENT_WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  KNOWLEDGE_GOVERNANCE_OPERATION_LEASE_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  KNOWLEDGE_DOCUMENT_STALE_UPLOAD_MINUTES: z.coerce.number().int().min(5).max(1440).default(10),
  KNOWLEDGE_DOCUMENT_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
  KNOWLEDGE_DOCUMENT_CLEANUP_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(10),
  KNOWLEDGE_DOCUMENT_CLEANUP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(10),
  KNOWLEDGE_DOCUMENT_CLEANUP_STALE_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  FOLLOW_UP_WORKER_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  FOLLOW_UP_WORKER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  FOLLOW_UP_WORKER_BUSINESS_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(25),
  FOLLOW_UP_WORKER_JOB_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(25),
  CUSTOMER_MEMORY_WORKER_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  CUSTOMER_MEMORY_WORKER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(20),
  CUSTOMER_MEMORY_DISCOVERY_BUSINESS_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(10),
  CUSTOMER_MEMORY_DISCOVERY_PER_BUSINESS_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(20),
  CUSTOMER_MEMORY_LIVE_PRIORITY_WINDOW_MINUTES: z.coerce.number().int().positive().max(1440).default(15),
  CUSTOMER_MEMORY_WORKER_PROCESS_BATCH_SIZE: z.coerce.number().int().positive().max(50).default(10),
  CUSTOMER_MEMORY_TURN_BATCH_DELAY_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
  CUSTOMER_MEMORY_BASIC_MONTHLY_AI_REQUEST_LIMIT: z.coerce.number().int().nonnegative().default(250),
  CUSTOMER_MEMORY_PLUS_MONTHLY_AI_REQUEST_LIMIT: z.coerce.number().int().nonnegative().default(1000),
  CUSTOMER_MEMORY_PREMIUM_MONTHLY_AI_REQUEST_LIMIT: z.coerce.number().int().nonnegative().default(5000),
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
  const storageProvider = process.env.KNOWLEDGE_STORAGE_PROVIDER
    ? value.KNOWLEDGE_STORAGE_PROVIDER
    : value.AWS_S3_BUCKET || value.KNOWLEDGE_S3_BUCKET
      ? "s3"
      : "local";
  const s3Bucket = value.AWS_S3_BUCKET ?? value.KNOWLEDGE_S3_BUCKET;
  const s3AccessKeyId = value.AWS_ACCESS_KEY_ID ?? value.KNOWLEDGE_S3_ACCESS_KEY_ID;
  const s3SecretAccessKey = value.AWS_SECRET_ACCESS_KEY ?? value.KNOWLEDGE_S3_SECRET_ACCESS_KEY;
  if (value.NODE_ENV === "production" && storageProvider !== "s3") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["KNOWLEDGE_STORAGE_PROVIDER"],
      message: "S3-compatible private storage is required in production",
    });
  }
  if (storageProvider === "s3") {
    if (!s3Bucket) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AWS_S3_BUCKET"],
        message: "AWS_S3_BUCKET is required for S3 storage",
      });
    }
    if (Boolean(s3AccessKeyId) !== Boolean(s3SecretAccessKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AWS_ACCESS_KEY_ID"],
        message: "Both S3 access-key fields must be provided together, or both omitted for the default credential chain",
      });
    }
    if (s3Bucket) {
      const deploymentEnvironment = (value.DEPLOYMENT_ENVIRONMENT ?? value.NODE_ENV) as StorageEnvironment;
      for (const issue of validateStorageEnvironment({
        deploymentEnvironment,
        bucketEnvironment: value.AWS_S3_BUCKET_ENVIRONMENT,
        bucketName: s3Bucket,
      })) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [issue.field],
          message: `${issue.code}: ${issue.message}`,
        });
      }
    }
  }
  if (value.NODE_ENV === "production" && value.KNOWLEDGE_MALWARE_SCANNER_MODE !== "clamav") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["KNOWLEDGE_MALWARE_SCANNER_MODE"],
      message: "ClamAV malware scanning is required for knowledge-document uploads in production",
    });
  }
  if (value.KNOWLEDGE_MALWARE_SCANNER_MODE === "clamav" && !value.KNOWLEDGE_CLAMAV_HOST) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["KNOWLEDGE_CLAMAV_HOST"],
      message: "KNOWLEDGE_CLAMAV_HOST is required when ClamAV scanning is enabled",
    });
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

const awsStorageConfigured = Boolean(parsed.data.AWS_S3_BUCKET);

export const env = {
  ...parsed.data,
  DEPLOYMENT_ENVIRONMENT: (parsed.data.DEPLOYMENT_ENVIRONMENT ?? parsed.data.NODE_ENV) as StorageEnvironment,
  KNOWLEDGE_STORAGE_PROVIDER: (process.env.KNOWLEDGE_STORAGE_PROVIDER
    ? parsed.data.KNOWLEDGE_STORAGE_PROVIDER
    : awsStorageConfigured || parsed.data.KNOWLEDGE_S3_BUCKET
      ? "s3"
      : "local") as "local" | "s3",
  KNOWLEDGE_S3_REGION: parsed.data.AWS_REGION ?? parsed.data.KNOWLEDGE_S3_REGION,
  KNOWLEDGE_S3_BUCKET: parsed.data.AWS_S3_BUCKET ?? parsed.data.KNOWLEDGE_S3_BUCKET,
  KNOWLEDGE_S3_ACCESS_KEY_ID: parsed.data.AWS_ACCESS_KEY_ID ?? parsed.data.KNOWLEDGE_S3_ACCESS_KEY_ID,
  KNOWLEDGE_S3_SECRET_ACCESS_KEY: parsed.data.AWS_SECRET_ACCESS_KEY ?? parsed.data.KNOWLEDGE_S3_SECRET_ACCESS_KEY,
  KNOWLEDGE_S3_FORCE_PATH_STYLE: awsStorageConfigured && process.env.KNOWLEDGE_S3_FORCE_PATH_STYLE === undefined
    ? false
    : parsed.data.KNOWLEDGE_S3_FORCE_PATH_STYLE,
  KNOWLEDGE_DOWNLOAD_URL_TTL_SECONDS: parsed.data.AWS_S3_SIGNED_URL_TTL_SECONDS
    ?? parsed.data.KNOWLEDGE_DOWNLOAD_URL_TTL_SECONDS,
};
export const corsOrigins = [...new Set([
  ...env.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
  "https://app.bizreplyhq.com",
  "https://bizreplyhq.com",
  "https://www.bizreplyhq.com",
])];

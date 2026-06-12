import "dotenv/config";
import { z } from "zod";

const optionalString = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());

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
  }
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const corsOrigins = env.CORS_ORIGINS.split(",").map((origin) => origin.trim());

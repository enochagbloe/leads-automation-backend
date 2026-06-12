import { PrismaClient } from "@prisma/client";
import { env } from "./env";

function runtimeDatabaseUrl() {
  const url = new URL(env.DATABASE_URL);
  if (!url.searchParams.has("connection_limit")) url.searchParams.set("connection_limit", String(env.DB_CONNECTION_LIMIT));
  if (!url.searchParams.has("pool_timeout")) url.searchParams.set("pool_timeout", String(env.DB_POOL_TIMEOUT_SECONDS));
  if (!url.searchParams.has("connect_timeout")) url.searchParams.set("connect_timeout", String(env.DB_CONNECT_TIMEOUT_SECONDS));
  return url.toString();
}

export const prisma = new PrismaClient({ datasourceUrl: runtimeDatabaseUrl() });

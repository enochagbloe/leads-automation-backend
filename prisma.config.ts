import "dotenv/config";
import { defineConfig } from "prisma/config";

function prismaCliDatabaseUrl() {
  const configured = process.env.DATABASE_URL;
  if (!configured) return "postgresql://localhost:5432/bizreplyai";
  return configured;
}

function prismaCliDirectUrl() {
  const configured = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!configured) return undefined;

  const url = new URL(configured);
  if (url.hostname.includes("-pooler")) {
    url.hostname = url.hostname.replace("-pooler", "");
    url.searchParams.set("sslmode", "require");
    url.searchParams.delete("channel_binding");
  }
  return url.toString();
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Prisma CLI migrations should use Neon's direct host, not the pooled runtime host.
    url: prismaCliDatabaseUrl(),
    directUrl: prismaCliDirectUrl(),
  },
});

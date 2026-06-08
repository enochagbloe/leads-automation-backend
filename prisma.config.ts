import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Client generation does not need a live database, so installs can run before .env setup.
    url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/bizreplyai",
  },
});

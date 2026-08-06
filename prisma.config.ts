import "dotenv/config";
import { defineConfig } from "prisma/config";

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

// Prisma 6 reads directUrl from schema.prisma. Populate its environment
// variable before Prisma loads the schema, while allowing an explicit
// production DIRECT_URL to take precedence.
const directUrl = prismaCliDirectUrl();
if (directUrl) process.env.DIRECT_URL = directUrl;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
});

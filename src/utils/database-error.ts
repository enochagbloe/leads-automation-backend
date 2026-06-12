import { Prisma } from "@prisma/client";

const DATABASE_UNAVAILABLE_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);

type ErrorWithCode = {
  code?: unknown;
};

export function isDatabaseUnavailableError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return DATABASE_UNAVAILABLE_CODES.has(error.code);
  }

  if (typeof error === "object" && error !== null) {
    const { code } = error as ErrorWithCode;
    return typeof code === "string" && DATABASE_UNAVAILABLE_CODES.has(code);
  }

  return false;
}

import { Prisma } from "@prisma/client";

const DATABASE_UNAVAILABLE_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);

type ErrorWithCode = {
  code?: unknown;
  message?: unknown;
  meta?: { error?: unknown };
};

function isUnavailableTransactionError(error: ErrorWithCode) {
  if (error.code !== "P2028") return false;
  const detail = [error.message, error.meta?.error]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return detail.includes("unable to start a transaction in the given time")
    || detail.includes("transaction not found")
    || detail.includes("obtained before disconnecting");
}

export function isDatabaseUnavailableError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return DATABASE_UNAVAILABLE_CODES.has(error.code) || isUnavailableTransactionError(error);
  }

  if (typeof error === "object" && error !== null) {
    const codedError = error as ErrorWithCode;
    return (typeof codedError.code === "string" && DATABASE_UNAVAILABLE_CODES.has(codedError.code))
      || isUnavailableTransactionError(codedError);
  }

  return false;
}

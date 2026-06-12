import { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { isDatabaseUnavailableError } from "../utils/database-error";

export const notFound: RequestHandler = (_req, _res, next) =>
  next(Object.assign(new Error("Route not found"), { statusCode: 404, code: "NOT_FOUND" }));

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (isDatabaseUnavailableError(error)) {
    console.error("Database unavailable", {
      method: req.method,
      path: req.path,
      name: error?.name,
      message: error?.message,
      code: error?.code,
      cause: error?.cause,
      stack: error?.stack,
    });

    res.status(503).json({
      error: {
        code: "DATABASE_UNAVAILABLE",
        message: "Service temporarily unavailable. Please try again shortly.",
      },
    });
    return;
  }

  const statusCode = error.statusCode ?? (error instanceof ZodError ? 422 : 500);
  const message = statusCode >= 500 ? "Internal server error" : error.message;
  if (statusCode >= 500) console.error(error);
  res.status(statusCode).json({
    error: {
      code: statusCode >= 500 ? "INTERNAL_ERROR" : (error.code ?? "REQUEST_FAILED"),
      message,
      ...(statusCode < 500 && error.details && { details: error.details }),
      ...(statusCode < 500 && error.context),
    },
  });
};

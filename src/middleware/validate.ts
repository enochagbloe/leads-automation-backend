import { RequestHandler } from "express";
import { ZodSchema } from "zod";

export const validate = (schema: ZodSchema): RequestHandler => (req, _res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return next(Object.assign(new Error("Validation failed"), {
      statusCode: 422,
      code: "VALIDATION_ERROR",
      details: result.error.flatten().fieldErrors,
    }));
  }
  req.body = result.data;
  next();
};

export const validateQuery = (schema: ZodSchema): RequestHandler => (req, res, next) => {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    return next(Object.assign(new Error("Validation failed"), {
      statusCode: 422,
      code: "VALIDATION_ERROR",
      details: result.error.flatten().fieldErrors,
    }));
  }
  res.locals.validatedQuery = result.data;
  next();
};

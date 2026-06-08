import { BusinessRole } from "@prisma/client";
import { RequestHandler } from "express";
import { AppError } from "../utils/errors";

export const requireRole = (...roles: BusinessRole[]): RequestHandler => (req, _res, next) => {
  if (!req.auth || !roles.some((role) => role === req.auth!.role)) return next(new AppError(403, "Insufficient permissions", "FORBIDDEN"));
  next();
};

export const requireBusiness: RequestHandler = (req, _res, next) => {
  if (!req.auth?.businessId) return next(new AppError(403, "Business context required", "BUSINESS_REQUIRED"));
  next();
};

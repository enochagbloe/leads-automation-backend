import { RequestHandler } from "express";
import { AppError } from "../utils/errors";

export const requireMessageContent: RequestHandler = (req, _res, next) => {
  if (typeof req.body?.content !== "string" || !req.body.content.trim()) {
    return next(new AppError(422, "Message content is required.", "MESSAGE_CONTENT_REQUIRED"));
  }
  next();
};

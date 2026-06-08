import { Request } from "express";

export function requestMetadata(req: Request) {
  return {
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  };
}

import { RequestHandler } from "express";
import { demoService } from "../services/demo.service";
export const authenticateDemo: RequestHandler = async (req, _res, next) => {
  try {
    const match = /^Bearer (\S+)$/.exec(req.get("authorization") ?? "");
    req.demo = await demoService.authenticate(match?.[1] ?? "", req.get("x-business-id"));
    next();
  } catch (error) { next(error); }
};

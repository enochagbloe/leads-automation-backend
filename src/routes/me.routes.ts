import { Router } from "express";
import { meController } from "../controllers/me.controller";
import { authenticateUser } from "../middleware/auth";

export const meRouter = Router();

meRouter.use(authenticateUser);
meRouter.get("/business-memberships", meController.businessMemberships);

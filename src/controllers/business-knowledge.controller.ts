import { BusinessRole } from "@prisma/client";
import { RequestHandler } from "express";
import { businessKnowledgeService } from "../services/business-knowledge.service";
export const businessKnowledgeController={get:(async(req,res)=>res.json(await businessKnowledgeService.get({businessId:req.auth!.businessId!,role:req.auth!.role as BusinessRole}))) satisfies RequestHandler};

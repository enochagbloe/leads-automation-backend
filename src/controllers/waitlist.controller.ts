import { RequestHandler } from "express";
import { waitlistService } from "../services/waitlist.service";

export const waitlistController = {
  signup: async (req, res) => res.status(201).json(await waitlistService.signup(req.body)),
  confirm: async (req, res) => res.json(await waitlistService.confirm(req.body.token)),
  resend: async (req, res) => res.json(await waitlistService.resend(req.body.email)),
} satisfies Record<string, RequestHandler>;

import { Router } from "express";
import { appointmentController } from "../controllers/appointment.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness } from "../middleware/rbac";
import { validate, validateQuery } from "../middleware/validate";
import {
  appointmentCalendarQuerySchema,
  appointmentListQuerySchema,
  assignAppointmentSchema,
  cancelAppointmentSchema,
  checkAppointmentAvailabilitySchema,
  createAppointmentSchema,
  rescheduleAppointmentSchema,
} from "../validation/appointment.schemas";

export const appointmentRouter = Router();

appointmentRouter.use(authenticate, requireBusiness);
appointmentRouter.get("/calendar", validateQuery(appointmentCalendarQuerySchema), appointmentController.calendar);
appointmentRouter.post("/check-availability", mutationLimiter, validate(checkAppointmentAvailabilitySchema), appointmentController.checkAvailability);
appointmentRouter.get("/", validateQuery(appointmentListQuerySchema), appointmentController.list);
appointmentRouter.post("/", mutationLimiter, validate(createAppointmentSchema), appointmentController.create);
appointmentRouter.get("/:appointmentId", appointmentController.detail);
appointmentRouter.patch("/:appointmentId/reschedule", mutationLimiter, validate(rescheduleAppointmentSchema), appointmentController.reschedule);
appointmentRouter.patch("/:appointmentId/cancel", mutationLimiter, validate(cancelAppointmentSchema), appointmentController.cancel);
appointmentRouter.patch("/:appointmentId/complete", mutationLimiter, appointmentController.complete);
appointmentRouter.patch("/:appointmentId/no-show", mutationLimiter, appointmentController.noShow);
appointmentRouter.patch("/:appointmentId/assign", mutationLimiter, validate(assignAppointmentSchema), appointmentController.assign);

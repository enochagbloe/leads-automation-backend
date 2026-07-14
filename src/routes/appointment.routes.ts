import { Router } from "express";
import { appointmentController } from "../controllers/appointment.controller";
import { authenticate } from "../middleware/auth";
import { mutationLimiter } from "../middleware/rate-limit";
import { requireBusiness } from "../middleware/rbac";
import { validate, validateQuery } from "../middleware/validate";
import {
  appointmentCalendarQuerySchema,
  appointmentListQuerySchema,
  appointmentSettingsSchema,
  approveAppointmentRescheduleRequestSchema,
  assignAppointmentSchema,
  cancelAppointmentSchema,
  checkAppointmentAvailabilitySchema,
  completeAppointmentSchema,
  confirmAppointmentSchema,
  createAppointmentSchema,
  declineAppointmentRescheduleRequestSchema,
  missedAppointmentSchema,
  noShowAppointmentSchema,
  requestAppointmentRescheduleSchema,
  rescheduleAppointmentSchema,
} from "../validation/appointment.schemas";

export const appointmentRouter = Router();

appointmentRouter.use(authenticate, requireBusiness);
appointmentRouter.get("/calendar", validateQuery(appointmentCalendarQuerySchema), appointmentController.calendar);
appointmentRouter.post("/check-availability", mutationLimiter, validate(checkAppointmentAvailabilitySchema), appointmentController.checkAvailability);
appointmentRouter.patch("/settings", mutationLimiter, validate(appointmentSettingsSchema), appointmentController.updateSettings);
appointmentRouter.get("/", validateQuery(appointmentListQuerySchema), appointmentController.list);
appointmentRouter.post("/", mutationLimiter, validate(createAppointmentSchema), appointmentController.create);
appointmentRouter.get("/:appointmentId", appointmentController.detail);
appointmentRouter.patch("/:appointmentId/reschedule", mutationLimiter, validate(rescheduleAppointmentSchema), appointmentController.reschedule);
appointmentRouter.post("/:appointmentId/reschedule-requests", mutationLimiter, validate(requestAppointmentRescheduleSchema), appointmentController.requestReschedule);
appointmentRouter.post("/:appointmentId/reschedule-requests/:requestId/approve", mutationLimiter, validate(approveAppointmentRescheduleRequestSchema), appointmentController.approveRescheduleRequest);
appointmentRouter.post("/:appointmentId/reschedule-requests/:requestId/decline", mutationLimiter, validate(declineAppointmentRescheduleRequestSchema), appointmentController.declineRescheduleRequest);
appointmentRouter.patch("/:appointmentId/cancel", mutationLimiter, validate(cancelAppointmentSchema), appointmentController.cancel);
appointmentRouter.patch("/:appointmentId/confirm", mutationLimiter, validate(confirmAppointmentSchema), appointmentController.confirm);
appointmentRouter.patch("/:appointmentId/complete", mutationLimiter, validate(completeAppointmentSchema), appointmentController.complete);
appointmentRouter.patch("/:appointmentId/no-show", mutationLimiter, validate(noShowAppointmentSchema), appointmentController.noShow);
appointmentRouter.patch("/:appointmentId/missed", mutationLimiter, validate(missedAppointmentSchema), appointmentController.missed);
appointmentRouter.patch("/:appointmentId/assign", mutationLimiter, validate(assignAppointmentSchema), appointmentController.assign);
appointmentRouter.patch("/:appointmentId/claim", mutationLimiter, appointmentController.claim);

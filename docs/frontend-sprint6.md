# Frontend Sprint 6 Handoff

## Sprint Goal

Sprint 6 Module 1 adds the internal appointment/calendar backend foundation. This is not customer self-booking, Google Calendar sync, AI booking, payment collection, or reminders yet.

Appointments are business-scoped and use the existing authenticated business context:

```http
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

## Appointment Endpoints

All endpoints are under:

```text
/api/business/appointments
```

| Method | Endpoint | Frontend use |
|---|---|---|
| GET | `/api/business/appointments` | Paginated appointment list with summary and search |
| GET | `/api/business/appointments/calendar` | Calendar range view |
| PATCH | `/api/business/appointments/settings` | Update appointment confirmation mode |
| POST | `/api/business/appointments/check-availability` | Check slot before booking |
| POST | `/api/business/appointments` | Create appointment |
| GET | `/api/business/appointments/:appointmentId` | Appointment detail + activity history |
| PATCH | `/api/business/appointments/:appointmentId/reschedule` | Reschedule appointment |
| PATCH | `/api/business/appointments/:appointmentId/cancel` | Cancel appointment |
| PATCH | `/api/business/appointments/:appointmentId/confirm` | Confirm appointment that needs business approval |
| PATCH | `/api/business/appointments/:appointmentId/complete` | Mark completed |
| PATCH | `/api/business/appointments/:appointmentId/no-show` | Mark no-show |
| PATCH | `/api/business/appointments/:appointmentId/missed` | Mark business-side missed appointment |
| PATCH | `/api/business/appointments/:appointmentId/assign` | Assign/reassign staff |

## Status Values

```text
PENDING_BUSINESS_CONFIRMATION
CONFIRMED
NEEDS_HUMAN_CONFIRMATION
RESCHEDULE_REQUESTED
RESCHEDULED
NEEDS_OUTCOME_CONFIRMATION
CANCELLED
COMPLETED
NO_SHOW
MISSED
```

## Create Appointment

```http
POST /api/business/appointments
```

```json
{
  "leadId": "lead-id",
  "conversationId": "conversation-id",
  "serviceId": "service-id",
  "assignedStaffId": "business-member-id",
  "customerName": "Kwame Mensah",
  "customerPhone": "+233241234567",
  "customerEmail": "kwame@example.com",
  "title": "Property Viewing",
  "description": "Property viewing appointment",
  "notes": "Customer prefers evening appointment.",
  "date": "2026-06-21",
  "time": "17:00",
  "timezone": "Africa/Accra",
  "locationType": "TO_BE_CONFIRMED",
  "location": null,
  "source": "CONVERSATION"
}
```

If `serviceId` is provided, the backend uses the service duration plus buffer. If no service is selected, send `durationMinutes`.

If `locationType` is `TO_BE_CONFIRMED` or location is missing for an in-person appointment, the backend returns:

```text
status = NEEDS_HUMAN_CONFIRMATION
locationStatus = NEEDS_CONFIRMATION
humanConfirmationRequired = true
humanConfirmationReason = LOCATION_REQUIRED
```

Otherwise the appointment is normally `CONFIRMED`.

## Basic Appointment Confirmation

Sprint 6 Module 2 adds business confirmation behavior for Basic plan accounts.

Business profile now includes:

```ts
appointmentConfirmationMode:
  | "MANUAL_CONFIRMATION_REQUIRED"
  | "AUTO_CONFIRM_WHEN_STAFF_ASSIGNED"
  | "AUTO_CONFIRM_SAFE_BOOKINGS";
```

Basic plan businesses are limited to:

```text
MANUAL_CONFIRMATION_REQUIRED
```

If a Basic business tries to enable an automatic confirmation mode through `PATCH /api/business/profile`, the API returns:

```json
{
  "error": {
    "code": "PLAN_LIMIT_REACHED",
    "message": "Upgrade your plan to enable automatic appointment confirmation.",
    "currentPlan": "BASIC",
    "recommendedPlan": "PLUS"
  }
}
```

For Basic businesses, appointments created from customer-facing sources such as `CONVERSATION` are created as:

```text
status = PENDING_BUSINESS_CONFIRMATION
humanConfirmationRequired = true
humanConfirmationReason = BUSINESS_CONFIRMATION_REQUIRED
```

Manually created business-side appointments can still be confirmed immediately unless the normal location rules require human confirmation.

## Plus Staff Auto-Confirm

Sprint 6 Module 3 adds Plus appointment confirmation mode:

```http
PATCH /api/business/appointments/settings
```

```json
{
  "appointmentConfirmationMode": "AUTO_CONFIRM_WHEN_STAFF_ASSIGNED"
}
```

Plan rules:

```text
BASIC -> MANUAL_CONFIRMATION_REQUIRED only
PLUS -> MANUAL_CONFIRMATION_REQUIRED or AUTO_CONFIRM_WHEN_STAFF_ASSIGNED
PREMIUM -> all modes, including AUTO_CONFIRM_SAFE_BOOKINGS
```

If Basic enables staff auto-confirm:

```json
{
  "error": {
    "code": "PLAN_UPGRADE_REQUIRED",
    "message": "Upgrade to Plus to enable staff-based automatic appointment confirmation."
  }
}
```

If Plus enables Premium safe mode:

```json
{
  "error": {
    "code": "PLAN_UPGRADE_REQUIRED",
    "message": "Upgrade to Premium to enable safe automatic appointment confirmation."
  }
}
```

When a Plus business uses `AUTO_CONFIRM_WHEN_STAFF_ASSIGNED`:

- Appointment with active assigned staff, available slot, bookable service, and safe location becomes `CONFIRMED`.
- Appointment without assigned staff becomes `PENDING_BUSINESS_CONFIRMATION` with `humanConfirmationReason = STAFF_REQUIRED`.
- Conversation/AI-created appointment with assigned staff conflict becomes `NEEDS_HUMAN_CONFIRMATION` with `humanConfirmationReason = AVAILABILITY_CONFLICT`.
- Manual appointment creation with a conflicting assigned staff member is blocked with `APPOINTMENT_SLOT_UNAVAILABLE`.

Assigning staff later through `/assign` can confirm a pending Plus appointment when the only remaining issue was `STAFF_REQUIRED`.

## Premium Safe Auto-Confirm

Sprint 6 Module 4 enables Premium businesses to use:

```text
AUTO_CONFIRM_SAFE_BOOKINGS
```

Use the same settings endpoint:

```http
PATCH /api/business/appointments/settings
```

```json
{
  "appointmentConfirmationMode": "AUTO_CONFIRM_SAFE_BOOKINGS"
}
```

Only Premium can enable this mode. Basic and Plus receive:

```json
{
  "error": {
    "code": "PLAN_UPGRADE_REQUIRED",
    "message": "Upgrade to Premium to enable safe automatic appointment confirmation."
  }
}
```

Premium safe-booking behavior:

- Safe appointment becomes `CONFIRMED`.
- Unclear location becomes `NEEDS_HUMAN_CONFIRMATION` with `LOCATION_REQUIRED`.
- Staff conflict on non-manual request becomes `NEEDS_HUMAN_CONFIRMATION` with `AVAILABILITY_CONFLICT`.
- Direct manual staff conflict remains blocked with `APPOINTMENT_STAFF_UNAVAILABLE`.
- Human-review appointments create high-priority notifications.
- Auto-confirmed appointments create normal in-app notifications.

Frontend should not decide whether a booking is safe. Render the backend status, `humanConfirmationReason`, and `availableActions`.

## Available Actions

Appointment responses include `availableActions` so the UI can render safe actions without hardcoding only status checks.

```ts
availableActions: Array<"CONFIRM" | "RESCHEDULE" | "CANCEL" | "COMPLETE" | "NO_SHOW" | "MISSED">
```

Current behavior:

```text
Future PENDING_BUSINESS_CONFIRMATION -> CONFIRM, RESCHEDULE, CANCEL
Future NEEDS_HUMAN_CONFIRMATION -> CONFIRM, RESCHEDULE, CANCEL
Future RESCHEDULE_REQUESTED -> CONFIRM, RESCHEDULE, CANCEL
Future CONFIRMED / RESCHEDULED -> RESCHEDULE, CANCEL
If rescheduleCount >= 1 -> RESCHEDULE is removed
Ended but inside 2-hour grace period -> COMPLETE, NO_SHOW, MISSED
NEEDS_OUTCOME_CONFIRMATION -> COMPLETE, NO_SHOW, MISSED
CANCELLED / COMPLETED / NO_SHOW / MISSED -> []
```

## Lifecycle Cleanup

Sprint 6 Module 2.5 adds stricter lifecycle rules.

- An appointment can only be rescheduled once.
- Past appointments cannot be rescheduled.
- After an appointment ends, the UI should show outcome actions instead of edit/reschedule actions.
- After the appointment has been ended for more than 2 hours, reads from list/calendar/detail lazily move it to `NEEDS_OUTCOME_CONFIRMATION`.
- Outcome-required appointments create a high-priority unread notification once.

New/updated appointment fields:

```ts
rescheduleCount: number;
lastRescheduledAt: string | null;
lastRescheduledById: string | null;
outcomeRequiredAt: string | null;
outcomeConfirmedAt: string | null;
outcomeConfirmedById: string | null;
outcomeNote: string | null;
completedNote: string | null;
noShowReason: string | null;
missedReason: string | null;
```

## Confirm Appointment

```http
PATCH /api/business/appointments/:appointmentId/confirm
```

```json
{
  "note": "Confirmed with the customer by phone."
}
```

Allowed only for:

```text
PENDING_BUSINESS_CONFIRMATION
NEEDS_HUMAN_CONFIRMATION
RESCHEDULE_REQUESTED
```

Success returns the updated appointment:

```json
{
  "appointment": {
    "id": "appointment-id",
    "status": "CONFIRMED",
    "confirmedAt": "2026-06-18T10:00:00.000Z",
    "confirmedById": "user-id",
    "humanConfirmationRequired": false,
    "humanConfirmationReason": null,
    "availableActions": ["RESCHEDULE", "CANCEL"]
  }
}
```

## Outcome Actions

```http
PATCH /api/business/appointments/:appointmentId/complete
```

```json
{
  "completedNote": "Meeting completed successfully."
}
```

```http
PATCH /api/business/appointments/:appointmentId/no-show
```

```json
{
  "noShowReason": "Customer did not arrive or respond."
}
```

```http
PATCH /api/business/appointments/:appointmentId/missed
```

```json
{
  "missedReason": "Business could not attend due to emergency."
}
```

Use `NO_SHOW` when the customer did not attend. Use `MISSED` when the business missed the appointment or failed to act.

If the appointment cannot be confirmed:

```json
{
  "error": {
    "code": "APPOINTMENT_CANNOT_CONFIRM",
    "message": "This appointment cannot be confirmed in its current status."
  }
}
```

## Availability Check

```http
POST /api/business/appointments/check-availability
```

```json
{
  "serviceId": "service-id",
  "date": "2026-06-21",
  "time": "17:00",
  "timezone": "Africa/Accra",
  "assignedStaffId": "business-member-id"
}
```

Success:

```json
{
  "available": true,
  "reason": null,
  "startTime": "2026-06-21T17:00:00.000Z",
  "endTime": "2026-06-21T17:45:00.000Z",
  "durationMinutes": 45,
  "warnings": []
}
```

Unavailable:

```json
{
  "available": false,
  "reason": "BUSINESS_CLOSED",
  "message": "The business is closed at this time.",
  "suggestedSlots": []
}
```

## Permissions

Business owner and manager can create, view, reschedule, cancel, complete, no-show, and assign appointments.

Staff can view only appointments assigned to their `BusinessMember.id`. Staff can mark assigned appointments completed or no-show. Staff cannot create, reschedule, cancel, or assign appointments.

`assignedStaffId` is always a `BusinessMember.id`, not a raw `User.id`.

## Calendar Query

```http
GET /api/business/appointments/calendar?dateFrom=2026-06-01&dateTo=2026-06-30&view=month
```

Optional filters:

```text
assignedStaffId
serviceId
status
```

## Staff Assignment

```http
PATCH /api/business/appointments/:appointmentId/assign
```

```json
{
  "assignedStaffId": "business-member-id"
}
```

`assignedStaffId` is always a `BusinessMember.id`. Invalid or cross-business assignees return:

```json
{
  "error": {
    "code": "INVALID_ASSIGNED_STAFF",
    "message": "The selected staff member is not available for this business."
  }
}
```

If assignment auto-confirms the appointment, listen for both:

```text
business.appointment.assigned
business.appointment.confirmed
business.notification.created
```

## Reschedule And Cancel Reasons

Reschedule and cancel now require a business-side reason.

```http
PATCH /api/business/appointments/:appointmentId/reschedule
```

```json
{
  "newDate": "2026-06-25",
  "newStartTime": "10:00",
  "timezone": "Africa/Accra",
  "rescheduleReason": "Customer requested a new time.",
  "notifyCustomer": false
}
```

```http
PATCH /api/business/appointments/:appointmentId/cancel
```

```json
{
  "cancellationReason": "Customer cannot make it.",
  "notifyCustomer": false
}
```

The previous `date` / `time` / `reason` fields are still accepted for compatibility. Reasons are stored internally only. No WhatsApp/customer notification is sent in this module.

If the appointment has already been rescheduled once:

```json
{
  "error": {
    "code": "APPOINTMENT_RESCHEDULE_LIMIT_REACHED",
    "message": "This appointment has already been rescheduled once. Please create a new appointment request instead."
  }
}
```

If the appointment is already in the past:

```json
{
  "error": {
    "code": "APPOINTMENT_CANNOT_RESCHEDULE_PAST",
    "message": "Past appointments cannot be rescheduled. Please record the appointment outcome or create a new appointment."
  }
}
```

If the reason is missing:

```json
{
  "error": {
    "code": "APPOINTMENT_REASON_REQUIRED",
    "message": "Please provide a reason before rescheduling this appointment."
  }
}
```

## Realtime Events

Listen on the existing SSE stream:

```http
GET /api/realtime/events
```

Appointment events:

```text
business.appointment.created
business.appointment.updated
business.appointment.confirmation_required
business.appointment.needs_confirmation
business.appointment.confirmed
business.appointment.outcome_required
business.appointment.rescheduled
business.appointment.cancelled
business.appointment.completed
business.appointment.no_show
business.appointment.missed
business.appointment.reschedule_limit_reached
business.appointment.assigned
business.appointments.calendar.updated
business.notification.created
```

On these events, refresh:

```text
appointments list
calendar range
appointment detail
lead detail if leadId is present
conversation detail if conversationId is present
business setup / knowledge preview if shown
```

## Important UI Notes

- Appointment creation is blocked by monthly plan limits only on create, not on reschedule/cancel/complete/no-show.
- Backend creates internal conversation system messages for appointment create/reschedule/cancel. These are not sent to WhatsApp.
- Backend updates lead activity and may move lead status to `APPOINTMENT_SCHEDULED` unless the lead is already `WON` or `LOST`.
- Do not hide past appointments from calendar/history. Render final states and `NEEDS_OUTCOME_CONFIRMATION`.
- Use backend `availableActions` as the source of truth for showing confirm/reschedule/cancel/outcome buttons.
- Do not build AI booking, public booking pages, payment/deposit flows, reminders, or Google Calendar UI yet.

## Error Codes To Handle

```text
APPOINTMENT_NOT_FOUND
APPOINTMENT_LIMIT_REACHED
APPOINTMENT_SLOT_UNAVAILABLE
APPOINTMENT_OUTSIDE_BUSINESS_HOURS
APPOINTMENT_OVERLAPS_BREAK_TIME
APPOINTMENT_SERVICE_NOT_BOOKABLE
APPOINTMENT_SERVICE_DURATION_REQUIRED
APPOINTMENT_ALREADY_CANCELLED
APPOINTMENT_ALREADY_COMPLETED
APPOINTMENT_CANNOT_CONFIRM
APPOINTMENT_RESCHEDULE_LIMIT_REACHED
APPOINTMENT_CANNOT_RESCHEDULE_PAST
APPOINTMENT_OUTCOME_ALREADY_RECORDED
APPOINTMENT_CANNOT_MARK_MISSED
APPOINTMENT_CANNOT_COMPLETE
APPOINTMENT_CANNOT_NO_SHOW
APPOINTMENT_REASON_REQUIRED
INVALID_ASSIGNED_STAFF
APPOINTMENT_STAFF_UNAVAILABLE
PLAN_UPGRADE_REQUIRED
SERVICE_NOT_FOUND
LEAD_NOT_FOUND
CONVERSATION_NOT_FOUND
STAFF_MEMBER_NOT_FOUND
FORBIDDEN
VALIDATION_ERROR
INVALID_TIMEZONE
INVALID_APPOINTMENT_STATUS
```

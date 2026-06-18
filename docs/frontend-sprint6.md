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
| POST | `/api/business/appointments/check-availability` | Check slot before booking |
| POST | `/api/business/appointments` | Create appointment |
| GET | `/api/business/appointments/:appointmentId` | Appointment detail + activity history |
| PATCH | `/api/business/appointments/:appointmentId/reschedule` | Reschedule appointment |
| PATCH | `/api/business/appointments/:appointmentId/cancel` | Cancel appointment |
| PATCH | `/api/business/appointments/:appointmentId/complete` | Mark completed |
| PATCH | `/api/business/appointments/:appointmentId/no-show` | Mark no-show |
| PATCH | `/api/business/appointments/:appointmentId/assign` | Assign/reassign staff |

## Status Values

```text
PENDING_BUSINESS_CONFIRMATION
CONFIRMED
NEEDS_HUMAN_CONFIRMATION
RESCHEDULE_REQUESTED
RESCHEDULED
CANCELLED
COMPLETED
NO_SHOW
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

## Reschedule And Cancel Reasons

Reschedule and cancel now require a business-side reason.

```http
PATCH /api/business/appointments/:appointmentId/reschedule
```

```json
{
  "date": "2026-06-25",
  "time": "10:00",
  "timezone": "Africa/Accra",
  "reason": "Customer requested a new time."
}
```

```http
PATCH /api/business/appointments/:appointmentId/cancel
```

```json
{
  "reason": "Customer cannot make it."
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
business.appointment.rescheduled
business.appointment.cancelled
business.appointment.completed
business.appointment.no_show
business.appointment.assigned
business.appointments.calendar.updated
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
APPOINTMENT_REASON_REQUIRED
SERVICE_NOT_FOUND
LEAD_NOT_FOUND
CONVERSATION_NOT_FOUND
STAFF_MEMBER_NOT_FOUND
FORBIDDEN
VALIDATION_ERROR
INVALID_TIMEZONE
INVALID_APPOINTMENT_STATUS
```

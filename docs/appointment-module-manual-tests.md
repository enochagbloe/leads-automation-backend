# Appointment Module Manual Tests

Use an authenticated owner or manager unless the test says staff. Always include:

```http
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

## Core Creation

1. Owner creates an appointment with a valid lead, service, staff assignee, date, time, and timezone.
   Expected: `201`, appointment is created, status is `CONFIRMED` unless location needs confirmation.

2. Manager creates an appointment.
   Expected: `201`.

3. Staff attempts to create an appointment.
   Expected: `FORBIDDEN`.

4. Create appointment with service missing duration and no `durationMinutes`.
   Expected: `APPOINTMENT_SERVICE_DURATION_REQUIRED`.

5. Create appointment without service and with `durationMinutes`.
   Expected: appointment is created.

## Isolation And Validation

6. Use a service from another business.
   Expected: `SERVICE_NOT_FOUND`.

7. Use a lead from another business.
   Expected: `LEAD_NOT_FOUND`.

8. Use a conversation from another business.
   Expected: `CONVERSATION_NOT_FOUND`.

9. Use an assignee from another business or inactive membership.
   Expected: `STAFF_MEMBER_NOT_FOUND`.

10. Staff lists appointments.
    Expected: only appointments assigned to that staff member appear.

## Availability

11. Check availability inside open business hours.
    Expected: `available: true`.

12. Check availability on a closed day.
    Expected: `available: false`, reason `BUSINESS_CLOSED`.

13. Check availability outside opening hours.
    Expected: reason `APPOINTMENT_OUTSIDE_BUSINESS_HOURS`.

14. Check availability during break time.
    Expected: reason `APPOINTMENT_OVERLAPS_BREAK_TIME`.

15. Create overlapping appointment for same staff member.
    Expected: `APPOINTMENT_SLOT_UNAVAILABLE`.

16. Cancel the first appointment, then create another appointment in the same slot.
    Expected: new appointment succeeds.

## Conversation And Lead Integration

17. Create appointment from a conversation.
    Expected: conversation gets an internal system message. No WhatsApp message is sent.

18. Create appointment for a lead whose status is not `WON` or `LOST`.
    Expected: lead status becomes `APPOINTMENT_SCHEDULED`.

19. Create appointment for a `WON` or `LOST` lead.
    Expected: lead status remains unchanged.

20. Lead detail timeline includes appointment activity.
    Expected: appointment event appears.

## Mutations

21. Reschedule appointment to an available slot.
    Expected: status becomes `RESCHEDULED`, activity and audit logs are created.

22. Reschedule without a reason.
    Expected: `APPOINTMENT_REASON_REQUIRED`.

23. Reschedule to unavailable slot.
    Expected: appropriate availability error.

24. Cancel appointment without a reason.
    Expected: `APPOINTMENT_REASON_REQUIRED`.

25. Cancel appointment.
    Expected: status `CANCELLED`, `cancelledAt` and `cancelledById` set.

26. Mark appointment completed as owner/manager.
    Expected: status `COMPLETED`.

27. Mark assigned appointment completed as staff.
    Expected: status `COMPLETED`.

28. Mark unassigned appointment completed as staff.
    Expected: `FORBIDDEN`.

29. Mark appointment no-show.
    Expected: status `NO_SHOW`.

30. Assign appointment to another active business member.
    Expected: assignment updates and realtime event emits.

## Calendar, Cache, Realtime

31. Fetch `/api/business/appointments/calendar` for a month range.
    Expected: appointments in range only.

32. Create/reschedule/cancel an appointment while calendar is cached.
    Expected: subsequent fetch reflects updated data.

33. Watch SSE stream during appointment create/reschedule/cancel/complete/no-show/assign.
    Expected: relevant `business.appointment.*` and `business.appointments.calendar.updated` events emit.

## Subscription

34. Set account usage to the plan appointment limit, then create an appointment.
    Expected: `APPOINTMENT_LIMIT_REACHED`.

35. Reschedule/cancel/complete at the limit.
    Expected: allowed; only new creation is blocked.

## Out Of Scope Guardrails

36. Verify appointment creation from conversation does not call WhatsApp outbound provider.
    Expected: only internal system message is stored.

37. Search code/logs during appointment flow.
    Expected: no OpenAI/AI call and no Google Calendar sync call.

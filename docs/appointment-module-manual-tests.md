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

## Basic Confirmation Behavior

36. Basic business creates an appointment from `source: "CONVERSATION"`.
    Expected: status `PENDING_BUSINESS_CONFIRMATION`, `humanConfirmationRequired: true`, reason `BUSINESS_CONFIRMATION_REQUIRED`.

37. Basic business manually creates an appointment from `source: "MANUAL"` with safe location details.
    Expected: status can be `CONFIRMED`.

38. Basic business tries to set `appointmentConfirmationMode` to `AUTO_CONFIRM_SAFE_BOOKINGS`.
    Expected: `PLAN_LIMIT_REACHED` with upgrade message.

39. Pending business-confirmation appointment response includes available actions.
    Expected: `CONFIRM`, `RESCHEDULE`, `CANCEL`.

40. Confirm a pending business-confirmation appointment.
    Expected: status `CONFIRMED`, `confirmedAt` and `confirmedById` set, human confirmation fields cleared.

41. Confirm an appointment already `CONFIRMED`.
    Expected: `APPOINTMENT_CANNOT_CONFIRM`.

42. Confirm appointment emits realtime event.
    Expected: `business.appointment.confirmed` and `business.appointments.calendar.updated`.

43. Create pending business-confirmation appointment while watching SSE.
    Expected: `business.appointment.confirmation_required` and `business.notification.created`.

44. Verify notification recipients for unassigned appointment.
    Expected: owner and managers receive high-priority unread notification.

45. Verify notification recipients for assigned appointment.
    Expected: assigned staff plus owner and managers receive high-priority unread notification.

46. Reschedule using Module 2 body aliases.
    Body: `newDate`, `newStartTime`, `rescheduleReason`, `notifyCustomer`.
    Expected: accepted and reason stored internally.

47. Cancel using Module 2 body aliases.
    Body: `cancellationReason`, `notifyCustomer`.
    Expected: accepted and reason stored internally.

## Lifecycle Cleanup

48. Create a new appointment.
    Expected: `rescheduleCount = 0`.

49. First reschedule succeeds.
    Expected: `rescheduleCount = 1`, `lastRescheduledAt` and `lastRescheduledById` set.

50. Attempt a second reschedule.
    Expected: `APPOINTMENT_RESCHEDULE_LIMIT_REACHED`.

51. Attempt to reschedule an appointment whose `endTime` is in the past.
    Expected: `APPOINTMENT_CANNOT_RESCHEDULE_PAST`.

52. Fetch a future appointment with `rescheduleCount >= 1`.
    Expected: `availableActions` does not include `RESCHEDULE`.

53. Fetch an active appointment after its end time but before the 2-hour grace period ends.
    Expected: `availableActions` includes `COMPLETE`, `NO_SHOW`, and `MISSED`.

54. Fetch an active appointment more than 2 hours after end time.
    Expected: status becomes `NEEDS_OUTCOME_CONFIRMATION`.

55. Fetch the same overdue appointment repeatedly.
    Expected: only one set of `APPOINTMENT_OUTCOME_REQUIRED` notifications exists.

56. Fetch `NEEDS_OUTCOME_CONFIRMATION` appointment.
    Expected: `availableActions` includes `COMPLETE`, `NO_SHOW`, and `MISSED`.

57. Complete appointment with `completedNote`.
    Expected: status `COMPLETED`, `outcomeConfirmedAt`, `outcomeConfirmedById`, and `completedNote` set.

58. Mark appointment no-show with `noShowReason`.
    Expected: status `NO_SHOW`, `outcomeConfirmedAt`, `outcomeConfirmedById`, and `noShowReason` set.

59. Mark appointment missed with `missedReason`.
    Expected: status `MISSED`, `outcomeConfirmedAt`, `outcomeConfirmedById`, and `missedReason` set.

60. Try another outcome action on completed/no-show/missed appointment.
    Expected: `APPOINTMENT_OUTCOME_ALREADY_RECORDED`.

61. Staff attempts outcome action on unassigned appointment.
    Expected: `FORBIDDEN`.

62. Watch SSE during outcome-required and missed flows.
    Expected: `business.appointment.outcome_required`, `business.appointment.missed`, `business.notification.created`, and calendar update events emit.

## Plus Staff Auto-Confirm

63. Plus owner enables `AUTO_CONFIRM_WHEN_STAFF_ASSIGNED`.
    Expected: settings update succeeds.

64. Basic owner enables `AUTO_CONFIRM_WHEN_STAFF_ASSIGNED`.
    Expected: `PLAN_UPGRADE_REQUIRED`.

65. Plus owner enables `AUTO_CONFIRM_SAFE_BOOKINGS`.
    Expected: `PLAN_UPGRADE_REQUIRED`.

66. Plus business creates safe appointment with active assigned staff.
    Expected: appointment status `CONFIRMED`, auto-confirm activity, assigned-staff notification, owner/manager notification.

67. Plus business creates appointment without assigned staff.
    Expected: `PENDING_BUSINESS_CONFIRMATION`, reason `STAFF_REQUIRED`.

68. Plus conversation-created appointment has assigned staff conflict.
    Expected: `NEEDS_HUMAN_CONFIRMATION`, reason `AVAILABILITY_CONFLICT`.

69. Manual appointment creation has assigned staff conflict.
    Expected: `APPOINTMENT_STAFF_UNAVAILABLE`.

70. Assign staff from another business.
    Expected: `INVALID_ASSIGNED_STAFF`.

71. Assign inactive/removed staff member.
    Expected: `INVALID_ASSIGNED_STAFF`.

72. Assign active staff to pending Plus appointment whose only reason is `STAFF_REQUIRED`.
    Expected: status becomes `CONFIRMED` and realtime emits assignment + confirmed events.

73. Staff conflict check ignores cancelled/completed/no-show/missed appointments.
    Expected: new appointment can use that slot.

74. Staff conflict check blocks active overlapping appointments including `NEEDS_OUTCOME_CONFIRMATION`.
    Expected: `APPOINTMENT_STAFF_UNAVAILABLE` or human-confirmation conflict for non-manual Plus request.

## Premium Safe Auto-Confirm

75. Premium owner enables `AUTO_CONFIRM_SAFE_BOOKINGS`.
    Expected: settings update succeeds.

76. Basic owner enables `AUTO_CONFIRM_SAFE_BOOKINGS`.
    Expected: `PLAN_UPGRADE_REQUIRED`.

77. Plus owner enables `AUTO_CONFIRM_SAFE_BOOKINGS`.
    Expected: `PLAN_UPGRADE_REQUIRED`.

78. Premium creates safe appointment.
    Expected: status `CONFIRMED`, activity `APPOINTMENT_AUTO_CONFIRMED_SAFE_BOOKING`, notification created.

79. Premium creates appointment with unclear location.
    Expected: `NEEDS_HUMAN_CONFIRMATION`, reason `LOCATION_REQUIRED`.

80. Premium non-manual appointment has staff conflict.
    Expected: `NEEDS_HUMAN_CONFIRMATION`, reason `AVAILABILITY_CONFLICT`.

81. Premium direct manual appointment has staff conflict.
    Expected: `APPOINTMENT_STAFF_UNAVAILABLE`.

82. Watch SSE during Premium unsafe appointment creation.
    Expected: `business.appointment.needs_confirmation` and `business.notification.created`.

83. Watch SSE during Premium safe appointment creation.
    Expected: `business.appointment.confirmed`, `business.notification.created`, and calendar update.

## Actionable Notifications

84. Create pending-confirmation appointment.
    Expected: notification type `APPOINTMENT_NEEDS_CONFIRMATION`, entity `APPOINTMENT`, action payload includes confirm/reschedule/cancel/view.

85. Create needs-human-confirmation appointment.
    Expected: notification type `APPOINTMENT_NEEDS_REVIEW`, high priority, action payload includes review/confirm/reschedule/cancel.

86. Trigger outcome-required lazy update.
    Expected: notification type `APPOINTMENT_OUTCOME_REQUIRED`, action payload includes completed/no-show/missed/view.

87. Assign appointment to staff.
    Expected: assigned staff receives `APPOINTMENT_ASSIGNED` notification.

88. Fetch `/api/business/notifications`.
    Expected: only current membership's notifications are returned.

89. Fetch `/api/business/notifications/counts`.
    Expected: unread, highPriority, and urgent counts are correct.

90. Mark notification read.
    Expected: status `READ`, `readAt` set.

91. Dismiss notification.
    Expected: status `DISMISSED`, `dismissedAt` set.

92. Mark notification actioned after successful appointment action.
    Expected: status `ACTIONED`, `actionedAt` set.

93. Try to access another member's notification as staff.
    Expected: `NOTIFICATION_NOT_FOUND`.

94. Re-trigger same unresolved appointment notification.
    Expected: duplicate unresolved notification is not created.

## Out Of Scope Guardrails

95. Verify appointment creation from conversation does not call WhatsApp outbound provider.
    Expected: only internal system message is stored.

96. Search code/logs during appointment flow.
    Expected: no OpenAI/AI call and no Google Calendar sync call.

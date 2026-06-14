# Business Availability Manual Tests

1. Owner saves all seven days and receives the ordered weekly schedule.
2. Manager saves all seven days successfully.
3. Staff can GET availability and summary but PUT returns `FORBIDDEN`.
4. PUT with fewer than seven rules returns `VALIDATION_ERROR`.
5. PUT with duplicate days returns `VALIDATION_ERROR`.
6. Open day without open/close times returns `VALIDATION_ERROR`.
7. Closed day with times returns `VALIDATION_ERROR`.
8. Invalid `HH:mm`, reversed hours, partial breaks, or breaks outside hours return `VALIDATION_ERROR`.
9. Invalid timezone returns `INVALID_TIMEZONE`.
10. Availability from Business A is never returned or modified under Business B.
11. Updating availability invalidates availability, summary, and setup-status caches.
12. Updating the business profile timezone synchronizes availability timezone and invalidates caches.
13. Setup status completes availability only with seven rules and at least one valid open day.
14. Audit log records `BUSINESS_AVAILABILITY_UPDATED` with previous/new values and changed days.
15. Realtime emits availability update and summary update events.
16. AI context helpers return only saved business-scoped availability.

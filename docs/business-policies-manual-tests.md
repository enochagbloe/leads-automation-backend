# Business Policies Manual Tests

1. Owner and manager can create valid policies.
2. Staff can list/detail only active customer-facing policies.
3. Staff cannot create, update, archive, restore, or reorder.
4. Title, content, category, visibility, summary, and priority validation works.
5. Owner and manager can update policies and audit metadata contains before/after values.
6. Archive is soft-delete and removes the policy from the default active list.
7. Archived and inactive policies do not count toward active limits.
8. Restore activates the policy and enforces the current plan limit.
9. Basic, Plus, and Premium enforce 10, 30, and 100 active policies.
10. Active policy limits are shared across all businesses in the workspace.
11. Summary counts and missing recommended categories are correct.
12. Policy mutations invalidate list, detail, summary, and setup-status caches.
13. Realtime events emit after each mutation.
14. Cross-business policy access returns `POLICY_NOT_FOUND`.
15. Business switching cannot leak cached owner/internal policy data to staff.
16. Setup status includes policy progress and completes policies with one active customer-facing policy.
17. AI context returns only active, non-archived, customer-facing saved policies.

# Frontend Sprint 7 Handoff

## Sprint Goal

Sprint 7 Modules 1-5A.4 add the OpenRouter AI reply engine, business knowledge context, safe auto-replies, AI-created appointment booking requests, human review / handoff foundation, account-type rules, team invite acceptance, staff-safe multi-business access, and staff access lifecycle controls.

There is no AI settings UI, AI simulator, advanced routing, AI analytics dashboard, image understanding UI, or Plus/Premium auto-confirm UI in this module.

## Environment Behavior

The backend controls AI with environment configuration:

```env
OPENROUTER_API_KEY=
OPENROUTER_DEFAULT_MODEL=
OPENROUTER_FALLBACK_MODELS=
OPENROUTER_MAX_FALLBACK_ATTEMPTS=2
AI_REPLY_ENABLED=true
AI_MIN_CONFIDENCE=0.75
```

Never expose provider keys, raw prompts, provider headers, or internal provider errors in the frontend.

## Manual AI Trigger

Owner and manager can process the latest inbound customer message:

```http
POST /api/business/conversations/:conversationId/ai/process-latest
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

Staff cannot call this endpoint.

Possible response statuses include:

```text
SUCCESS_AUTO_REPLIED
SUCCESS_BOOKING_REQUEST_CREATED
BLOCKED_LOW_CONFIDENCE
BLOCKED_POLICY
BLOCKED_QUOTA
BLOCKED_MISSING_CONTEXT
BLOCKED_UNAVAILABLE_SLOT
AI_FALLBACK_EXHAUSTED
WHATSAPP_SEND_FAILED
PROVIDER_ERROR
```

Blocked responses return `blocked: true`. Successful replies and booking-request acknowledgements return `blocked: false` with a stored AI message.

## Account Type Rules

Auth user objects now include:

```ts
type UserAccountType = "OWNER_CAPABLE" | "STAFF_ONLY";

type AuthUser = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  emailVerified: boolean;
  status: "ACTIVE" | "DISABLED";
  accountType: UserAccountType;
  canCreateBusiness: boolean;
  createdAt: string;
};
```

Normal registration creates:

```text
accountType: OWNER_CAPABLE
canCreateBusiness: true
```

Invite-created staff accounts create:

```text
accountType: STAFF_ONLY
canCreateBusiness: false
```

Frontend should hide or disable “Create business” for:

```text
accountType = STAFF_ONLY
canCreateBusiness = false
```

The backend remains the source of truth. If a staff-only user calls business creation anyway, it returns:

```json
{
  "error": {
    "code": "STAFF_ACCOUNT_CANNOT_CREATE_BUSINESS",
    "message": "This account was created as a staff account. Staff accounts cannot create businesses."
  }
}
```

When inviting staff, owner/manager should handle:

```text
INVITED_EMAIL_ALREADY_BUSINESS_OWNER
USER_ALREADY_BUSINESS_MEMBER
```

`INVITED_EMAIL_ALREADY_BUSINESS_OWNER` means the email belongs to a user with an active owner membership. Show a clear message asking for a staff email instead.

## Team Invite Acceptance

Validate invite link before showing signup/login UI:

```http
GET /api/invites/:token
```

Valid response:

```json
{
  "valid": true,
  "inviteId": "invite-id",
  "business": {
    "id": "business-id",
    "name": "Enoch Properties"
  },
  "role": "STAFF",
  "email": "staff@example.com",
  "status": "PENDING",
  "expiresAt": "2026-06-30T10:00:00.000Z"
}
```

Invalid response:

```json
{
  "valid": false,
  "code": "INVITE_INVALID_OR_EXPIRED",
  "message": "This invite link is invalid or has expired."
}
```

Existing logged-in user accepts invite:

```http
POST /api/invites/:token/accept
Authorization: Bearer <accessToken>
```

No request body is required.

New invitee signs up from invite:

```http
POST /api/invites/:token/signup
Content-Type: application/json
```

```json
{
  "name": "Kwame Mensah",
  "password": "SecurePass123!"
}
```

Do not ask for email on invite signup. The backend uses the invite email.

Successful accept/signup response includes:

```json
{
  "accepted": true,
  "business": {
    "id": "business-id",
    "name": "Enoch Properties"
  },
  "membership": {
    "id": "business-member-id",
    "role": "STAFF",
    "status": "ACTIVE"
  },
  "activeBusinessId": "business-id",
  "activeMembershipId": "business-member-id",
  "role": "STAFF"
}
```

Signup-from-invite also returns `accessToken` and `refreshToken`, so the frontend can enter the invited business immediately.

Invite acceptance errors to handle:

```text
INVITE_NOT_FOUND
INVITE_INVALID_OR_EXPIRED
INVITE_ALREADY_ACCEPTED
INVITE_CANCELLED
INVITE_EMAIL_MISMATCH
INVALID_INVITE_ROLE
USER_ALREADY_EXISTS
INVITED_EMAIL_ALREADY_BUSINESS_OWNER
USER_ALREADY_BUSINESS_MEMBER
ACCOUNT_NOT_ALLOWED_FOR_STAFF_INVITE
BUSINESS_NOT_FOUND
```

`INVITE_EMAIL_MISMATCH` means the logged-in user is not the invited email. Ask them to log in with the invited email.

`USER_ALREADY_EXISTS` on signup means the invited email already has an account; show login + accept flow instead.

## Staff Multi-Business Access

The frontend should use the membership list as the business switcher source. There is no separate switch endpoint.

List accessible businesses:

```http
GET /api/businesses
Authorization: Bearer <accessToken>
```

This endpoint does not require `X-Business-Id`, so staff-only users can load their available businesses before selecting one.

Response:

```ts
type BusinessMembershipOption = {
  membershipId: string;
  businessId: string;
  businessName: string;
  role: "BUSINESS_OWNER" | "MANAGER" | "STAFF";
  status: "ACTIVE" | "INVITED" | "SUSPENDED_BY_PLAN" | "DISABLED" | "REMOVED";
  disabledAt: string | null;
  disabledReason: string | null;
  removedAt: string | null;
  removedReason: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  restoredAt: string | null;
  accountType: "OWNER_CAPABLE" | "STAFF_ONLY";
  canCreateBusiness: boolean;
  joinedAt: string;
  lastAccessedAt: string | null;
  business: Record<string, unknown>;
  positionTitle: string | null;
  specialties: string[];
  serviceTags: string[];
  isAiHandoffEligible: boolean;
  aiHandoffPriority: number | null;
  permissions: {
    canViewOperationalQueues: boolean;
    canViewLeads: boolean;
    canViewAllOperationalLeads: boolean;
    canClaimUnassignedLeads: boolean;
    canAssignLeadsToSelf: boolean;
    canReassignLeadsToOthers: boolean;
    canManageAllLeads: boolean;
    canViewConversations: boolean;
    canViewAllOperationalConversations: boolean;
    canClaimUnassignedConversations: boolean;
    canAssignConversationsToSelf: boolean;
    canReassignConversationsToOthers: boolean;
    canManageAllConversations: boolean;
    canViewAppointments: boolean;
    canViewAllOperationalAppointments: boolean;
    canClaimUnassignedAppointments: boolean;
    canAssignAppointmentsToSelf: boolean;
    canReassignAppointmentsToOthers: boolean;
    canManageAllAppointments: boolean;
    canViewAiHandoffTasks: boolean;
    canClaimUnassignedAiHandoffTasks: boolean;
    canAssignAiHandoffTasksToSelf: boolean;
    canReassignAiHandoffTasksToOthers: boolean;
    canManageBilling: boolean;
    canManageTeam: boolean;
    canManageBusinessSettings: boolean;
    canCreateBusiness: boolean;
  };
};

type BusinessMembershipResponse = {
  memberships: BusinessMembershipOption[];
};
```

Switching businesses is done by sending the selected business ID on every business-scoped request:

```http
X-Business-Id: <selectedBusinessId>
```

Do not store or send `BusinessMember.id` as `X-Business-Id`. Use `membershipId` for display/state only. Backend permissions and assignee fields still use `BusinessMember.id` where the API specifically asks for an assignee/member ID.

`GET /api/auth/me` also includes:

```ts
{
  memberships: BusinessMembershipOption[];
  activeBusinessContext: {
    business: { id: string; name: string };
    membership: {
      id: string;
      role: "BUSINESS_OWNER" | "MANAGER" | "STAFF";
      status: "ACTIVE" | "INVITED" | "SUSPENDED_BY_PLAN" | "DISABLED" | "REMOVED";
    };
    account: {
      accountType: "OWNER_CAPABLE" | "STAFF_ONLY";
      canCreateBusiness: boolean;
    };
    permissions: BusinessMembershipOption["permissions"];
  } | null;
  permissionFlags: BusinessMembershipOption["permissions"];
}
```

Only `ACTIVE` memberships can access business modules. Non-active memberships are listed for clear UX state, but business-scoped API calls return controlled errors:

```text
BUSINESS_MEMBERSHIP_NOT_FOUND
MEMBERSHIP_INVITE_NOT_ACCEPTED
MEMBERSHIP_SUSPENDED_BY_PLAN
MEMBERSHIP_DISABLED
MEMBERSHIP_REMOVED
BUSINESS_ACCESS_DENIED
```

Recommended UI behavior:

- `INVITED`: show “Invitation pending” and send the user through invite acceptance.
- `SUSPENDED_BY_PLAN`: show “Access limited by plan” and ask them to contact the business owner.
- `DISABLED`: show “Access disabled” and ask them to contact the business owner.
- `REMOVED`: remove or hide the business from active switcher choices after refetch.
- `BUSINESS_MEMBERSHIP_NOT_FOUND`: clear the selected business and refetch `/api/businesses`.

Staff users can belong to multiple businesses. A staff member can see assigned and unassigned operational work inside the selected business, but not work already assigned to another staff member. Switching `X-Business-Id` must not leak data from another business.

## Operational Queues And Claiming Work

Staff queue visibility:

- leads: assigned to the staff member or unassigned
- conversations: assigned to the staff member or unassigned
- appointments: assigned to the staff member or unassigned
- AI handoff tasks: use unassigned or self-assigned `NEEDS_HUMAN_REVIEW` conversations for now

Owners and managers can still see all operational work.

Claim endpoints:

```http
PATCH /api/business/leads/:leadId/claim
PATCH /api/business/conversations/:conversationId/claim
PATCH /api/business/appointments/:appointmentId/claim
```

Legacy aliases also exist:

```http
PATCH /api/leads/:leadId/claim
PATCH /api/conversations/:conversationId/claim
```

All claim requests require:

```http
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

Claim behavior:

- unassigned work becomes assigned to the actor’s `BusinessMember.id`
- staff cannot claim work already assigned to another member
- owners/managers should use the existing assignment endpoints for reassignment
- staff cannot unassign or reassign after claiming

Already-assigned error:

```json
{
  "error": {
    "code": "WORK_ALREADY_ASSIGNED",
    "message": "This item is already assigned to another team member."
  }
}
```

Appointment claim may also return:

```text
STAFF_SCHEDULE_CONFLICT
CANNOT_CLAIM_COMPLETED_WORK
CANNOT_CLAIM_CANCELLED_WORK
```

Assignment target validation now returns:

```text
INVALID_ASSIGNMENT_TARGET
```

Staff operational profile endpoint:

```http
PATCH /api/business/members/:memberId/operational-profile
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
Content-Type: application/json
```

```json
{
  "positionTitle": "Site Supervisor",
  "specialties": ["site visit", "construction complaint", "inspection"],
  "serviceTags": ["construction", "site inspection"],
  "isAiHandoffEligible": true,
  "aiHandoffPriority": 1
}
```

Owner-only in V1. Use this data later for Plus team-aware AI routing.

## Staff Access Lifecycle

Owner-only V1 endpoints:

```http
PATCH /api/business/members/:memberId/disable
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
Content-Type: application/json
```

```json
{
  "reason": "No longer active on this project"
}
```

```http
PATCH /api/business/members/:memberId/restore
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

```http
PATCH /api/business/members/:memberId/remove
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
Content-Type: application/json
```

```json
{
  "reason": "Staff no longer works with the business"
}
```

`memberId` is the `BusinessMember.id`, not the `User.id`.

Managers and staff cannot use these endpoints in V1. Existing team invite management is owner-only, so lifecycle management follows the same permission rule.

Disabled, removed, or plan-suspended members lose normal business access but their user account and historical membership record remain. The backend also safely unassigns active work:

- active leads assigned to the member become unassigned
- open conversations assigned to the member become unassigned
- human-handling conversations move to `NEEDS_HUMAN_REVIEW`
- future appointments assigned to the member become unassigned
- confirmed future appointments move to `NEEDS_HUMAN_CONFIRMATION`
- unresolved notifications for that member are dismissed

Lifecycle response:

```ts
{
  member: BusinessMembershipOption;
  affectedRecords?: {
    affectedLeads: number;
    affectedConversations: number;
    affectedAppointments: number;
    affectedNotifications: number;
  };
}
```

Restore can fail if the active staff limit would be exceeded:

```json
{
  "error": {
    "code": "STAFF_LIMIT_EXCEEDED",
    "message": "Your current plan does not allow more active staff members. Upgrade your plan or disable another staff member.",
    "allowedActiveMembers": 2,
    "currentActiveMembers": 2
  }
}
```

Lifecycle errors:

```text
BUSINESS_MEMBER_NOT_FOUND
BUSINESS_MEMBER_ALREADY_DISABLED
BUSINESS_MEMBER_ALREADY_REMOVED
BUSINESS_MEMBER_ALREADY_ACTIVE
CANNOT_REMOVE_BUSINESS_OWNER
CANNOT_DISABLE_BUSINESS_OWNER
STAFF_CANNOT_REMOVE_SELF
STAFF_LIMIT_EXCEEDED
FORBIDDEN
```

Realtime events:

```text
business.member.disabled
business.member.restored
business.member.removed
business.member.suspended_by_plan
business.member.access_changed
business.team.updated
business.conversation.updated
business.appointment.updated
business.lead.updated
business.lead.claimed
business.conversation.claimed
business.appointment.claimed
business.member.operational_profile_updated
```

On these events, refetch:

- `/api/businesses`
- `/api/auth/me`
- affected lead/conversation/appointment lists
- notification counts

## Plus Customer Issue Routing

Plus and Premium can now turn AI-detected customer complaints into lightweight internal issue records. Basic does not get complaint intelligence; Basic only receives safe human handoff behavior.

Customer-facing behavior:

- AI replies politely and calmly.
- AI must not mention internal routing, tickets, assignments, staff names, or issue logs.
- Conversation assignment/client owner is not changed automatically.

Issue endpoints:

```http
GET /api/business/customer-issues
GET /api/business/customer-issues/:issueId
PATCH /api/business/customer-issues/:issueId/status
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

List query params:

```text
status
category
severity
responsibleMembershipId
leadId
conversationId
createdFrom
createdTo
page
limit
```

Status update body:

```json
{
  "status": "ACKNOWLEDGED"
}
```

Allowed statuses:

```text
OPEN
ACKNOWLEDGED
RESOLVED
CLOSED
```

Issue shape:

```ts
type CustomerIssue = {
  id: string;
  businessId: string;
  leadId: string | null;
  conversationId: string | null;
  customerMessageId: string | null;
  type: "COMPLAINT" | "ISSUE" | "REQUEST_REQUIRES_INTERNAL_ACTION";
  category:
    | "DELAY"
    | "POOR_SERVICE"
    | "QUALITY_ISSUE"
    | "STAFF_BEHAVIOR"
    | "MISCOMMUNICATION"
    | "PAYMENT_ISSUE"
    | "APPOINTMENT_ISSUE"
    | "DELIVERY_OR_SITE_ISSUE"
    | "MISSING_ITEM_OR_MISSING_WORK"
    | "FOLLOW_UP_REQUIRED"
    | "OTHER";
  severity: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  summary: string;
  customerMessageExcerpt: string | null;
  clientOwnerMembershipId: string | null;
  conversationAssignedMembershipId: string | null;
  suggestedResponsibleMembershipId: string | null;
  responsibleMembershipId: string | null;
  routingReason: string | null;
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "CLOSED";
  createdBy: "AI" | "MANUAL";
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};
```

Access:

- Basic receives `PLAN_UPGRADE_REQUIRED` on customer issue endpoints.
- Owner/manager can view all customer issues in the selected business.
- Staff can view customer issues assigned to them and unassigned issues.
- Staff can acknowledge or resolve issues assigned to them.
- Only owner/manager can close an issue.

Realtime events:

```text
business.ai.safe_handoff_triggered
business.customer_issue.created
business.customer_issue.routed
business.customer_issue.status_updated
business.notification.created
business.conversation.updated
```

Notification actions may include:

```text
VIEW_CUSTOMER_ISSUE
VIEW_CONVERSATION
```

## Automatic Processing

When an inbound WhatsApp customer message is stored, the backend safely attempts AI processing if:

- global AI replies are enabled
- business AI replies and auto-reply are enabled
- plan AI quota is available
- conversation has `aiEnabled=true`
- conversation is not `CLOSED`
- conversation is not in human takeover or human-review state
- message is `senderType: CUSTOMER` and `direction: INBOUND`

AI failure never rolls back the original inbound WhatsApp message.

## AI Messages

AI replies are normal conversation messages:

```text
senderType: AI
direction: OUTBOUND
messageType: TEXT
deliveryStatus: PENDING | SENT | FAILED | INTERNAL
```

Render `senderType: AI` as the BizReply AI assistant. For WhatsApp conversations, the message is created as pending, then becomes `SENT` or `FAILED`. If WhatsApp is not connected, the AI message is stored as `FAILED`.

## Human Review

When AI is low-confidence, unsafe, over quota, missing required context, or the customer asks for a human:

- no AI reply is sent
- conversation moves to `status: NEEDS_HUMAN_REVIEW`
- `needsHumanReview: true`
- `humanReviewReason` is set
- `humanReviewType` is set
- `aiEnabled: false`
- `humanTakeover: false`
- notification type `AI_HUMAN_REVIEW_REQUIRED` is created for owners/managers
- on Plus/Premium, the assigned staff member is also notified when the conversation has an assignee

Notification actions:

```json
[
  { "label": "View conversation", "action": "VIEW_CONVERSATION", "variant": "default" },
  { "label": "Take over", "action": "TAKE_OVER_CONVERSATION", "variant": "secondary" },
  { "label": "Dismiss", "action": "DISMISS", "variant": "secondary" }
]
```

Do not treat `NEEDS_HUMAN_REVIEW` as full human takeover. Human takeover still happens only when a human explicitly takes over.

Human review types:

```text
LOW_CONFIDENCE
CUSTOMER_REQUESTED_HUMAN
COMPLAINT
PAYMENT_OR_REFUND
POLICY_UNCERTAINTY
BOOKING_UNCLEAR
MISSING_BUSINESS_CONTEXT
MEDIA_OR_IMAGE_UNSUPPORTED
AI_PROVIDER_FAILED
QUOTA_EXCEEDED
SAFETY_BLOCKED
OTHER
```

## Human Handoff Endpoints

Take over a conversation:

```http
PATCH /api/business/conversations/:conversationId/take-over
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
Content-Type: application/json
```

```json
{
  "reason": "Customer asked for a human"
}
```

`reason` is optional.

Response conversation state:

```text
status: HUMAN_HANDLING
humanTakeover: true
aiEnabled: false
needsHumanReview: false
humanReviewResolvedAt: timestamp
humanReviewResolvedByMembershipId: current membership id
```

Resume AI:

```http
PATCH /api/business/conversations/:conversationId/resume-ai
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
Content-Type: application/json
```

```json
{
  "reason": "Issue reviewed"
}
```

`reason` is optional.

Response conversation state:

```text
status: AI_HANDLING
humanTakeover: false
aiEnabled: true
needsHumanReview: false
humanReviewResolvedAt: timestamp
humanReviewResolvedByMembershipId: current membership id
```

Resume AI does not process old messages immediately. Future inbound customer messages can trigger AI again.

Access:

- owner/manager can take over or resume accessible business conversations
- assigned staff can take over or resume their assigned conversations
- staff cannot take over unassigned or other staff conversations

## Booking Requests

When AI detects booking intent and has service, date, and time:

- backend validates the service
- backend checks availability through the appointment service
- backend creates an appointment request with `source: AI_CONVERSATION`
- Basic appointments are always `PENDING_BUSINESS_CONFIRMATION`
- AI replies: “request sent for confirmation”
- AI never says the appointment is confirmed

For this module, Plus and Premium use the same safe pending/request behavior. Advanced staff routing and safe auto-confirm are not enabled from AI yet.

If booking details are missing, the AI asks a clarifying question instead of creating an appointment. If the slot or setup is not usable and no safe reply is available, the conversation goes to human review.

## Realtime Events

Listen for:

```text
business.ai.reply.started
business.ai.reply.completed
business.ai.reply.blocked
business.ai.reply.failed
business.ai.booking_request.created
business.ai.human_review.required
business.conversation.human_takeover.started
business.conversation.ai_resumed
business.conversation.updated
business.member.joined
business.invite.accepted
message.created
message.status.updated
business.appointment.created
business.notification.created
```

Use realtime events to refetch conversation detail, conversation list, appointment/calendar data, and notification counts. Database-backed API responses remain the source of truth.

Booking request event payload includes:

```json
{
  "conversationId": "...",
  "appointmentId": "...",
  "appointmentStatus": "PENDING_BUSINESS_CONFIRMATION",
  "sourceMessageId": "..."
}
```

## Business Knowledge Context

The frontend does not send business knowledge to AI. The backend builds context from:

- business profile
- active non-archived services and pricing
- weekly availability
- active customer-facing policies only
- lead/customer context
- recent conversation messages
- plan capability flags
- AI readiness warnings

Internal-only policies, secrets, provider tokens, billing data, deleted messages, and cross-business records are excluded.

## Error Codes

Handle these cleanly:

```text
AI_DISABLED
AI_AUTO_REPLY_DISABLED
AI_QUOTA_EXCEEDED
AI_LOW_CONFIDENCE
AI_HUMAN_REVIEW_REQUIRED
AI_UNSAFE_TO_REPLY
AI_MISSING_CONTEXT
AI_REPLY_VALIDATION_FAILED
AI_CONVERSATION_NOT_ELIGIBLE
AI_PROVIDER_ERROR
AI_PROVIDER_TIMEOUT
AI_PROVIDER_RATE_LIMITED
AI_PROVIDER_UNAVAILABLE
AI_MODEL_UNAVAILABLE
AI_RESPONSE_PARSE_ERROR
AI_FALLBACK_EXHAUSTED
AI_BOOKING_MISSING_FIELDS
AI_BOOKING_SERVICE_NOT_FOUND
AI_BOOKING_SERVICE_NOT_BOOKABLE
AI_BOOKING_SLOT_UNAVAILABLE
AI_BOOKING_BUSINESS_NOT_READY
AI_BOOKING_CREATE_FAILED
WHATSAPP_NOT_CONNECTED
WHATSAPP_SEND_FAILED
FORBIDDEN
BUSINESS_ACCESS_DENIED
CONVERSATION_ACCESS_DENIED
CONVERSATION_ALREADY_HUMAN_HANDLING
CONVERSATION_NOT_IN_HUMAN_REVIEW
AI_ALREADY_ENABLED
AI_ALREADY_DISABLED
HUMAN_TAKEOVER_FORBIDDEN
HUMAN_REVIEW_NOT_FOUND
CUSTOMER_ISSUE_NOT_FOUND
PLAN_UPGRADE_REQUIRED
STAFF_ACCOUNT_CANNOT_CREATE_BUSINESS
BUSINESS_MEMBERSHIP_NOT_FOUND
MEMBERSHIP_INVITE_NOT_ACCEPTED
MEMBERSHIP_SUSPENDED_BY_PLAN
MEMBERSHIP_DISABLED
MEMBERSHIP_REMOVED
BUSINESS_MEMBER_NOT_FOUND
BUSINESS_MEMBER_ALREADY_DISABLED
BUSINESS_MEMBER_ALREADY_REMOVED
BUSINESS_MEMBER_ALREADY_ACTIVE
CANNOT_REMOVE_BUSINESS_OWNER
CANNOT_DISABLE_BUSINESS_OWNER
STAFF_CANNOT_REMOVE_SELF
STAFF_LIMIT_EXCEEDED
WORK_ALREADY_ASSIGNED
INVALID_ASSIGNMENT_TARGET
STAFF_SCHEDULE_CONFLICT
CANNOT_CLAIM_COMPLETED_WORK
CANNOT_CLAIM_CANCELLED_WORK
CANNOT_REASSIGN_WITHOUT_PERMISSION
OPERATIONAL_PROFILE_UPDATE_DENIED
MEMBERSHIP_NOT_ACTIVE
INVITED_EMAIL_ALREADY_BUSINESS_OWNER
USER_ALREADY_BUSINESS_MEMBER
INVALID_ACCOUNT_TYPE
INVITE_NOT_FOUND
INVITE_INVALID_OR_EXPIRED
INVITE_ALREADY_ACCEPTED
INVITE_CANCELLED
INVITE_EMAIL_MISMATCH
INVALID_INVITE_ROLE
USER_ALREADY_EXISTS
ACCOUNT_NOT_ALLOWED_FOR_STAFF_INVITE
```

## Frontend Notes

- Show `NEEDS_HUMAN_REVIEW` as “Needs human review”.
- Show `HUMAN_HANDLING` as “Human handling” or “Human takeover”.
- Use the take-over endpoint for the notification action `TAKE_OVER_CONVERSATION`.
- Use the resume endpoint when a user chooses to turn AI back on.
- Use `user.accountType` and `user.canCreateBusiness` to conditionally show create-business UI.
- Use `/api/invites/:token` before rendering invite signup/login screens.
- Use `/api/businesses` or `/api/auth/me` for the logged-in user's own business switcher memberships.
- Use `GET /api/business/members` for the selected business team list when rendering lead or appointment assignment dropdowns.
- After invite acceptance, set active business from `activeBusinessId` and `activeMembershipId`.
- Use `BusinessMember.id` for staff lifecycle actions and staff assignment fields.
- Do not use `User.id` when disabling/removing/restoring a staff member.
- Do not use `User.id` for `assignedStaffId`; assignment endpoints expect `BusinessMember.id`.
- Only show members with `canReceiveAssignedWork: true` as assignable targets.
- Staff work queues should include unassigned plus self-assigned items.
- Show “Assign to me” only when the item is unassigned and the relevant `canClaimUnassigned...` permission is true.
- Hide “Assign to me” for items already assigned to another member.
- If a lifecycle request returns 403, show the message without logging the user out.
- After member disable/remove/restore, refetch memberships and active business context.
- Show failed AI messages with the existing failed-message UI.
- Refetch appointments when `business.ai.booking_request.created` or `business.appointment.created` arrives.
- Do not add an AI simulator button.
- Do not add advanced AI routing controls, complaint analytics, task boards, or auto-confirm controls yet.

## Out Of Scope

- AI settings UI
- AI playground/simulator
- Complaint analytics and full task board
- Premium safe auto-confirm from AI
- AI-generated reschedule/cancel messages
- AI analytics dashboard
- Embeddings/vector knowledge base

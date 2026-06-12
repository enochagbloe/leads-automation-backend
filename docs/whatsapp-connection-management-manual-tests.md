# WhatsApp Connection Management Manual Tests

Use an owner, manager, and staff access token with the same `X-Business-Id`.

## Connection lifecycle

1. `GET /api/business/whatsapp/status` as owner, manager, and staff. Confirm no secrets are returned.
2. As owner, call `POST /api/business/whatsapp/connect/start` with `{"provider":"MOCK_WHATSAPP","displayPhoneNumber":"+233241234567"}`. Confirm `CONNECTED`.
3. Repeat connect/start. Confirm `WHATSAPP_ALREADY_CONNECTED`.
4. Try connect/start as manager and staff. Confirm `FORBIDDEN`.
5. Call `GET /api/business/whatsapp/health`. Confirm local connection state and message timestamps.
6. Call `POST /api/business/whatsapp/deactivate` as owner. Confirm `DEACTIVATED`.
7. Send an outbound reply in a WhatsApp conversation. Confirm `WHATSAPP_DEACTIVATED`.
8. Confirm old leads, conversations, and messages remain available.
9. Simulate inbound delivery for the historical number. Confirm the message metadata includes `integrationStatus: "DEACTIVATED"` and `automationSkipped: true`.

## Live connection security

1. Confirm `MOCK_WHATSAPP` connect/start is rejected while `WHATSAPP_PROVIDER_MODE=live`.
2. Call `/connect/complete` without first calling `/connect/start`. Confirm `WHATSAPP_CONNECTION_NOT_STARTED`.
3. Call `/connect/complete` without an access token. Confirm validation fails.
4. Complete with a token that cannot access the requested Meta phone number. Confirm `WHATSAPP_PROVIDER_OWNERSHIP_VERIFICATION_FAILED`.
5. Complete with a valid token and WABA ID. Confirm Meta verifies the phone belongs to that WABA.
6. Send an outbound message and confirm the integration-specific encrypted credential is used rather than the global environment token.

## Change number and history

1. Connect a mock number.
2. Call `POST /api/business/whatsapp/change/start`.
3. Confirm the old integration is `DEACTIVATED`.
4. Start or complete the new connection.
5. Confirm only one active integration exists and the old integration record remains.

## Audits, cache, and realtime

Confirm audit records exist for:

```text
WHATSAPP_CONNECTION_STARTED
WHATSAPP_CONNECTED
WHATSAPP_DEACTIVATED
WHATSAPP_NUMBER_CHANGED
```

Confirm connection status/health caches are invalidated after lifecycle changes.

Confirm SSE emits:

```text
whatsapp.connection.updated
whatsapp.connection.deactivated
```

## Cross-business isolation

Use a token without membership in the selected business and send its ID as `X-Business-Id`. Confirm `BUSINESS_ACCESS_DENIED`.

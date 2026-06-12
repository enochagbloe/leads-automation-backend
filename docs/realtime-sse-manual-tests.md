# Real-time SSE Manual Tests

## Connect

```bash
curl -N http://localhost:3000/api/realtime/events \
  -H 'Authorization: Bearer ACCESS_TOKEN' \
  -H 'X-Business-Id: BUSINESS_ID' \
  -H 'Accept: text/event-stream'
```

Expected initial event:

```text
event: connected
data: {"businessId":"...","connectedAt":"..."}
```

A `ping` event is sent every 25 seconds.

## Trigger events

While the stream remains open:

1. Simulate inbound WhatsApp message: expect `lead.created`, `conversation.created`, `message.created`, `conversation.updated`, and `conversation.unread_count.updated`.
2. Send staff reply: expect `message.created`, `conversation.updated`, and `message.status.updated`.
3. Simulate delivery status: expect `message.status.updated`.
4. Assign conversation: expect `conversation.assigned` and `conversation.updated`.
5. Mark conversation read: expect `conversation.read` and `conversation.updated`.
6. End Chat: expect `conversation.closed`, system `message.created`, and `conversation.updated`.
7. Simulate customer reply after close: expect `conversation.reopened`, `message.created`, and `conversation.updated`.

## Security cases

1. Missing token returns `401`.
2. Invalid `X-Business-Id` membership returns `403 BUSINESS_ACCESS_DENIED`.
3. Business A stream receives no Business B events.
4. Staff stream receives only events where `assignedStaffId` matches its membership.
5. Disconnecting curl removes the SSE client.

SSE is UI-only. Confirm all REST and webhook actions still succeed if no stream is connected.

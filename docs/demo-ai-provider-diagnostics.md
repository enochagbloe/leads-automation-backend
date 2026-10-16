# Demo interpreter provider failure — 2026-10-15

## Verified cause

A synthetic greeting using the configured `openai/gpt-4o-mini` model and the actual
strict `conversation_interpretation` JSON schema received HTTP 402 from OpenRouter.
The authenticated key endpoint returned 200 with no key-specific credit limit; the
account credits endpoint returned 200 and confirmed the account balance was exhausted.
Only boolean exhaustion flags and status codes were printed. No customer data, API key,
prompts or raw provider payloads were logged or saved.

This is an account billing failure, not missing credentials or a reproduced schema,
empty-success-response, model-not-found or transport failure. A successful model completion
cannot be verified until the account is funded. Model-list metadata reports response-format
and structured-output support for the primary and both configured fallbacks:
`google/gemini-2.5-flash` and `meta-llama/llama-3.1-8b-instruct`.
Metadata support is not a guarantee of current endpoint availability or schema acceptance.

## Failure path and behavior

1. Canonical inbound message is persisted. Demo processing durably claims it with
   `demoAiAttempted=true` before calling the provider.
2. The shared interpreter requests strict JSON Schema with `require_parameters=true`.
   Its `maxAttempts: 1` deliberately prevents fallback model calls for that interpretation.
3. Previously, HTTP 402 mapped to generic `AI_PROVIDER_ERROR`. The demo wrapper discarded
   the nested provider detail, leaving no way to distinguish billing from other failures.
4. Provider, interpreter and demo server diagnostics now carry only whitelisted model,
   HTTP status, category, request count and fallback outcome. Completion failures no longer
   retain raw upstream messages or exception text in their error context.
5. Account billing rejection stops fallback attempts even in callers that allow multiple
   models. Recoverable failures retain the caller's existing attempt budget. No new AI stage,
   model substitution, relaxed schema or semantic fallback was added.

The demo client still receives `503 DEMO_AI_UNAVAILABLE` with a safe reason code, not
provider internals. Failed claims remain claimed. Once credits are restored, send a **new
customer message with a new clientMessageId**; neither process-latest nor replaying the old
claimed ID regenerates its response. Successful reply replay remains unchanged.

## Validation

253 targeted tests passed:

```powershell
node --import tsx --test tests/ai-provider-diagnostics.test.ts tests/demo-ai.test.ts tests/conversation-interpreter.test.ts tests/conversation-response.test.ts
```

Includes HTTP 400/401/402/404/429/503, HTTP-200 error envelopes, empty/refused outputs,
missing credentials/model, transport/timeout/abort, safe log redaction, allowed fallback
recovery, strict request format and the real interpreter-to-demo billing failure path.
The demo regression checks retained inbound content, one provider call and rejected replay
of the same claimed message. Provider outputs in tests are controlled; the credit check
and synthetic HTTP 402 reproduction used the configured live OpenRouter account.

Operational resolution: replenish the OpenRouter account used by the configured key,
then smoke-test a new message. Code cannot repair an exhausted external account balance.

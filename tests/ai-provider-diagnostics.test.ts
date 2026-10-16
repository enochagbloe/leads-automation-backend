import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../src/config/env";
import { AppError } from "../src/utils/errors";
import { OpenRouterProvider } from "../src/services/ai-provider.service";
import { safeProviderDiagnostics } from "../src/services/ai-provider-diagnostics";
import { interpretationOutputSchema } from "../src/services/conversation-interpretation-output";

const input = { businessId: "synthetic", systemPrompt: "SECRET_PROMPT", userPrompt: "SECRET_CUSTOMER", maxAttempts: 1, responseFormat: { type: "json_schema" as const, json_schema: { name: "conversation_interpretation", strict: true as const, schema: interpretationOutputSchema } } };
function setup(t: import("node:test").TestContext) {
  const saved = { OPENROUTER_API_KEY: env.OPENROUTER_API_KEY, OPENROUTER_DEFAULT_MODEL: env.OPENROUTER_DEFAULT_MODEL, OPENROUTER_FALLBACK_MODELS: env.OPENROUTER_FALLBACK_MODELS, OPENROUTER_MAX_FALLBACK_ATTEMPTS: env.OPENROUTER_MAX_FALLBACK_ATTEMPTS };
  Object.assign(env, { OPENROUTER_API_KEY: "SECRET_KEY", OPENROUTER_DEFAULT_MODEL: "test/primary", OPENROUTER_FALLBACK_MODELS: ["test/fallback"], OPENROUTER_MAX_FALLBACK_ATTEMPTS: 2 });
  t.after(() => Object.assign(env, saved));
  const logs: unknown[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => logs.push(args));
  t.mock.method(console, "info", (...args: unknown[]) => logs.push(args));
  return logs;
}
for (const [status, category] of [[400,"REQUEST_REJECTED"],[401,"AUTHENTICATION"],[402,"INSUFFICIENT_CREDITS"],[404,"MODEL_UNAVAILABLE"],[429,"RATE_LIMIT"],[503,"PROVIDER_UNAVAILABLE"]] as const) {
  test(`HTTP ${status} records safe diagnostics and honors the one-attempt interpreter budget`, async t => {
    const logs = setup(t);
    const fetcher = t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.response_format, input.responseFormat);
      assert.deepEqual(body.provider, { require_parameters: true });
      return Response.json({ error: { code: status, message: "SECRET_PROVIDER_PAYLOAD SECRET_KEY SECRET_CUSTOMER" } }, { status });
    });
    await assert.rejects(new OpenRouterProvider().generateCompletion(input), (error: unknown) => {
      const diagnostic = safeProviderDiagnostics(error)!;
      assert.equal(diagnostic.attempts[0]?.category, category); assert.equal(diagnostic.attempts[0]?.httpStatus, status);
      assert.equal(diagnostic.providerRequestCount, 1); assert.equal(diagnostic.primaryModel, "test/primary");
      assert.doesNotMatch(JSON.stringify(error), /SECRET_/); return true;
    });
    assert.equal(fetcher.mock.callCount(), 1); assert.doesNotMatch(JSON.stringify(logs), /SECRET_/);
  });
}
test("exhausted billing skips all configured fallback models", async t => {
  setup(t); const fetcher = t.mock.method(globalThis,"fetch",async()=>Response.json({error:{code:402}},{status:402}));
  await assert.rejects(new OpenRouterProvider().generateCompletion({...input,maxAttempts:3}), e => { assert.equal(safeProviderDiagnostics(e)?.fallbackOutcome,"SKIPPED_BILLING"); return true; });
  assert.equal(fetcher.mock.callCount(),1);
});
test("missing credentials/model are distinct and never send a request", async t => {
  setup(t); const fetcher=t.mock.method(globalThis,"fetch",async()=>{throw new Error("must not send");});
  env.OPENROUTER_API_KEY=undefined;
  await assert.rejects(new OpenRouterProvider().generateCompletion(input), e=>{ assert.equal(safeProviderDiagnostics(e)?.attempts[0]?.category,"MISSING_CREDENTIALS"); assert.equal(safeProviderDiagnostics(e)?.providerRequestCount,0); return true; });
  env.OPENROUTER_API_KEY="SECRET_KEY"; env.OPENROUTER_DEFAULT_MODEL=undefined;
  await assert.rejects(new OpenRouterProvider().generateCompletion(input), e=>{ assert.equal(safeProviderDiagnostics(e)?.attempts[0]?.category,"MISSING_MODEL"); return true; });
  assert.equal(fetcher.mock.callCount(),0);
});
for (const [body, category] of [[{choices:[{message:{content:"  "}}]},"EMPTY_RESPONSE"],[{choices:[{message:{refusal:"SECRET_REFUSAL"}}]},"REFUSAL"],[{error:{code:402,message:"SECRET_ERROR"}},"INSUFFICIENT_CREDITS"]] as const) {
  test(`HTTP 200 ${category} does not become a successful completion`, async t=>{
    const logs=setup(t); t.mock.method(globalThis,"fetch",async()=>Response.json(body));
    await assert.rejects(new OpenRouterProvider().generateCompletion(input),e=>{ assert.equal(safeProviderDiagnostics(e)?.attempts[0]?.category,category);return true; });
    assert.doesNotMatch(JSON.stringify(logs),/SECRET_/);
  });
}
for (const name of ["TypeError","TimeoutError","AbortError"]) test(`${name} is classified without logging exception text`,async t=>{
  const logs=setup(t); t.mock.method(globalThis,"fetch",async()=>{const e=new Error("SECRET_TRANSPORT");e.name=name;throw e;});
  await assert.rejects(new OpenRouterProvider().generateCompletion(input),e=>{assert.equal(safeProviderDiagnostics(e)?.attempts[0]?.category,name==="TimeoutError"?"TIMEOUT":name==="AbortError"?"ABORTED":"TRANSPORT");return true;});
  assert.doesNotMatch(JSON.stringify(logs),/SECRET_/);
});
test("a permitted fallback records recovery while retaining strict schema",async t=>{
  const logs=setup(t);let calls=0;
  t.mock.method(globalThis,"fetch",async(_url: string | URL | Request, init?: RequestInit)=>{const body=JSON.parse(String(init?.body));assert.deepEqual(body.response_format,input.responseFormat);return ++calls===1?Response.json({error:{message:"SECRET_ERROR"}},{status:503}):Response.json({choices:[{message:{content:'{"ok":true}'}}]});});
  const result=await new OpenRouterProvider().generateCompletion({...input,maxAttempts:2});
  assert.equal(result.providerRequestCount,2);assert.equal(result.fallbackAttempted,true);assert.equal(result.finalModelUsed,"test/fallback");
  assert.match(JSON.stringify(logs),/SUCCEEDED/);assert.doesNotMatch(JSON.stringify(logs),/SECRET_/);
});
test("diagnostic boundary drops arbitrary error context and invalid model identifiers",()=>{
  const e=new AppError(502,"SECRET_ERROR","AI_PROVIDER_ERROR",{providerDiagnostics:{primaryModel:"SECRET MODEL\n",raw:"SECRET_PAYLOAD",attempts:[{model:"bad\nSECRET",category:"SECRET",message:"SECRET"}]}});
  assert.doesNotMatch(JSON.stringify(safeProviderDiagnostics(e)),/SECRET/);
});

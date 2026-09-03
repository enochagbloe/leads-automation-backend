import type { TestContext } from "node:test";

// Prisma exposes methods through proxies without own property descriptors.
export function mockMethod(t: TestContext, target: any, name: string, implementation: (...args: any[]) => any) {
  const original = target[name];
  const fn = t.mock.fn(implementation);
  target[name] = fn;
  t.after(() => { target[name] = original; });
  return fn;
}

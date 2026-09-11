import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/config/prisma";
import { mockMethod } from "./helpers/mock-method";
import { checkSlot } from "../src/services/appointment/appointment-availability.service";
import { validateService } from "../src/services/appointment/appointment-validation.service";

for (const open of [true, false]) test(`existing appointment availability remains authoritative: open=${open}`, async t => {
  mockMethod(t, prisma.service, "findFirst", async ({ where }: any) => { assert.equal(where.businessId, "business-a"); assert.equal(where.id, "service-a"); return { id: "service-a", isActive: true, isArchived: false, isBookable: true, durationMinutes: 30, bufferMinutes: 0 } as any; });
  mockMethod(t, prisma.businessAvailability, "findFirst", async ({ where }: any) => { assert.equal(where.businessId, "business-a"); return { isOpen: open, openTime: "09:00", closeTime: "17:00" } as any; });
  mockMethod(t, prisma.appointment, "create", () => { assert.fail("availability must not create appointments"); });
  const result = await checkSlot({ businessId: "business-a", serviceId: "service-a", date: "2026-09-12", time: "12:00", timezone: "Africa/Accra" });
  assert.equal(result.available, open); assert.equal(result.reason, open ? null : "BUSINESS_CLOSED");
});
test("existing appointment validation rejects foreign/nonbookable service and absent duration", async t => {
  const spy = mockMethod(t, prisma.service, "findFirst", async () => null);
  await assert.rejects(validateService("business-a", "foreign"), (e: any) => e.code === "SERVICE_NOT_FOUND"); spy.mock.restore();
  mockMethod(t, prisma.service, "findFirst", async () => ({ isActive: true, isArchived: false, isBookable: false }) as any);
  await assert.rejects(validateService("business-a", "s"), (e: any) => e.code === "APPOINTMENT_SERVICE_NOT_BOOKABLE");
  await assert.rejects(validateService("business-a", null), (e: any) => e.code === "APPOINTMENT_SERVICE_DURATION_REQUIRED");
});

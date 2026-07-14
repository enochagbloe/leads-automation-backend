import { DayOfWeek } from "@prisma/client";
import { AppError } from "../../utils/errors";

export function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

export function parseTime(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return { hour: hour!, minute: minute!, totalMinutes: hour! * 60 + minute! };
}

export function appointmentDateUtc(date: string) {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

export function dateInTimezone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function timeInTimezone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
}

export function offsetMs(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const asUtc = Date.UTC(values.year!, values.month! - 1, values.day!, values.hour!, values.minute!, values.second!, 0);
  return asUtc - date.getTime();
}

export function zonedDateTimeToUtc(date: string, time: string, timezone: string) {
  if (!validTimezone(timezone)) throw new AppError(422, "Invalid timezone.", "INVALID_TIMEZONE");
  const { year, month, day } = parseDate(date);
  const { hour, minute } = parseTime(time);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let result = new Date(localAsUtc - offsetMs(new Date(localAsUtc), timezone));
  result = new Date(localAsUtc - offsetMs(result, timezone));
  return result;
}

export function dayOfWeekFor(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone }).format(date).toUpperCase() as DayOfWeek;
}

export function rangeFromDates(dateFrom?: string, dateTo?: string) {
  if (!dateFrom && !dateTo) return undefined;
  return {
    ...(dateFrom ? { gte: appointmentDateUtc(dateFrom) } : {}),
    ...(dateTo ? { lt: new Date(appointmentDateUtc(dateTo).getTime() + 24 * 60 * 60 * 1000) } : {}),
  };
}

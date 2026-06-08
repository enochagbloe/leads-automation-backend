import slugify from "slugify";

export function makeBusinessSlug(name: string) {
  return `${slugify(name, { lower: true, strict: true })}-${crypto.randomUUID().slice(0, 8)}`;
}

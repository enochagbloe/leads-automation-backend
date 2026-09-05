import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { AppError } from "../utils/errors";

export const CRAWLER_AGENT = "BizReplyDemoCrawler/1.0";
export const blockedUrl = () => new AppError(400, "Only public HTTP(S) websites are supported", "DEMO_WEBSITE_BLOCKED");
export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.range() !== "unicast") return false;
    // Only global IPv6 unicast. Excludes transition, mapped, link-local and metadata ranges.
    return parsed.kind() === "ipv4" || parsed.match(ipaddr.parse("2000::"), 3);
  } catch { return false; }
}
export function normalizeDemoUrl(input: string): URL {
  if (input.length > 2048) throw blockedUrl();
  let url: URL;
  try { url = new URL(input); } catch { throw new AppError(400, "Invalid website URL", "DEMO_WEBSITE_INVALID"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || hostname.endsWith(".") || (!isIP(hostname) && (!hostname.includes(".") || /(?:^|\.)(localhost|local|internal|lan|home|test|invalid|onion|arpa)$/.test(hostname))) || (isIP(hostname) && !isPublicAddress(hostname))) throw blockedUrl();
  url.hash = "";
  // Demo crawling never needs tracking/auth query strings.
  url.search = "";
  return url;
}
export function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new AppError(408, "Website request timed out", "DEMO_WEBSITE_TIMEOUT"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export type PublicResponse = { status: number; body: string; contentType: string; location?: string };
export const demoPublicHttp = {
  resolve: async (hostname: string) => lookup(hostname, { all: true, verbatim: true }),
  async get(url: URL, signal: AbortSignal, maxBytes = 512 * 1024): Promise<PublicResponse> {
    const checked = normalizeDemoUrl(url.href);
    const hostname = checked.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await withAbort(this.resolve(hostname), signal);
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw blockedUrl();
    const selected = addresses[0]!;
    // Connect to the validated IP, not the hostname: no second DNS lookup/rebinding window.
    return new Promise((resolve, reject) => {
      const request = (checked.protocol === "https:" ? httpsRequest : httpRequest)({
        hostname: selected.address, family: selected.family, port: checked.protocol === "https:" ? 443 : 80,
        servername: isIP(hostname) ? undefined : hostname,
        path: checked.pathname, method: "GET", agent: false, signal,
        headers: { Host: checked.host, "User-Agent": CRAWLER_AGENT, Accept: "text/html,text/plain;q=0.8", "Accept-Encoding": "identity" },
      }, response => {
        const status = response.statusCode ?? 500;
        const contentType = (response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        const location = response.headers.location;
        if (status < 200 || status >= 300) { response.destroy(); resolve({ status, body: "", contentType, location }); return; }
        if (!["text/html", "text/plain"].includes(contentType) || (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) {
          response.destroy(); reject(new AppError(400, "Unsupported website content", "DEMO_WEBSITE_CONTENT_TYPE")); return;
        }
        if (Number(response.headers["content-length"]) > maxBytes) { response.destroy(); reject(new AppError(400, "Website page too large", "DEMO_WEBSITE_TOO_LARGE")); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) { response.destroy(); reject(new AppError(400, "Website page too large", "DEMO_WEBSITE_TOO_LARGE")); }
          else chunks.push(chunk);
        });
        response.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8"), contentType }));
        response.on("error", reject);
        response.on("aborted", () => reject(new AppError(502, "Incomplete website response", "DEMO_WEBSITE_FETCH_FAILED")));
      });
      request.on("error", reject);
      request.end();
    });
  },
};

import { Parser } from "htmlparser2";
import robotsParser from "robots-parser";
import { CRAWLER_AGENT, demoPublicHttp, normalizeDemoUrl, withAbort } from "./demo-url.service";
import { AppError } from "../utils/errors";

export const CRAWL_LIMITS = { pages: 5, requests: 12, totalMs: 20_000, pageMs: 6_000, pageText: 6_000, totalText: 24_000 };
export type CrawlPage = { url: string; title: string; description: string; text: string; links: Array<{ url: string; label: string }> };
export type CrawlResult = { sourceWebsite: string | null; crawlStatus: "NOT_STARTED" | "COMPLETE" | "PARTIAL" | "FAILED"; startedAt: string; completedAt: string; pagesAttempted: number; pagesFetched: number; errorCode: string | null; pages: CrawlPage[] };
const clean = (value: string) => value.replace(/\s+/g, " ").trim();
const excluded = /(?:^|\/)(?:login|logout|signin|admin|wp-admin|cart|checkout|account|privacy|terms|cookies|search|tags?|blog)(?:[/.\-_]|$)/i;
const priority = /service|pric(?:e|ing)|about|contact|faq|booking|solution|appointment|what-we-do/i;
export function usefulLink(value: string, origin: string): URL | null {
  try {
    const url = normalizeDemoUrl(new URL(value, origin).href);
    if (url.origin !== new URL(origin).origin || excluded.test(decodeURIComponent(url.pathname)) || /\.(pdf|zip|png|jpe?g|gif|mp4|mp3|xml|css|js)$/i.test(url.pathname)) return null;
    return url;
  } catch { return null; }
}
export function parseDemoPage(html: string, url: string, plain = false): CrawlPage {
  const page: CrawlPage = { url, title: "", description: "", text: "", links: [] };
  if (plain) { page.text = clean(html).slice(0, CRAWL_LIMITS.pageText); return page; }
  const stack: Array<{ skip: boolean; blocked: boolean; tag: string }> = [];
  let title = false; let anchor: { url: string; label: string } | undefined;
  const parser = new Parser({
    onopentag(tag, attrs) {
      const blocked = Boolean(stack.at(-1)?.blocked) || ["script", "style", "noscript", "svg", "iframe", "form"].includes(tag) || "hidden" in attrs || attrs["aria-hidden"] === "true";
      const skip = Boolean(stack.at(-1)?.skip) || blocked || ["nav", "footer"].includes(tag);
      stack.push({ skip, blocked, tag });
      if (blocked) return;
      // Navigation text is omitted, but its public business links remain useful candidates.
      if (tag === "a" && attrs.href) {
        const link = usefulLink(attrs.href, url);
        if (link) anchor = { url: link.href, label: "" };
      }
      if (skip) return;
      if (tag === "title") title = true;
      if (tag === "meta" && attrs.name?.toLowerCase() === "description") page.description = clean(attrs.content ?? "").slice(0, 500);
      if (["p", "li", "h1", "h2", "h3", "td", "tr", "div", "section", "br"].includes(tag)) page.text += " ";
    },
    ontext(text) {
      if (stack.at(-1)?.blocked) return;
      if (anchor) anchor.label = (anchor.label + text).slice(0, 150);
      if (stack.at(-1)?.skip) return;
      if (title) page.title = (page.title + text).slice(0, 200);
      if (page.text.length < CRAWL_LIMITS.pageText * 2) page.text += text;
    },
    onclosetag(tag) {
      if (tag === "title") title = false;
      if (tag === "a" && anchor) { if (page.links.length < 100) page.links.push(anchor); anchor = undefined; }
      stack.pop();
    },
  }, { decodeEntities: true });
  parser.end(html);
  page.title = clean(page.title);
  page.text = clean(`${page.title} ${page.description} ${page.text}`).slice(0, CRAWL_LIMITS.pageText);
  return page;
}
export const demoCrawlerService = {
  async crawl(source: string, parentSignal?: AbortSignal): Promise<CrawlResult> {
    const start = Date.now();
    const initial = normalizeDemoUrl(source);
    const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(CRAWL_LIMITS.totalMs)]) : AbortSignal.timeout(CRAWL_LIMITS.totalMs);
    const result: CrawlResult = { sourceWebsite: initial.href, crawlStatus: "FAILED", startedAt: new Date(start).toISOString(), completedAt: "", pagesAttempted: 0, pagesFetched: 0, errorCode: null, pages: [] };
    let requests = 0; let failures = 0; let chars = 0;
    let robots: ReturnType<typeof robotsParser> | undefined;
    const fetchPage = async (input: URL, forRobots = false) => {
      let url = input;
      for (let redirects = 0; redirects <= 2; redirects++) {
        if (url.origin !== initial.origin) throw new AppError(400, "Cross-origin redirect blocked", "DEMO_WEBSITE_REDIRECT_BLOCKED");
        if (!forRobots && (!usefulLink(url.href, initial.href) || robots?.isAllowed(url.href, CRAWLER_AGENT) === false)) throw new AppError(403, "Website access rules block this page", "DEMO_WEBSITE_ROBOTS_BLOCKED");
        if (++requests > CRAWL_LIMITS.requests) throw new AppError(400, "Crawl request limit reached", "DEMO_WEBSITE_LIMIT_REACHED");
        const pageSignal = AbortSignal.any([signal, AbortSignal.timeout(CRAWL_LIMITS.pageMs)]);
        const response = await withAbort(demoPublicHttp.get(url, pageSignal, forRobots ? 64 * 1024 : undefined), pageSignal);
        if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
          url = normalizeDemoUrl(new URL(response.location, url).href);
          continue;
        }
        return { response, url };
      }
      throw new AppError(400, "Website redirect limit reached", "DEMO_WEBSITE_REDIRECT_BLOCKED");
    };
    try {
      const rules = await fetchPage(new URL("/robots.txt", initial), true);
      if (rules.response.status === 200 && rules.response.contentType === "text/plain") robots = robotsParser(new URL("/robots.txt", initial).href, rules.response.body);
      else if (![404, 410].includes(rules.response.status)) throw new AppError(403, "Website access rules unavailable", "DEMO_WEBSITE_ROBOTS_BLOCKED");
      const delay = Math.max(250, (robots?.getCrawlDelay(CRAWLER_AGENT) ?? 0) * 1000);
      const queue = [initial]; const seen = new Set<string>();
      while (queue.length && result.pagesAttempted < CRAWL_LIMITS.pages && chars < CRAWL_LIMITS.totalText && !signal.aborted) {
        const url = queue.shift()!;
        const key = url.href.replace(/\/$/, "");
        if (seen.has(key)) continue;
        seen.add(key);
        result.pagesAttempted++;
        try {
          await withAbort(new Promise(resolve => { const timer = setTimeout(resolve, Math.min(delay, CRAWL_LIMITS.totalMs)); timer.unref(); }), signal);
          if (delay >= CRAWL_LIMITS.totalMs) throw new AppError(408, "Website crawl delay exceeds demo budget", "DEMO_WEBSITE_TIMEOUT");
          const fetched = await fetchPage(url);
          if (fetched.response.status !== 200) throw new AppError(502, "Website could not be read", "DEMO_WEBSITE_FETCH_FAILED");
          const page = parseDemoPage(fetched.response.body, fetched.url.href, fetched.response.contentType === "text/plain");
          page.text = page.text.slice(0, CRAWL_LIMITS.totalText - chars); chars += page.text.length;
          result.pagesFetched++;
          result.pages.push(page);
          if (result.pagesAttempted === 1) {
            const candidates = page.links.filter(link => priority.test(new URL(link.url).pathname + " " + link.label));
            for (const candidate of candidates.slice(0, 20)) { const next = usefulLink(candidate.url, initial.href); if (next && robots?.isAllowed(next.href, CRAWLER_AGENT) !== false) queue.push(next); }
          }
        } catch (error) {
          failures++;
          result.errorCode = error instanceof AppError ? error.code : "DEMO_WEBSITE_FETCH_FAILED";
        }
      }
      result.crawlStatus = chars < 80 ? "FAILED" : failures || signal.aborted || chars >= CRAWL_LIMITS.totalText ? "PARTIAL" : "COMPLETE";
      if (chars < 80 && !result.errorCode) result.errorCode = "DEMO_WEBSITE_EMPTY";
    } catch (error) { result.errorCode = error instanceof AppError ? error.code : "DEMO_WEBSITE_FETCH_FAILED"; }
    result.completedAt = new Date().toISOString();
    return result;
  },
};

import { chromium } from "playwright";
import { handleCookieConsent } from "@/lib/cookie-consent";
import { detectChat } from "@/lib/detect-chat";
import type { DetectionEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");

  if (!url) {
    return Response.json({ error: "Missing url parameter" }, { status: 400 });
  }

  try {
    new URL(url);
  } catch {
    return Response.json({ error: "Invalid URL" }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;

      const send = (event: DetectionEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch {}
      };

      let browser;
      try {
        send({ type: "status", message: "Launching browser..." });

        browser = await chromium.launch({
          headless: true,
          args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        });

        const context = await browser.newContext({
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          viewport: { width: 1280, height: 800 },
        });

        const page = await context.newPage();
        page.on("console", () => {});
        page.on("pageerror", () => {});

        send({ type: "status", message: `Loading ${url}...` });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(3000);

        send({ type: "status", message: "Handling cookie consent..." });
        const cookieHandled = await handleCookieConsent(page);
        if (cookieHandled) {
          send({ type: "status", message: "Cookie consent accepted." });
        }
        await page.waitForTimeout(3000);

        send({ type: "status", message: "Running detection pipeline..." });
        const result = await detectChat(page, url, (message) => {
          send({ type: "status", message });
        });

        send({ type: "result", data: result });
        send({ type: "done" });

        await context.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error("[detect] Error:", message);
        send({ type: "error", message });
      } finally {
        if (browser) {
          try { await browser.close(); } catch {}
        }
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

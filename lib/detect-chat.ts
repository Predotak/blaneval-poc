import type { Page } from "playwright";
import * as cheerio from "cheerio";
import type { DetectionResult } from "./types";
import { KNOWN_VENDORS } from "./vendors";
import { callLLM, CHAT_DETECTION_PROMPT } from "./llm";
import { findChatLauncher } from "./fixed-scanner";

type ProgressFn = (message: string) => void;

const CHAT_DOMAIN_PATTERNS = [
  /chat/, /livechat/, /support/, /helpdesk/, /messenger/,
  /lette\.ai/, /crisp\.chat/, /drift\.com/, /tawk\.to/,
  /intercom/, /hubspot/, /zendesk/, /tidio/, /freshchat/,
  /olark/, /liveperson/, /comm100/, /kayako/, /smartsupp/,
];

function extractDOMSnapshot(html: string): string {
  const $ = cheerio.load(html);
  const elements: Record<string, string>[] = [];
  $("*").each((_, el) => {
    if (!("name" in el)) return;
    const tag = el.name as string;
    if (!tag || ["html", "head", "body", "script", "style", "noscript", "meta", "link"].includes(tag)) return;
    const id = $(el).attr("id") || "";
    const cls = ($(el).attr("class") || "").slice(0, 80);
    const role = $(el).attr("role") || "";
    const ariaLabel = $(el).attr("aria-label") || "";
    const placeholder = $(el).attr("placeholder") || "";
    if (id || cls || role || ariaLabel || placeholder) {
      elements.push({ tag, id, cls, role, ariaLabel, placeholder });
    }
  });
  return JSON.stringify(elements, null, 0).slice(0, 8000);
}

// Pass 1: Known vendor fingerprinting
async function detectByFingerprint(page: Page, onProgress: ProgressFn): Promise<DetectionResult | null> {
  onProgress("Pass 1: Checking known vendor fingerprints...");

  for (const vendor of KNOWN_VENDORS) {
    const found = await page.locator(vendor.detect).count();
    if (found > 0) {
      onProgress(`  ✓ ${vendor.name} detected on main page (${found} elements)`);
      return {
        found: true,
        method: "fingerprint",
        vendor: vendor.name,
        confidence: "high",
        widgetType: `${vendor.name} chat widget`,
        launcherSelector: vendor.open,
      };
    }

    for (const frame of page.frames()) {
      try {
        const inFrame = await frame.locator(vendor.detect).count();
        if (inFrame > 0) {
          onProgress(`  ✓ ${vendor.name} detected in iframe (${inFrame} elements)`);
          return {
            found: true,
            method: "fingerprint",
            vendor: vendor.name,
            confidence: "high",
            widgetType: `${vendor.name} chat widget (iframe)`,
            launcherSelector: vendor.open,
          };
        }
      } catch {
        // frame may have been detached
      }
    }
    onProgress(`  ✗ ${vendor.name} — not found`);
  }

  onProgress("Pass 1 result: No known vendor matched.");
  return null;
}

// Pass 1.5: Iframe source domain matching
async function detectByIframeDomain(page: Page, onProgress: ProgressFn): Promise<DetectionResult | null> {
  onProgress("Pass 1.5: Checking iframe sources for chat domains...");

  const iframes = await page.evaluate(() =>
    Array.from(document.querySelectorAll("iframe")).map((f) => ({
      src: f.src || f.getAttribute("data-src") || "",
      id: f.id || "",
    }))
  );

  if (iframes.length === 0) {
    onProgress("  No iframes found on page.");
  } else {
    for (const iframe of iframes) {
      const display = iframe.src.slice(0, 80) || "(empty src)";
      onProgress(`  iframe: ${display}${iframe.id ? ` id="${iframe.id}"` : ""}`);
    }
  }

  for (const iframe of iframes) {
    const srcLower = iframe.src.toLowerCase();
    const match = CHAT_DOMAIN_PATTERNS.find((p) => p.test(srcLower));
    if (match) {
      let hostname = "";
      try { hostname = new URL(iframe.src).hostname; } catch {}
      onProgress(`  ✓ Matched pattern /${match.source}/ on ${hostname}`);
      return {
        found: true,
        method: "iframe-domain",
        vendor: hostname || "unknown",
        confidence: "high",
        widgetType: `Chat widget from ${hostname}`,
        iframeSelector: iframe.id ? `iframe#${iframe.id}` : `iframe[src='${iframe.src}']`,
      };
    }
  }

  onProgress("Pass 1.5 result: No chat-related iframes found.");
  return null;
}

// Pass 2: LLM-based DOM analysis
async function detectByLLM(page: Page, url: string, onProgress: ProgressFn): Promise<DetectionResult | null> {
  onProgress("Pass 2: Running AI DOM analysis...");

  const html = await page.content();
  const domSnapshot = extractDOMSnapshot(html);
  onProgress(`  DOM snapshot: ${domSnapshot.length} chars`);

  // Gather all signals for the LLM
  const iframeSrcs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("iframe")).map((f) => f.src || "").filter(Boolean)
  );

  const scriptSrcs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("script[src]")).map((s) => (s as HTMLScriptElement).src)
  );

  const fixedElements = await page.evaluate(() => {
    const results: string[] = [];
    for (const el of document.querySelectorAll("*")) {
      const style = window.getComputedStyle(el);
      if (style.position !== "fixed" && style.position !== "sticky") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const visible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      if (!visible) continue;
      results.push(
        `<${el.tagName.toLowerCase()}> id="${el.id}" class="${(el.className?.toString?.() || "").slice(0, 60)}" aria-label="${el.getAttribute("aria-label") || ""}" pos=(${Math.round(rect.x)},${Math.round(rect.y)}) size=${Math.round(rect.width)}x${Math.round(rect.height)}`
      );
    }
    return results;
  });

  onProgress(`  Iframes: ${iframeSrcs.length}, Scripts: ${scriptSrcs.length}, Fixed elements: ${fixedElements.length}`);

  const userPrompt = `Page URL: ${url}

DOM snapshot (condensed):
${domSnapshot}

Iframe sources:
${iframeSrcs.length > 0 ? iframeSrcs.join("\n") : "(none)"}

Script sources:
${scriptSrcs.join("\n")}

Fixed/sticky-position visible elements:
${fixedElements.length > 0 ? fixedElements.join("\n") : "(none)"}`;

  onProgress("  Calling LLM...");
  const aiResult = await callLLM(CHAT_DETECTION_PROMPT, userPrompt);

  onProgress(`  LLM response: ${aiResult.slice(0, 200)}`);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(aiResult);
  } catch {
    const match = aiResult.match(/\{[\s\S]*\}/);
    if (match) {
      parsed = JSON.parse(match[0]);
      onProgress("  (extracted JSON from response)");
    } else {
      parsed = { found: false, notes: aiResult };
      onProgress("  (could not parse JSON from response)");
    }
  }

  onProgress(`  AI verdict: found=${parsed.found}, confidence=${parsed.confidence || "n/a"}`);

  if (parsed.found) {
    return {
      found: true,
      method: "ai",
      confidence: (parsed.confidence as "high" | "medium" | "low") || "medium",
      widgetType: (parsed.widget_type as string) || "Unknown chat widget",
      launcherSelector: (parsed.launcher_selector as string) || undefined,
      notes: (parsed.notes as string) || undefined,
    };
  }

  onProgress(`Pass 2 result: ${(parsed.notes as string) || "No chat detected by AI."}`);
  return null;
}

// Screenshot the launcher element
async function screenshotLauncher(page: Page, selector: string): Promise<string | undefined> {
  try {
    await page.addStyleTag({
      content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
    });
    const el = page.locator(selector).first();
    const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) {
      const buffer = await el.screenshot({ timeout: 5000 });
      return buffer.toString("base64");
    }
  } catch {
    // screenshot failed, not critical
  }
  return undefined;
}

// Scan all fixed-position elements for debugging
async function logFixedElements(page: Page, onProgress: ProgressFn) {
  const elements = await page.evaluate(() => {
    const results: { tag: string; id: string; cls: string; w: number; h: number; x: number; y: number; visible: boolean; hint: string }[] = [];
    for (const el of document.querySelectorAll("*")) {
      const style = window.getComputedStyle(el);
      if (style.position !== "fixed" && style.position !== "sticky") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const visible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      results.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || "",
        cls: (el.className?.toString?.() || "").slice(0, 60),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        visible,
        hint: [el.tagName.toLowerCase(), el.id, el.className, el.getAttribute("aria-label") || ""].join(" ").toLowerCase().trim().slice(0, 60),
      });
    }
    return results;
  });

  if (elements.length === 0) {
    onProgress("  No fixed/sticky elements found.");
  } else {
    onProgress(`  Fixed/sticky elements (${elements.length}):`);
    for (const e of elements) {
      const vis = e.visible ? "✓" : "✗";
      onProgress(`    ${vis} <${e.tag}> #${e.id || "(none)"} ${e.w}x${e.h} at (${e.x},${e.y}) hint="${e.hint}"`);
    }
  }
}

export async function detectChat(
  page: Page,
  url: string,
  onProgress: ProgressFn
): Promise<DetectionResult> {
  // Log page title for context
  const title = await page.title();
  onProgress(`Page title: "${title}"`);

  // Pass 1
  const fingerprint = await detectByFingerprint(page, onProgress);
  if (fingerprint) {
    onProgress(`Found: ${fingerprint.vendor} (vendor fingerprint)`);
    if (fingerprint.launcherSelector) {
      fingerprint.screenshotBase64 = await screenshotLauncher(page, fingerprint.launcherSelector);
    }
    return fingerprint;
  }

  // Pass 1.5
  const iframeDomain = await detectByIframeDomain(page, onProgress);
  if (iframeDomain) {
    onProgress(`Found: ${iframeDomain.vendor} (iframe domain)`);
    const launcher = await findChatLauncher(page);
    if (launcher?.id) {
      onProgress(`  Launcher via fixed-scanner: #${launcher.id} (${launcher.area}px²)`);
      iframeDomain.launcherSelector = `#${launcher.id}`;
      iframeDomain.screenshotBase64 = await screenshotLauncher(page, `#${launcher.id}`);
    }
    return iframeDomain;
  }

  // Pass 1.75a: Script source detection
  onProgress("Pass 1.75a: Checking script sources for chat platforms...");
  const chatScript = await page.evaluate(() => {
    const patterns = /chat|livechat|smartsupp|tawk|crisp|intercom|drift|hubspot|zendesk|tidio|messenger|amio|freshchat|olark|jivochat|gorgias|helpscout|userlike|comm100|kayako|liveperson|botpress|voiceflow|chatwoot/i;
    for (const s of document.querySelectorAll("script[src]")) {
      if (patterns.test(s.src)) return s.src;
    }
    return null;
  });

  if (chatScript) {
    onProgress(`  ✓ Chat script found: ${chatScript.slice(0, 100)}`);
    const launcher = await findChatLauncher(page);
    const screenshot = launcher?.id ? await screenshotLauncher(page, `#${launcher.id}`) : undefined;

    let vendor = "unknown";
    try {
      const hostname = new URL(chatScript).hostname;
      vendor = hostname;
    } catch {
      const match = chatScript.match(/\/([^/]+?)(?:\.js)?$/);
      if (match) vendor = match[1];
    }

    return {
      found: true,
      method: "fingerprint",
      vendor,
      confidence: "high",
      widgetType: `Chat widget (detected via script: ${chatScript.slice(0, 60)})`,
      launcherSelector: launcher?.id ? `#${launcher.id}` : undefined,
      screenshotBase64: screenshot,
    };
  }
  onProgress("  No chat scripts found.");

  // Pass 1.75b: Custom element tag scan
  onProgress("Pass 1.75: Scanning for chat-related custom elements...");
  const customElement = await page.evaluate(() => {
    const chatTags = [
      "df-messenger", "kommunicate-widget", "botpress-webchat",
      "voiceflow-chat", "landbot-widget", "chatwoot-widget",
    ];
    // Check exact known tags
    for (const tag of chatTags) {
      const el = document.querySelector(tag);
      if (el) {
        const rect = el.getBoundingClientRect();
        return { tag, id: el.id || "", w: Math.round(rect.width), h: Math.round(rect.height) };
      }
    }
    // Check any custom element whose tag contains chat/messenger/bot/widget
    const all = document.querySelectorAll("*");
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      if (!tag.includes("-")) continue; // custom elements have a hyphen
      if (/chat|messenger|bot|widget|support|helpdesk/.test(tag)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return { tag, id: el.id || "", w: Math.round(rect.width), h: Math.round(rect.height) };
        }
      }
    }
    return null;
  });

  if (customElement) {
    onProgress(`  ✓ Custom element found: <${customElement.tag}> ${customElement.w}x${customElement.h}`);
    const selector = customElement.id ? `#${customElement.id}` : customElement.tag;
    const screenshot = await screenshotLauncher(page, selector);
    return {
      found: true,
      method: "fingerprint",
      vendor: customElement.tag,
      confidence: "high",
      widgetType: `Chat widget (<${customElement.tag}> custom element)`,
      launcherSelector: selector,
      screenshotBase64: screenshot,
    };
  }
  onProgress("  No chat-related custom elements found.");

  // Pass 2
  try {
    const ai = await detectByLLM(page, url, onProgress);
    if (ai) {
      onProgress(`Found: ${ai.widgetType} (AI analysis)`);
      const launcher = await findChatLauncher(page);
      if (launcher?.id) {
        onProgress(`  Launcher via fixed-scanner: #${launcher.id} (${launcher.area}px²)`);
        ai.launcherSelector = ai.launcherSelector || `#${launcher.id}`;
        ai.screenshotBase64 = await screenshotLauncher(page, `#${launcher.id}`);
      }
      return ai;
    }
  } catch (err) {
    onProgress(`AI detection failed: ${(err as Error).message}`);
  }

  // Final fallback: fixed-position scanner
  onProgress("Fallback: Scanning fixed-position elements...");
  await logFixedElements(page, onProgress);

  const launcher = await findChatLauncher(page);
  if (launcher) {
    onProgress(`Possible launcher found: #${launcher.id} (${launcher.area}px², hint="${launcher.hint}")`);
    const screenshot = launcher.id
      ? await screenshotLauncher(page, `#${launcher.id}`)
      : undefined;
    return {
      found: true,
      method: "fixed-scanner",
      confidence: "low",
      widgetType: "Possible chat widget (detected by position heuristic)",
      launcherSelector: launcher.id ? `#${launcher.id}` : undefined,
      notes: `Fixed-position element: ${launcher.hint}`,
      screenshotBase64: screenshot,
    };
  }

  // Log everything we see for debugging
  onProgress("Debug: All fixed-position elements on page:");
  await logFixedElements(page, onProgress);

  onProgress("No chat widget detected.");
  return {
    found: false,
    method: "none",
    confidence: "high",
    notes: "No chat widget found by any detection method.",
  };
}

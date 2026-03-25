import type { Page } from "playwright";
import * as cheerio from "cheerio";
import type { DetectionResult } from "./types";
import { KNOWN_VENDORS } from "./vendors";
import { callLLM, CHAT_DETECTION_PROMPT, callVisionLLM, VISUAL_CHAT_DETECTION_PROMPT } from "./llm";
import { findChatLauncher, findAllCandidates } from "./fixed-scanner";

import type { CandidateScreenshot } from "./types";

type ProgressFn = (message: string) => void;
type CandidateFn = (candidate: CandidateScreenshot) => void;

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
async function detectByLLM(page: Page, url: string, onProgress: ProgressFn, hints?: { chatScript?: string }): Promise<DetectionResult | null> {
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

  const hintSection = hints?.chatScript
    ? `\n\nIMPORTANT HINT: A chat-related script was already detected: ${hints.chatScript}\nThis strongly suggests a chat widget exists. Focus on finding its launcher element — it may be inside an iframe.`
    : "";

  const userPrompt = `Page URL: ${url}

DOM snapshot (condensed):
${domSnapshot}

Iframe sources:
${iframeSrcs.length > 0 ? iframeSrcs.join("\n") : "(none)"}

Script sources:
${scriptSrcs.join("\n")}

Fixed/sticky-position visible elements:
${fixedElements.length > 0 ? fixedElements.join("\n") : "(none)"}${hintSection}`;

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
  onProgress: ProgressFn,
  onCandidate?: CandidateFn
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
  // This is a signal, not a final answer — only return early if we also find a launcher
  onProgress("Pass 1.75a: Checking script sources for chat platforms...");
  let chatScriptHint: string | null = null;

  const chatScript = await page.evaluate(() => {
    const patterns = /chat|livechat|smartsupp|tawk|crisp|intercom|drift|hubspot|zendesk|tidio|messenger|amio|freshchat|olark|jivochat|gorgias|helpscout|userlike|comm100|kayako|liveperson|botpress|voiceflow|chatwoot/i;
    for (const s of document.querySelectorAll<HTMLScriptElement>("script[src]")) {
      if (patterns.test(s.src)) return s.src;
    }
    return null;
  });

  if (chatScript) {
    onProgress(`  ✓ Chat script found: ${chatScript.slice(0, 100)}`);
    chatScriptHint = chatScript;

    // Only return early if we can also find the launcher on the main page
    const launcher = await findChatLauncher(page);
    if (launcher?.id) {
      onProgress(`  ✓ Launcher also found: #${launcher.id}`);
      const screenshot = await screenshotLauncher(page, `#${launcher.id}`);

      let vendor = "unknown";
      try { vendor = new URL(chatScript).hostname; } catch {}

      return {
        found: true,
        method: "fingerprint",
        vendor,
        confidence: "high",
        widgetType: `Chat widget (detected via script: ${chatScript.slice(0, 60)})`,
        launcherSelector: `#${launcher.id}`,
        screenshotBase64: screenshot,
      };
    }
    onProgress("  Script found but no launcher on main page — will pass hint to LLM.");
  } else {
    onProgress("  No chat scripts found.");
  }

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
  let aiResult: DetectionResult | null = null;
  try {
    aiResult = await detectByLLM(page, url, onProgress, {
      chatScript: chatScriptHint ?? undefined,
    });
    if (aiResult) {
      onProgress(`Found: ${aiResult.widgetType} (AI analysis, confidence: ${aiResult.confidence})`);
      const launcher = await findChatLauncher(page);
      if (launcher?.id) {
        onProgress(`  Launcher via fixed-scanner: #${launcher.id} (${launcher.area}px²)`);
        aiResult.launcherSelector = aiResult.launcherSelector || `#${launcher.id}`;
        aiResult.screenshotBase64 = await screenshotLauncher(page, `#${launcher.id}`);
      }
      // Always continue to Pass 3 for visual verification
      onProgress("  Continuing to Pass 3 for visual verification...");
    }
  } catch (err) {
    onProgress(`AI detection failed: ${(err as Error).message}`);
  }

  // Pass 3: Visual analysis — screenshot ALL fixed/sticky elements and ask vision LLM
  onProgress("Pass 3: Visual analysis of candidate elements...");
  try {
    let candidates = await findAllCandidates(page);
    onProgress(`  findAllCandidates: ${candidates.length} elements`);

    // If findAllCandidates found nothing, gather ALL visible fixed/sticky elements as fallback
    if (candidates.length === 0) {
      onProgress("  Expanding search to all visible fixed/sticky elements...");
      candidates = await page.evaluate(() => {
        const results: { id: string; tag: string; area: number; hint: string; selector: string }[] = [];
        for (const el of document.querySelectorAll("*")) {
          const style = window.getComputedStyle(el);
          if (style.position !== "fixed" && style.position !== "sticky") continue;
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          // Skip full-screen overlays
          if (rect.width > window.innerWidth * 0.9 && rect.height > window.innerHeight * 0.9) continue;
          const tag = el.tagName.toLowerCase();
          const cls = el.className?.toString?.() ?? "";
          const firstClass = cls.split(/\s+/).filter(Boolean)[0] || "";
          const hint = [tag, el.id, cls, el.getAttribute("aria-label") || ""].join(" ").toLowerCase().trim().slice(0, 80);
          const selector = el.id ? `#${el.id}` : (firstClass ? `${tag}.${firstClass}` : tag);
          results.push({ id: el.id || "", tag, area: Math.round(rect.width * rect.height), hint, selector });
        }
        results.sort((a, b) => a.area - b.area);
        return results.slice(0, 5);
      });
      onProgress(`  Expanded search: ${candidates.length} elements`);
    }

    if (candidates.length > 0) {
      // Disable animations for stable screenshots
      await page.addStyleTag({
        content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
      });

      // Screenshot each candidate
      const images: { base64: string; label: string }[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const sel = c.selector || (c.id ? `#${c.id}` : c.tag);
        try {
          const el = page.locator(sel).first();
          const visible = await el.isVisible({ timeout: 1000 }).catch(() => false);
          if (visible) {
            const buffer = await el.screenshot({ timeout: 3000 });
            const b64 = buffer.toString("base64");
            const label = `Element ${i}: <${c.tag}> ${c.hint} (${c.area}px²)`;
            images.push({ base64: b64, label });
            onCandidate?.({ index: i, label, base64: b64 });
            onProgress(`  ✓ Screenshot ${i}: <${c.tag}> ${c.hint.slice(0, 40)} (${c.area}px²)`);
          } else {
            onProgress(`  ✗ Element ${i} not visible: ${sel}`);
          }
        } catch {
          onProgress(`  ✗ Could not screenshot element ${i}: ${sel}`);
        }
      }

      if (images.length > 0) {
        onProgress(`  Sending ${images.length} screenshots to vision LLM...`);
        const textPrompt = `I have ${images.length} screenshots of fixed-position UI elements from ${url}.\n\n` +
          images.map((img, i) => `Image ${i}: ${img.label}`).join("\n") +
          "\n\nWhich one (if any) is a chat widget launcher?";

        const visionResult = await callVisionLLM(
          VISUAL_CHAT_DETECTION_PROMPT,
          textPrompt,
          images
        );

        onProgress(`  Vision LLM raw response: ${visionResult.slice(0, 300)}`);

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(visionResult);
        } catch {
          const match = visionResult.match(/\{[\s\S]*\}/);
          parsed = match ? JSON.parse(match[0]) : { chat_launcher_index: null };
        }

        // Log each candidate's verdict
        const verdicts = parsed.candidates as { index: number; is_chat: boolean; reason: string }[] | undefined;
        if (verdicts && Array.isArray(verdicts)) {
          for (const v of verdicts) {
            const icon = v.is_chat ? "✓" : "✗";
            onProgress(`  ${icon} Element ${v.index}: ${v.reason}`);
          }
        }

        const idx = parsed.chat_launcher_index;
        if (typeof idx === "number" && idx >= 0 && idx < candidates.length) {
          const winner = candidates[idx];
          const winnerSel = winner.selector || (winner.id ? `#${winner.id}` : winner.tag);
          onProgress(`  ✓ Visual match: element ${idx} — <${winner.tag}> ${winner.hint}`);
          onCandidate?.({ index: idx, label: `Match: <${winner.tag}> ${winner.hint}`, base64: images[idx]?.base64 ?? "", isMatch: true });

          return {
            found: true,
            method: "visual",
            confidence: (parsed.confidence as "high" | "medium" | "low") || "medium",
            widgetType: `Chat launcher (visually identified: ${(parsed.reason as string) || winner.hint})`,
            launcherSelector: winnerSel,
            screenshotBase64: images[idx]?.base64,
            notes: (parsed.reason as string) || undefined,
          };
        }
        onProgress("  Vision LLM: no chat launcher identified.");
      }
    }
  } catch (err) {
    onProgress(`  Visual analysis failed: ${(err as Error).message}`);
  }

  // If Pass 2 found something with medium/low confidence but Pass 3 didn't confirm,
  // still return the AI result as best guess
  if (aiResult) {
    onProgress(`Returning AI result (${aiResult.confidence} confidence, unconfirmed by visual pass).`);
    return aiResult;
  }

  onProgress("No chat widget detected.");
  return {
    found: false,
    method: "none",
    confidence: "high",
    notes: "No chat widget found by any detection method.",
  };
}

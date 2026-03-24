import { chromium } from "playwright";
import OpenAI from "openai";
import * as cheerio from "cheerio";

// ─────────────────────────────────────────────
// CONFIG — fill these in before running
// ─────────────────────────────────────────────
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "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";
const MODEL = "meta-llama/llama-3.3-70b-instruct"; // swap freely on OpenRouter
const TARGET_URLS = [
  "https://www.hali.ie/",
  // add more URLs here
];

// ─────────────────────────────────────────────
// KNOWN VENDOR FINGERPRINTS (Pass 1 detection)
// Each entry: selector to detect presence, selector to open, input selector,
// message container selector
// ─────────────────────────────────────────────
const KNOWN_VENDORS = [
  {
    name: "Intercom",
    detect: "#intercom-container, .intercom-launcher, iframe[name*='intercom']",
    open: ".intercom-launcher, [aria-label*='Open Intercom'], .intercom-launcher-frame",
    input: ".intercom-composer-input, [placeholder*='message' i]",
    messages: ".intercom-conversation-part-body, .intercom-block-paragraph",
  },
  {
    name: "Drift",
    detect: "#drift-widget, .drift-widget-container, iframe#drift-widget",
    open: "#drift-widget .widget-button, .drift-open-chat",
    input: "textarea.compose-box",
    messages: ".drift-message-text",
  },
  {
    name: "Zendesk",
    detect: "#launcher, iframe#launcher, [data-testid='launcher']",
    open: "#launcher, iframe#launcher",
    input: "input[placeholder*='Type a message' i], textarea[placeholder*='Type' i]",
    messages: ".message-content, [data-garden-id='chat.message']",
  },
  {
    name: "Tidio",
    detect: "#tidio-chat, #tidio-chat-iframe, .tidio-chat",
    open: "#tidio-chat-code, .tidio-1hq5mx6",
    input: "textarea[data-tidio-element='textarea']",
    messages: "[data-tidio-element='message']",
  },
  {
    name: "HubSpot",
    detect: "#hubspot-messages-iframe-container, #hs-chat-open-button",
    open: "#hubspot-messages-iframe-container .open-button, #hs-chat-open-button",
    input: "input[placeholder*='message' i], textarea[placeholder*='message' i]",
    messages: ".private-message__text, .message-bubble",
  },
  {
    name: "tawk.to",
    detect: "#tawkchat-container, iframe[title*='tawk' i]",
    open: ".tawk-button, .tawk-min-container",
    input: "textarea[placeholder*='Enter message' i]",
    messages: ".tawk-message-text",
  },
  {
    name: "Crisp",
    detect: ".crisp-client, #crisp-chatbox",
    open: ".crisp-client .cc-tlyw, [data-id='crisp']",
    input: "div[contenteditable][data-placeholder]",
    messages: ".crisp-message-text",
  },
];

// ─────────────────────────────────────────────
// BENCHMARK QUESTIONS (sent during Step 3)
// These are generic — AI will also generate
// site-specific ones after Step 1 analysis
// ─────────────────────────────────────────────
const GENERIC_QUESTIONS = [
  "Hi, what can you help me with?",
  "What are your main products or services?",
];

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
const client = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

async function callLLM(systemPrompt, userPrompt, label, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    console.log(`\n  [LLM] Calling model for: ${label}... (attempt ${attempt}/${retries})`);
    try {
      const res = await client.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 1024,
      });
      return res.choices[0].message.content.trim();
    } catch (err) {
      if (err.status === 429 && attempt < retries) {
        const wait = attempt * 5;
        console.log(`  Rate limited. Waiting ${wait}s before retry...`);
        await new Promise(r => setTimeout(r, wait * 1000));
      } else {
        throw err;
      }
    }
  }
}

function separator(title) {
  const line = "─".repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

function log(label, value) {
  console.log(`\n  ▸ ${label}:`);
  if (typeof value === "object") {
    console.log(JSON.stringify(value, null, 4).split("\n").map(l => "    " + l).join("\n"));
  } else {
    const lines = String(value).split("\n");
    lines.forEach(l => console.log(`    ${l}`));
  }
}

// Handle cookie consent banners — tries common accept buttons
async function handleCookieConsent(page) {
  console.log("\n  [Cookies] Looking for cookie consent banner...");

  const acceptSelectors = [
    // Common consent management platforms
    "button[id*='accept' i]",
    "button[class*='accept' i]",
    "a[id*='accept' i]",
    "button[data-action='accept']",
    // CookieBot
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "#CybotCookiebotDialogBodyButtonAccept",
    // OneTrust
    "#onetrust-accept-btn-handler",
    // Complianz
    ".cmplz-accept",
    // CookieYes
    ".cky-btn-accept",
    // Generic text matching
    "button:has-text('Accept All')",
    "button:has-text('Accept all')",
    "button:has-text('Accept Cookies')",
    "button:has-text('Accept cookies')",
    "button:has-text('Allow All')",
    "button:has-text('Allow all')",
    "button:has-text('I agree')",
    "button:has-text('Got it')",
    "button:has-text('OK')",
    "a:has-text('Accept All')",
    "a:has-text('Accept all')",
  ];

  for (const selector of acceptSelectors) {
    try {
      const btn = page.locator(selector).first();
      const visible = await btn.isVisible({ timeout: 500 }).catch(() => false);
      if (visible) {
        await btn.click({ timeout: 3000 });
        console.log(`  [Cookies] Accepted via: ${selector}`);
        return true;
      }
    } catch {
      continue;
    }
  }

  console.log("  [Cookies] No consent banner found or already dismissed.");
  return false;
}

// Clean HTML down to readable text for LLM context
function extractPageText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, img, link, meta").remove();
  return $("body").text().replace(/\s+/g, " ").trim().slice(0, 6000);
}

// Get a simplified DOM snapshot for chat detection (tag + id + class + aria)
function extractDOMSnapshot(html) {
  const $ = cheerio.load(html);
  const elements = [];
  $("*").each((_, el) => {
    const tag = el.name;
    if (!tag || ["html", "head", "body", "script", "style", "noscript", "meta", "link"].includes(tag)) return;
    const id = $(el).attr("id") || "";
    const cls = ($(el).attr("class") || "").slice(0, 80);
    const role = $(el).attr("role") || "";
    const ariaLabel = $(el).attr("aria-label") || "";
    const placeholder = $(el).attr("placeholder") || "";
    const title = $(el).attr("title") || "";
    const dataSrc = $(el).attr("src") || "";
    if (id || cls || role || ariaLabel || placeholder) {
      elements.push({ tag, id, cls, role, ariaLabel, placeholder, title, src: dataSrc });
    }
  });
  // Return a condensed JSON string, capped at 8000 chars
  return JSON.stringify(elements, null, 0).slice(0, 8000);
}

// ─────────────────────────────────────────────
// STEP 1: ANALYZE
// ─────────────────────────────────────────────
async function analyzeWebsite(page, url) {
  separator(`STEP 1 — ANALYZE: ${url}`);

  const html = await page.content();
  const pageText = extractPageText(html);
  const pageTitle = await page.title();

  log("Page title", pageTitle);
  log("Extracted text (preview)", pageText.slice(0, 300) + "...");

  const analysis = await callLLM(
    `You are a website analyst. Given the text content of a website, extract structured information.
Always respond with valid JSON only, no markdown, no explanation.
JSON shape:
{
  "purpose": "one sentence describing what this website is for",
  "type": "e.g. ecommerce, blog, SaaS, news, community, portfolio, etc",
  "audience": "who the target audience is",
  "tone": "e.g. professional, friendly, casual, formal, playful",
  "topics": ["main topic 1", "main topic 2", "main topic 3"],
  "benchmark_questions": [
    "a relevant question a visitor might ask the chat",
    "another relevant question",
    "a third relevant question"
  ]
}`,
    `Website URL: ${url}\nPage title: ${pageTitle}\n\nPage content:\n${pageText}`,
    "website analysis"
  );

  let parsed;
  try {
    parsed = JSON.parse(analysis);
  } catch {
    // Try to extract JSON from response if model added extra text
    const match = analysis.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : { raw: analysis };
  }

  log("Analysis result", parsed);
  return parsed;
}

// ─────────────────────────────────────────────
// STEP 2: DETECT CHAT
// ─────────────────────────────────────────────
async function detectChat(page, url) {
  separator(`STEP 2 — DETECT CHAT: ${url}`);

  // Wait a bit for JS-rendered widgets to appear
  await page.waitForTimeout(3000);

  // --- Pass 1: Known vendor fingerprinting ---
  console.log("\n  [Pass 1] Checking known vendor fingerprints...");

  for (const vendor of KNOWN_VENDORS) {
    const found = await page.locator(vendor.detect).count();
    if (found > 0) {
      log("Vendor detected", vendor.name);
      log("Using selector map", {
        open: vendor.open,
        input: vendor.input,
        messages: vendor.messages,
      });
      return { found: true, method: "fingerprint", vendor };
    }

    // Also check inside iframes (many vendors embed in iframes)
    for (const frame of page.frames()) {
      try {
        const inFrame = await frame.locator(vendor.detect).count();
        if (inFrame > 0) {
          log("Vendor detected (in iframe)", vendor.name);
          return { found: true, method: "fingerprint", vendor, frame };
        }
      } catch {
        // frame may have been detached
      }
    }
  }

  console.log("  No known vendor found.");

  // --- Pass 1.5: Check iframe sources for known chat domains ---
  console.log("\n  [Pass 1.5] Checking iframe sources for chat domains...");
  const iframeSrcs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("iframe")).map(f => ({
      src: f.src || f.getAttribute("data-src") || "",
      id: f.id || "",
      cls: f.className || "",
    }))
  );

  const chatDomainPatterns = [
    /chat/, /livechat/, /support/, /helpdesk/, /messenger/,
    /lette\.ai/, /crisp\.chat/, /drift\.com/, /tawk\.to/,
    /intercom/, /hubspot/, /zendesk/, /tidio/, /freshchat/,
    /olark/, /liveperson/, /comm100/, /kayako/, /smartsupp/,
  ];

  for (const iframe of iframeSrcs) {
    const srcLower = iframe.src.toLowerCase();
    const match = chatDomainPatterns.find(p => p.test(srcLower));
    if (match) {
      log("Chat iframe detected via domain", { src: iframe.src, id: iframe.id });
      const iframeSelector = iframe.id
        ? `iframe#${iframe.id}`
        : `iframe[src='${iframe.src}']`;
      // Find the actual frame object for interaction
      const chatFrame = page.frames().find(f => f.url().includes(iframe.src.split("?")[0]));
      return {
        found: true,
        method: "iframe-domain",
        confidence: "high",
        widget_type: `Chat widget from ${new URL(iframe.src).hostname}`,
        iframe_selector: iframeSelector,
        launcher_selector: iframeSelector,
        input_selector: "input[type='text'], textarea, div[contenteditable='true']",
        messages_selector: "[class*='message'], [class*='chat'], [class*='response'], [class*='bubble']",
        frame: chatFrame || null,
      };
    }
  }

  // --- Pass 2: AI DOM analysis ---
  console.log("\n  [Pass 2] Extracting DOM snapshot for LLM analysis...");
  const html = await page.content();
  const domSnapshot = extractDOMSnapshot(html);
  log("Iframes found", iframeSrcs.length > 0 ? iframeSrcs : "none");

  const aiResult = await callLLM(
    `You are an expert web scraper analyzing a DOM snapshot to find a chat widget.
A chat widget typically has: a launcher button (floating, usually bottom-right), an input field for typing messages, and a message display area.
Look for elements with IDs/classes/aria-labels suggesting chat, messaging, support, helpdesk, bot, assistant, live-chat, etc.

If you find a chat widget, respond ONLY with this JSON:
{
  "found": true,
  "confidence": "high|medium|low",
  "widget_type": "description of what kind of chat it appears to be",
  "launcher_selector": "CSS selector to click to open the chat",
  "input_selector": "CSS selector for the message input field",
  "messages_selector": "CSS selector for the chat message container",
  "notes": "any relevant notes about the widget"
}

If no chat widget is found, respond ONLY with:
{ "found": false, "notes": "reason why no chat was found" }

Never include markdown or explanations outside the JSON.`,
    `Page URL: ${url}\n\nDOM snapshot (condensed):\n${domSnapshot}\n\nIframe sources: ${JSON.stringify(iframeSrcs)}`,
    "AI chat detection"
  );

  let parsed;
  try {
    parsed = JSON.parse(aiResult);
  } catch {
    const match = aiResult.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : { found: false, notes: aiResult };
  }

  log("AI detection result", parsed);
  return { method: "ai", ...parsed };
}

// ─────────────────────────────────────────────
// STEP 3: INTERACT WITH CHAT
// ─────────────────────────────────────────────
async function interactWithChat(page, detection, analysisResult, url) {
  separator(`STEP 3 — INTERACT: ${url}`);

  if (!detection.found) {
    log("Result", "No chat widget found — skipping interaction step");
    return;
  }

  // Build question set: generic + site-specific from analysis
  const questions = [
    ...GENERIC_QUESTIONS,
    ...(analysisResult?.benchmark_questions || []).slice(0, 2),
  ];
  log("Questions to send", questions);

  // Resolve selectors from detection result
  let openSelector, inputSelector, messagesSelector, targetFrame;

  if (detection.method === "fingerprint") {
    openSelector = detection.vendor.open;
    inputSelector = detection.vendor.input;
    messagesSelector = detection.vendor.messages;
    targetFrame = detection.frame || null;
  } else if (detection.method === "iframe-domain") {
    openSelector = detection.iframe_selector;
    inputSelector = detection.input_selector;
    messagesSelector = detection.messages_selector;
    targetFrame = detection.frame || null;
  } else {
    openSelector = detection.launcher_selector;
    inputSelector = detection.input_selector;
    messagesSelector = detection.messages_selector;
  }

  log("Selectors in use", { openSelector, inputSelector, messagesSelector });

  // --- Try to open the chat ---
  console.log("\n  [3a] Opening chat widget...");
  let chatOpened = false;

  // Build a prioritized list of selectors to try
  const launchSelectors = [
    // From detection result (if visible)
    openSelector,
    // Common chat trigger/launcher IDs
    "[id*='chat-widget-trigger']", "[id*='chat-launcher']", "[id*='chat-button']",
    // Heuristic selectors
    "button[aria-label*='chat' i]", "button[title*='chat' i]",
    "[class*='chat'][class*='launcher' i]", "[class*='chat'][class*='trigger' i]",
    "[class*='chat'][class*='button' i]", "[class*='chat'][class*='open' i]",
    "button[aria-label*='support' i]", "button[aria-label*='help' i]",
    "[class*='widget'][class*='button' i]",
    "img[alt*='chat' i]",
  ];

  for (const sel of launchSelectors) {
    if (!sel || chatOpened) continue;
    try {
      const el = page.locator(sel).first();
      const vis = await el.isVisible({ timeout: 1000 }).catch(() => false);
      if (vis) {
        await el.click({ timeout: 3000 });
        console.log(`  Chat opened via: ${sel}`);
        chatOpened = true;
        await page.waitForTimeout(2000);
      }
    } catch { continue; }
  }

  // Fallback: scan for fixed-position visible elements in bottom-right that look chat-related
  if (!chatOpened) {
    console.log("  [3a] Scanning fixed-position elements...");
    const launcherId = await page.evaluate(() => {
      const all = document.querySelectorAll("*");
      let best = null;
      let bestArea = Infinity;
      for (const el of all) {
        const style = window.getComputedStyle(el);
        if (style.position !== "fixed" && style.position !== "sticky") continue;
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < window.innerHeight * 0.7 || rect.right < window.innerWidth * 0.6) continue;
        const hint = [el.id, el.className, el.getAttribute("aria-label") || ""].join(" ").toLowerCase();
        if (!/chat|message|support|help|bot|widget|launcher|lette|crisp|drift|intercom|hubspot|tawk|zendesk|tidio/.test(hint)) continue;
        const area = rect.width * rect.height;
        if (area < bestArea) { bestArea = area; best = el.id || null; }
      }
      return best;
    });

    if (launcherId) {
      try {
        await page.locator(`#${launcherId}`).click({ timeout: 3000 });
        console.log(`  Chat opened via fixed-position scan: #${launcherId}`);
        chatOpened = true;
        await page.waitForTimeout(2000);
      } catch (err) {
        console.log(`  Click failed: ${err.message}`);
      }
    }
  }

  // Last resort: force-show chat iframes
  if (!chatOpened) {
    console.log("  [3a] Force-showing chat iframes...");
    try {
      const forced = await page.evaluate(() => {
        const iframes = document.querySelectorAll("iframe[src*='chat'], iframe[id*='chat']");
        if (iframes.length === 0) return false;
        for (const iframe of iframes) {
          iframe.style.cssText = "display:block!important;visibility:visible!important;opacity:1!important;position:fixed!important;bottom:20px!important;right:20px!important;width:400px!important;height:600px!important;z-index:999999!important;";
          // Also show parent containers
          let parent = iframe.parentElement;
          for (let i = 0; i < 3 && parent; i++) {
            parent.style.display = "block";
            parent.style.visibility = "visible";
            parent.style.opacity = "1";
            parent = parent.parentElement;
          }
        }
        return true;
      });
      if (forced) {
        console.log("  Chat iframe forced visible.");
        chatOpened = true;
        await page.waitForTimeout(2000);
      }
    } catch {}
  }

  if (!chatOpened) {
    log("Interact result", "Could not open chat — widget may require human trigger or auth");
    return;
  }

  // --- Send each question and capture response ---
  const conversation = [];

  for (const question of questions) {
    console.log(`\n  [3b] Sending: "${question}"`);

    try {
      // Find input — check frames first (chat is typically in an iframe), then main page
      let inputLocator = null;

      // Order: chat frame first (if detected), then other frames, then main page
      const chatFrames = page.frames().filter(f => /chat|lette|crisp|drift|intercom|hubspot|zendesk|tidio|tawk|support|messenger/i.test(f.url()));
      const otherFrames = page.frames().filter(f => !chatFrames.includes(f));
      const frames = [...chatFrames, ...otherFrames, page];

      for (const f of frames) {
        try {
          const loc = f.locator(inputSelector).first();
          const visible = await loc.isVisible().catch(() => false);
          if (visible) {
            inputLocator = loc;
            break;
          }
        } catch {
          continue;
        }
      }

      // If not found by selector, try broad heuristics — chat frames first
      if (!inputLocator) {
        const inputHeuristics = [
          "input[type='text'][placeholder*='message' i]",
          "textarea[placeholder*='message' i]",
          "div[contenteditable='true'][data-placeholder*='message' i]",
          "input[type='text'][placeholder*='type' i]",
          "textarea[placeholder*='type' i]",
          "input[type='text'][placeholder*='ask' i]",
          "textarea[placeholder*='ask' i]",
          "div[contenteditable='true'][data-placeholder]",
          "div[contenteditable='true']",
          "input[type='text'][placeholder*='write' i]",
          "textarea",
        ];
        // Search chat frames first, skip main page generic inputs
        const heuristicFrames = [...chatFrames, ...otherFrames];
        for (const sel of inputHeuristics) {
          if (inputLocator) break;
          for (const f of heuristicFrames) {
            try {
              const loc = f.locator(sel).first();
              const visible = await loc.isVisible().catch(() => false);
              if (visible) {
                inputLocator = loc;
                console.log(`  Found input via heuristic in frame: ${sel}`);
                break;
              }
            } catch {
              continue;
            }
          }
        }
      }

      if (!inputLocator) {
        log("Input field", "Not found — chat may not be open or requires prior steps");
        break;
      }

      // Type message
      await inputLocator.click();
      await inputLocator.fill(question);
      await page.waitForTimeout(500);
      await inputLocator.press("Enter");

      const sentAt = Date.now();
      console.log("  Message sent. Waiting for reply...");

      // Wait for response to appear (up to 15s for AI chats)
      let reply = null;
      const maxWait = 15000;
      const pollInterval = 1000;
      let elapsed = 0;
      let lastText = "";

      while (elapsed < maxWait) {
        await page.waitForTimeout(pollInterval);
        elapsed += pollInterval;

        // Try to read messages from main page and frames
        for (const f of [page, ...page.frames()]) {
          try {
            const msgs = await f.locator(messagesSelector).allTextContents().catch(() => []);
            if (msgs.length > 0) {
              const current = msgs[msgs.length - 1].trim();
              if (current && current !== question && current.length > 5) {
                // Check if text is still streaming (changing)
                if (current === lastText) {
                  reply = current;
                  break;
                }
                lastText = current;
              }
            }
          } catch {
            continue;
          }
        }
        if (reply) break;
      }

      const responseTime = ((Date.now() - sentAt) / 1000).toFixed(1);

      const turn = {
        question,
        reply: reply || "(no reply captured within timeout)",
        response_time_seconds: parseFloat(responseTime),
      };

      conversation.push(turn);
      log(`Q: ${question}`, `A: ${turn.reply}\n    ⏱  ${responseTime}s`);

      await page.waitForTimeout(1500); // pause between messages
    } catch (err) {
      log(`Error on question "${question}"`, err.message);
      conversation.push({ question, reply: `error: ${err.message}`, response_time_seconds: null });
    }
  }

  return conversation;
}

// ─────────────────────────────────────────────
// MAIN RUNNER
// ─────────────────────────────────────────────
async function runPOC() {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║   WEBSITE ANALYZER + CHAT BENCHMARK POC         ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`\n  Model  : ${MODEL}`);
  console.log(`  URLs   : ${TARGET_URLS.length}`);

  if (OPENROUTER_API_KEY === "YOUR_KEY_HERE") {
    console.error("\n  ERROR: Set OPENROUTER_API_KEY env variable or edit poc.js");
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: false, // set true to run invisible; false lets you watch the browser
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled", // stealth: hide automation flag
    ],
  });

  const results = [];

  for (const url of TARGET_URLS) {
    console.log(`\n\n${"═".repeat(60)}`);
    console.log(`  PROCESSING: ${url}`);
    console.log("═".repeat(60));

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    // Suppress console noise from the target page
    page.on("console", () => {});
    page.on("pageerror", () => {});

    try {
      console.log(`\n  Loading page...`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);
      console.log("  Page loaded.");

      // Handle cookie consent banners
      await handleCookieConsent(page);
      await page.waitForTimeout(3000); // wait for widgets that load after consent

      // Run the three steps
      const analysis = await analyzeWebsite(page, url);
      const detection = await detectChat(page, url);
      const conversation = await interactWithChat(page, detection, analysis, url);

      results.push({ url, analysis, detection, conversation });
    } catch (err) {
      console.error(`\n  FATAL ERROR for ${url}: ${err.message}`);
      results.push({ url, error: err.message });
    } finally {
      await context.close();
    }
  }

  await browser.close();

  // ─── FINAL SUMMARY ───
  separator("FINAL SUMMARY");
  for (const r of results) {
    console.log(`\n  URL: ${r.url}`);
    if (r.error) {
      console.log(`  Error: ${r.error}`);
      continue;
    }
    console.log(`  Purpose  : ${r.analysis?.purpose || "n/a"}`);
    console.log(`  Type     : ${r.analysis?.type || "n/a"}`);
    console.log(`  Tone     : ${r.analysis?.tone || "n/a"}`);
    console.log(`  Chat     : ${r.detection?.found ? `✓ found (${r.detection.method}${r.detection.vendor ? " — " + r.detection.vendor.name : ""})` : "✗ not found"}`);
    if (r.conversation?.length) {
      console.log(`  Messages : ${r.conversation.length} Q&A pairs captured`);
      r.conversation.forEach((t, i) => {
        console.log(`    [${i + 1}] Q: ${t.question.slice(0, 60)}`);
        console.log(`        A: ${(t.reply || "").slice(0, 100)}${t.reply?.length > 100 ? "..." : ""}`);
        console.log(`        ⏱  ${t.response_time_seconds}s`);
      });
    }
  }

  console.log("\n\n  POC complete.\n");
}

runPOC().catch(err => {
  console.error("Unhandled error:", err);
  process.exit(1);
});

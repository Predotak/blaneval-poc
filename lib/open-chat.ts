import type { Page, Frame } from "playwright";
import type { DetectionResult } from "./types";
import { findChatLauncher, findAllCandidates } from "./fixed-scanner";

type ProgressFn = (message: string) => void;

const LAUNCHER_SELECTORS = [
  "[id*='chat-widget-trigger']",
  "[id*='chat-launcher']",
  "[id*='chat-button']",
  "button[aria-label*='chat' i]",
  "button[title*='chat' i]",
  "[class*='chat'][class*='launcher' i]",
  "[class*='chat'][class*='trigger' i]",
  "[class*='chat'][class*='button' i]",
  "[class*='chat'][class*='open' i]",
  "button[aria-label*='support' i]",
  "button[aria-label*='help' i]",
  "button[aria-label*='message' i]",
];

async function tryClickInContext(
  context: Page | Frame,
  selectors: string[],
  onProgress: ProgressFn,
  label: string
): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const el = context.locator(sel).first();
      const visible = await el.isVisible({ timeout: 800 }).catch(() => false);
      if (visible) {
        await el.click({ timeout: 3000 });
        onProgress(`  Clicked in ${label}: ${sel}`);
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

async function takePageScreenshot(page: Page, onProgress: ProgressFn): Promise<string | undefined> {
  await page.waitForTimeout(3000);
  onProgress("  Taking screenshot of opened chat...");
  try {
    const buffer = await page.screenshot({ timeout: 10000 });
    onProgress("  Screenshot captured.");
    return buffer.toString("base64");
  } catch (err) {
    onProgress(`  Screenshot failed: ${(err as Error).message}`);
    return undefined;
  }
}

export async function openChatAndScreenshot(
  page: Page,
  detection: DetectionResult,
  onProgress: ProgressFn
): Promise<string | undefined> {
  if (!detection.found) return undefined;

  onProgress("Opening chat widget...");

  // Disable animations for stable screenshots
  await page.addStyleTag({
    content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
  });

  // Dismiss any full-screen fixed overlays that block clicks (cookie banners, consent walls, etc.)
  const dismissed = await page.evaluate(() => {
    let count = 0;
    for (const el of document.querySelectorAll("*")) {
      const style = window.getComputedStyle(el);
      if (style.position !== "fixed") continue;
      const rect = el.getBoundingClientRect();
      // Full-screen or near-full-screen overlay
      if (rect.width > window.innerWidth * 0.8 && rect.height > window.innerHeight * 0.8) {
        (el as HTMLElement).style.display = "none";
        count++;
      }
    }
    return count;
  });
  if (dismissed > 0) {
    onProgress(`  Dismissed ${dismissed} full-screen overlay(s).`);
    await page.waitForTimeout(500);
  }

  // Build selector list — detection-specific first, then generic
  const selectors = [
    ...(detection.launcherSelector ? [detection.launcherSelector] : []),
    ...LAUNCHER_SELECTORS,
  ];

  // Strategy 1: Try detected selector + common selectors on main page
  onProgress("  Strategy 1: Trying selectors on main page...");
  if (await tryClickInContext(page, selectors, onProgress, "main page")) {
    return takePageScreenshot(page, onProgress);
  }

  // Strategy 1b: If detected selector exists but click failed, try clicking child buttons inside it
  if (detection.launcherSelector) {
    onProgress("  Strategy 1b: Trying child elements of detected launcher...");
    const childSelectors = [
      `${detection.launcherSelector} button`,
      `${detection.launcherSelector} a`,
      `${detection.launcherSelector} [role='button']`,
      `${detection.launcherSelector} [class*='icon']`,
      `${detection.launcherSelector} span`,
    ];
    if (await tryClickInContext(page, childSelectors, onProgress, "main page (child)")) {
      return takePageScreenshot(page, onProgress);
    }
  }

  // Strategy 2: Try inside iframes
  onProgress("  Strategy 2: Searching inside iframes...");
  const allFrames = page.frames().filter((f) => f !== page.mainFrame());
  allFrames.sort((a, b) => {
    const aChat = /chat|messenger|support|widget|bot/i.test(a.url()) ? 0 : 1;
    const bChat = /chat|messenger|support|widget|bot/i.test(b.url()) ? 0 : 1;
    return aChat - bChat;
  });

  for (const frame of allFrames) {
    try {
      const frameUrl = frame.url().slice(0, 60);
      const frameSelectors = [...selectors, "button", "[role='button']", "a[href='#']"];
      if (await tryClickInContext(frame, frameSelectors, onProgress, `iframe(${frameUrl})`)) {
        return takePageScreenshot(page, onProgress);
      }
    } catch {
      continue;
    }
  }

  // Strategy 3: Fixed-position keyword scanner
  onProgress("  Strategy 3: Trying fixed-position keyword scanner...");
  const launcher = await findChatLauncher(page);
  if (launcher?.id) {
    try {
      await page.locator(`#${launcher.id}`).click({ timeout: 3000 });
      onProgress(`  Clicked via keyword scanner: #${launcher.id}`);
      return takePageScreenshot(page, onProgress);
    } catch {
      onProgress(`  Could not click #${launcher.id}`);
    }
  }

  // Strategy 4: Try all fixed-position candidates (brute force)
  onProgress("  Strategy 4: Trying all fixed-position candidates...");
  const candidates = await findAllCandidates(page);
  for (const c of candidates) {
    const sel = c.selector || (c.id ? `#${c.id}` : c.tag);
    try {
      const el = page.locator(sel).first();
      const visible = await el.isVisible({ timeout: 500 }).catch(() => false);
      if (visible) {
        await el.click({ timeout: 3000 });
        onProgress(`  Clicked candidate: ${sel} (${c.hint.slice(0, 40)})`);
        // Wait briefly and check if something changed (new iframe, new elements)
        await page.waitForTimeout(1500);
        const afterFrames = page.frames().length;
        const afterFixed = await page.evaluate(() => {
          let count = 0;
          for (const el of document.querySelectorAll("*")) {
            const s = window.getComputedStyle(el);
            if ((s.position === "fixed" || s.position === "sticky") && s.display !== "none") count++;
          }
          return count;
        });
        onProgress(`  After click: ${afterFrames} frames, ${afterFixed} fixed elements`);
        return takePageScreenshot(page, onProgress);
      }
    } catch {
      continue;
    }
  }

  // Strategy 5: Force-show chat iframe
  if (detection.iframeSelector) {
    onProgress("  Strategy 5: Force-showing chat iframe...");
    try {
      await page.evaluate((sel: string) => {
        const iframe = document.querySelector(sel) as HTMLIFrameElement;
        if (!iframe) return;
        iframe.style.cssText =
          "display:block!important;visibility:visible!important;opacity:1!important;" +
          "position:fixed!important;bottom:20px!important;right:20px!important;" +
          "width:400px!important;height:600px!important;z-index:999999!important;";
        let parent = iframe.parentElement;
        for (let i = 0; i < 3 && parent; i++) {
          parent.style.display = "block";
          parent.style.visibility = "visible";
          parent.style.opacity = "1";
          parent = parent.parentElement;
        }
      }, detection.iframeSelector);
      onProgress("  Chat iframe forced visible.");
      return takePageScreenshot(page, onProgress);
    } catch {}
  }

  onProgress("  Could not open chat after all strategies.");
  return undefined;
}

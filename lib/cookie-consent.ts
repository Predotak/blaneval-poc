import type { Page } from "playwright";

const ACCEPT_SELECTORS = [
  "button[id*='accept' i]",
  "button[class*='accept' i]",
  "a[id*='accept' i]",
  "button[data-action='accept']",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "#CybotCookiebotDialogBodyButtonAccept",
  "#onetrust-accept-btn-handler",
  ".cmplz-accept",
  ".cky-btn-accept",
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

export async function handleCookieConsent(page: Page): Promise<boolean> {
  for (const selector of ACCEPT_SELECTORS) {
    try {
      const btn = page.locator(selector).first();
      const visible = await btn.isVisible({ timeout: 500 }).catch(() => false);
      if (visible) {
        await btn.click({ timeout: 3000 });
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

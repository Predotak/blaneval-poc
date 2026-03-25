import type { Page } from "playwright";

const CHAT_KEYWORDS =
  /chat|message|support|help|bot|widget|launcher|messenger|dialogflow|df-messenger|lette|crisp|drift|intercom|hubspot|tawk|zendesk|tidio|freshdesk|freshchat|kommunicate|botpress|voiceflow|landbot|chatwoot|smartsupp|amio|livechat|olark|kayako|comm100|userlike|gorgias|helpscout|jivochat|liveperson/;

export interface LauncherCandidate {
  id: string;
  tag: string;
  area: number;
  hint: string;
  selector?: string;
}

export async function findAllCandidates(
  page: Page
): Promise<LauncherCandidate[]> {
  return page.evaluate(() => {
    const candidates: { id: string; tag: string; area: number; hint: string; selector: string }[] = [];
    let index = 0;

    for (const el of document.querySelectorAll("*")) {
      const style = window.getComputedStyle(el);
      if (style.position !== "fixed" && style.position !== "sticky") continue;
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      // Skip full-width elements (headers, banners, overlays)
      if (rect.width > window.innerWidth * 0.6) continue;
      // Skip elements taller than half the viewport (likely panels, not launchers)
      if (rect.height > window.innerHeight * 0.5) continue;
      // Skip tiny invisible dots
      if (rect.width < 10 || rect.height < 10) continue;

      const hint = [
        el.tagName.toLowerCase(),
        el.id,
        el.className?.toString?.() ?? "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("title") || "",
      ].join(" ").toLowerCase().trim().slice(0, 80);

      // Build a selector that can locate this element
      let selector = "";
      if (el.id) {
        selector = `#${el.id}`;
      } else {
        const tag = el.tagName.toLowerCase();
        const cls = el.className?.toString?.() ?? "";
        const firstClass = cls.split(/\s+/).filter(Boolean)[0];
        if (firstClass) {
          // Use first class name — more reliable than nth-of-type
          selector = `${tag}.${firstClass}`;
        } else {
          // Fallback: use parent ID + nth-of-type
          const parent = el.parentElement;
          if (parent) {
            const siblings = Array.from(parent.querySelectorAll(`:scope > ${tag}`));
            const nth = siblings.indexOf(el) + 1;
            const parentId = parent.id ? `#${parent.id} > ` : "";
            selector = `${parentId}${tag}:nth-of-type(${nth})`;
          }
        }
      }

      candidates.push({
        id: el.id || "",
        tag: el.tagName.toLowerCase(),
        area: Math.round(rect.width * rect.height),
        hint,
        selector,
      });
      index++;
      if (index >= 8) break; // cap at 8 candidates
    }

    // Sort by area (smallest first — chat launchers are typically small)
    candidates.sort((a, b) => a.area - b.area);
    return candidates.slice(0, 5);
  });
}

export async function findChatLauncher(
  page: Page
): Promise<LauncherCandidate | null> {
  return page.evaluate((pattern: string) => {
    const regex = new RegExp(pattern);
    const all = document.querySelectorAll("*");
    let best: { id: string; tag: string; area: number; hint: string } | null =
      null;
    let bestArea = Infinity;

    for (const el of all) {
      const style = window.getComputedStyle(el);
      if (style.position !== "fixed" && style.position !== "sticky") continue;
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      )
        continue;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (
        rect.bottom < window.innerHeight * 0.7 ||
        rect.right < window.innerWidth * 0.6
      )
        continue;

      const hint = [
        el.tagName.toLowerCase(),
        el.id,
        el.className?.toString?.() ?? "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("title") || "",
      ]
        .join(" ")
        .toLowerCase();

      if (!regex.test(hint)) continue;

      const area = rect.width * rect.height;
      if (area < bestArea) {
        bestArea = area;
        best = {
          id: el.id || "",
          tag: el.tagName.toLowerCase(),
          area,
          hint: hint.trim().slice(0, 80),
        };
      }
    }
    return best;
  }, CHAT_KEYWORDS.source);
}

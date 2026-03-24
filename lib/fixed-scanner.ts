import type { Page } from "playwright";

const CHAT_KEYWORDS =
  /chat|message|support|help|bot|widget|launcher|messenger|dialogflow|df-messenger|lette|crisp|drift|intercom|hubspot|tawk|zendesk|tidio|freshdesk|freshchat|kommunicate|botpress|voiceflow|landbot|chatwoot|smartsupp|amio|livechat|olark|kayako|comm100|userlike|gorgias|helpscout|jivochat|liveperson/;

export interface LauncherCandidate {
  id: string;
  tag: string;
  area: number;
  hint: string;
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

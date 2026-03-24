import OpenAI from "openai";

const MODEL = "meta-llama/llama-3.3-70b-instruct";

function getClient() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
  return new OpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" });
}

export async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  retries = 3
): Promise<string> {
  const client = getClient();
  for (let attempt = 1; attempt <= retries; attempt++) {
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
      return res.choices[0].message.content?.trim() ?? "";
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 429 && attempt < retries) {
        await new Promise((r) => setTimeout(r, attempt * 5000));
      } else {
        throw err;
      }
    }
  }
  throw new Error("LLM call failed after retries");
}

export const CHAT_DETECTION_PROMPT = `You are an expert at detecting chat widgets on websites. You will receive:
1. A condensed DOM snapshot (element tags, IDs, classes, aria-labels)
2. All iframe sources on the page
3. All script sources loaded on the page
4. All fixed/sticky-position elements with their position, size, and attributes

Your job is to determine if a chat widget exists. Use ALL signals:

**Script sources**: Chat platforms load via scripts (e.g., chatbot.js, tawk.js, crisp.js, intercom). A script with "chat", "bot", "messenger", "support", "livechat" in the URL is a strong signal.

**Fixed-position elements**: Chat launchers are typically small (40-150px), positioned in the bottom-right corner, and may have chat-related IDs/classes/aria-labels. BUT — labels may be in ANY language (e.g., "napište nám" = Czech for "write to us", "Schreib uns" = German, "Écrivez-nous" = French). A small fixed button in the bottom-right is likely a chat launcher even if the label is not in English.

**Iframes**: Chat widgets often load in iframes from third-party domains containing "chat", "messenger", "support", etc.

**DOM elements**: Look for IDs/classes containing chat, messenger, bot, support, helpdesk, livechat, widget, assistant, or vendor names (intercom, drift, zendesk, tidio, hubspot, tawk, crisp, amio, smartsupp, freshchat, dialogflow).

If you find a chat widget, respond ONLY with this JSON:
{
  "found": true,
  "confidence": "high|medium|low",
  "widget_type": "description of what kind of chat it appears to be",
  "launcher_selector": "CSS selector to click to open the chat",
  "notes": "any relevant notes about the widget"
}

If no chat widget is found, respond ONLY with:
{ "found": false, "notes": "reason why no chat was found" }

Never include markdown or explanations outside the JSON.`;

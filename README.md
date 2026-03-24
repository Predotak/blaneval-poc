# Website Analyzer + Chat Benchmark POC

Proves 3 steps on any website:
1. **Analyze** — AI identifies purpose, tone, audience
2. **Detect** — Finds chat widget (vendor fingerprint first, AI DOM fallback)
3. **Interact** — Opens chat, sends messages, captures replies

## Setup (Mac)

### 1. Install Node.js (if not installed)
```bash
brew install node
```
No Homebrew? Install it first:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 2. Get an OpenRouter API key
- Go to https://openrouter.ai
- Sign up → Dashboard → API Keys → Create key
- Free tier includes Llama 3.3 70B

### 3. Clone / copy this folder, then install dependencies
```bash
cd poc
npm install
npx playwright install chromium
```

### 4. Set your API key
```bash
export OPENROUTER_API_KEY=sk-or-xxxxxxxxxxxx
```
Or edit `poc.js` line 8 directly.

### 5. Add your URLs
Edit `poc.js` line 12 — add as many URLs as you want:
```js
const TARGET_URLS = [
  "https://www.hali.ie/",
  "https://another-site.com/",
];
```

### 6. Run
```bash
npm start
```

A real Chrome window will open so you can watch it work.
Set `headless: true` on line 153 of poc.js to run invisibly.

## Swap models
Edit line 9 in poc.js. Any OpenRouter model ID works, e.g.:
- `meta-llama/llama-3.3-70b-instruct` (default, best quality, free tier)
- `mistralai/mistral-7b-instruct` (faster, cheaper)
- `qwen/qwen-2.5-72b-instruct` (strong alternative)
- `google/gemma-3-27b-it` (Google's open model)

## What you'll see in the console
```
STEP 1 — ANALYZE
  ▸ Purpose: Community magazine for local Irish audiences
  ▸ Tone: friendly, community-focused

STEP 2 — DETECT CHAT
  [Pass 1] Checking known vendor fingerprints...
  No known vendor found. Falling back to AI DOM analysis...
  ▸ AI detection result: { found: true, confidence: "medium", ... }

STEP 3 — INTERACT
  ▸ Questions to send: [...]
  [3a] Opening chat widget...
  [3b] Sending: "Hi, what can you help me with?"
      A: "Hello! I'm here to help..."  ⏱ 3.2s
```

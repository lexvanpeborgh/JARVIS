# JARVIS v3 Free

Installable iPhone PWA with zero paid AI requirement.

Production: https://jarvis-v2-delta.vercel.app/

## Free AI stack
- Chat / explanations / file analysis: `gemini-2.5-flash-lite` Free Tier
- Current web research: Gemini Google Search grounding (free quota)
- Realtime speech-to-speech: `gemini-3.1-flash-live-preview` Free Tier
- Live voice: `Gacrux` with an original calm, mature, refined cinematic style; no imitation of a real actor
- Visual generation: free Gemini-created SVG/vector visuals instead of paid photoreal image generation

## Features
- Persistent local chat history and Memory Core
- Tasks, agenda and notes with AI tool actions
- Image/PDF/text/CSV/JSON/Markdown input (direct upload limited to 3 MB)
- Current web search with source links
- Live microphone conversation with audio responses
- Offline PWA shell and home-screen installation
- Local JSON backup export

## Zero-payment setup
The user creates a Gemini API key in Google AI Studio using the Gemini API Free Tier. No paid Vercel AI Gateway is used. The key is entered directly in JARVIS Settings and stored separately in local browser storage on that device. It is not committed to GitHub, not included in JARVIS backup exports, and not stored as a Vercel project secret.

The browser sends the key over HTTPS to the JARVIS API routes for the current request. The Realtime route exchanges it for a short-lived Gemini ephemeral token before opening the Live API WebSocket.

## Architecture
Next.js 16 App Router hosted on Vercel. Vercel is only used for free web hosting/serverless routing; provider-backed AI goes to Google Gemini using the user's Free Tier key. The UI is assembled deterministically from `source/` fragments by `scripts/assemble.mjs` before every build.

## Privacy note
Google's Gemini API Free Tier terms may allow submitted content to be used to improve Google products. Do not send secrets or highly confidential information through Free Tier prompts.

## Install on iPhone
Open the production URL in Safari → Share → Add to Home Screen. In JARVIS: More → Settings → create/paste the free Gemini API key → Test free key.

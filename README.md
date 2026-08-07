# JARVIS v2

Installable mobile PWA for iPhone, rebuilt from scratch on 2026-08-07.

## Features
- GPT-5.6 Terra chat through Vercel AI Gateway
- Current web research with source links
- Realtime speech-to-speech with GPT-Realtime 2.1
- Calm cinematic `cedar` voice; no imitation of a real actor
- Persistent local chat history and Memory Core
- Tasks, agenda and notes with AI tool actions
- Image/PDF/text/CSV/JSON/Markdown input
- Image generation
- Offline PWA shell and home-screen installation
- Local JSON backup export

## Architecture
Next.js 16 App Router on Vercel. The UI is assembled deterministically from `source/` fragments by `scripts/assemble.mjs` before every dev/build run. Secrets are never stored in browser code.

## AI Gateway prerequisite
Vercel currently requires a valid payment card on the team account before it will service AI Gateway requests, including requests using free Gateway credits. Until that account-level prerequisite is enabled, the PWA interface and local organizer work but provider-backed chat, web search, image generation and Realtime voice are blocked by Vercel.

## Install on iPhone
Open the final Vercel production URL in Safari, then Share → Add to Home Screen.

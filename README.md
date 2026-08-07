# JARVIS v2

Installable mobile PWA for iPhone, rebuilt from scratch on 2026-08-07.

Production: https://jarvis-v2-delta.vercel.app/

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

## Verified deployment
The production build was rebuilt directly from the files on GitHub main, assembled successfully, compiled with Next.js 16/Turbopack and reached Vercel READY. Homepage, manifest, service worker, icon and health endpoint all returned HTTP 200. No production error/fatal runtime logs were present during verification.

## AI Gateway prerequisite
A real provider call was tested separately. Vercel currently refuses AI Gateway requests for this team until a valid payment card is on file, including requests intended to use free Gateway credits. Until that account-level prerequisite is enabled, the PWA interface and local organizer work but provider-backed chat, web search, image generation and Realtime voice are blocked by Vercel.

## Install on iPhone
Open the production URL in Safari, then Share → Add to Home Screen.

# JARVIS

Fresh stable mobile PWA rebuilt from scratch on 2026-08-07.

Live production: https://jarvis-fresh.vercel.app/

## Current features
- Mobile JARVIS HUD
- Installable PWA
- Local chat history
- Memory Core
- Tasks
- Agenda
- Notes
- Spoken local replies when browser speech synthesis is available
- Offline shell via service worker

## Deployment
Hosted directly on Vercel. No GitHub Pages workflow and no framework/build step are used.

## Cloud AI
The current stable base intentionally does not embed an OpenAI API key in browser code. A secure server-side AI layer can be added separately.

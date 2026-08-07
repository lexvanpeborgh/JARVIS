export const runtime = 'nodejs';
export async function GET() {
  return Response.json({
    ok: true,
    app: 'JARVIS Personal Core',
    version: '4.0.0',
    chatModel: 'gemini-3.5-flash-lite',
    realtimeModel: 'gemini-3.1-flash-live-preview',
    provider: 'Google Gemini Free Tier',
    billingRequired: false,
    tools: ['memory', 'tasks', 'calendar', 'notes', 'weather', 'web-search', 'files', 'live-voice'],
  });
}

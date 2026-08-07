export const runtime = 'nodejs';
export async function GET() {
  return Response.json({
    ok: true,
    app: 'JARVIS v3 Free',
    chatModel: 'gemini-2.5-flash-lite',
    realtimeModel: 'gemini-3.1-flash-live-preview',
    provider: 'Google Gemini Free Tier',
    billingRequired: false,
  });
}

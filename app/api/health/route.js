export const runtime = 'nodejs';
export async function GET() {
  return Response.json({
    ok: true,
    app: 'JARVIS v2',
    chatModel: 'openai/gpt-5.6-terra',
    realtimeModel: 'openai/gpt-realtime-2.1',
    gatewayOIDC: Boolean(process.env.VERCEL_OIDC_TOKEN),
  });
}

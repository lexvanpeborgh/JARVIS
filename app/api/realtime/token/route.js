import { friendlyProviderError } from '../../../_server/providers';

export const runtime = 'nodejs';
export const maxDuration = 30;

const LIVE_MODEL = 'gemini-3.1-flash-live-preview';

export async function POST(request) {
  const apiKey = String(request.headers.get('x-gemini-key') || '').trim();
  if (!apiKey) return Response.json({ error: 'Voeg eerst je gratis Gemini API-key toe in Instellingen.' }, { status: 401 });
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1alpha/auth_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
      }),
      cache: 'no-store',
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: { message: text } }; }
    if (!response.ok) throw Object.assign(new Error(data?.error?.message || `Gemini token HTTP ${response.status}`), { status: response.status });
    if (!data?.name) throw new Error('Gemini gaf geen kortlevend Live-token terug.');
    return Response.json({
      token: data.name,
      model: LIVE_MODEL,
      url: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained',
      expiresInMinutes: 30,
      freeTier: true,
    });
  } catch (error) {
    console.error('jarvis-live-token', { status: error?.status, message: error?.message });
    return Response.json({ error: friendlyProviderError(error, 'Live-token kon niet worden gemaakt.') }, { status: error?.status || 500 });
  }
}

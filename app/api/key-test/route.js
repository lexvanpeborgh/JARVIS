import { callGemini, friendlyProviderError, geminiText } from '../../_server/providers';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(request) {
  const apiKey = String(request.headers.get('x-gemini-key') || '').trim();
  if (!apiKey) return Response.json({ error: 'Voeg eerst een Gemini API-key toe.' }, { status: 401 });
  try {
    const data = await callGemini(apiKey, {
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly JARVIS_OK' }] }],
      generationConfig: { maxOutputTokens: 20 },
    });
    return Response.json({ ok: geminiText(data).includes('JARVIS_OK'), model: 'gemini-3.5-flash-lite', freeTier: true });
  } catch (error) {
    console.error('jarvis-key-test', { status: error?.status, message: error?.message });
    return Response.json({ error: friendlyProviderError(error, 'Gemini-key kon niet worden getest.') }, { status: error?.status || 500 });
  }
}

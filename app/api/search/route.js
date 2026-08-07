import { searchWeb } from '../../_server/providers';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(request) {
  const apiKey = String(request.headers.get('x-tavily-key') || '').trim();
  if (!apiKey) return Response.json({ error: 'Voeg eerst je gratis Tavily-key toe in Instellingen.' }, { status: 401 });
  try {
    const body = await request.json();
    return Response.json(await searchWeb(apiKey, body.query));
  } catch (error) {
    console.error('jarvis-search', { status: error?.status, message: error?.message });
    return Response.json({ error: error?.message || 'Live web search is tijdelijk niet beschikbaar.' }, { status: error?.status || 500 });
  }
}

import { getWeather } from '../../_server/providers';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(request) {
  try {
    const body = await request.json();
    return Response.json(await getWeather(body));
  } catch (error) {
    console.error('jarvis-weather', { status: error?.status, message: error?.message });
    return Response.json({ error: error?.message || 'Live weer is tijdelijk niet beschikbaar.' }, { status: error?.status || 500 });
  }
}

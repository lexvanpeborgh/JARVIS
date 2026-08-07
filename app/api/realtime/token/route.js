export const runtime = 'nodejs';

const LIVE_MODEL = 'gemini-3.1-flash-live-preview';

export async function POST(request) {
  const key = String(request.headers.get('x-gemini-key') || '').trim();
  if (!key) return Response.json({ error:'Voeg eerst je gratis Gemini API-key toe in JARVIS Settings.' }, { status:401 });

  try {
    const expireTime = new Date(Date.now() + 25 * 60 * 1000).toISOString();
    const newSessionExpireTime = new Date(Date.now() + 60 * 1000).toISOString();
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
      method:'POST',
      headers:{ 'content-type':'application/json', 'x-goog-api-key':key },
      body:JSON.stringify({
        uses:1,
        expireTime,
        newSessionExpireTime,
        liveConnectConstraints:{
          model:`models/${LIVE_MODEL}`,
          config:{
            responseModalities:['AUDIO'],
            sessionResumption:{},
          },
        },
      }),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error:{ message:text } }; }
    if (!response.ok) throw Object.assign(new Error(data?.error?.message || `Gemini token HTTP ${response.status}`), { status:response.status });
    if (!data?.name) throw new Error('Gemini returned no ephemeral token');
    return Response.json({
      token:data.name,
      model:LIVE_MODEL,
      url:'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained',
      freeTier:true,
    });
  } catch (error) {
    console.error('gemini-realtime-token', error);
    const friendly = error?.status === 429 ? 'Je gratis Gemini Live-limiet is bereikt. Probeer later opnieuw.' : (error?.message || 'Could not create Gemini Live token');
    return Response.json({ error:friendly }, { status:error?.status || 500 });
  }
}

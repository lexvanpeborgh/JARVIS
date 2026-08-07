export const runtime = 'nodejs';
export const maxDuration = 60;

const MODEL = 'gemini-3.5-flash-lite';

function cleanSvg(raw) {
  let text = String(raw || '').replace(/```(?:svg|xml)?/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('<svg');
  const end = text.lastIndexOf('</svg>');
  if (start < 0 || end < 0) return null;
  text = text.slice(start, end + 6);
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '');
  text = text.replace(/javascript:/gi, '');
  return text;
}

export async function POST(request) {
  const key = String(request.headers.get('x-gemini-key') || '').trim();
  if (!key) return Response.json({ error:'Voeg eerst je gratis Gemini API-key toe in JARVIS Settings.' }, { status:401 });

  try {
    const { prompt } = await request.json();
    if (!prompt || typeof prompt !== 'string') return Response.json({ error:'Prompt is required' }, { status:400 });

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method:'POST',
      headers:{ 'content-type':'application/json', 'x-goog-api-key':key },
      body:JSON.stringify({
        systemInstruction:{ parts:[{ text:'Create a polished standalone SVG visual. Return ONLY valid SVG markup, no markdown. Use viewBox 0 0 1024 1024. No external images, fonts, scripts, JavaScript, event handlers or remote resources. Make it visually rich but readable on a phone. If the request is photographic, reinterpret it as a premium cinematic vector illustration.' }] },
        contents:[{ role:'user', parts:[{ text:String(prompt).slice(0,4000) }] }],
        generationConfig:{ maxOutputTokens:8192 },
      }),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error:{message:text} }; }
    if (!response.ok) throw Object.assign(new Error(data?.error?.message || `Gemini HTTP ${response.status}`), {status:response.status});
    const raw = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    const svg = cleanSvg(raw);
    if (!svg) throw new Error('Gemini returned no valid SVG visual');
    return Response.json({ base64:Buffer.from(svg,'utf8').toString('base64'), mediaType:'image/svg+xml', freeTier:true, kind:'svg' });
  } catch (error) {
    console.error('free-visual-generation', error);
    const friendly = error?.status === 429 ? 'Je gratis Gemini-daglimiet is bereikt. Probeer later opnieuw.' : (error?.message || 'Visual generation failed');
    return Response.json({ error:friendly }, { status:error?.status || 500 });
  }
}

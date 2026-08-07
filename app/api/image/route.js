import { callGemini, friendlyProviderError, geminiText } from '../../_server/providers';

export const runtime = 'nodejs';
export const maxDuration = 60;

function cleanSvg(value) {
  let svg = String(value || '').replace(/```(?:svg|xml)?/gi, '').replace(/```/g, '').trim();
  const start = svg.indexOf('<svg');
  const end = svg.lastIndexOf('</svg>');
  if (start < 0 || end < 0) return '';
  svg = svg.slice(start, end + 6);
  svg = svg
    .replace(/<(script|foreignObject|iframe|object|embed|audio|video)[\s\S]*?<\/\1>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, '')
    .replace(/(?:javascript|data:text\/html):/gi, '')
    .replace(/(?:href|xlink:href)\s*=\s*(['"])https?:[\s\S]*?\1/gi, '')
    .replace(/url\(\s*(['"])?https?:[\s\S]*?\)/gi, 'none');
  if (!/^<svg\b/i.test(svg) || svg.length > 500000) return '';
  return svg;
}

export async function POST(request) {
  const apiKey = String(request.headers.get('x-gemini-key') || '').trim();
  if (!apiKey) return Response.json({ error: 'Voeg eerst je gratis Gemini API-key toe in Instellingen.' }, { status: 401 });
  try {
    const body = await request.json();
    const prompt = String(body.prompt || '').trim().slice(0, 4000);
    if (!prompt) return Response.json({ error: 'Beschrijf eerst de gewenste visual.' }, { status: 400 });
    const data = await callGemini(apiKey, {
      systemInstruction: { parts: [{ text: 'Create a polished, detailed standalone SVG vector visual based on the request. Return ONLY valid SVG, no markdown. Use viewBox="0 0 1024 1024". Do not use scripts, event handlers, foreignObject, external images, remote fonts or remote resources. Use an elegant cinematic visual language and make it readable on a phone. If the request is photographic, reinterpret it as a premium vector illustration.' }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 8192 },
    });
    const svg = cleanSvg(geminiText(data));
    if (!svg) throw new Error('De gratis AI gaf geen geldige vectorvisual terug. Probeer een concretere beschrijving.');
    return Response.json({ base64: Buffer.from(svg, 'utf8').toString('base64'), mediaType: 'image/svg+xml', freeTier: true, kind: 'svg' });
  } catch (error) {
    console.error('jarvis-visual', { status: error?.status, message: error?.message });
    return Response.json({ error: friendlyProviderError(error, 'Visual kon niet worden gemaakt.') }, { status: error?.status || 500 });
  }
}

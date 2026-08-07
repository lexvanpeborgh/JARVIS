import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

async function assemble(prefix, output) {
  const dir = 'source';
  const names = (await readdir(dir)).filter(n => n.startsWith(prefix + '.') && n.endsWith('.txt')).sort();
  if (!names.length) throw new Error(`No source fragments for ${prefix}`);
  const parts = await Promise.all(names.map(n => readFile(join(dir, n), 'utf8')));
  await mkdir(output.split('/').slice(0,-1).join('/'), { recursive: true });
  await writeFile(output, parts.join(''), 'utf8');
}

await assemble('page', 'app/page.js');
await assemble('globals', 'app/globals.css');

let page = await readFile('app/page.js', 'utf8');

page = page.replace(
  "const GEMINI_KEY_STORAGE = 'jarvis-gemini-free-key';",
  "const GEMINI_KEY_STORAGE = 'jarvis-gemini-free-key';\nconst TAVILY_KEY_STORAGE = 'jarvis-tavily-free-key';"
);

page = page.replace(
  "const [geminiKey, setGeminiKey] = useState('');\n  const [keyTest, setKeyTest] = useState('');",
  "const [geminiKey, setGeminiKey] = useState('');\n  const [keyTest, setKeyTest] = useState('');\n  const [tavilyKey, setTavilyKey] = useState('');\n  const [tavilyTest, setTavilyTest] = useState('');"
);

page = page.replace(
  "setGeminiKey(localStorage.getItem(GEMINI_KEY_STORAGE) || '');",
  "setGeminiKey(localStorage.getItem(GEMINI_KEY_STORAGE) || '');\n      setTavilyKey(localStorage.getItem(TAVILY_KEY_STORAGE) || '');"
);

page = page.replace(
  "  const flash = useCallback((text) => {",
  [
    "  useEffect(() => {",
    "    try {",
    "      if (tavilyKey) localStorage.setItem(TAVILY_KEY_STORAGE, tavilyKey);",
    "      else localStorage.removeItem(TAVILY_KEY_STORAGE);",
    "    } catch {}",
    "  }, [tavilyKey]);",
    "",
    "  const flash = useCallback((text) => {"
  ].join('\n')
);

page = page.replace(
  "  const send = useCallback(async () => {",
  [
    "  const testTavilyKey = useCallback(async () => {",
    "    const key = tavilyKey.trim();",
    "    if (!key) { setTavilyTest('Voeg eerst een Tavily-key toe'); return; }",
    "    setTavilyTest('Testen…');",
    "    try {",
    "      const response = await fetch('/api/search', { method:'POST', headers:{'content-type':'application/json','x-tavily-key':key}, body:JSON.stringify({query:'OpenAI'}) });",
    "      const data = await response.json();",
    "      if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));",
    "      setTavilyTest('✓ Gratis web search werkt');",
    "    } catch (error) { setTavilyTest('✕ ' + (error?.message || 'Tavily-key werkt niet')); }",
    "  }, [tavilyKey]);",
    "",
    "  const send = useCallback(async () => {"
  ].join('\n')
);

const oldSetup = [
  "systemInstruction:{ parts:[{ text:`You are JARVIS, a private personal AI assistant. Speak Dutch by default unless the user changes language. Speak naturally, calmly and intelligently. Voice manner: mature, composed, refined, measured and subtly British/cinematic, but never imitate Paul Bettany or any real person. Keep spoken answers concise but useful. Current device time: ${new Date().toISOString()}.` }] },",
  "          inputAudioTranscription:{},",
  "          outputAudioTranscription:{},"
].join('\n');

const newSetup = [
  "systemInstruction:{ parts:[{ text:`You are JARVIS, a private personal AI assistant. Speak Dutch by default unless the user changes language. Speak naturally, calmly and intelligently. Voice manner: mature, composed, refined, measured and subtly British/cinematic, but never imitate Paul Bettany or any real person. Keep spoken answers concise but useful. You have two live-data tools. For ANY weather question, ALWAYS call get_weather before answering. If the user says here, where I am, nearby, or my location, pass location exactly as __device__. If the user names a city or place, pass that location. For other current, recent, live, today, latest, news, sports scores, prices, opening hours, schedules, releases or anything else that may have changed, call web_search before answering. Base live answers only on returned tool data. Current device time: ${new Date().toISOString()}.` }] },",
  "          inputAudioTranscription:{},",
  "          outputAudioTranscription:{},",
  "          tools:[{ functionDeclarations:[",
  "            { name:'get_weather', description:'Get current weather and a short forecast from a dedicated live weather service. Always use this for weather. Use __device__ when the user asks for weather here or at their current location.', parameters:{ type:'object', properties:{ location:{type:'string',description:'City/place name, or __device__ for the iPhone current location'} }, required:['location'] } },",
  "            { name:'web_search', description:'Search the live public web for current or recently changed non-weather information.', parameters:{ type:'object', properties:{ query:{type:'string',description:'A concise web search query'} }, required:['query'] } }",
  "          ] }],"
].join('\n');

if (!page.includes(oldSetup)) throw new Error('Could not locate stable JARVIS Live setup block');
page = page.replace(oldSetup, newSetup);

const toolHook = "          if (msg.goAway?.timeLeft) setVoiceError(`Gemini Live gaat opnieuw verbinden binnen ${msg.goAway.timeLeft}.`);";
const toolReplacement = [
  "          for (const fc of msg.toolCall?.functionCalls || []) {",
  "            let responsePayload;",
  "            try {",
  "              if (fc?.name === 'get_weather') {",
  "                let weatherRequest = { location:String(fc?.args?.location || '').trim() };",
  "                if (weatherRequest.location === '__device__') {",
  "                  if (!navigator.geolocation) throw new Error('Locatie is niet beschikbaar op dit toestel. Noem een stad, bijvoorbeeld Mortsel.');",
  "                  const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy:false, timeout:8000, maximumAge:300000 }));",
  "                  weatherRequest = { latitude:position.coords.latitude, longitude:position.coords.longitude };",
  "                }",
  "                const r = await fetch('/api/weather', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(weatherRequest) });",
  "                const data = await r.json();",
  "                if (!r.ok) throw new Error(data.error || ('Weather HTTP ' + r.status));",
  "                responsePayload = data;",
  "              } else if (fc?.name === 'web_search') {",
  "                const key = tavilyKey.trim();",
  "                if (!key) throw new Error('Geen Tavily Search-key ingesteld. Open More → Settings → FREE LIVE WEB SEARCH.');",
  "                const r = await fetch('/api/search', { method:'POST', headers:{'content-type':'application/json','x-tavily-key':key}, body:JSON.stringify({query:String(fc?.args?.query || '')}) });",
  "                const data = await r.json();",
  "                if (!r.ok) throw new Error(data.error || ('Search HTTP ' + r.status));",
  "                responsePayload = { ok:true, answer:data.answer || '', results:data.results || [] };",
  "              } else {",
  "                continue;",
  "              }",
  "            } catch (error) {",
  "              responsePayload = { ok:false, error:String(error?.message || error) };",
  "            }",
  "            if (ws.readyState === WebSocket.OPEN) {",
  "              ws.send(JSON.stringify({ toolResponse:{ functionResponses:[{ id:fc.id, name:fc.name, response:responsePayload }] } }));",
  "            }",
  "          }",
  "          if (msg.goAway?.timeLeft) setVoiceError(`Gemini Live gaat opnieuw verbinden binnen ${msg.goAway.timeLeft}.`);"
].join('\n');

if (!page.includes(toolHook)) throw new Error('Could not locate Live message hook');
page = page.replace(toolHook, toolReplacement);

const profileMarker = '<div className="panel"><div className="panelHead"><span>PROFILE</span></div>';
const tavilyPanel = [
  '<div className="panel"><div className="panelHead"><span>FREE LIVE WEB SEARCH</span></div>',
  '            <p className="muted">Voor actuele niet-weer informatie gebruikt JARVIS Live Tavily Search. Weer gebruikt een aparte gratis live weerbron en verbruikt geen Tavily-credit.</p>',
  '            <label className="field">Tavily API-key<input type="password" autoComplete="off" value={tavilyKey} onChange={e=>{setTavilyKey(e.target.value.trim());setTavilyTest(\'\')}} placeholder="tvly-…"/></label>',
  '            <div className="formStack"><a className="primary setupLink" href="https://app.tavily.com/" target="_blank" rel="noreferrer">Maak gratis Tavily-key</a><button className="secondary" onClick={testTavilyKey}>Test gratis web search</button></div>',
  '            {tavilyTest && <p className={`keyStatus ${tavilyTest.startsWith(\'✓\')?\'ok\':\'\'}`}>{tavilyTest}</p>}',
  '            <p className="microcopy">Deze key blijft alleen in lokale opslag op dit toestel en wordt niet in je backup of GitHub gezet.</p>',
  '          </div>',
  '          '
].join('\n');

if (!page.includes(profileMarker)) throw new Error('Could not locate Settings profile marker');
page = page.replace(profileMarker, tavilyPanel + profileMarker);
page = page.replace('Gemini 2.5 Flash-Lite · FREE', 'Gemini 3.5 Flash-Lite · FREE');
page = page.replace('<div><span>Web</span><b>Google Search grounding</b></div>', '<div><span>Live web</span><b>{tavilyKey?\'Tavily · FREE\':\'Tavily key required\'}</b></div><div><span>Weather</span><b>Open-Meteo · LIVE · FREE</b></div>');

await writeFile('app/page.js', page, 'utf8');

await mkdir('app/api/search', { recursive:true });
const searchRoute = [
  "export const runtime = 'nodejs';",
  "export const maxDuration = 30;",
  "",
  "export async function POST(request) {",
  "  const key = String(request.headers.get('x-tavily-key') || '').trim();",
  "  if (!key) return Response.json({ error:'Voeg eerst je gratis Tavily API-key toe in JARVIS Settings.' }, { status:401 });",
  "  try {",
  "    const body = await request.json();",
  "    const query = String(body.query || '').trim();",
  "    if (!query) return Response.json({ error:'Search query is required' }, { status:400 });",
  "    const response = await fetch('https://api.tavily.com/search', {",
  "      method:'POST',",
  "      headers:{ 'content-type':'application/json', 'authorization':'Bearer ' + key },",
  "      body:JSON.stringify({ query, search_depth:'basic', max_results:5, include_answer:'basic', include_raw_content:false }),",
  "    });",
  "    const text = await response.text();",
  "    let data; try { data = JSON.parse(text); } catch { data = { error:text }; }",
  "    if (!response.ok) return Response.json({ error:data?.detail || data?.error || ('Tavily HTTP ' + response.status) }, { status:response.status });",
  "    const results = (data.results || []).slice(0,5).map(r => ({ title:r.title || r.url, url:r.url, content:String(r.content || '').slice(0,1200), published_date:r.published_date || null }));",
  "    return Response.json({ ok:true, answer:data.answer || '', results });",
  "  } catch (error) {",
  "    console.error('tavily-search', error);",
  "    return Response.json({ error:error?.message || 'Web search failed' }, { status:500 });",
  "  }",
  "}"
].join('\n');
await writeFile('app/api/search/route.js', searchRoute, 'utf8');

await mkdir('app/api/weather', { recursive:true });
const weatherRoute = [
  "export const runtime = 'nodejs';",
  "export const maxDuration = 30;",
  "",
  "function weatherText(code) {",
  "  const c = Number(code);",
  "  if (c === 0) return 'heldere hemel';",
  "  if ([1,2].includes(c)) return 'licht tot gedeeltelijk bewolkt';",
  "  if (c === 3) return 'bewolkt';",
  "  if ([45,48].includes(c)) return 'mist';",
  "  if ([51,53,55,56,57].includes(c)) return 'motregen';",
  "  if ([61,63,65,66,67].includes(c)) return 'regen';",
  "  if ([71,73,75,77,85,86].includes(c)) return 'sneeuw';",
  "  if ([80,81,82].includes(c)) return 'regenbuien';",
  "  if ([95,96,99].includes(c)) return 'onweer';",
  "  return 'wisselvallig weer';",
  "}",
  "",
  "export async function POST(request) {",
  "  try {",
  "    const body = await request.json();",
  "    let latitude = Number(body.latitude);",
  "    let longitude = Number(body.longitude);",
  "    let label = 'Jouw locatie';",
  "",
  "    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {",
  "      const location = String(body.location || '').trim();",
  "      if (!location) return Response.json({ error:'Noem een plaats of geef locatietoegang.' }, { status:400 });",
  "      const geo = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(location) + '&count=1&language=nl&format=json', { cache:'no-store' });",
  "      const geoData = await geo.json();",
  "      const place = geoData?.results?.[0];",
  "      if (!geo.ok || !place) return Response.json({ error:'Ik kon die plaats niet vinden: ' + location }, { status:404 });",
  "      latitude = Number(place.latitude);",
  "      longitude = Number(place.longitude);",
  "      label = [place.name, place.admin1, place.country].filter(Boolean).join(', ');",
  "    }",
  "",
  "    const params = new URLSearchParams({",
  "      latitude:String(latitude), longitude:String(longitude), timezone:'auto', forecast_days:'3',",
  "      current:'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m',",
  "      daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max'",
  "    });",
  "    const response = await fetch('https://api.open-meteo.com/v1/forecast?' + params.toString(), { cache:'no-store' });",
  "    const data = await response.json();",
  "    if (!response.ok || data?.error) return Response.json({ error:data?.reason || 'Weather service failed' }, { status:502 });",
  "",
  "    const c = data.current || {};",
  "    const d = data.daily || {};",
  "    const forecast = (d.time || []).slice(0,3).map((date,i) => ({",
  "      date, condition:weatherText(d.weather_code?.[i]), max_c:d.temperature_2m_max?.[i], min_c:d.temperature_2m_min?.[i],",
  "      precipitation_probability_max:d.precipitation_probability_max?.[i], precipitation_mm:d.precipitation_sum?.[i], max_wind_kmh:d.wind_speed_10m_max?.[i]",
  "    }));",
  "",
  "    return Response.json({",
  "      ok:true, source:'Open-Meteo', location:label, latitude, longitude, observed_at:c.time, timezone:data.timezone,",
  "      current:{ condition:weatherText(c.weather_code), temperature_c:c.temperature_2m, feels_like_c:c.apparent_temperature, humidity_percent:c.relative_humidity_2m, precipitation_mm:c.precipitation, rain_mm:c.rain, showers_mm:c.showers, snowfall_cm:c.snowfall, cloud_cover_percent:c.cloud_cover, wind_kmh:c.wind_speed_10m, gust_kmh:c.wind_gusts_10m },",
  "      forecast",
  "    });",
  "  } catch (error) {",
  "    console.error('open-meteo-weather', error);",
  "    return Response.json({ error:error?.message || 'Weather lookup failed' }, { status:500 });",
  "  }",
  "}"
].join('\n');
await writeFile('app/api/weather/route.js', weatherRoute, 'utf8');

console.log('JARVIS assembled: Gemini Live + Tavily web + Open-Meteo live weather');

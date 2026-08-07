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

// Tavily key: private local browser setting, just like the Gemini key.
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
  `  useEffect(() => {\n    try {\n      if (tavilyKey) localStorage.setItem(TAVILY_KEY_STORAGE, tavilyKey);\n      else localStorage.removeItem(TAVILY_KEY_STORAGE);\n    } catch {}\n  }, [tavilyKey]);\n\n  const flash = useCallback((text) => {`
);

// Tavily key tester.
page = page.replace(
  "  const send = useCallback(async () => {",
  `  const testTavilyKey = useCallback(async () => {\n    const key = tavilyKey.trim();\n    if (!key) { setTavilyTest('Voeg eerst een Tavily-key toe'); return; }\n    setTavilyTest('Testen…');\n    try {\n      const response = await fetch('/api/search', { method:'POST', headers:{'content-type':'application/json','x-tavily-key':key}, body:JSON.stringify({query:'OpenAI'}) });\n      const data = await response.json();\n      if (!response.ok) throw new Error(data.error || \\`HTTP \\${response.status}\\`);\n      setTavilyTest('✓ Gratis web search werkt');\n    } catch (error) { setTavilyTest(\\`✕ \\${error?.message || 'Tavily-key werkt niet'}\\`); }\n  }, [tavilyKey]);\n\n  const send = useCallback(async () => {`
);

// Keep the stable Gemini Live transport and add ONLY one synchronous custom
// function tool. Search itself happens via our own /api/search route, avoiding
// Gemini Live Search-grounding quota issues.
const oldSetup = `systemInstruction:{ parts:[{ text:\`You are JARVIS, a private personal AI assistant. Speak Dutch by default unless the user changes language. Speak naturally, calmly and intelligently. Voice manner: mature, composed, refined, measured and subtly British/cinematic, but never imitate Paul Bettany or any real person. Keep spoken answers concise but useful. Current device time: \${new Date().toISOString()}.\` }] },\n          inputAudioTranscription:{},\n          outputAudioTranscription:{},`;
const newSetup = `systemInstruction:{ parts:[{ text:\`You are JARVIS, a private personal AI assistant. Speak Dutch by default unless the user changes language. Speak naturally, calmly and intelligently. Voice manner: mature, composed, refined, measured and subtly British/cinematic, but never imitate Paul Bettany or any real person. Keep spoken answers concise but useful. You have a web_search function. For current, recent, live, today, latest, news, weather, sports scores, prices, opening hours, schedules, releases or anything that may have changed, ALWAYS call web_search before answering. Base the answer on the returned results and mention when the result is current. Current device time: \${new Date().toISOString()}.\` }] },\n          inputAudioTranscription:{},\n          outputAudioTranscription:{},\n          tools:[{ functionDeclarations:[{ name:'web_search', description:'Search the live public web for current or recently changed information before answering.', parameters:{ type:'object', properties:{ query:{type:'string',description:'A concise web search query'} }, required:['query'] } }] }],`;
if (!page.includes(oldSetup)) throw new Error('Could not locate stable JARVIS Live setup block');
page = page.replace(oldSetup, newSetup);

// Handle Gemini Live tool calls by querying Tavily and returning the result to
// the same live session. No Tavily key is ever sent to Gemini.
const toolHook = `          if (msg.goAway?.timeLeft) setVoiceError(\`Gemini Live gaat opnieuw verbinden binnen \${msg.goAway.timeLeft}.\`);`;
const toolReplacement = `          for (const fc of msg.toolCall?.functionCalls || []) {\n            if (fc?.name !== 'web_search') continue;\n            let responsePayload;\n            try {\n              const key = tavilyKey.trim();\n              if (!key) throw new Error('Geen Tavily Search-key ingesteld. Open More → Settings → FREE LIVE WEB SEARCH.');\n              const r = await fetch('/api/search', { method:'POST', headers:{'content-type':'application/json','x-tavily-key':key}, body:JSON.stringify({query:String(fc?.args?.query || '')}) });\n              const data = await r.json();\n              if (!r.ok) throw new Error(data.error || \\`Search HTTP \\${r.status}\\`);\n              responsePayload = { ok:true, answer:data.answer || '', results:data.results || [] };\n            } catch (error) {\n              responsePayload = { ok:false, error:String(error?.message || error) };\n            }\n            if (ws.readyState === WebSocket.OPEN) {\n              ws.send(JSON.stringify({ toolResponse:{ functionResponses:[{ id:fc.id, name:'web_search', response:responsePayload }] } }));\n            }\n          }\n          if (msg.goAway?.timeLeft) setVoiceError(\`Gemini Live gaat opnieuw verbinden binnen \${msg.goAway.timeLeft}.\`);`;
if (!page.includes(toolHook)) throw new Error('Could not locate Live message hook');
page = page.replace(toolHook, toolReplacement);

// Add Tavily setup UI before Profile.
const profileMarker = `<div className="panel"><div className="panelHead"><span>PROFILE</span></div>`;
const tavilyPanel = `<div className="panel"><div className="panelHead"><span>FREE LIVE WEB SEARCH</span></div>\n            <p className="muted">Voor actuele informatie gebruikt JARVIS Live Tavily Search. Het Researcher-plan geeft 1.000 gratis API-credits per maand en vereist geen betaalkaart.</p>\n            <label className="field">Tavily API-key<input type="password" autoComplete="off" value={tavilyKey} onChange={e=>{setTavilyKey(e.target.value.trim());setTavilyTest('')}} placeholder="tvly-…"/></label>\n            <div className="formStack"><a className="primary setupLink" href="https://app.tavily.com/" target="_blank" rel="noreferrer">Maak gratis Tavily-key</a><button className="secondary" onClick={testTavilyKey}>Test gratis web search</button></div>\n            {tavilyTest && <p className={\`keyStatus \${tavilyTest.startsWith('✓')?'ok':''}\`}>{tavilyTest}</p>}\n            <p className="microcopy">Deze key blijft alleen in lokale opslag op dit toestel en wordt niet in je backup of GitHub gezet.</p>\n          </div>\n          `;
if (!page.includes(profileMarker)) throw new Error('Could not locate Settings profile marker');
page = page.replace(profileMarker, tavilyPanel + profileMarker);

// Update visible status labels.
page = page.replace('Gemini 2.5 Flash-Lite · FREE', 'Gemini 3.5 Flash-Lite · FREE');
page = page.replace('<div><span>Web</span><b>Google Search grounding</b></div>', '<div><span>Live web</span><b>{tavilyKey?\'Tavily · FREE\':\'Tavily key required\'}</b></div>');

await writeFile('app/page.js', page, 'utf8');

// Generate a tiny server-side Tavily proxy. The user key arrives only per
// request and is never stored by JARVIS/Vercel.
await mkdir('app/api/search', { recursive:true });
await writeFile('app/api/search/route.js', `export const runtime = 'nodejs';\nexport const maxDuration = 30;\n\nexport async function POST(request) {\n  const key = String(request.headers.get('x-tavily-key') || '').trim();\n  if (!key) return Response.json({ error:'Voeg eerst je gratis Tavily API-key toe in JARVIS Settings.' }, { status:401 });\n  try {\n    const body = await request.json();\n    const query = String(body.query || '').trim();\n    if (!query) return Response.json({ error:'Search query is required' }, { status:400 });\n    const response = await fetch('https://api.tavily.com/search', {\n      method:'POST',\n      headers:{ 'content-type':'application/json', 'authorization':\\`Bearer \\${key}\\` },\n      body:JSON.stringify({ query, search_depth:'basic', max_results:5, include_answer:'basic', include_raw_content:false }),\n    });\n    const text = await response.text();\n    let data; try { data = JSON.parse(text); } catch { data = { error:text }; }\n    if (!response.ok) return Response.json({ error:data?.detail || data?.error || \\`Tavily HTTP \\${response.status}\\` }, { status:response.status });\n    const results = (data.results || []).slice(0,5).map(r => ({ title:r.title || r.url, url:r.url, content:String(r.content || '').slice(0,1200), published_date:r.published_date || null }));\n    return Response.json({ ok:true, answer:data.answer || '', results });\n  } catch (error) {\n    console.error('tavily-search', error);\n    return Response.json({ error:error?.message || 'Web search failed' }, { status:500 });\n  }\n}\n`, 'utf8');

console.log('JARVIS assembled: stable Gemini Live + Tavily free web search tool');

export const runtime = 'nodejs';
export const maxDuration = 60;

const MODEL = 'gemini-3.5-flash-lite';
const API = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const functionDeclarations = [
  {
    name: 'save_memory',
    description: 'Save a durable user-provided preference, goal, profile fact, routine, project fact, or something the user explicitly asks JARVIS to remember. Do not save fleeting details.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The durable fact to remember.' },
        category: { type: 'string', enum: ['preference','goal','profile','routine','project','general'] },
      },
      required: ['text','category'],
    },
  },
  {
    name: 'add_task',
    description: 'Add a concrete task to the user local JARVIS task list.',
    parameters: { type:'object', properties:{ title:{type:'string'} }, required:['title'] },
  },
  {
    name: 'add_event',
    description: 'Add an event or appointment to the local JARVIS agenda. Use ISO 8601 date-time with timezone when possible.',
    parameters: { type:'object', properties:{ title:{type:'string'}, when:{type:'string'} }, required:['title','when'] },
  },
  {
    name: 'save_note',
    description: 'Append useful text to the user local JARVIS notes.',
    parameters: { type:'object', properties:{ text:{type:'string'} }, required:['text'] },
  },
  {
    name: 'open_url',
    description: 'Open a public http or https URL on the user device only when explicitly requested.',
    parameters: { type:'object', properties:{ url:{type:'string'} }, required:['url'] },
  },
];

function getKey(request) {
  return String(request.headers.get('x-gemini-key') || '').trim();
}

function safeUrl(value) {
  try {
    const u = new URL(value);
    return ['http:','https:'].includes(u.protocol) ? u.toString() : null;
  } catch { return null; }
}

function isSearchRequest(text) {
  return /\b(zoek|search|web|internet|online|actueel|recent|laatste|latest|vandaag|today|nieuws|news|prijs|prijzen|price|voorraad|stock|weer|weather|wanneer|when|openingstijden|hours|score|uitslag|resultaat|current|momenteel|nu)\b/i.test(text);
}

function isLocalActionRequest(text) {
  return /\b(onthoud|remember|taak|task|todo|to-do|agenda|afspraak|event|note|notitie|bewaar|save|open (?:deze|dit|the) (?:link|url)|voeg .* toe|zet .* in)\b/i.test(text);
}

async function callGemini(key, payload) {
  const response = await fetch(API, {
    method: 'POST',
    headers: { 'content-type':'application/json', 'x-goog-api-key':key },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error:{ message:text } }; }
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Gemini HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function outputText(data) {
  return (data?.candidates?.[0]?.content?.parts || []).filter(p => typeof p.text === 'string').map(p => p.text).join('').trim();
}

function actionFrom(call) {
  const a = call?.args || {};
  if (call?.name === 'save_memory' && a.text) return { type:'save_memory', text:String(a.text), category:a.category || 'general' };
  if (call?.name === 'add_task' && a.title) return { type:'add_task', title:String(a.title) };
  if (call?.name === 'add_event' && a.title && a.when) return { type:'add_event', title:String(a.title), when:String(a.when) };
  if (call?.name === 'save_note' && a.text) return { type:'save_note', text:String(a.text) };
  if (call?.name === 'open_url' && a.url) {
    const url = safeUrl(a.url);
    if (url) return { type:'open_url', url };
  }
  return null;
}

export async function POST(request) {
  const key = getKey(request);
  if (!key) return Response.json({ error:'Voeg eerst je gratis Gemini API-key toe in JARVIS Settings.' }, { status:401 });

  const actions = [];
  try {
    const body = await request.json();
    const message = String(body.message || '').trim();
    if (!message && !body.attachment) return Response.json({ error:'Message is required' }, { status:400 });

    const memories = Array.isArray(body.memoryContext) ? body.memoryContext.slice(0,12) : [];
    const old = Array.isArray(body.historyMatches) ? body.historyMatches.slice(0,8) : [];
    const recent = Array.isArray(body.recentMessages) ? body.recentMessages.slice(-12) : [];
    const localTime = body.localTime || new Date().toISOString();
    const userName = String(body.userName || '').trim();
    const wantsAction = isLocalActionRequest(message);
    const wantsSearch = !wantsAction && isSearchRequest(message);

    const freshnessNote = wantsSearch
      ? `\nIMPORTANT: This free text route has no Google Search grounding on Gemini 3.x Free Tier. Do not invent current facts. Tell the user briefly that current web research is available for free through JARVIS LIVE (tap the reactor), whose Live model has Google Search support.`
      : '';

    const system = `You are JARVIS, a highly capable private personal AI assistant in a mobile web app.\nDefault to Dutch (Belgian/NL) unless the user changes language. Be practical, accurate, conversational and direct. You are not the fictional Iron Man character and you do not imitate any real person. Help with normal conversation, explanations, study, planning, coding, research, travel, analysis, creative work and personal organization.\n\nFor local organizer requests, use the supplied function tools and only confirm an action after the function was called. Save only durable memories. For dates use device time ${localTime}.\nUser name: ${userName || '(not set)'}\nRelevant Memory Core:\n${memories.length ? memories.map(x=>'- '+x).join('\n') : '(none)'}\nRelevant older chats:\n${old.length ? old.map(x=>'- '+(x.role||'unknown')+': '+x.text).join('\n') : '(none)'}${freshnessNote}`;

    const contents = recent.filter(m => m && typeof m.text === 'string').map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text:m.text }],
    }));

    const userParts = [];
    if (body.attachment?.base64 && body.attachment?.mimeType) {
      userParts.push({ inline_data:{ mime_type:String(body.attachment.mimeType), data:String(body.attachment.base64) } });
    }
    if (message) userParts.push({ text:message });
    contents.push({ role:'user', parts:userParts });

    let data = await callGemini(key, {
      systemInstruction:{ parts:[{ text:system }] },
      contents,
      ...(wantsAction ? { tools:[{ functionDeclarations }] } : {}),
      generationConfig:{ maxOutputTokens:4096 },
    });

    if (wantsAction) {
      for (let loop = 0; loop < 4; loop++) {
        const candidate = data?.candidates?.[0]?.content;
        const calls = (candidate?.parts || []).filter(p => p.functionCall).map(p => p.functionCall);
        if (!calls.length) break;
        contents.push(candidate);
        const responseParts = [];
        for (const call of calls) {
          const action = actionFrom(call);
          if (action) actions.push(action);
          responseParts.push({
            functionResponse:{
              name:call.name,
              ...(call.id ? { id:call.id } : {}),
              response: action ? { ok:true, queued_for_device:true } : { ok:false, error:'Invalid local action' },
            },
          });
        }
        contents.push({ role:'user', parts:responseParts });
        data = await callGemini(key, {
          systemInstruction:{ parts:[{ text:system }] },
          contents,
          tools:[{ functionDeclarations }],
          generationConfig:{ maxOutputTokens:2048 },
        });
      }
    }

    return Response.json({
      text: outputText(data) || (actions.length ? 'Uitgevoerd.' : 'Geen tekstantwoord ontvangen.'),
      actions,
      sources: [],
      model: MODEL,
      freeTier:true,
    });
  } catch (error) {
    console.error('gemini-chat-error', error);
    const raw = error?.message || 'Gemini request failed';
    const friendly = error?.status === 429 ? 'Je gratis Gemini-daglimiet is bereikt. Probeer later opnieuw; er wordt niets aangerekend.' : raw;
    return Response.json({ error:friendly }, { status:error?.status || 500 });
  }
}

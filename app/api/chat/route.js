import { callGemini, friendlyProviderError, geminiText, getWeather, searchWeb } from '../../_server/providers';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MODEL = 'gemini-3.5-flash-lite';

const functionDeclarations = [
  {
    name: 'get_weather',
    description: 'Get current weather and a three day forecast. Always use this for a weather question.',
    parameters: {
      type: 'object',
      properties: { location: { type: 'string', description: 'City or place name. Use the supplied home location when the user says here.' } },
      required: ['location'],
    },
  },
  {
    name: 'web_search',
    description: 'Search current public web information. Use this for news, sports scores, prices, stock, opening hours, schedules, releases and facts that may have changed.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'save_memory',
    description: 'Save a durable preference, profile fact, goal, routine or project fact the user wants JARVIS to remember.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' }, category: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'add_task',
    description: 'Add a concrete task to the local JARVIS task list.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, due: { type: 'string', description: 'Optional ISO 8601 date-time.' } },
      required: ['title'],
    },
  },
  {
    name: 'add_event',
    description: 'Add an appointment or event to the local JARVIS agenda.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, when: { type: 'string', description: 'ISO 8601 date-time.' } },
      required: ['title', 'when'],
    },
  },
  {
    name: 'save_note',
    description: 'Append text to the local JARVIS notebook.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'open_url',
    description: 'Open a public HTTP or HTTPS page on the user device, only when the user explicitly asks.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
];

function localAction(call) {
  const args = call?.args || {};
  if (call?.name === 'save_memory' && args.text) return { type: 'save_memory', text: String(args.text), category: String(args.category || 'general') };
  if (call?.name === 'add_task' && args.title) return { type: 'add_task', title: String(args.title), due: args.due ? String(args.due) : '' };
  if (call?.name === 'add_event' && args.title && args.when) return { type: 'add_event', title: String(args.title), when: String(args.when) };
  if (call?.name === 'save_note' && args.text) return { type: 'save_note', text: String(args.text) };
  if (call?.name === 'open_url' && args.url) {
    try {
      const url = new URL(String(args.url));
      if (['http:', 'https:'].includes(url.protocol)) return { type: 'open_url', url: url.toString() };
    } catch {}
  }
  return null;
}

async function runTool(call, tavilyKey, homeLocation) {
  const args = call?.args || {};
  if (call?.name === 'get_weather') {
    const location = String(args.location || homeLocation || 'Mortsel');
    return getWeather({ location });
  }
  if (call?.name === 'web_search') return searchWeb(tavilyKey, args.query);
  const action = localAction(call);
  return action ? { ok: true, queued_for_device: true, action } : { ok: false, error: 'Ongeldige lokale actie.' };
}

export async function POST(request) {
  const apiKey = String(request.headers.get('x-gemini-key') || '').trim();
  const tavilyKey = String(request.headers.get('x-tavily-key') || '').trim();
  if (!apiKey) return Response.json({ error: 'Voeg eerst je gratis Gemini API-key toe in Instellingen.' }, { status: 401 });

  try {
    const body = await request.json();
    const message = String(body.message || '').trim().slice(0, 30000);
    if (!message && !body.attachment) return Response.json({ error: 'Een bericht of bestand is vereist.' }, { status: 400 });

    const memory = Array.isArray(body.memoryContext) ? body.memoryContext.slice(0, 14).map(String) : [];
    const history = Array.isArray(body.historyMatches) ? body.historyMatches.slice(0, 8) : [];
    const recent = Array.isArray(body.recentMessages) ? body.recentMessages.slice(-14) : [];
    const userName = String(body.userName || '').trim().slice(0, 100);
    const style = String(body.responseStyle || 'duidelijk en praktisch').trim().slice(0, 120);
    const localTime = String(body.localTime || new Date().toISOString());
    const homeLocation = String(body.homeLocation || 'Mortsel').slice(0, 200);

    const system = [
      'You are JARVIS, a highly capable private personal assistant inside a mobile app.',
      'Default to Dutch (Belgian/NL) unless the user changes language. Be accurate, calm, natural, practical and direct.',
      `Preferred answer style: ${style}.`,
      'You can explain, plan, analyse, write, calculate, study, brainstorm and use the supplied tools.',
      'For EVERY weather question, call get_weather before answering. For facts that could have changed, call web_search before answering.',
      'For organizer requests, call the correct local tool and only confirm success after the tool call. Save only durable memories.',
      'Do not claim access to arbitrary phone apps, accounts, devices or services that are not represented by a tool.',
      'You are not the fictional Iron Man character and must not imitate Paul Bettany or another real person.',
      `User name: ${userName || '(not set)'}. Device time: ${localTime}. Home weather location: ${homeLocation}.`,
      `Relevant Memory Core:\n${memory.length ? memory.map(item => `- ${item}`).join('\n') : '(none)'}`,
      `Relevant older conversations:\n${history.length ? history.map(item => `- ${item.role || 'unknown'}: ${String(item.text || '').slice(0, 1200)}`).join('\n') : '(none)'}`,
      tavilyKey ? 'Current web search is available.' : 'Current web search requires the optional Tavily key. If web_search returns an error, explain how to enable it instead of inventing current facts.',
    ].join('\n\n');

    const contents = recent
      .filter(item => item && typeof item.text === 'string' && item.text.trim())
      .map(item => ({
        role: item.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(item.text).slice(0, 12000) }],
      }));

    const userParts = [];
    const attachment = body.attachment;
    if (attachment?.base64 && attachment?.mimeType) {
      const data = String(attachment.base64);
      if (data.length > 3_600_000) return Response.json({ error: 'Dit bestand is te groot voor een betrouwbare mobiele upload.' }, { status: 413 });
      userParts.push({ inlineData: { mimeType: String(attachment.mimeType).slice(0, 120), data } });
      userParts.push({ text: `Bestandsnaam: ${String(attachment.filename || 'bijlage').slice(0, 240)}` });
    }
    if (message) userParts.push({ text: message });
    contents.push({ role: 'user', parts: userParts });

    const actions = [];
    const sources = [];
    let data = await callGemini(apiKey, {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations }],
      generationConfig: { maxOutputTokens: 4096 },
    }, MODEL);

    for (let turn = 0; turn < 5; turn += 1) {
      const candidate = data?.candidates?.[0]?.content;
      const calls = (candidate?.parts || []).filter(part => part.functionCall).map(part => part.functionCall);
      if (!calls.length) break;
      contents.push(candidate);
      const functionResponses = [];
      for (const call of calls) {
        let result;
        try {
          result = await runTool(call, tavilyKey, homeLocation);
          const action = localAction(call);
          if (action) actions.push(action);
          if (call.name === 'web_search' && result?.results) {
            for (const source of result.results) {
              if (!sources.some(existing => existing.url === source.url)) sources.push({ title: source.title, url: source.url });
            }
          }
          if (call.name === 'get_weather' && result?.ok && !sources.some(source => source.url.includes('open-meteo.com'))) {
            sources.push({ title: 'Open-Meteo live weer', url: 'https://open-meteo.com/' });
          }
        } catch (toolError) {
          result = { ok: false, error: toolError?.message || String(toolError) };
        }
        functionResponses.push({
          functionResponse: {
            id: call.id,
            name: call.name,
            response: { result },
          },
        });
      }
      contents.push({ role: 'user', parts: functionResponses });
      data = await callGemini(apiKey, {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations }],
        generationConfig: { maxOutputTokens: 4096 },
      }, MODEL);
    }

    const text = geminiText(data) || (actions.length ? 'Uitgevoerd en lokaal opgeslagen.' : 'Ik ontving geen volledig tekstantwoord. Probeer je vraag opnieuw.');
    return Response.json({ text, actions, sources: sources.slice(0, 8), model: MODEL, freeTier: true });
  } catch (error) {
    console.error('jarvis-chat', { status: error?.status, message: error?.message });
    return Response.json({ error: friendlyProviderError(error, 'De gratis AI-route reageerde niet.') }, { status: error?.status || 500 });
  }
}

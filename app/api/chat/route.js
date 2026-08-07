import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 60;

const safeUrl = (value) => {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null;
  } catch { return null; }
};

export async function POST(request) {
  const actions = [];
  try {
    const body = await request.json();
    const message = String(body.message || '').trim();
    if (!message && !body.attachment) {
      return Response.json({ error: 'Message is required' }, { status: 400 });
    }

    const localTools = {
      web_search: openai.tools.webSearch({}),
      save_memory: tool({
        description: 'Save a durable user-provided preference, goal, profile fact, routine, project fact, or something the user explicitly asks to remember. Do not save fleeting details. Avoid sensitive personal data unless the user explicitly asks to save it.',
        inputSchema: z.object({
          text: z.string().min(1).max(1000),
          category: z.enum(['preference','goal','profile','routine','project','general']),
        }),
        execute: async ({ text, category }) => {
          const action = { type: 'save_memory', text, category };
          actions.push(action);
          return { ok: true, action };
        },
      }),
      add_task: tool({
        description: 'Add a concrete task to the user’s JARVIS task list.',
        inputSchema: z.object({ title: z.string().min(1).max(500) }),
        execute: async ({ title }) => {
          const action = { type: 'add_task', title };
          actions.push(action);
          return { ok: true, action };
        },
      }),
      add_event: tool({
        description: 'Add an event or appointment to the local JARVIS agenda. Use ISO 8601 date-time with timezone when known.',
        inputSchema: z.object({
          title: z.string().min(1).max(500),
          when: z.string().min(1).max(100),
        }),
        execute: async ({ title, when }) => {
          const action = { type: 'add_event', title, when };
          actions.push(action);
          return { ok: true, action };
        },
      }),
      save_note: tool({
        description: 'Append useful text to the user’s local JARVIS notes.',
        inputSchema: z.object({ text: z.string().min(1).max(4000) }),
        execute: async ({ text }) => {
          const action = { type: 'save_note', text };
          actions.push(action);
          return { ok: true, action };
        },
      }),
      open_url: tool({
        description: 'Open a public http/https webpage on the user device, only when the user explicitly asked to open it.',
        inputSchema: z.object({ url: z.string().min(1).max(2000) }),
        execute: async ({ url }) => {
          const clean = safeUrl(url);
          if (!clean) return { ok: false, error: 'Unsafe URL' };
          const action = { type: 'open_url', url: clean };
          actions.push(action);
          return { ok: true, action };
        },
      }),
    };

    const memoryContext = Array.isArray(body.memoryContext) ? body.memoryContext.slice(0, 12) : [];
    const historyMatches = Array.isArray(body.historyMatches) ? body.historyMatches.slice(0, 10) : [];
    const localTime = body.localTime || new Date().toISOString();
    const userName = String(body.userName || '').trim();

    const agent = new ToolLoopAgent({
      model: 'openai/gpt-5.6-terra',
      instructions: `You are JARVIS, a highly capable personal AI assistant inside a private mobile PWA.\n\nSTYLE\n- Default to Dutch (Belgian/NL) unless the user asks for another language.\n- Be direct, practical and intelligent. Do not pretend to be a fictional character or a real person.\n- You can handle ordinary conversation, explanations, planning, study help, coding, research, travel, current events, analysis and creative work.\n\nFRESH INFORMATION\n- Use web_search whenever current, recent, time-sensitive, niche or externally verifiable public information matters.\n- If you used web search, ground the answer in the retrieved information.\n\nLOCAL ACTIONS\n- Use save_memory/add_task/add_event/save_note/open_url when the user requests such actions.\n- Never claim a local action happened unless you actually called the corresponding tool.\n- For relative dates, use the device time supplied below.\n\nMEMORY\n- Durable Memory Core entries should be useful beyond the current turn.\n- Do not save temporary facts just because they were mentioned.\n\nDEVICE CONTEXT\nUser name: ${userName || '(not set)'}\nDevice time: ${localTime}\nRelevant Memory Core:\n${memoryContext.length ? memoryContext.map(x=>'- '+x).join('\n') : '(none)'}\nRelevant older chat matches:\n${historyMatches.length ? historyMatches.map(x=>'- '+(x.role || 'unknown')+': '+x.text).join('\n') : '(none)'}`,
      tools: localTools,
      stopWhen: stepCountIs(8),
    });

    const recent = Array.isArray(body.recentMessages) ? body.recentMessages.slice(-14) : [];
    const messages = recent
      .filter(m => m && typeof m.text === 'string')
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }));

    const content = [];
    if (message) content.push({ type: 'text', text: message });
    const a = body.attachment;
    if (a?.base64 && a?.mimeType) {
      const data = `data:${a.mimeType};base64,${a.base64}`;
      if (String(a.mimeType).startsWith('image/')) {
        content.push({ type: 'image', image: data });
      } else {
        content.push({ type: 'file', data, mediaType: a.mimeType, filename: a.filename || 'attachment' });
      }
    }
    messages.push({ role: 'user', content });

    const result = await agent.generate({ messages });
    const sources = (result.sources || []).map(s => ({
      url: s.url,
      title: s.title || s.url,
    })).filter(s => s.url);

    return Response.json({
      text: result.text || (actions.length ? 'Uitgevoerd.' : 'Geen tekstantwoord ontvangen.'),
      actions,
      sources,
      model: 'openai/gpt-5.6-terra',
    });
  } catch (error) {
    console.error('chat-error', error);
    return Response.json({ error: error?.message || 'JARVIS chat failed' }, { status: 500 });
  }
}

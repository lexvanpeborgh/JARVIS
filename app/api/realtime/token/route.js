import { gateway } from '@ai-sdk/gateway';
import { experimental_getRealtimeToolDefinitions as getRealtimeToolDefinitions, tool } from 'ai';
import { z } from 'zod';

export const runtime = 'nodejs';

const realtimeTools = {
  save_memory: tool({
    description: 'Save a durable user-provided fact, preference, goal, routine, project detail, or something the user explicitly asks JARVIS to remember.',
    inputSchema: z.object({
      text: z.string().min(1).max(1000),
      category: z.enum(['preference','goal','profile','routine','project','general']),
    }),
  }),
  add_task: tool({
    description: 'Add a concrete task to the user local JARVIS task list.',
    inputSchema: z.object({ title: z.string().min(1).max(500) }),
  }),
  add_event: tool({
    description: 'Add an event or appointment to the local JARVIS agenda. Use ISO 8601 date-time with timezone when possible.',
    inputSchema: z.object({ title: z.string().min(1).max(500), when: z.string().min(1).max(100) }),
  }),
  save_note: tool({
    description: 'Append useful text to the user local JARVIS notes.',
    inputSchema: z.object({ text: z.string().min(1).max(4000) }),
  }),
};

export async function POST() {
  try {
    const [credentials, tools] = await Promise.all([
      gateway.experimental_realtime.getToken({ model: 'openai/gpt-realtime-2.1' }),
      getRealtimeToolDefinitions({ tools: realtimeTools }),
    ]);
    return Response.json({ token: credentials.token, url: credentials.url, tools });
  } catch (error) {
    console.error('realtime-token', error);
    return Response.json({ error: error?.message || 'Could not create realtime token' }, { status: 500 });
  }
}

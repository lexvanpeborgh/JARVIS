export const APP_STORAGE_KEY = 'jarvis-personal-core-v4';
export const GEMINI_KEY_STORAGE = 'jarvis-gemini-free-key';
export const TAVILY_KEY_STORAGE = 'jarvis-tavily-free-key';

export function uid(prefix = 'j') {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const conversationMemories = [
  ['profile', 'Voorkeurstaal: Nederlands (België).'],
  ['preference', 'Geeft de voorkeur aan praktische, duidelijke uitleg en oplossingen zonder onnodige kosten.'],
  ['profile', 'Gebruikt een iPhone als gsm en een Windows-pc.'],
  ['interest', 'Terugkerende interesses: lopen en marathonvoorbereiding, wielrennen en sport.'],
  ['interest', 'Terugkerende context: logistiek, supply chain, werk en studie.'],
  ['location', 'Veelgebruikte locatiecontext: België en Mortsel.'],
];

export function createInitialState() {
  const now = new Date().toISOString();
  return {
    version: 4,
    profile: {
      name: '',
      homeLocation: 'Mortsel',
      responseStyle: 'duidelijk en praktisch',
      autoSpeak: false,
    },
    messages: [
      {
        id: uid('msg'),
        role: 'assistant',
        text: 'JARVIS online. Ik kan met je praten, dingen uitleggen en opzoeken, bestanden bekijken, en lokaal je geheugen, taken, agenda en notities beheren. Waarmee beginnen we?',
        createdAt: now,
      },
    ],
    conversations: [],
    voiceArchive: [],
    memories: conversationMemories.map(([category, text]) => ({
      id: uid('mem'),
      category,
      text,
      source: 'Eerdere gesprekken',
      createdAt: now,
    })),
    tasks: [],
    events: [],
    notes: '',
    updatedAt: now,
  };
}

export function normalizeState(value) {
  const fallback = createInitialState();
  if (!value || typeof value !== 'object') return fallback;
  return {
    ...fallback,
    ...value,
    version: 4,
    profile: { ...fallback.profile, ...(value.profile || {}) },
    messages: Array.isArray(value.messages) && value.messages.length ? value.messages.slice(-300) : fallback.messages,
    conversations: Array.isArray(value.conversations) ? value.conversations.slice(-80) : [],
    voiceArchive: Array.isArray(value.voiceArchive) ? value.voiceArchive.slice(-80) : [],
    memories: Array.isArray(value.memories) ? value.memories.slice(-300) : fallback.memories,
    tasks: Array.isArray(value.tasks) ? value.tasks.slice(-500) : [],
    events: Array.isArray(value.events) ? value.events.slice(-500) : [],
    notes: typeof value.notes === 'string' ? value.notes.slice(0, 200000) : '',
  };
}

function tokens(text) {
  return [...new Set(String(text || '')
    .toLocaleLowerCase('nl-BE')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 2))];
}

export function relevantHistory(state, query, limit = 8) {
  const wanted = tokens(query);
  if (!wanted.length) return [];
  const pool = [
    ...(state?.messages || []),
    ...(state?.conversations || []).flatMap(item => item.messages || []),
    ...(state?.voiceArchive || []).flatMap(item => item.messages || []),
  ];
  return pool
    .map(item => {
      const haystack = String(item.text || '').toLocaleLowerCase('nl-BE');
      const score = wanted.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      return { ...item, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, limit)
    .map(({ score: _score, ...item }) => item);
}

export function relevantMemories(state, query, limit = 12) {
  const wanted = tokens(query);
  return [...(state?.memories || [])]
    .map(item => {
      const text = String(item.text || '').toLocaleLowerCase('nl-BE');
      const score = wanted.reduce((sum, token) => sum + (text.includes(token) ? 2 : 0), 0);
      return { ...item, score };
    })
    .sort((a, b) => b.score - a.score || String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, limit)
    .map(item => item.text);
}

export function formatLocalDate(value, options = {}) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('nl-BE', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    ...options,
  }).format(date);
}

export function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function icsDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function downloadIcs(event) {
  const start = icsDate(event.when);
  if (!start) return false;
  const end = icsDate(new Date(new Date(event.when).getTime() + 60 * 60 * 1000));
  const clean = value => String(value || '').replace(/([,;])/g, '\\$1').replace(/\n/g, '\\n');
  const content = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//JARVIS Personal Core//NL',
    'BEGIN:VEVENT',
    `UID:${clean(event.id)}@jarvis.local`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${clean(event.title)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${event.title || 'jarvis-afspraak'}.ics`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

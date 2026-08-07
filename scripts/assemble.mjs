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

// Keep the stable direct Gemini Live voice transport, but enable Google's
// built-in Search grounding for current/recent information.
let page = await readFile('app/page.js', 'utf8');
const oldSetup = `systemInstruction:{ parts:[{ text:\`You are JARVIS, a private personal AI assistant. Speak Dutch by default unless the user changes language. Speak naturally, calmly and intelligently. Voice manner: mature, composed, refined, measured and subtly British/cinematic, but never imitate Paul Bettany or any real person. Keep spoken answers concise but useful. Current device time: \${new Date().toISOString()}.\` }] },\n          inputAudioTranscription:{},\n          outputAudioTranscription:{},`;
const newSetup = `systemInstruction:{ parts:[{ text:\`You are JARVIS, a private personal AI assistant. Speak Dutch by default unless the user changes language. Speak naturally, calmly and intelligently. Voice manner: mature, composed, refined, measured and subtly British/cinematic, but never imitate Paul Bettany or any real person. Keep spoken answers concise but useful. You have Google Search available. Whenever the user asks about current, recent, live, today, latest, news, weather, sports scores, prices, opening hours, schedules, releases, public figures or anything that may have changed, use Google Search before answering and say when information is current as of the search. Current device time: \${new Date().toISOString()}.\` }] },\n          inputAudioTranscription:{},\n          outputAudioTranscription:{},\n          tools:[{ googleSearch:{} }],`;
if (!page.includes(oldSetup)) throw new Error('Could not locate JARVIS Live setup block for Search injection');
page = page.replace(oldSetup, newSetup);
await writeFile('app/page.js', page, 'utf8');

console.log('JARVIS source assembled with Gemini Live Google Search');

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
console.log('JARVIS source assembled');

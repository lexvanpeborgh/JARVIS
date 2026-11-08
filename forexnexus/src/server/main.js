// Startpunt: één langlopend proces met HTTP-server, SSE en achtergrondengine.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openDb, getState, setState } from '../store/db.js';
import { loadMasterKey, secretStore, hashPassword } from './security.js';
import { createEngine } from '../engine/engine.js';
import { createApp } from './http.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = process.env.FNX_DATA_DIR || join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8080);

const db = openDb(join(DATA, 'forexnexus.db'));
const mk = loadMasterKey(process.env, join(DATA, 'master.key'));
if (mk.source !== 'env') console.warn(`[security] FNX_MASTER_KEY niet gezet; sleutelbestand in ${DATA} gebruikt (${mk.source}). Zet FNX_MASTER_KEY als runtime secret in productie.`);
const secrets = secretStore(db, mk.key);

// Privétoegang: FNX_ACCESS_PASSWORD(_HASH) of een eenmalig gegenereerd wachtwoord in een bestand.
if (!process.env.FNX_ACCESS_PASSWORD && !process.env.FNX_ACCESS_PASSWORD_HASH && !getState(db, 'auth.passwordHash')) {
  const pw = randomBytes(12).toString('base64url');
  setState(db, 'auth.passwordHash', hashPassword(pw));
  const f = join(DATA, 'INITIAL_PASSWORD.txt');
  if (!existsSync(f)) writeFileSync(f, `${pw}\n`, { mode: 0o600 });
  console.warn(`[security] Geen FNX_ACCESS_PASSWORD gezet. Eenmalig wachtwoord geschreven naar ${f} (alleen leesbaar voor de eigenaar). Zet FNX_ACCESS_PASSWORD in productie.`);
}

const engine = createEngine({ db, secrets, log: console });
const { server } = createApp({ db, engine, secrets, log: console });
server.listen(PORT, () => console.log(`[forexnexus] luistert op poort ${PORT}`));

async function shutdown(sig) {
  console.log(`[forexnexus] ${sig}: netjes afsluiten`);
  server.close();
  await engine.stop(true);
  setTimeout(() => { db.close(); process.exit(0); }, 300).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

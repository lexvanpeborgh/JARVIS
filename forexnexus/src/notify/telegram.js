// Telegram-notificaties via een duurzame outbox.
//
// Statussen: PENDING → SENDING → SENT
//                      ↘ RETRY_SCHEDULED (429 met Retry-After, 5xx, netwerkfout vóór verzending)
//                      ↘ FAILED (400/401/403/404: configuratiefout)
//                      ↘ UNKNOWN (timeout NA verzending: aflevering onzeker → niet blind opnieuw)
//            EXPIRED (entry niet meer geldig vlak vóór verzending), CANCELLED
// Een HTTP-succes betekent alleen dat Telegram het bericht accepteerde, niet dat het gelezen is.

import { redact } from '../server/security.js';
import { heartbeat } from '../store/db.js';

export const OUTBOX_STATUS = ['PENDING', 'SENDING', 'SENT', 'RETRY_SCHEDULED', 'EXPIRED', 'CANCELLED', 'FAILED', 'UNKNOWN'];

export function enqueue(db, { signalId = null, kind, channel = 'telegram', dedupeKey, payload, at = Date.now() }) {
  try {
    db.run('INSERT INTO outbox (signal_id, kind, channel, dedupe_key, status, attempts, next_attempt_at, payload, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', signalId, kind, channel, dedupeKey, 'PENDING', 0, at, JSON.stringify(payload), at, at);
    return { ok: true };
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return { ok: false, duplicate: true };
    throw e;
  }
}

/** Bij opstarten: SENDING-items van een onderbroken proces zijn onzeker. */
export function recoverOutbox(db, now = Date.now()) {
  const r = db.run("UPDATE outbox SET status = 'UNKNOWN', last_error = 'Proces herstart tijdens verzending; aflevering onzeker', updated_at = ? WHERE status = 'SENDING'", now);
  return r.changes;
}

export async function telegramApi(token, method, body, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let sent = false;
  try {
    const p = fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: ctrl.signal });
    sent = true;
    const res = await p;
    const data = await res.json().catch(() => ({}));
    return { httpStatus: res.status, data };
  } catch (e) {
    const timeout = e.name === 'AbortError' || /abort|timeout/i.test(e.message);
    const err = new Error(timeout ? 'TIMEOUT' : `NETWORK: ${e.message}`);
    err.timeout = timeout; err.maybeSent = sent && timeout; err.preSend = !timeout && /ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(e.message);
    throw err;
  } finally { clearTimeout(timer); }
}

/** Controleer bot en chatrechten via officiële methoden getMe en getChat. */
export async function checkTelegram(token, chatId, opts = {}) {
  if (!token) return { ok: false, code: 'TOKEN_MISSING', text: 'Bot-token ontbreekt.' };
  try {
    const me = await telegramApi(token, 'getMe', {}, opts);
    if (!me.data.ok) return { ok: false, code: 'BAD_TOKEN', text: 'Telegram weigert het bot-token.' };
    if (!chatId) return { ok: false, code: 'CHAT_MISSING', text: 'Chat-ID ontbreekt.', bot: me.data.result.username };
    const chat = await telegramApi(token, 'getChat', { chat_id: chatId }, opts);
    if (!chat.data.ok) return { ok: false, code: 'CHAT_NOT_ACCESSIBLE', text: `Bot heeft geen toegang tot deze chat (${chat.data.description || chat.httpStatus}). Stuur de bot eerst een bericht of voeg hem toe aan het kanaal.`, bot: me.data.result.username };
    return { ok: true, code: 'OK', bot: me.data.result.username, chatType: chat.data.result.type };
  } catch (e) {
    return { ok: false, code: 'NETWORK', text: redact(e.message, [token]) };
  }
}

/**
 * Verwerk de outbox. `revalidate(item)` controleert vlak vóór verzending of een
 * entrymelding nog geldig is; zo niet → EXPIRED.
 */
export async function processOutbox(db, { token, chatId, revalidate = () => null, now = () => Date.now(), fetchImpl = fetch, timeoutMs = 10_000, maxAttempts = 6, limit = 10 }) {
  const due = db.all("SELECT * FROM outbox WHERE status IN ('PENDING','RETRY_SCHEDULED') AND next_attempt_at <= ? ORDER BY id LIMIT ?", now(), limit);
  const results = [];
  for (const item of due) {
    const payload = JSON.parse(item.payload);
    if (!token || !chatId) {
      db.run("UPDATE outbox SET status='FAILED', last_error=?, updated_at=? WHERE id=?", 'Telegram niet geconfigureerd', now(), item.id);
      results.push({ id: item.id, status: 'FAILED' }); continue;
    }
    const invalid = item.kind === 'ENTRY' ? revalidate(item, payload) : null;
    if (invalid) {
      db.run("UPDATE outbox SET status='EXPIRED', last_error=?, updated_at=? WHERE id=?", `${invalid.code}: ${invalid.text}`, now(), item.id);
      results.push({ id: item.id, status: 'EXPIRED', reason: invalid.code }); continue;
    }
    // claim (voorkomt dubbele verzending door parallelle verwerking)
    const claim = db.run("UPDATE outbox SET status='SENDING', attempts=attempts+1, updated_at=? WHERE id=? AND status IN ('PENDING','RETRY_SCHEDULED')", now(), item.id);
    if (claim.changes !== 1) continue;
    try {
      const r = await telegramApi(token, 'sendMessage', { chat_id: chatId, text: payload.text, parse_mode: 'HTML', disable_web_page_preview: true }, { fetchImpl, timeoutMs });
      if (r.data.ok) {
        db.run("UPDATE outbox SET status='SENT', sent_at=?, provider_message_id=?, last_error=NULL, updated_at=? WHERE id=?", now(), String(r.data.result?.message_id ?? ''), now(), item.id);
        results.push({ id: item.id, status: 'SENT' });
      } else if (r.httpStatus === 429) {
        const ra = Number(r.data.parameters?.retry_after ?? 30);
        db.run("UPDATE outbox SET status='RETRY_SCHEDULED', next_attempt_at=?, last_error=?, updated_at=? WHERE id=?", now() + ra * 1000, `429 rate limit, Retry-After ${ra}s`, now(), item.id);
        results.push({ id: item.id, status: 'RETRY_SCHEDULED', retryAfter: ra });
      } else if (r.httpStatus >= 500) {
        const att = item.attempts + 1;
        const st = att >= maxAttempts ? 'FAILED' : 'RETRY_SCHEDULED';
        db.run('UPDATE outbox SET status=?, next_attempt_at=?, last_error=?, updated_at=? WHERE id=?', st, now() + backoff(att), `Telegram ${r.httpStatus}`, now(), item.id);
        results.push({ id: item.id, status: st });
      } else {
        db.run("UPDATE outbox SET status='FAILED', last_error=?, updated_at=? WHERE id=?", redact(`Telegram ${r.httpStatus}: ${r.data.description || ''}`, [token]), now(), item.id);
        results.push({ id: item.id, status: 'FAILED' });
      }
    } catch (e) {
      if (e.maybeSent) {
        db.run("UPDATE outbox SET status='UNKNOWN', last_error=?, updated_at=? WHERE id=?", 'Timeout na verzending: aflevering onzeker, niet automatisch opnieuw verstuurd', now(), item.id);
        results.push({ id: item.id, status: 'UNKNOWN' });
      } else {
        const att = item.attempts + 1;
        const st = att >= maxAttempts ? 'FAILED' : 'RETRY_SCHEDULED';
        db.run('UPDATE outbox SET status=?, next_attempt_at=?, last_error=?, updated_at=? WHERE id=?', st, now() + backoff(att), redact(e.message, [token]), now(), item.id);
        results.push({ id: item.id, status: st });
      }
    }
  }
  if (results.length) heartbeat(db, 'telegram', results.some(r => r.status === 'FAILED') ? 'error' : 'ok', { processed: results.length, results: results.map(r => r.status) });
  return results;
}

export function backoff(attempt) {
  const base = Math.min(300_000, 2000 * 2 ** attempt);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Opmaak van een entrymelding (HTML-modus van Telegram). */
export function formatEntry(sig, { appUrl = '', fmt }) {
  const d = sig.snapshot; const p = d.plan; const long = sig.direction === 'LONG';
  const L = [];
  L.push(`<b>${long ? '🟢 BUY — mogelijke LONGentry' : '🔴 SELL — mogelijke SHORTentry'}</b>`);
  L.push(`${esc(d.instrumentDisplay || sig.instrument)}${sig.contract ? ` (${esc(sig.contract)})` : ''} · ${esc(sig.timeframe)} · ${esc(d.strategy.name)} v${esc(d.strategy.version)}`);
  L.push(`Modus: <b>${esc(sig.modeLabel)}</b> · Signaal-ID: <code>${esc(sig.id)}</code>`);
  L.push('');
  L.push(`Entry (${long ? 'ask' : 'bid'}): <b>${fmt(p.entry)}</b>`);
  L.push(`SL: ${fmt(p.sl)} (${p.dist.sl.value} ${p.dist.sl.unit})`);
  if (p.tp1 != null) L.push(`TP1: ${fmt(p.tp1)} (${p.dist.tp1.value} ${p.dist.tp1.unit}) · RR bruto ${p.rr.tp1.gross} / netto ${p.rr.tp1.net ?? '—'}${p.tp1Role === 'observation' ? ' · observatie' : ' · exit'}`);
  if (p.tp2 != null) L.push(`TP2: ${fmt(p.tp2)} (${p.dist.tp2.value} ${p.dist.tp2.unit}) · RR bruto ${p.rr.tp2.gross} / netto ${p.rr.tp2.net ?? '—'}${p.exitTarget === 'tp2' ? ' · exit' : ' · observatie'}`);
  L.push(`Geldig tot: ${esc(new Date(sig.expires_at).toISOString().slice(11, 19))} UTC`);
  L.push('');
  L.push('<b>Waarom:</b>');
  for (const c of d.conditions.filter(x => x.ok).slice(0, 5)) L.push(`✔ ${esc(c.detail)}`);
  if (d.against?.[0]) L.push(`<b>Tegen:</b> ${esc(d.against[0])}`);
  L.push(`Nieuws: ${esc(d.snapshot.news?.status?.text || 'nieuwsfilter uit')}${d.snapshot.news?.next ? ` · volgend: ${esc(d.snapshot.news.next.currency)} ${esc(d.snapshot.news.next.title)} over ${d.snapshot.news.minutesToNext} min` : ''}`);
  if (appUrl) L.push(`<a href="${esc(appUrl)}/#/signal/${encodeURIComponent(sig.id)}">Open signaal in de app</a>`);
  L.push('<i>Geen order geplaatst. Analysemelding, geen garantie.</i>');
  return L.join('\n');
}

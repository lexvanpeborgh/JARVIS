-- ForexNexus Alpha — initieel schema. Alle tijden in UTC-milliseconden.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Versleutelde geheimen (AES-256-GCM). Waarden verlaten de server nooit.
CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  hint TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_nonces (
  nonce TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS instruments (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,          -- 'oanda', 'csv', 'parquet', 'demo', 'live'
  provider TEXT,
  instrument TEXT NOT NULL,
  contract TEXT,
  timeframe TEXT NOT NULL,
  price_type TEXT,               -- 'BA' | 'M' | 'B' | 'A' | 'LAST'
  volume_type TEXT,              -- 'tick_count' | 'exchange' | 'synthetic' | 'proxy' | 'none'
  timezone TEXT,
  from_t INTEGER,
  to_t INTEGER,
  rows INTEGER,
  checksum TEXT,
  kind TEXT NOT NULL,            -- 'real' | 'synthetic'
  filename TEXT,
  corrections TEXT,
  quality TEXT,
  imported_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS candles (
  dataset_id TEXT NOT NULL,
  instrument TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  t INTEGER NOT NULL,
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
  bo REAL, bh REAL, bl REAL, bc REAL,
  ao REAL, ah REAL, al REAL, ac REAL,
  v REAL,
  v_type TEXT,
  complete INTEGER NOT NULL,
  contract TEXT,
  received_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dataset_id, instrument, timeframe, t)
);

CREATE TABLE IF NOT EXISTS quote_snapshots (
  instrument TEXT NOT NULL,
  provider TEXT NOT NULL,
  time INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  bid REAL, ask REAL,
  PRIMARY KEY (instrument, provider, time)
);

CREATE TABLE IF NOT EXISTS strategy_versions (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  family TEXT NOT NULL,
  definition TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS config_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL UNIQUE,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Iedere evaluatie van een gesloten candle (kandidaten, blokkades, wachttoestanden).
CREATE TABLE IF NOT EXISTS evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument TEXT NOT NULL,
  strategy TEXT NOT NULL,
  version TEXT NOT NULL,
  candle_t INTEGER NOT NULL,
  evaluated_at INTEGER NOT NULL,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  direction TEXT,
  blockers TEXT,
  decision TEXT NOT NULL,
  config_version INTEGER,
  UNIQUE (instrument, strategy, version, candle_t, mode)
);
CREATE INDEX IF NOT EXISTS evaluations_recent ON evaluations (instrument, strategy, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  instrument TEXT NOT NULL,
  contract TEXT,
  strategy TEXT NOT NULL,
  version TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  candle_t INTEGER NOT NULL,
  direction TEXT NOT NULL,
  mode TEXT NOT NULL,
  data_kind TEXT NOT NULL,
  provider TEXT,
  status TEXT NOT NULL,         -- ACTIVE | EXPIRED | CANCELLED | ENTRY_MISSED | TAKEN
  entry_ref REAL, sl REAL, tp1 REAL, tp2 REAL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  snapshot TEXT NOT NULL,        -- onveranderlijke snapshot van alle gebruikte waarden
  config_version INTEGER
);
CREATE INDEX IF NOT EXISTS signals_recent ON signals (created_at DESC);

CREATE TABLE IF NOT EXISTS signal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS scenarios (
  id TEXT PRIMARY KEY,
  signal_id TEXT,
  created_at INTEGER NOT NULL,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id TEXT,
  kind TEXT NOT NULL,            -- ENTRY | CANCELLED | EXPIRED | EXIT | TEST
  channel TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,          -- PENDING | SENDING | SENT | RETRY_SCHEDULED | EXPIRED | CANCELLED | FAILED | UNKNOWN
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  provider_message_id TEXT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE TABLE IF NOT EXISTS paper_orders (
  id TEXT PRIMARY KEY,
  signal_id TEXT,
  origin TEXT NOT NULL,          -- MANUAL | AUTO
  instrument TEXT NOT NULL,
  direction TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  status TEXT NOT NULL,          -- ACCEPTED | REJECTED
  reason TEXT,
  units REAL,
  fill_price REAL,
  fill_time INTEGER,
  quote TEXT
);

CREATE TABLE IF NOT EXISTS paper_positions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  signal_id TEXT,
  origin TEXT NOT NULL,
  instrument TEXT NOT NULL,
  direction TEXT NOT NULL,
  units REAL NOT NULL,
  entry REAL NOT NULL,
  sl REAL NOT NULL,
  tp REAL,
  status TEXT NOT NULL,          -- OPEN | CLOSED
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  exit_price REAL,
  exit_reason TEXT,
  realized_r REAL,
  realized_money REAL,
  costs TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS paper_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id TEXT,
  order_id TEXT,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS journal_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id TEXT,
  signal_id TEXT,
  at INTEGER NOT NULL,
  text TEXT NOT NULL,
  attachment TEXT
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  currency TEXT NOT NULL,
  impact TEXT,
  category TEXT,
  time INTEGER,
  all_day INTEGER NOT NULL DEFAULT 0,
  forecast TEXT,
  previous TEXT,
  actual TEXT,
  url TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS calendar_time ON calendar_events (time);

CREATE TABLE IF NOT EXISTS calendar_fetches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  coverage_from INTEGER,
  coverage_to INTEGER,
  count INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  dataset_id TEXT,
  data_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  config TEXT NOT NULL,
  meta TEXT,
  metrics TEXT,
  sensitivity TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS backtest_trades (
  run_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (run_id, idx)
);

CREATE TABLE IF NOT EXISTS heartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,           -- scan | quote | stream | calendar | telegram | engine | worker_tick
  at INTEGER NOT NULL,
  status TEXT NOT NULL,         -- ok | error | skipped
  detail TEXT
);
CREATE INDEX IF NOT EXISTS heartbeats_kind ON heartbeats (kind, at DESC);

CREATE TABLE IF NOT EXISTS engine_state (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS data_quality (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  dataset_id TEXT,
  instrument TEXT,
  type TEXT NOT NULL,
  detail TEXT
);

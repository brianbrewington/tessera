// Schema DDL. The full v2.1 table set ships from the start so later slices add logic,
// not migrations (spec §11: the schema seam — REFERENCES, frame_debt — ships now).
// `dim` is injected into the four vec0 tables (spec §3: vectors split by kind × tier,
// never co-mingled).

export function ddl(dim: number): string {
  if (!Number.isInteger(dim) || dim <= 0) throw new Error(`bad embedding dim: ${dim}`);
  return `
CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  subtype      TEXT,
  origin       TEXT NOT NULL,
  text         TEXT NOT NULL,                       -- pure identity/dedup basis (mapper-constructed)
  name         TEXT,                                -- first-class display name (decoupled from identity)
  description  TEXT,                                -- first-class self-contained description
  content_hash TEXT NOT NULL,
  strength     REAL NOT NULL DEFAULT 1,
  timestamp    INTEGER NOT NULL,
  provenance   TEXT,
  metadata     TEXT,
  last_observed      INTEGER,                       -- SOURCE nodes (spec §3), separate from strength
  observation_budget REAL,
  status       TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','durable')),
  pinned       INTEGER NOT NULL DEFAULT 0,
  frame_debt   INTEGER NOT NULL DEFAULT 0,          -- v3.1 §11 audit counter (PATTERN)
  version      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_nodes_content_hash ON nodes(content_hash);

CREATE TABLE IF NOT EXISTS edges (
  id              TEXT PRIMARY KEY,
  from_id         TEXT NOT NULL REFERENCES nodes(id),
  to_id           TEXT NOT NULL REFERENCES nodes(id),
  kind            TEXT NOT NULL,                     -- incl. REFERENCES (v3.1 back-ref)
  polarity        TEXT NOT NULL DEFAULT '',           -- '' = none; NULL would split UNIQUE dedup
  semantic_weight REAL NOT NULL DEFAULT 0,
  hebbian_weight  REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','durable')),
  version         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (from_id, to_id, kind, polarity)
);

CREATE TABLE IF NOT EXISTS edge_assertions (
  id             TEXT PRIMARY KEY,
  edge_id        TEXT NOT NULL REFERENCES edges(id),
  reason         TEXT NOT NULL,
  origin         TEXT NOT NULL,
  grounding      TEXT,
  expert_surprise INTEGER,
  status         TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','durable')),
  version        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS layout (
  node_id  TEXT PRIMARY KEY REFERENCES nodes(id),
  x        REAL NOT NULL,
  y        REAL NOT NULL,
  tile_id  TEXT,
  zoom_min INTEGER,
  version  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS mutation_log (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  effective_at INTEGER NOT NULL,
  actor        TEXT NOT NULL,
  cause        TEXT NOT NULL,
  op           TEXT NOT NULL,
  target_id    TEXT,
  before       TEXT,
  after        TEXT
);

CREATE TABLE IF NOT EXISTS breaker_state (
  origin          TEXT PRIMARY KEY,
  window_size     INTEGER NOT NULL DEFAULT 0,
  good_count      INTEGER NOT NULL DEFAULT 0,
  bad_count       INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'closed',
  last_transition INTEGER
);

CREATE TABLE IF NOT EXISTS pyramid (
  zoom          INTEGER NOT NULL,
  tile_id       TEXT NOT NULL,
  node_id       TEXT NOT NULL REFERENCES nodes(id),
  rank          INTEGER NOT NULL,
  promoted_from TEXT,
  PRIMARY KEY (zoom, tile_id, node_id)
);

-- Vectors: four tiers, split by kind × (quarantine|shared). Every embedding lands in a
-- quarantine table; a promote txn copies it to the matching shared table (spec §3, §5.2).
CREATE VIRTUAL TABLE IF NOT EXISTS vec_node_quarantine   USING vec0(node_id TEXT PRIMARY KEY, embedding float[${dim}]);
CREATE VIRTUAL TABLE IF NOT EXISTS vec_node_shared       USING vec0(node_id TEXT PRIMARY KEY, embedding float[${dim}]);
CREATE VIRTUAL TABLE IF NOT EXISTS vec_assert_quarantine USING vec0(assert_id TEXT PRIMARY KEY, embedding float[${dim}]);
CREATE VIRTUAL TABLE IF NOT EXISTS vec_assert_shared     USING vec0(assert_id TEXT PRIMARY KEY, embedding float[${dim}]);
`;
}

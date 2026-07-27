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

-- Chunk extraction memo: a CHUNK node id is inserted here only AFTER its extraction fully completed (parse
-- succeeded and the mapper finished). Re-ingest skips a chunk iff it's here — a chunk that started but crashed
-- mid-map is absent, so it retries (never silently frozen half-written). Parse-failures are absent too → retry.
CREATE TABLE IF NOT EXISTS extracted_chunks (
  chunk_id TEXT PRIMARY KEY REFERENCES nodes(id)
);

-- Ingest manifest: one row per SOURCE content hash (identity is path-free, so content_hash is the key). Records
-- the FILE-level ingest state so a whole-corpus re-run skips an unchanged doc with ZERO writes — a chunk-memo
-- hit still re-embeds and re-putNodes every chunk, so the file-level skip is what makes a re-run truly no-op.
-- status='complete' gates the skip; a 'partial' (a chunk parse-failed) row re-enters ingest so failures are
-- never frozen (the F1 review trap). A file that fails to READ writes no row at all → it retries as new next
-- run (correct, and simpler than a read_error state nothing could key by hash). path/title are metadata.
-- No liveness column: supersession is v1.5 (this v1 is additive).
CREATE TABLE IF NOT EXISTS ingest_sources (
  content_hash    TEXT PRIMARY KEY,
  path            TEXT,
  title           TEXT,
  status          TEXT NOT NULL DEFAULT 'complete',
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  parse_failures  INTEGER NOT NULL DEFAULT 0,
  extractor_model TEXT,
  ingested_at     INTEGER NOT NULL
);

-- Assertion provenance (FD3): which SOURCE/CHUNK node(s) grounded each edge assertion. SET-valued — several
-- chunks can assert the same relationship, so provenance accumulates across reinforcements (INSERT OR IGNORE),
-- never collapses to one. Recorded now even though liveness/retraction is v1.5: it is the enabler for that
-- work and is unrecoverable retroactively (a graph built without it can't be pruned without re-paying the LLM).
CREATE TABLE IF NOT EXISTS assertion_sources (
  assertion_id TEXT NOT NULL REFERENCES edge_assertions(id),
  source_id    TEXT NOT NULL,
  PRIMARY KEY (assertion_id, source_id)
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

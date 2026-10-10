-- Varysheet - initial schema (D1 / SQLite)
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-db --local|--remote

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- a "database" == a Notion table (collection of records with a shared schema)
CREATE TABLE IF NOT EXISTS databases (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT '📋',
  description TEXT NOT NULL DEFAULT '',
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_databases_owner ON databases(owner_id);

-- collaboration: other registered users invited to a database
CREATE TABLE IF NOT EXISTS database_members (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'editor', -- editor | viewer
  created_at  INTEGER NOT NULL,
  UNIQUE (database_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON database_members(user_id);

-- custom fields of a database (fully user defined: name + type + config + order)
CREATE TABLE IF NOT EXISTS properties (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  config      TEXT NOT NULL DEFAULT '{}',
  position    REAL NOT NULL DEFAULT 0,
  width       INTEGER NOT NULL DEFAULT 200,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_properties_database ON properties(database_id, position);

-- table rows; the cell values are stored as a JSON object keyed by property id
CREATE TABLE IF NOT EXISTS records (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  "values"    TEXT NOT NULL DEFAULT '{}',
  position    REAL NOT NULL DEFAULT 0,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_database ON records(database_id, position);

-- saved views (table / board / gallery) with filters, sorts and grouping
CREATE TABLE IF NOT EXISTS views (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'table',
  config      TEXT NOT NULL DEFAULT '{}',
  position    REAL NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_views_database ON views(database_id, position);

-- public share links
CREATE TABLE IF NOT EXISTS shares (
  id          TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  permission  TEXT NOT NULL DEFAULT 'view', -- view | edit
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_database ON shares(database_id);

-- uploaded objects (metadata for the R2 blob)
CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  database_id TEXT REFERENCES databases(id) ON DELETE CASCADE,
  record_id   TEXT,
  property_id TEXT,
  r2_key      TEXT NOT NULL,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  mime        TEXT NOT NULL DEFAULT 'application/octet-stream',
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_database ON files(database_id);

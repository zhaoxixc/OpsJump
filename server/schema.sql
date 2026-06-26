CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  real_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS login_locks (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  fail_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shortcuts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#2563eb',
  category TEXT NOT NULL DEFAULT '默认',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS network_logs (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  port INTEGER,
  operator TEXT NOT NULL DEFAULT 'system',
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shortcuts_sort ON shortcuts(sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_network_logs_tool_created ON network_logs(tool, created_at);
CREATE INDEX IF NOT EXISTS idx_login_locks_username ON login_locks(username);

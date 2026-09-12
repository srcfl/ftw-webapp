CREATE TABLE github_snapshots (
  repo TEXT NOT NULL,
  captured_hour TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  stars INTEGER NOT NULL CHECK (stars >= 0),
  forks INTEGER NOT NULL CHECK (forks >= 0),
  watchers INTEGER NOT NULL CHECK (watchers >= 0),
  open_prs INTEGER NOT NULL CHECK (open_prs >= 0),
  draft_prs INTEGER NOT NULL CHECK (draft_prs >= 0),
  dependency_prs INTEGER NOT NULL CHECK (dependency_prs >= 0),
  open_issues INTEGER NOT NULL CHECK (open_issues >= 0),
  merged_prs_30d INTEGER NOT NULL CHECK (merged_prs_30d >= 0),
  closed_issues_30d INTEGER NOT NULL CHECK (closed_issues_30d >= 0),
  contributors INTEGER NOT NULL CHECK (contributors >= 0),
  pushed_at TEXT,
  latest_release TEXT,
  latest_release_at TEXT,
  PRIMARY KEY (repo, captured_hour)
);

CREATE INDEX github_snapshots_by_time
  ON github_snapshots (captured_hour DESC);

CREATE TABLE github_traffic_daily (
  repo TEXT NOT NULL,
  date TEXT NOT NULL,
  views INTEGER NOT NULL CHECK (views >= 0),
  unique_visitors INTEGER NOT NULL CHECK (unique_visitors >= 0),
  clones INTEGER NOT NULL CHECK (clones >= 0),
  unique_cloners INTEGER NOT NULL CHECK (unique_cloners >= 0),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (repo, date)
);

CREATE TABLE github_referrers (
  repo TEXT NOT NULL,
  date TEXT NOT NULL,
  referrer TEXT NOT NULL,
  visits INTEGER NOT NULL CHECK (visits >= 0),
  unique_visitors INTEGER NOT NULL CHECK (unique_visitors >= 0),
  PRIMARY KEY (repo, date, referrer)
);

CREATE TABLE github_paths (
  repo TEXT NOT NULL,
  date TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  views INTEGER NOT NULL CHECK (views >= 0),
  unique_visitors INTEGER NOT NULL CHECK (unique_visitors >= 0),
  PRIMARY KEY (repo, date, path)
);

CREATE TABLE site_traffic_daily (
  date TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  requests INTEGER NOT NULL CHECK (requests >= 0),
  visits INTEGER NOT NULL CHECK (visits >= 0),
  response_bytes INTEGER NOT NULL CHECK (response_bytes >= 0),
  sample_interval REAL NOT NULL CHECK (sample_interval >= 1),
  observed_at TEXT NOT NULL
);

CREATE TABLE relay_snapshots (
  observed_at TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  uptime_seconds INTEGER NOT NULL CHECK (uptime_seconds >= 0),
  rooms INTEGER NOT NULL CHECK (rooms >= 0),
  sockets INTEGER NOT NULL CHECK (sockets >= 0),
  frames_routed INTEGER NOT NULL CHECK (frames_routed >= 0),
  bytes_routed INTEGER NOT NULL CHECK (bytes_routed >= 0)
);

CREATE INDEX relay_snapshots_by_time
  ON relay_snapshots (observed_at DESC);

CREATE TABLE fleet_daily (
  date TEXT PRIMARY KEY,
  reports INTEGER NOT NULL CHECK (reports >= 0),
  dimensions_json TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE TABLE collector_runs (
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  detail TEXT NOT NULL,
  PRIMARY KEY (source, started_at)
);

CREATE INDEX collector_runs_latest
  ON collector_runs (source, finished_at DESC);

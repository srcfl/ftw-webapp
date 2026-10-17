-- Only already-public group cells. No home ids or household values.
CREATE TABLE usage_snapshots (
  captured_hour TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL,
  view_json TEXT NOT NULL
);

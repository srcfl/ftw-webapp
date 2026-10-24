-- FTW Cloud's own hours: sums over the whole service, never a home, device or address.
CREATE TABLE cloud_ops_hours (
 shard TEXT NOT NULL,
 hour TEXT NOT NULL,
 seconds INTEGER NOT NULL,
 starts INTEGER NOT NULL,
 counters_json TEXT NOT NULL,
 gauges_json TEXT NOT NULL,
 latency_json TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 PRIMARY KEY (shard, hour)
);
-- The latest exact totals of closed fleet and energy report days, for the
-- private view; never a report or an id.
CREATE TABLE cloud_ops_days (
 id INTEGER PRIMARY KEY CHECK(id=1),
 observed_at TEXT NOT NULL,
 fleet_json TEXT NOT NULL,
 energy_json TEXT NOT NULL
);

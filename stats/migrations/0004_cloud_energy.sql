-- Latest public daily energy report totals only; never a single report.
CREATE TABLE cloud_energy_view (
 id INTEGER PRIMARY KEY CHECK(id=1),
 observed_at TEXT NOT NULL,
 view_json TEXT NOT NULL
);

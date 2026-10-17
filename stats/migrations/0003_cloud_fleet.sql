-- Latest public daily cells only; never household reports or ids.
CREATE TABLE cloud_fleet_view (
 id INTEGER PRIMARY KEY CHECK(id=1),
 observed_at TEXT NOT NULL,
 view_json TEXT NOT NULL
);

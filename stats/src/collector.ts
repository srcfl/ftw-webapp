export async function saveCollectorRun(
  db: D1Database,
  source: string,
  startedAt: string,
  ok: boolean,
  detail: string
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO collector_runs
        (source, started_at, finished_at, ok, detail)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(source, startedAt, new Date().toISOString(), ok ? 1 : 0, detail)
    .run()
}

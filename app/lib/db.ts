import { neon } from "@neondatabase/serverless";

// Edge-safe singleton. All SQL goes through Neon; no local Postgres.
let _sql: ReturnType<typeof neon> | null = null;

export function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL missing");
    _sql = neon(url);
  }
  return _sql;
}

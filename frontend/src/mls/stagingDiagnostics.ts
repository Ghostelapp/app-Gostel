export async function recordStagingCheck(result: string) {
  const SQLite = await import('expo-sqlite');
  const db = await SQLite.openDatabaseAsync('ghostel-mls-diagnostics.db');
  try {
    await db.execAsync('CREATE TABLE IF NOT EXISTS results (id INTEGER PRIMARY KEY, result TEXT NOT NULL)');
    await db.runAsync('INSERT INTO results(result) VALUES (?)', result);
  } finally { await db.closeAsync(); }
}

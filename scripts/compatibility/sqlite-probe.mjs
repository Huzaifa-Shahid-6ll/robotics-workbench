import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const database = new DatabaseSync(':memory:');
database.exec('CREATE TABLE probe (value INTEGER NOT NULL); INSERT INTO probe VALUES (42)');
assert.equal(database.prepare('SELECT value FROM probe').get().value, 42);
const version = database.prepare('SELECT sqlite_version() AS version').get().version;
database.close();
await writeFile('artifacts/compatibility/sqlite.json', JSON.stringify({
  passed: true, runtime: process.execPath, node: process.version, sqlite: version,
  scope: 'In-memory native runtime probe only; not persistence, migrations or packaged serial verification.'
}, null, 2)+'\n');
console.log(`Node native SQLite ${version}: in-memory probe passed.`);

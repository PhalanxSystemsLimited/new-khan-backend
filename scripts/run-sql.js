// Runs a .sql file against DATABASE_URL: node scripts/run-sql.js db/seed-dev.sql
import fs from 'node:fs';
import { pool } from '../src/config/db.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/run-sql.js <file.sql>');
  process.exit(1);
}
try {
  await pool.query(fs.readFileSync(file, 'utf8'));
  console.log(`Ran ${file}`);
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

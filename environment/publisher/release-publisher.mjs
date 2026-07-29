#!/usr/bin/env node

import duckdb from "duckdb";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, "..", "releases.duckdb");

function run(connection, sql) {
  return new Promise((resolve, reject) => {
    connection.run(sql, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

async function initializeDatabase() {
  const db = new duckdb.Database(DB_PATH);
  const connection = db.connect();

  await run(
    connection,
    `
      CREATE TABLE IF NOT EXISTS publication_receipts (
        publication_id TEXT,
        request_token TEXT PRIMARY KEY,
        bundle_id TEXT,
        status TEXT
      );
    `
  );

  connection.close();

  console.log("✓ Database initialized");
}

async function main() {
  console.log("Release Publisher");

  await initializeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
#!/usr/bin/env node

import duckdb from "duckdb";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, "..", "releases.duckdb");
const CSV_PATH = path.join(__dirname, "..", "fixtures", "build_manifest.csv");

function run(connection, sql) {
  return new Promise((resolve, reject) => {
    connection.run(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function all(connection, sql) {
  return new Promise((resolve, reject) => {
    connection.all(sql, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

async function initializeDatabase(connection) {
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
}

async function loadManifest(connection) {
  await run(connection, `DROP TABLE IF EXISTS build_manifest;`);

  await run(
    connection,
    `
    CREATE TABLE build_manifest AS
    SELECT *
    FROM read_csv_auto('${CSV_PATH.replace(/\\/g, "/")}', HEADER=TRUE);
    `
  );

const rows = await all(
  connection,
  `
  SELECT COUNT(*) AS total_rows
  FROM build_manifest;
  `
);



 console.log(`✓ Loaded ${rows[0].total_rows} manifest rows`);
}

async function main() {
  console.log("Release Publisher");

  const db = new duckdb.Database(DB_PATH);
  const connection = db.connect();

  await initializeDatabase(connection);

  console.log("✓ Database initialized");

  await loadManifest(connection);

  connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
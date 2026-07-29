#!/usr/bin/env node

import duckdb from "duckdb";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, "..", "releases.duckdb");
const CSV_PATH = path.join(__dirname, "..", "fixtures", "build_manifest.csv");

const GATEWAY_URL = "http://127.0.0.1:7070";
const CURRENT_KEY_URL = `${GATEWAY_URL}/v1/signing-key/current`;
const PUBLICATIONS_URL = `${GATEWAY_URL}/v1/publications`;

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
      if (err) reject(err);
      else resolve(rows);
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

  console.log("✓ Database initialized");
}

async function loadManifest(connection) {
  await run(connection, `DROP VIEW IF EXISTS active_builds;`);
  await run(connection, `DROP TABLE IF EXISTS build_manifest;`);

  await run(
    connection,
    `
    CREATE TABLE build_manifest AS
    SELECT *
    FROM read_csv_auto('${CSV_PATH.replace(/\\/g, "/")}', HEADER=TRUE);
    `
  );

  await run(
    connection,
    `
    CREATE VIEW active_builds AS
    WITH deduplicated AS (
      SELECT DISTINCT *
      FROM build_manifest
    )
    SELECT *
    FROM deduplicated
    WHERE record_type = 'BUILD'
      AND entry_id NOT IN (
        SELECT supersedes_id
        FROM deduplicated
        WHERE record_type='WITHDRAWAL'
          AND supersedes_id IS NOT NULL
      );
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

async function getPublishableBundles(connection) {
  const bundles = await all(
    connection,
    `
    SELECT
      bundle_id,
      COUNT(*) AS artifact_count,
      SUM(size_bytes) AS total_bytes
    FROM active_builds
    GROUP BY bundle_id
    ORDER BY bundle_id;
    `
  );

  return bundles.map((bundle) => ({
    bundle_id: bundle.bundle_id,
    artifact_count: Number(bundle.artifact_count),
    total_bytes: Number(bundle.total_bytes),
  }));
}

async function printPublishableBundles(connection) {
  const bundles = await getPublishableBundles(connection);

  console.log("\nPublishable Bundles");
  console.table(bundles);
}

async function getBundleBuilds(connection, bundleId) {
  const rows = await all(
    connection,
    `
    SELECT
      entry_id,
      component_id,
      version,
      size_bytes,
      recorded_at
    FROM active_builds
    WHERE bundle_id='${bundleId}'
    ORDER BY component_id, version, entry_id;
    `
  );

  return rows.map((row) => ({
    ...row,
    size_bytes: Number(row.size_bytes),
  }));
}

async function inspectBundle(connection, bundleId) {
  const builds = await getBundleBuilds(connection, bundleId);

  console.log(`\n${bundleId} Builds`);
  console.table(builds);
  console.log(`Total: ${builds.length}`);
}

async function main() {
  console.log("Release Publisher");

  const db = new duckdb.Database(DB_PATH);
  const connection = db.connect();

  await initializeDatabase(connection);
  await loadManifest(connection);

  await printPublishableBundles(connection);

  // Temporary inspection
  await inspectBundle(connection, "BND-101");

  connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
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








async function getCurrentSigningKey() {
  const response = await fetch(CURRENT_KEY_URL);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch signing key (${response.status})`
    );
  }

  return response.json();
}



// step 2 


function createDescriptor(bundle) {
  return JSON.stringify({
    artifact_count: bundle.artifact_count,
    bundle_id: bundle.bundle_id,
    total_bytes: bundle.total_bytes,
  });
}


import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function signDescriptor(descriptor) {
  const id = crypto.randomUUID();

  const descriptorFile = path.join(os.tmpdir(), `${id}.bin`);
  const signatureFile = path.join(os.tmpdir(), `${id}.pem`);

  await fs.writeFile(descriptorFile, descriptor, "utf8");

  await execFileAsync("openssl", [
    "cms",
    "-sign",
    "-in",
    descriptorFile,
    "-signer",
    "/app/keys/current/current.cert.pem",
    "-inkey",
    "/app/keys/current/current.key.pem",
    "-outform",
    "PEM",
    "-binary",
    "-out",
    signatureFile,
  ]);

  const signature = await fs.readFile(signatureFile, "utf8");

  await fs.rm(descriptorFile, { force: true });
  await fs.rm(signatureFile, { force: true });

  return signature;
}


async function publishDescriptor(descriptor, signature, requestToken) {
  const response = await fetch(PUBLICATIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      descriptor,
      signature,
      request_token: requestToken,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Gateway returned ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}



async function saveReceipt(connection, receipt, bundleId) {
  await run(
    connection,
    `
    INSERT INTO publication_receipts (
      publication_id,
      request_token,
      bundle_id,
      status
    )
    VALUES (
      '${receipt.publication_id}',
      '${receipt.request_token}',
      '${bundleId}',
      '${receipt.status}'
    );
    `
  );
}



async function getReceipt(connection, requestToken) {
  const rows = await all(
    connection,
    `
    SELECT
      publication_id,
      request_token,
      status
    FROM publication_receipts
    WHERE request_token='${requestToken}';
    `
  );

  return rows.length ? rows[0] : null;
}

























// async function main() {
//   console.log("Release Publisher");

//   const db = new duckdb.Database(DB_PATH);
//   const connection = db.connect();

//   await initializeDatabase(connection);
//   await loadManifest(connection);

//   await printPublishableBundles(connection);

//   // Temporary inspection
//   await inspectBundle(connection, "BND-101");

//   connection.close();
// }


async function main() {
  

  const db = new duckdb.Database(DB_PATH);
  const connection = db.connect();

  await initializeDatabase(connection);
  await loadManifest(connection);

  const signingKey = await getCurrentSigningKey();

  

  const bundles = await getPublishableBundles(connection);

  

 for (const bundle of bundles) {
  const requestToken = `token-${bundle.bundle_id}`;

  let receipt = await getReceipt(connection, requestToken);

  if (!receipt) {
    const descriptor = createDescriptor(bundle);

    const signature = await signDescriptor(descriptor);

    receipt = await publishDescriptor(
      descriptor,
      signature,
      requestToken
    );

    await saveReceipt(
      connection,
      receipt,
      bundle.bundle_id
    );
  }

  console.log(
  `BUNDLE ${bundle.bundle_id} SIGNED KEY=${signingKey.key_id}`
);

console.log(
  `BUNDLE ${bundle.bundle_id} PUBLISHED RECEIPT=${receipt.publication_id} TOKEN=${receipt.request_token} STATUS=${receipt.status}`
);
}

  connection.close();
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
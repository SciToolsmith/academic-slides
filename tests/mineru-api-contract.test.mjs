#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, prepareSourceMineru } from "../scripts/prepare-source-mineru.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures", "mineru-v1-v2");
const SOURCE_PATH = path.join(FIXTURE_DIR, "sample_origin.pdf");

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function binaryResponse(bytes, status = 200) {
  const buffer = Buffer.from(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() { return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength); },
  };
}

async function copyFixtureTo(destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(FIXTURE_DIR, { withFileTypes: true })) {
    await fs.cp(path.join(FIXTURE_DIR, entry.name), path.join(destination, entry.name), { recursive: true });
  }
}

async function testUploadContract() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "academic-slides-mineru-api-"));
  const secret = "test-secret-that-must-not-be-persisted";
  try {
    const outputDir = path.join(temporary, "normalized");
    const cacheDir = path.join(temporary, "cache");
    let networkCalls = 0;
    await assert.rejects(() => prepareSourceMineru({
      source: SOURCE_PATH,
      outputDir,
      cacheDir,
      modelVersion: "vlm",
    }, {
      env: { ACADEMIC_SLIDES_MINERU_TEST: secret },
      fetch: async () => { networkCalls += 1; throw new Error("network must not run"); },
    }), /--confirm-upload/);
    assert.equal(networkCalls, 0);

    const calls = [];
    const logs = [];
    let pollCount = 0;
    const fetchMock = async (url, init = {}) => {
      const call = { url, method: init.method ?? "GET", headers: init.headers ?? null, body: init.body ?? null };
      calls.push(call);
      if (url === "https://mineru.net/api/v4/file-urls/batch") {
        const body = JSON.parse(init.body);
        assert.deepEqual(body.extra_formats, []);
        assert.equal(body.model_version, "vlm");
        assert.equal(body.enable_formula, true);
        assert.equal(body.enable_table, true);
        assert.equal(init.headers.Authorization, `Bearer ${secret}`);
        return jsonResponse({ code: 0, data: { batch_id: "batch-fixture", file_urls: ["https://signed-upload.invalid/object"] } });
      }
      if (url === "https://signed-upload.invalid/object") {
        assert.equal(init.method, "PUT");
        assert.equal("Content-Type" in init.headers, false);
        assert.equal(Number(init.headers["Content-Length"]), (await fs.stat(SOURCE_PATH)).size);
        for await (const _chunk of init.body) { /* consume the source stream in the mock */ }
        return { ok: true, status: 200 };
      }
      if (url === "https://mineru.net/api/v4/extract-results/batch/batch-fixture") {
        pollCount += 1;
        assert.equal(init.headers.Authorization, `Bearer ${secret}`);
        if (pollCount === 1) return jsonResponse({ code: 0, data: { extract_result: [{ state: "running" }] } });
        return jsonResponse({ code: 0, data: { extract_result: [{ state: "done", full_zip_url: "https://signed-download.invalid/result.zip" }] } });
      }
      if (url === "https://signed-download.invalid/result.zip") return binaryResponse("fixture-zip");
      throw new Error("unexpected mocked URL");
    };
    const result = await prepareSourceMineru({
      source: SOURCE_PATH,
      outputDir,
      cacheDir,
      modelVersion: "vlm",
      language: "ch",
      confirmUpload: true,
      tokenEnv: "ACADEMIC_SLIDES_MINERU_TEST",
      pollMs: 1,
      maxWaitMs: 100,
    }, {
      env: { ACADEMIC_SLIDES_MINERU_TEST: secret },
      fetch: fetchMock,
      sleep: async () => {},
      now: (() => { let value = 0; return () => value += 10; })(),
      logger: (message) => logs.push(message),
      extractZip: async (_zipPath, destination) => copyFixtureTo(destination),
    });
    assert.equal(result.cached, false);
    assert.equal(pollCount, 2);
    assert.equal(calls.length, 5);
    const persisted = (await Promise.all((await fs.readdir(outputDir)).map((filename) => fs.readFile(path.join(outputDir, filename), "utf8")))).join("\n");
    assert.equal(persisted.includes(secret), false);
    assert.equal(persisted.includes("signed-upload.invalid"), false);
    assert.equal(persisted.includes("signed-download.invalid"), false);
    assert.equal(persisted.includes("Authorization"), false);
    assert.equal(logs.join("\n").includes(secret), false);
    assert.equal(logs.join("\n").includes("signed-"), false);
    const record = JSON.parse(await fs.readFile(path.join(outputDir, "extraction-record.json"), "utf8"));
    assert.equal(record.api.credential_env, "ACADEMIC_SLIDES_MINERU_TEST");
    assert.equal(record.api.credential_persisted, false);
    assert.equal(record.api.signed_urls_persisted, false);
    assert.deepEqual(record.parameters.extra_formats, []);

    const cached = await prepareSourceMineru({
      source: SOURCE_PATH,
      outputDir,
      cacheDir,
      modelVersion: "vlm",
      language: "ch",
      confirmUpload: true,
      tokenEnv: "ACADEMIC_SLIDES_MINERU_TEST",
    }, {
      env: { ACADEMIC_SLIDES_MINERU_TEST: secret },
      fetch: async () => { throw new Error("cache hit must not call network"); },
    });
    assert.equal(cached.cached, true);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function testCliCredentialBoundary() {
  assert.throws(() => parseArgs(["--token", "literal-secret"]), /Token values are not accepted/);
  assert.throws(() => parseArgs(["--api-token=literal-secret"]), /Token values are not accepted/);
  const parsed = parseArgs(["--token-env", "MY_MINERU_TOKEN", "--confirm-upload"]);
  assert.equal(parsed.tokenEnv, "MY_MINERU_TOKEN");
  assert.equal(parsed.confirmUpload, true);
}

testCliCredentialBoundary();
await testUploadContract();
console.log("PASS mineru-api-contract: explicit upload consent, env-only credentials, signed upload/poll/download, safe persistence, and cache reuse are enforced.");

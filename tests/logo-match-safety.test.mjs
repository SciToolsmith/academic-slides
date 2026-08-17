#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findUniversityLogos } from "../scripts/find-university-logo.mjs";

const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "academic-slides-logo-test-"));
const rawDir = path.join(fixtureDir, "raw");
const catalog = path.join(fixtureDir, "catalog.json");

try {
  await mkdir(rawDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(rawDir, "peking.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>'),
    writeFile(path.join(rawDir, "beihang.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>'),
  ]);
  await writeFile(catalog, JSON.stringify({
    root: ".",
    logos: [
      {
        id: "peking",
        school_name: "北京大学",
        aliases: ["Peking University"],
        file: "raw/peking.svg",
        format: "svg",
        source: { verification_status: "unverified" },
      },
      {
        id: "beihang",
        school_name: "北京航空航天大学",
        aliases: ["北航"],
        file: "raw/beihang.svg",
        format: "svg",
        source: { verification_status: "unverified" },
      },
    ],
  }, null, 2));

  const exact = await findUniversityLogos("北京大学", catalog);
  assert.equal(exact.results[0]?.school_name, "北京大学");
  assert.equal(exact.results[0]?.verification?.usable_without_verification, false);

  const missing = await findUniversityLogos("南京航空航天大学", catalog);
  assert.equal(missing.results.length, 0, "Default lookup must not substitute a similar institution.");

  const provisional = await findUniversityLogos("南京航空航天大学", catalog, { exact: false });
  assert.equal(provisional.results[0]?.school_name, "北京航空航天大学");
  assert.equal(provisional.results[0]?.verification?.status, "candidate-only");
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}

console.log("PASS logo-match-safety: exact matching is default and fuzzy results remain provisional.");

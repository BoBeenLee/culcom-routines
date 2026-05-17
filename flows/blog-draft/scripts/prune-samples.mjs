#!/usr/bin/env node
// samples/naver/*.md 를 frontmatter 의 pubDate 내림차순으로 정렬해
// 상위 WINDOW 개만 유지하고, 나머지는 samples/naver/archive/ 로 이동한다.
// rolling window 코퍼스 관리용 — corpus-refresh.yml cron 마지막 단계에서 호출.
//
// 사용:
//   node flows/blog-draft/scripts/prune-samples.mjs [--window 15] [--dry-run]
//
// 디렉터리만 처리하고 archive/ 하위는 재진입하지 않는다.

import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FLOW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLES_DIR = path.join(FLOW_DIR, "prompts/samples/naver");
const ARCHIVE_DIR = path.join(SAMPLES_DIR, "archive");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const WINDOW = parseInt(arg("--window") || "15", 10);
const DRY_RUN = process.argv.includes("--dry-run");

if (!Number.isFinite(WINDOW) || WINDOW < 1) {
  console.error(`invalid --window: ${WINDOW}`);
  process.exit(2);
}

function parsePubDate(md) {
  const m = md.match(/^-\s*pubDate:\s*(\d{4}-\d{2}-\d{2})/m);
  return m ? m[1] : "";
}

async function listSampleFiles() {
  const entries = await readdir(SAMPLES_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name);
}

async function main() {
  const files = await listSampleFiles();
  const rows = [];
  for (const name of files) {
    const full = path.join(SAMPLES_DIR, name);
    const md = await readFile(full, "utf8");
    const pubDate = parsePubDate(md);
    rows.push({ name, pubDate });
  }
  // pubDate 내림차순. 빈 pubDate 는 가장 오래된 것으로 취급.
  rows.sort((a, b) => (b.pubDate || "0000-00-00").localeCompare(a.pubDate || "0000-00-00"));

  const keep = rows.slice(0, WINDOW);
  const evict = rows.slice(WINDOW);

  console.log(`window=${WINDOW} total=${rows.length} keep=${keep.length} evict=${evict.length}`);
  if (!evict.length) {
    console.log("nothing to archive.");
    return;
  }

  if (!DRY_RUN) await mkdir(ARCHIVE_DIR, { recursive: true });

  for (const row of evict) {
    const src = path.join(SAMPLES_DIR, row.name);
    const dst = path.join(ARCHIVE_DIR, row.name);
    if (DRY_RUN) {
      console.log(`[dry] would move ${row.pubDate || "(no date)"} ${row.name} → archive/`);
      continue;
    }
    await rename(src, dst);
    console.log(`[move] ${row.pubDate || "(no date)"} ${row.name} → archive/`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

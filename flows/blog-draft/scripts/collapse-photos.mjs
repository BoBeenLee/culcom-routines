#!/usr/bin/env node
// 이슈 본문의 "### 사진 (이 영역에 드래그&드롭) — 필수" 섹션 내용을
// <details><summary>📷 첨부 사진 N장 (펼치기)</summary>...</details> 로 감싼다.
// 사진이 많은 이슈에서 본문이 길어지지 않도록.
//
// idempotent: 이미 <details> 로 감싸져 있으면 아무것도 하지 않는다 (workflow
// 가 본문을 edit 하면 issues:edited 가 한 번 더 트리거되지만, concurrency 큐
// + drafted 라벨 가드 + 이 step 의 idempotence 로 무한 루프 방지).
//
// 환경변수:
//   ISSUE_NUMBER (필수)
//   GH_TOKEN     (필수, gh CLI 가 사용)

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const issueNumber = process.env.ISSUE_NUMBER;
if (!issueNumber) {
  console.error("[collapse-photos] ISSUE_NUMBER env 가 비어있다.");
  process.exit(2);
}

const PHOTO_HEADER = "### 사진 (이 영역에 드래그&드롭) — 필수";
const SUMMARY_PREFIX = "📷 첨부 사진";

function gh(args, opts = {}) {
  const r = spawnSync("gh", args, { encoding: "utf8", ...opts });
  if (r.status !== 0) {
    throw new Error(`gh ${args.join(" ")} 실패 (exit ${r.status}): ${r.stderr}`);
  }
  return r.stdout;
}

const body = gh(["issue", "view", issueNumber, "--json", "body", "--jq", ".body"]);

// 이미 감싸져 있나? — 사진 헤더 직후에 <details> 가 등장하면 skip.
const headerIdx = body.indexOf(PHOTO_HEADER);
if (headerIdx < 0) {
  console.log("[collapse-photos] 사진 헤더 없음 — skip");
  process.exit(0);
}

const afterHeader = body.slice(headerIdx + PHOTO_HEADER.length);
// 다음 ### 헤더 또는 본문 끝까지가 사진 섹션.
const nextHeaderMatch = afterHeader.match(/\n###\s+/);
const sectionEndOffset = nextHeaderMatch ? nextHeaderMatch.index : afterHeader.length;
const rawSection = afterHeader.slice(0, sectionEndOffset);

// 이미 <details><summary>📷 ... 패턴이 있으면 끝.
if (/<details>\s*\n\s*<summary>📷/.test(rawSection)) {
  console.log("[collapse-photos] 이미 <details> 로 감싸짐 — skip");
  process.exit(0);
}

const sectionTrimmed = rawSection.trim();
if (!sectionTrimmed) {
  console.log("[collapse-photos] 사진 섹션 비어있음 — skip");
  process.exit(0);
}

// 이미지 개수 추정 — <img> + ![](url) 둘 다 카운트
const imgCount =
  (sectionTrimmed.match(/<img[^>]+>/gi) || []).length +
  (sectionTrimmed.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length;

const beforeSection = body.slice(0, headerIdx + PHOTO_HEADER.length);
const restOfBody = afterHeader.slice(sectionEndOffset);

const wrapped = [
  "",
  "",
  "<details>",
  `<summary>${SUMMARY_PREFIX} ${imgCount}장 (펼치기)</summary>`,
  "",
  sectionTrimmed,
  "",
  "</details>",
  "",
].join("\n");

const newBody = beforeSection + wrapped + restOfBody;

if (newBody === body) {
  console.log("[collapse-photos] 변경 없음 — skip");
  process.exit(0);
}

const tmp = mkdtempSync(path.join(tmpdir(), "issue-body-"));
const bodyFile = path.join(tmp, "body.md");
writeFileSync(bodyFile, newBody, "utf8");

gh(["issue", "edit", issueNumber, "--body-file", bodyFile], { stdio: "inherit" });
console.log(`[collapse-photos] 이슈 #${issueNumber} 본문 사진 섹션 (${imgCount}장)을 <details> 로 감쌈`);

#!/usr/bin/env node
// importer 출력에서 culcom- 블로그가 다지점 글을 섞어 올릴 가능성에 대비해,
// "하남" / "미사" 키워드가 본문 또는 제목에 포함된 logNo 만 통과시킨다.
// corpus-refresh.yml 의 detect → migrate 사이에 끼워 쓴다.
//
// 사용:
//   node flows/blog-draft/scripts/filter-hanam-logNos.mjs \
//     --in /tmp/naver-import --logNos a,b,c
//
// stdout : 필터 통과한 logNo 만 comma 로 join (트레일링 newline 없음)
// stderr : 진단 로그 (workflow 에서 echo 됨)
//
// 매칭 전략: importer 가 생성한 logNo 별 markdown (제목 H1 + 본문) 전체에
// 정규식 /하남|미사/ 매칭. title-only 로 좁히면 일부 정상 하남글이 누락된다
// (예: logNo 224249814155 "해외영업 직장인의 영어회화 스터디 도전기" — 본문엔
// 하남/미사 모두 등장하지만 제목엔 없음).

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const IN_DIR = path.resolve(arg("--in") || "/tmp/naver-import");
const logNos = (arg("--logNos") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PATTERN = /하남|미사/;

if (!logNos.length) {
  // 빈 입력 → 빈 출력. detect 단계가 비어있을 때 정상 흐름.
  process.exit(0);
}

let inFiles;
try {
  inFiles = (await readdir(IN_DIR)).filter((f) => f.endsWith(".md"));
} catch (e) {
  console.error(`[filter] importer 출력 디렉터리 읽기 실패: ${IN_DIR} (${e.code || e.message})`);
  process.exit(0);
}

// migrate-from-importer.mjs:findFileForLogNo 와 동일한 검출 규약 (assets/{logNo}/ 참조).
async function findTextForLogNo(logNo) {
  for (const f of inFiles) {
    const text = await readFile(path.join(IN_DIR, f), "utf8");
    if (text.includes(`assets/${logNo}/`)) return { file: f, text };
  }
  return null;
}

const passed = [];
for (const ln of logNos) {
  const found = await findTextForLogNo(ln);
  if (!found) {
    console.error(`[filter] ${ln}: importer 출력에 없음 → skip`);
    continue;
  }
  if (PATTERN.test(found.text)) {
    passed.push(ln);
    console.error(`[filter] ${ln}: 하남/미사 매칭 → keep (${found.file})`);
  } else {
    console.error(`[filter] ${ln}: 하남/미사 매칭 없음 → drop (${found.file})`);
  }
}

console.error(`[filter] in=${logNos.length} kept=${passed.length} dropped=${logNos.length - passed.length}`);
process.stdout.write(passed.join(","));

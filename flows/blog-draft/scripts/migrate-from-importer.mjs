#!/usr/bin/env node
// naver-blog-importer 출력을 samples/naver/{logNo}.md 형식으로 옮긴다.
// - 메타 헤더(pubDate/url/logNo) 추가
// - 본문은 importer 가 만든 마크다운 그대로 유지
// - `![](assets/{logNo}/img_NNN.{ext})` 와 `[![](assets/...)](url)` 을
//   `[이미지 #N: TBD]` 마커로 교체. N 은 본문 등장 순서 (NNN 이 아님 — 나중에
//   사람이 직접 이미지를 보고 묘사를 채워 넣을 때 #N 만 보면 되도록).
//
// 사용:
//   node flows/blog-draft/scripts/migrate-from-importer.mjs \
//     --in /tmp/naver-import \
//     --logNos 224241400842,224249814155,...
//
// 주의: 기존 prompts/samples/naver/*.md 를 덮어쓴다.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FLOW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(FLOW_DIR, "prompts/samples/naver");
const BLOG_ID = "culcom-";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const IN_DIR = path.resolve(arg("--in") || "/tmp/naver-import");
const targetLogNos = (arg("--logNos") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (!targetLogNos.length) {
  console.error("사용: --in <importerDir> --logNos a,b,c");
  process.exit(2);
}

async function findFileForLogNo(logNo) {
  const files = (await readdir(IN_DIR)).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const text = await readFile(path.join(IN_DIR, f), "utf8");
    if (text.includes(`assets/${logNo}/`)) return { file: f, text };
  }
  return null;
}

// 본문에서 이미지 마크다운을 등장 순서대로 `[이미지 #N: TBD]` 로 교체.
// 단일 pass + alternation 으로 본문 등장 순서대로 번호 부여.
// 처리하는 패턴 (alternation 순서 중요 — 더 긴 패턴 먼저):
// 1. `[![](assets/{logNo}/img_NNN.ext)](url)`  ← 링크에 감싼 이미지
// 2. `![](assets/{logNo}/img_NNN.ext)`         ← 단독 이미지
function replaceImageRefs(body, logNo) {
  let n = 0;
  const re = new RegExp(
    [
      `\\[!\\[[^\\]]*\\]\\(assets/${logNo}/img_\\d+\\.[a-z0-9]+\\)\\]\\([^)]*\\)`,
      `!\\[[^\\]]*\\]\\(assets/${logNo}/img_\\d+\\.[a-z0-9]+\\)`,
    ].join("|"),
    "g",
  );
  body = body.replace(re, () => `[이미지 #${++n}: TBD]`);
  return { body, count: n };
}

// importer 출력의 카드형 chrome 블록을 placeholder 로 치환.
// raw chrome (`[**카카오톡** ... pf-link.kakao.com](url)`) 은 Naver 에디터가
// 자동 생성하는 위젯이라 reference 샘플에 그대로 두면 LLM 이 학습해서
// draft 가 같은 chrome 을 출력하게 된다. 운영자가 네이버 에디터에서 카드를
// 직접 삽입할 자리만 표시되도록 placeholder 로 치환한다.
function replaceWidgetChrome(md) {
  return md
    .replace(/\[\*\*카카오톡\*\*[^\]]*?pf-link\.kakao\.com\]\([^)]+\)/g, "[카카오톡 카드]")
    .replace(/\[\*\*컬컴 하남점\*\*[^\]]*?\]\(#\)/g, "[매장 박스]")
    .replace(/\[\*\*네이버지도\*\*[^\]]*?map\.naver\.com\]\([^)]+\)/g, "[지도 위젯]");
}

// importer 의 출력에 잔존하는 위젯 chrome 라인을 마지막으로 정리한다.
// (cheerio 단계에서 스트립 안 한 행들)
const WIDGET_CHROME = new Set([
  "이 블로그의 체크인",
  "이 장소의 다른 글",
  "카카오톡",
  "카카오톡으로 이용하세요",
  "pf-link.kakao.com",
  "네이버지도",
  "map.naver.com",
  "place.map.naver.com",
]);

function cleanupChrome(md) {
  const lines = md.split("\n");
  const out = [];
  for (const line of lines) {
    const stripped = line
      .replace(/^[\s>\-*#]+/, "")
      .replace(/[*_`]/g, "")
      .replace(/[​-‍﻿ ]/g, "")
      .trim();
    if (WIDGET_CHROME.has(stripped)) continue;
    out.push(line.replace(/[ \t]+$/, ""));
  }
  // 다중 공백 줄 → 1
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    // 빈 링크 (chrome 제거 후 잔재)
    .replace(/\[\s*\]\([^)]*\)/g, "")
    .trim();
}

async function migrate(logNo) {
  const found = await findFileForLogNo(logNo);
  if (!found) {
    console.warn(`[skip] ${logNo}: importer 출력에서 찾지 못함`);
    return false;
  }
  const { file, text } = found;
  const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
  const pubDate = dateMatch ? dateMatch[1] : "";
  // 첫 H1 = 제목
  const h1 = text.match(/^#\s+([^\n]+)\n/);
  const title = h1 ? h1[1].trim() : "";
  // body = H1 제거한 나머지
  let body = h1 ? text.slice(h1[0].length) : text;
  // 이미지 마커 치환을 먼저 — 그래야 `![](...)` 의 빈 alt `[]` 가 cleanup 의
  // 빈 링크 strip 에 휘말리지 않는다.
  const { body: withMarkers, count } = replaceImageRefs(body, logNo);
  // 위젯 chrome 카드를 placeholder 로 치환 (cleanupChrome 전에 — chrome 안의
  // 라인들이 cleanupChrome 의 line filter 에 미리 잡혀버리지 않도록).
  const bodyWithPlaceholders = replaceWidgetChrome(withMarkers);
  const bodyWithMarkers = cleanupChrome(bodyWithPlaceholders);

  const md = [
    `# ${title}`,
    ``,
    `- pubDate: ${pubDate}`,
    `- url: https://blog.naver.com/${BLOG_ID}/${logNo}`,
    `- logNo: ${logNo}`,
    ``,
    `---`,
    ``,
    bodyWithMarkers,
    ``,
  ].join("\n");
  const outFile = path.join(OUT_DIR, `${logNo}.md`);
  await writeFile(outFile, md, "utf8");
  console.log(`[ok] ${outFile} (${md.length}B, ${count} images)`);
  return true;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  let ok = 0;
  for (const ln of targetLogNos) {
    if (await migrate(ln)) ok++;
  }
  console.log(`\nDone. migrated ${ok}/${targetLogNos.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

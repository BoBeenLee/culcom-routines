#!/usr/bin/env node
// Issue 폼 본문 파싱 → outputs/issue.json
// GitHub Issue Forms는 본문을 "### 라벨\n\n값\n\n### 다음 라벨..." 형태로 직렬화한다.
//
// 환경변수:
//   ISSUE_BODY     (필수) Issue 본문 마크다운
//   ISSUE_NUMBER   (선택) 코멘트/라벨 부여 시 사용
// 출력: outputs/issue.json + stdout 디버그

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = path.resolve("outputs");
const body = process.env.ISSUE_BODY || "";
if (!body) {
  console.error("[parse-issue] ISSUE_BODY env가 비어있다.");
  process.exit(1);
}

// "### 헤더\n\n값" 블록을 분해
function parseFormBody(md) {
  const sections = {};
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let curKey = null;
  let buf = [];
  const flush = () => {
    if (curKey === null) return;
    sections[curKey] = buf.join("\n").trim();
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^###\s+(.+?)\s*$/);
    if (m) {
      flush();
      curKey = m[1].trim();
    } else if (curKey !== null) {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

const sections = parseFormBody(body);

// 필드 키는 한글 라벨이 그대로 들어옴. 폼 정의와 매칭.
const channelRaw = sections["채널"] || "";
const subjectRaw = sections["주제 / 수업 종류 (선택)"] || "";
const vibeRaw = sections["분위기 / 강조 포인트 (선택)"] || "";
const whenRaw = sections["시기 / 날짜 (선택, 트렌드 리서치 기준)"] || "";
const photosRaw = sections["사진 (이 영역에 드래그&드롭) — 필수"] || "";

// 값이 비었거나 "_No response_" 인 경우 빈 문자열 처리
const clean = (s) => {
  const t = (s || "").trim();
  if (!t || t === "_No response_") return "";
  return t;
};

const channelText = clean(channelRaw);
const subject = clean(subjectRaw) || "오늘의 컬컴 하남";
const vibe = clean(vibeRaw);
const today = new Date().toISOString().slice(0, 10);
const when = clean(whenRaw) || today;

// 채널 결정
const channels = (() => {
  if (!channelText || channelText.startsWith("둘 다")) return ["naver", "insta"];
  if (channelText.includes("네이버")) return ["naver"];
  if (channelText.includes("인스타")) return ["insta"];
  return ["naver", "insta"]; // 알 수 없으면 둘 다
})();

// 이미지 URL 추출 (마크다운 ![](url) + <img src="..."> + 그냥 https://...github.com/user-attachments/...)
const imageUrls = [];
const seenUrls = new Set();
const pushUrl = (u) => {
  if (!u) return;
  if (seenUrls.has(u)) return;
  seenUrls.add(u);
  imageUrls.push(u);
};
const fullText = body;
for (const m of fullText.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) pushUrl(m[1]);
for (const m of fullText.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) pushUrl(m[1]);
for (const m of fullText.matchAll(/https?:\/\/[^\s<>"')]+\.(?:png|jpe?g|webp|gif|heic)/gi)) pushUrl(m[0]);
for (const m of fullText.matchAll(/https?:\/\/github\.com\/user-attachments\/[^\s<>"')]+/gi)) pushUrl(m[0]);

const result = {
  channels,
  channelText,
  subject,
  vibe,
  when,
  today,
  imageUrls,
  hasPhotos: imageUrls.length > 0,
};

await mkdir(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, "issue.json");
await writeFile(outFile, JSON.stringify(result, null, 2), "utf8");
console.log(`[parse-issue] wrote ${outFile}`);
console.log(JSON.stringify(result, null, 2));

if (!result.hasPhotos) {
  console.error("[parse-issue] 이미지가 없습니다. 사진 첨부가 필수입니다.");
  process.exit(3);
}

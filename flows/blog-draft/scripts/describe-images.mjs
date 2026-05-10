#!/usr/bin/env node
// 샘플 마크다운의 [이미지 #N: TBD] 마커를 Gemini Flash 로 생성한
// 한 줄 묘사로 치환한다. naver-style.md 의 이미지 위치 표기 규칙을
// 그대로 따른다 (15자 이내, 분위기·소품·인물 활동 중심, 식별 외모 묘사 금지).
//
// 사용:
//   node flows/blog-draft/scripts/describe-images.mjs \
//     --samples flows/blog-draft/prompts/samples/naver \
//     --assets /tmp/naver-import/assets \
//     --logNos 224241400842,224249814155,...
//
// idempotent: TBD 마커만 처리하므로 재실행해도 안전. JSON 파싱 실패 시
// 해당 logNo 의 마커를 그대로 두고 다음 logNo 로 진행.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const SAMPLES_DIR = path.resolve(arg("--samples") || "flows/blog-draft/prompts/samples/naver");
const ASSETS_DIR = path.resolve(arg("--assets") || "/tmp/naver-import/assets");
const targetLogNos = (arg("--logNos") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!targetLogNos.length) {
  console.error("사용: --samples <samplesDir> --assets <assetsDir> --logNos a,b,c");
  process.exit(2);
}

function runGemini(prompt) {
  return new Promise((resolve, reject) => {
    // --include-directories 로 ASSETS_DIR 을 워크스페이스에 포함시킨다.
    // 빠지면 @<path> 가 워크스페이스 밖이라 거부되고 모델이 이미지 못 봄.
    const child = spawn(
      "gemini",
      [
        "--yolo",
        "-m",
        "gemini-2.5-flash",
        "--include-directories",
        ASSETS_DIR,
        "-p",
        prompt,
      ],
      {
        env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`gemini exit ${code}: ${err.slice(0, 800)}`));
      else resolve(out.trim());
    });
  });
}

// Gemini 가 가끔 따옴표·코드블록·chain-of-thought 누출을 섞어 답하므로
// 첫 의미 있는 줄만 사용 + 도구호출 비슷한 패턴은 거부.
function cleanDescription(raw) {
  const candidates = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<ctrl\d+>/g, " ")
    .split(/\r?\n/)
    .map((s) => s.replace(/^[\s\-*>"'`]+/, "").replace(/[\s"'`]+$/, "").trim())
    .filter((s) => s.length > 0);
  for (const c of candidates) {
    // 도구호출/JSON 누출 거부 — function_call(...) 또는 strategic_intent: 같은 패턴
    if (/^[a-zA-Z_]+\s*\(/.test(c)) continue;
    if (/strategic_intent|<ctrl|update_topic|tool_call/i.test(c)) continue;
    if (c.length > 60) continue; // 15자 가이드 + 여유 — 너무 길면 누출 의심
    return c;
  }
  return "";
}

function buildPrompt(imagePath) {
  return [
    `@${imagePath}`,
    "",
    "이 컬컴 하남 영어회화 스터디 사진 한 장에 대해 한 줄 묘사를 작성하라.",
    "",
    "규칙:",
    "- 15자 이내 한국어 한 줄",
    "- 분위기·구도·소품·인물 활동 중심 (예: \"멤버분들이 둘러앉아 발표 자료 보는 모습\")",
    "- 사진에 보이는 활동·표정·테이블 위 자료를 자연스럽게",
    "- 실명·얼굴 식별 가능한 외모 묘사 금지 → \"멤버분\", \"리더님\", \"외국인 친구\", \"조교님\" 등으로 일반화",
    "- 카카오 QR/로고는 \"카카오 채널 안내 이미지\", 네이버 지도 위젯은 \"매장 위치 지도\" 같은 식으로 표현",
    "- 마크다운/이모지/숫자/따옴표/JSON 없이 묘사 본문 한 줄만 출력",
  ].join("\n");
}

async function listImages(logNo) {
  const dir = path.join(ASSETS_DIR, logNo);
  let files;
  try {
    files = await readdir(dir);
  } catch (e) {
    throw new Error(`asset dir not found: ${dir}`);
  }
  return files
    .filter((f) => /^img_\d+\.[a-z0-9]+$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

async function processLogNo(logNo) {
  const samplePath = path.join(SAMPLES_DIR, `${logNo}.md`);
  let md;
  try {
    md = await readFile(samplePath, "utf8");
  } catch (e) {
    console.warn(`[skip] ${logNo}: sample not found at ${samplePath}`);
    return false;
  }
  const tbdMatches = [...md.matchAll(/\[이미지 #(\d+): TBD\]/g)];
  if (!tbdMatches.length) {
    console.log(`[ok] ${logNo}: no TBD markers (already filled)`);
    return true;
  }
  const imageCount = Math.max(...tbdMatches.map((m) => parseInt(m[1], 10)));
  const allImages = await listImages(logNo);
  if (allImages.length < imageCount) {
    console.warn(
      `[skip] ${logNo}: only ${allImages.length} images on disk, need ${imageCount}`,
    );
    return false;
  }
  // #N ↔ img_NNN 매핑은 importer 출력 순서. listImages 가 sort 하므로
  // img_001 → #1, img_002 → #2, ...
  const imagePaths = allImages.slice(0, imageCount);

  // 한 장씩 호출 — 배치 호출은 Gemini 가 출력 순서를 어긋나게 매핑하는 경우 있음.
  let updated = md;
  let filled = 0;
  for (let i = 0; i < imagePaths.length; i++) {
    const n = i + 1;
    if (!new RegExp(`\\[이미지 #${n}: TBD\\]`).test(updated)) continue;
    process.stdout.write(`[run] ${logNo} #${n}/${imageCount}: `);
    let raw;
    try {
      raw = await runGemini(buildPrompt(imagePaths[i]));
    } catch (e) {
      console.log(`fail (${e.message.slice(0, 100)})`);
      continue;
    }
    const desc = cleanDescription(raw).replace(/[\r\n\]]/g, " ").trim();
    if (!desc) {
      console.log(`empty response`);
      continue;
    }
    console.log(desc);
    const re = new RegExp(`\\[이미지 #${n}: TBD\\]`, "g");
    updated = updated.replace(re, `[이미지 #${n}: ${desc}]`);
    filled++;
  }
  await writeFile(samplePath, updated, "utf8");
  const remaining = (updated.match(/\[이미지 #\d+: TBD\]/g) || []).length;
  console.log(
    `[ok] ${logNo}: filled ${filled}/${imageCount} (${remaining} TBD remaining)`,
  );
  return true;
}

async function main() {
  let ok = 0;
  for (const ln of targetLogNos) {
    if (await processLogNo(ln)) ok++;
  }
  console.log(`\nDone. processed ${ok}/${targetLogNos.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

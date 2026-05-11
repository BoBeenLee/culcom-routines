#!/usr/bin/env node
// 첨부 이미지를 Gemini Flash 로 **한 장씩** 분석해 사진별 alt 문장과 마커 라벨을
// 추출한다. draft.mjs 가 결과를 prompt 에 inject 하면 LLM 이 사진별 단서를 본문
// 후크·중반 에피소드에 명시적으로 반영하기가 쉬워져 동질화가 완화된다.
//
// 묶음 1회 호출 대신 사진별 N회 호출을 쓰는 이유:
// - 사진별 묘사가 15자로 압축되지 않고 50~150자 풍부하게 추출됨.
// - 사진 #N ↔ 묘사 #N 매핑이 정확 (describe-images.mjs:142 주석 참고 — 배치
//   호출은 출력 순서가 어긋나는 경우가 보고됨).
//
// 입력: outputs/issue.json, outputs/images.json (extract-images 산출물)
// 출력: outputs/image-analysis.json
//   {
//     image_alts: [
//       { idx, file, alt(50~150자 풍부 묘사), marker_label(15자 이내) },
//       ...
//     ],
//     _model, _count
//   }
//
// 페르소나·후크 씨앗·묶음 분위기 같은 reduce 결과는 이 단계에서 산출하지 않는다.
// draft.mjs 가 사진별 alt + 사진 원본 + 운영자 메모를 종합해 직접 결정한다
// (naver-style.md §1 페르소나 선택 규칙).
//
// 사진별 호출 실패 시 그 사진은 alt/marker_label 빈 값으로 두고 다음 사진으로
// 진행 (idempotent, 일부 실패해도 파이프라인 계속).

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const OUT_DIR = path.resolve("outputs");
const IMAGES_JSON = path.join(OUT_DIR, "images.json");
const OUT = path.join(OUT_DIR, "image-analysis.json");
const MODEL = "gemini-2.5-flash";

await mkdir(OUT_DIR, { recursive: true });

const images = JSON.parse(await readFile(IMAGES_JSON, "utf8"));

if (!images.downloaded || images.downloaded.length === 0) {
  console.log("[analyze-images] no images; skip");
  await writeFile(
    OUT,
    JSON.stringify(
      { image_alts: [], _model: MODEL, _count: 0, _note: "no images" },
      null,
      2,
    ),
    "utf8",
  );
  process.exit(0);
}

function buildPrompt(imagePath) {
  return [
    `@${imagePath}`,
    "",
    "이 컬컴 하남 영어회화 스터디 사진 1장을 블로그 본문 작성용으로 자세히 묘사하라.",
    "",
    "다음 JSON 스키마로만 출력. 코드블록·서두·맺음말·설명 없이 JSON 객체만:",
    "{",
    `  "alt": "이 사진의 분위기·시간대·장소·소품·인물 활동·표정·구도를 종합한 풍부한 묘사. 60~150자 한국어. 본문 후크·중반 에피소드의 씨앗으로 쓸 수 있을 만큼 구체적으로. 매장 일반론('카페 같은 분위기') 보다 이 사진만의 특이점(조명·옷차림·테이블 위 자료·인물 구성·창밖 풍경 등)을 우선.",`,
    `  "marker_label": "네이버 [이미지 #N: __] 마커 자리에 들어갈 한 줄 라벨. 15자 이내. 분위기·구도·소품 중심 (예: '멤버분들이 둘러앉아 발표 자료 보는 모습')."`,
    "}",
    "",
    "규칙:",
    "- 사진에서 확인되지 않는 사실 만들지 말 것.",
    "- 실명·식별 가능한 외모 묘사 금지. 인물은 \"멤버분\", \"리더님\", \"외국인 친구\", \"조교님\" 등으로만.",
    "- 카카오 QR/로고 사진은 alt 에 \"카카오 채널 안내 이미지\" 류, 네이버 지도 위젯은 \"매장 위치 지도\" 류로.",
    "- JSON 외 텍스트 출력 금지 (`update_topic(...)`, `<ctrl##>`, `strategic_intent:` 같은 도구호출 누출 절대 금지).",
  ].join("\n");
}

function runGemini(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "gemini",
      ["--yolo", "-m", MODEL, "-p", prompt],
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
      else resolve(out);
    });
  });
}

function extractJson(text) {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e < 0 || e <= s) return null;
  try {
    return JSON.parse(text.slice(s, e + 1));
  } catch {
    return null;
  }
}

// alt 가 너무 짧거나 도구호출 누출이 섞인 경우 거부.
function isUsable(parsed) {
  if (!parsed) return false;
  if (typeof parsed.alt !== "string" || parsed.alt.trim().length < 10) return false;
  if (typeof parsed.marker_label !== "string") return false;
  const blob = `${parsed.alt} ${parsed.marker_label}`;
  if (/strategic_intent|<ctrl|update_topic|tool_call|function_call/i.test(blob)) return false;
  return true;
}

function trimLabel(s, max) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
}

const imageAlts = [];
let ok = 0;
for (let i = 0; i < images.downloaded.length; i++) {
  const idx = i + 1;
  const d = images.downloaded[i];
  const rel = path.relative(ROOT, d.file);
  process.stdout.write(`[analyze-images] #${idx}/${images.downloaded.length} ${rel}: `);
  let parsed = null;
  try {
    const out = await runGemini(buildPrompt(rel));
    parsed = extractJson(out);
    if (!isUsable(parsed)) {
      console.log(`parse/usability fail; raw head: ${out.slice(0, 120).replace(/\n/g, " ")}`);
      parsed = null;
    }
  } catch (e) {
    console.log(`gemini fail (${e.message.slice(0, 100)})`);
  }
  if (parsed) {
    const alt = parsed.alt.trim();
    const marker_label = trimLabel(parsed.marker_label, 30);
    imageAlts.push({ idx, file: rel, alt, marker_label });
    ok++;
    console.log(`ok — label="${marker_label}" alt[${alt.length}]`);
  } else {
    imageAlts.push({ idx, file: rel, alt: "", marker_label: "" });
  }
}

await writeFile(
  OUT,
  JSON.stringify(
    {
      image_alts: imageAlts,
      _model: MODEL,
      _count: imageAlts.length,
      _ok: ok,
    },
    null,
    2,
  ),
  "utf8",
);
console.log(`[analyze-images] wrote ${OUT} (${ok}/${imageAlts.length} ok)`);

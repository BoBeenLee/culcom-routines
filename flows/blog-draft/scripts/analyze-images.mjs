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
    "이 컬컴 하남 영어회화 스터디 사진 1장을 블로그 본문 작성용 단서로 풍부하게 묘사하라.",
    "",
    "다음 6가지 차원을 순서대로 관찰한 뒤 종합해 JSON 으로 출력:",
    "1. **장소·인테리어·조명·시간대** — 햇빛 방향, 조명 색감, 창가/내부, 시간 추정",
    "2. **테이블 위 자료·소품** — 프린트, 노트북, 책, 커피잔, 메모, 필기구, 음료 컵 등 보이는 것만",
    "3. **인물 수·활동·표정** — 몇 명, 무엇을 하는 중, 어떤 표정·자세 (실명·외모 식별 금지)",
    "4. **옷차림·계절감** — 반팔/긴팔, 색감·톤, 계절 단서",
    "5. **분위기·정서** — 아늑함·집중·활기·차분함·웃음 등 톤 단어",
    "6. **이 사진만의 차별 단서** — 일반 스터디 사진과 구분되는 특이점 (창밖 풍경, 특정 소품, 특정 활동, 특정 인물 구성 등)",
    "",
    "다음 JSON 스키마로만 출력. 코드블록·서두·맺음말·설명 없이 JSON 객체만:",
    "{",
    `  "marker_label": "네이버 [이미지 #N: __] 자리에 들어갈 한 줄 라벨. 15자 이내. 분위기·구도·소품 중심 (예: '멤버분들이 둘러앉아 발표 자료 보는 모습').",`,
    `  "alt": "위 6차원을 종합한 풍부한 묘사. 150~250자 한국어, 2~4문장. 본문 후크·중반 에피소드의 씨앗으로 쓸 수 있을 만큼 구체적으로. '카페 같은 분위기' 류 일반론 금지 — 이 사진만의 디테일을 살릴 것.",`,
    `  "scene": "장소·조명·시간대 한 줄 (40자 이내). 예: '늦은 오후 햇살이 비스듬히 들어오는 창가'",`,
    `  "props": "테이블 위 자료·소품 한 줄 (40자 이내, 보이는 것만). 예: '영어 프린트, 노트북, 따뜻한 라떼 한 잔'",`,
    `  "people": "인물 수·활동·표정 한 줄 (40자 이내, 실명·외모 묘사 금지). 예: '멤버분 5명이 둥글게 앉아 활기차게 토론'",`,
    `  "mood_tags": ["분위기 태그 2~4개 (한 단어씩, 예: '집중', '아늑함', '주말 오전')"],`,
    `  "distinctive": "이 사진만의 차별 단서 한 줄 (40자 이내). 예: '창밖 단풍과 테이블 위 노란 메모지 더미'"`,
    "}",
    "",
    "규칙:",
    "- 사진에서 확인되지 않는 사실 만들지 말 것 (보이지 않으면 빈 문자열 또는 빈 배열).",
    "- 실명·식별 가능한 외모(특정 머리스타일·옷 브랜드·얼굴 특징) 묘사 금지. 인물은 \"멤버분\", \"리더님\", \"외국인 친구\", \"조교님\" 등으로만.",
    "- 카카오 QR/로고 사진은 alt 에 \"카카오 채널 안내 이미지\" 류, 네이버 지도 위젯은 \"매장 위치 지도\" 류로. 사람이 안 보이면 people 은 빈 문자열.",
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
// 50자 미만이면 풍부한 묘사가 안 됐다고 판단 — fallback (빈 alt) 으로 떨어진다.
function isUsable(parsed) {
  if (!parsed) return false;
  if (typeof parsed.alt !== "string" || parsed.alt.trim().length < 50) return false;
  if (typeof parsed.marker_label !== "string") return false;
  const blob = [
    parsed.alt,
    parsed.marker_label,
    parsed.scene,
    parsed.props,
    parsed.people,
    parsed.distinctive,
  ]
    .filter((s) => typeof s === "string")
    .join(" ");
  if (/strategic_intent|<ctrl|update_topic|tool_call|function_call/i.test(blob)) return false;
  return true;
}

function trimLabel(s, max) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
}

function cleanField(s, max) {
  if (typeof s !== "string") return "";
  return trimLabel(s, max);
}

function cleanMoodTags(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((t) => typeof t === "string")
    .map((t) => trimLabel(t, 15))
    .filter((t) => t.length > 0)
    .slice(0, 6);
}

// 사진별 호출은 독립적이라 worker pool 로 병렬화. Gemini OAuth quota 와
// GitHub Actions runner (2 vCPU) 를 고려해 기본 동시성 4. ANALYZE_IMAGES_CONCURRENCY
// 환경변수로 워크플로우/로컬에서 override 가능 (1 이면 순차 실행).
const CONCURRENCY = Math.max(
  1,
  parseInt(process.env.ANALYZE_IMAGES_CONCURRENCY || "4", 10) || 4,
);

async function analyzeOne(i) {
  const idx = i + 1;
  const d = images.downloaded[i];
  const rel = path.relative(ROOT, d.file);
  const tag = `[analyze-images] #${idx}/${images.downloaded.length} ${rel}`;
  let parsed = null;
  let failMsg = "";
  try {
    const out = await runGemini(buildPrompt(rel));
    parsed = extractJson(out);
    if (!isUsable(parsed)) {
      failMsg = `parse/usability fail; raw head: ${out.slice(0, 120).replace(/\n/g, " ")}`;
      parsed = null;
    }
  } catch (e) {
    failMsg = `gemini fail (${e.message.slice(0, 100)})`;
  }
  if (parsed) {
    const alt = parsed.alt.trim();
    const marker_label = trimLabel(parsed.marker_label, 30);
    const scene = cleanField(parsed.scene, 80);
    const props = cleanField(parsed.props, 80);
    const people = cleanField(parsed.people, 80);
    const distinctive = cleanField(parsed.distinctive, 80);
    const mood_tags = cleanMoodTags(parsed.mood_tags);
    console.log(
      `${tag}: ok — label="${marker_label}" alt[${alt.length}] mood=${mood_tags.join("/") || "-"}`,
    );
    return { idx, file: rel, alt, marker_label, scene, props, people, mood_tags, distinctive };
  }
  console.log(`${tag}: ${failMsg}`);
  return {
    idx,
    file: rel,
    alt: "",
    marker_label: "",
    scene: "",
    props: "",
    people: "",
    mood_tags: [],
    distinctive: "",
  };
}

const results = new Array(images.downloaded.length);
let cursor = 0;
async function worker() {
  while (true) {
    const i = cursor++;
    if (i >= images.downloaded.length) return;
    results[i] = await analyzeOne(i);
  }
}
const workerCount = Math.min(CONCURRENCY, images.downloaded.length);
console.log(
  `[analyze-images] concurrency=${workerCount}, total=${images.downloaded.length}`,
);
await Promise.all(Array.from({ length: workerCount }, () => worker()));

const imageAlts = results;
const ok = imageAlts.filter((a) => a.alt && a.alt.length > 0).length;

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

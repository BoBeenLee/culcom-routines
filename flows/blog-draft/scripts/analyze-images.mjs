#!/usr/bin/env node
// 첨부 이미지를 Gemini Flash 로 한 번에 묶어 분석해 본문 작성 단서 텍스트를 추출.
// draft.mjs 가 결과를 prompt 에 inject 하면 본문이 사진에서 도출된 페르소나·
// 후크 씨앗을 명시적으로 사용하게 되어 동질화 (글마다 같은 골격으로 수렴) 가 완화된다.
//
// 입력: outputs/issue.json, outputs/images.json (extract-images 산출물)
// 출력: outputs/image-analysis.json
//   { mood, scene, people, persona_candidate, persona_rationale, hook_seed, image_descriptions }
// 실패·이미지 0장 시 fallback 구조만 저장하고 exit 0 (파이프라인 계속 진행).

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const OUT_DIR = path.resolve("outputs");
const IMAGES_JSON = path.join(OUT_DIR, "images.json");
const ISSUE_JSON = path.join(OUT_DIR, "issue.json");
const OUT = path.join(OUT_DIR, "image-analysis.json");

await mkdir(OUT_DIR, { recursive: true });

const images = JSON.parse(await readFile(IMAGES_JSON, "utf8"));
const issue = JSON.parse(await readFile(ISSUE_JSON, "utf8"));

const fallback = {
  mood: "",
  scene: "",
  people: "",
  persona_candidate: "",
  persona_rationale: "",
  hook_seed: "",
  image_descriptions: [],
  _note: "image analysis fallback",
};

if (!images.downloaded || images.downloaded.length === 0) {
  console.log("[analyze-images] no images; skip");
  await writeFile(
    OUT,
    JSON.stringify({ ...fallback, _note: "no images" }, null, 2),
    "utf8",
  );
  process.exit(0);
}

// naver-style.md §1 의 7개 페르소나와 동일한 라벨. 모델이 그대로 출력하도록 지시.
const personas = [
  "직장인 회원 (해외영업·법카·바쁜 직장인)",
  "아이 엄마 / 영유맘 / 7세 학부모",
  "왕초보 / 영어 울렁증 (40대 abcd 도전기 포함)",
  "장기 회원 (6개월~1년차) 달라진 점 / 프리토킹 도달기",
  "컬컴 조교 시점",
  "외국인 친구·데이트·계절 테마형",
  "여행/비즈니스 영어 테마형",
];

const imageCount = images.downloaded.length;
const imageRefs = images.downloaded
  .map((d, i) => `@${path.relative(ROOT, d.file)} (#${i + 1})`)
  .join(" ");

const prompt = [
  imageRefs,
  "",
  "너는 컬컴 하남 영어회화 스터디 블로그 글의 사전 사진 분석 담당이다.",
  `첨부된 ${imageCount}장 사진을 한 묶음으로 관찰하고, 본문 작성에 사용할 단서를 추출하라.`,
  "",
  "운영자 메모 (페르소나 선택 시 우선 반영):",
  `- 주제: ${issue.subject || "(없음)"}`,
  `- 분위기: ${issue.vibe || "(없음)"}`,
  `- 기준일: ${issue.when || ""}`,
  "",
  "다음 JSON 스키마로만 출력. 코드블록·서두·맺음말·설명 없이 JSON 객체만:",
  "{",
  `  "mood": "사진 묶음 전체 분위기·계절감·시간대 (한 줄, 30자 이내)",`,
  `  "scene": "장소·소품·테이블 위 자료 등 보이는 단서 (1~2줄, 80자 이내)",`,
  `  "people": "인물 수·활동·구성 (한 줄, 40자 이내. 실명·외모 묘사 금지)",`,
  `  "persona_candidate": "아래 7개 중 하나의 이름을 그대로",`,
  `  "persona_rationale": "왜 그 페르소나인지 한 줄 (30자 이내)",`,
  `  "hook_seed": "본문 후크의 씨앗이 될 만한 이 사진 묶음만의 차별 단서 1~2개 (60자 이내. 예: '늦은 오후 햇살의 카페형 매장', '외국인 친구와 카드 게임', '저녁 7시 가득 찬 매장'). 매장 일반론 말고 이 사진들만의 특이점.",`,
  `  "image_descriptions": ["#1 묘사 15자 이내", "#2 ...", "..."]`,
  "}",
  "",
  "persona_candidate 후보 (이 중 하나만 그대로 복사):",
  ...personas.map((p, i) => `${i + 1}. ${p}`),
  "",
  "규칙:",
  "- 사진에서 확인되지 않는 사실 만들지 말 것.",
  "- 실명·식별 가능한 외모 묘사 금지. 인물은 \"멤버분\", \"리더님\", \"외국인 친구\", \"조교님\" 등으로만.",
  "- 카카오 QR/로고 사진은 \"카카오 채널 안내 이미지\", 네이버 지도 위젯은 \"매장 위치 지도\" 같은 식으로.",
  `- image_descriptions 배열 길이는 정확히 ${imageCount} (각 사진에 1:1 대응, 첨부 순서대로 #1..#${imageCount}).`,
  "- 운영자 메모(주제·분위기)가 비어있지 않으면 그것을 페르소나 선택에 우선 반영. 모호하거나 비어있으면 사진 단서로 결정.",
  "- JSON 외 텍스트 출력 금지 (`update_topic(...)`, `<ctrl##>`, `strategic_intent:` 같은 도구호출 누출 절대 금지).",
].join("\n");

function runGemini(p) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "gemini",
      ["--yolo", "-m", "gemini-2.5-flash", "-p", p],
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

let analysis;
try {
  console.log(`[analyze-images] gemini-flash, images=${imageCount}`);
  const out = await runGemini(prompt);
  const parsed = extractJson(out);
  if (
    parsed &&
    typeof parsed.persona_candidate === "string" &&
    parsed.persona_candidate.trim().length > 0
  ) {
    analysis = { ...fallback, ...parsed };
    delete analysis._note;
    console.log(`[analyze-images] parsed ok. persona=${parsed.persona_candidate}`);
    if (parsed.hook_seed) console.log(`[analyze-images] hook_seed=${parsed.hook_seed}`);
  } else {
    console.warn(
      `[analyze-images] parse fail / missing persona_candidate. raw head:\n${out.slice(0, 500)}`,
    );
    analysis = { ...fallback, _note: "parse fail or missing persona_candidate" };
  }
} catch (e) {
  console.warn(`[analyze-images] gemini fail: ${e.message}`);
  analysis = { ...fallback, _note: `gemini error: ${e.message.slice(0, 200)}` };
}

await writeFile(OUT, JSON.stringify(analysis, null, 2), "utf8");
console.log(`[analyze-images] wrote ${OUT}`);
console.log(JSON.stringify(analysis, null, 2));

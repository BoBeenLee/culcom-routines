#!/usr/bin/env node
// 채널별로 Gemini를 호출해 초안을 생성한다.
// 입력: outputs/issue.json, outputs/trends.json, outputs/images.json
//       flows/blog-draft/prompts/system.md, prompts/{naver|ig}-style.md
// 출력: outputs/{channel}.md, outputs/comment.md

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convert as mdToNaverHtml } from "@jjlabsio/md-to-naver-blog";

const ROOT = process.cwd();
const FLOW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMPTS_DIR = path.join(FLOW_DIR, "prompts");
const OUT_DIR = path.resolve("outputs");

const issue = JSON.parse(await readFile(path.join(OUT_DIR, "issue.json"), "utf8"));
const trends = JSON.parse(await readFile(path.join(OUT_DIR, "trends.json"), "utf8"));
const images = JSON.parse(await readFile(path.join(OUT_DIR, "images.json"), "utf8"));
const systemMd = await readFile(path.join(PROMPTS_DIR, "system.md"), "utf8");

const styleFiles = {
  naver: "naver-style.md",
  insta: "ig-style.md",
};
const channelLabel = {
  naver: "네이버 블로그",
  insta: "인스타그램",
};

async function readStyle(channel) {
  try {
    return await readFile(path.join(PROMPTS_DIR, styleFiles[channel]), "utf8");
  } catch {
    return `# ${channelLabel[channel]} 스타일 가이드\n(가이드 파일이 비어있음 — 일반 톤으로 작성)\n`;
  }
}

// 네이버 블로그: 이미지 수에 따른 분량·구조 가이드. 분량 tier 는 reference
// 샘플 10개의 본문 char count 실측에 기반 (1,700~5,600자, 이미지 7~15장).
function naverLengthGuide(imageCount) {
  const imagePlacement = [
    "",
    "[이미지 위치 표기 — 필수]",
    `- 본문에 첨부된 ${imageCount}장의 사진이 들어갈 자리를 모두 표시한다.`,
    "- 형식: `[이미지 #N: 한 줄 묘사]` (예: `[이미지 #1: 멤버분들이 둘러앉아 발표 자료 보는 모습]`)",
    `- N은 1부터 ${imageCount}까지 정확히 매칭. 같은 번호 두 번 쓰지 말고, 모든 번호가 본문 어딘가에 등장해야 한다.`,
    "- 한 줄 묘사는 사진을 직접 관찰해 분위기·구도·소품 중심으로 짧게 (15자 이내).",
    "- 마크다운 이미지 문법 `![](url)` 으로 쓰지 말 것 — 운영자가 네이버 에디터에서 직접 사진을 끌어 올린다.",
    "",
    "[위젯 chrome — single-line raw 형태 그대로 출력]",
    "- 매장/지도/카카오 카드는 다음 정확한 single-line raw chrome 으로 본문에 출력. 운영자가 그대로 네이버 에디터에 붙여넣으면 카드로 렌더된다.",
    "",
    "  매장 박스 (오프닝 첫 이미지 직후 또는 본문 끝에 자주 등장):",
    "  `[**컬컴 하남점**경기도 하남시 미사강변중앙로204번길 22 마이움센트럴아케이드 201호, 202호](#)`",
    "",
    "  네이버 지도 위젯 (선택):",
    "  `[**네이버지도**컬컴 하남점map.naver.com](https://map.naver.com/p/entry/place/1965780250)`",
    "",
    "  카카오 채널 링크 (CTA 끝, 카카오 안내 이미지 마커 직후 — query 는 반드시 state=hanam,blog):",
    "  `[**카카오톡**pf-link.kakao.com](https://pf-link.kakao.com/qr/_xeMISK/pages/_Hxh?query=state=hanam,blog)`",
    "",
    "- 위 chrome 블록은 글자·괄호·URL 한 글자도 바꾸지 말 것. 줄바꿈 넣지 말 것 (반드시 single-line).",
    "- plain `[카카오톡](url)` 으로 압축하거나 다른 query 값 사용 금지.",
    "",
    "[줄바꿈 규칙 — 한 줄 24자 이내]",
    "- 본문 한 줄에 글자 수가 24를 넘기지 않도록 어절(공백) 경계에서 줄바꿈해 짧게 끊어 쓸 것.",
    "- 25자 이상 한 줄에 몰아쓰지 말고, 길어지면 자연스러운 위치에서 별도 줄로 분리.",
    "- 단, 위젯 chrome 라인 (매장 박스 / 지도 / 카카오) 과 마지막 해시태그 한 줄은 single-line 유지가 우선 — 24자 넘어도 줄바꿈 금지.",
    "",
    "[모델 누출 금지]",
    "- `update_topic(...)`, `<ctrl##>`, `strategic_intent:`, `tool_call`, `function_call` 같은 도구호출 메타데이터 절대 출력 금지.",
  ].join("\n");
  if (imageCount <= 3) {
    return [
      `- 분량: 본문 1,200~3,000자. (이미지 ${imageCount}장)`,
      "- 구조: 한 가지 인상·에피소드에 집중. 단락 5~10개.",
      "- 사진을 본문 자연스러운 흐름에 1~2번 인용하며 마커 위치 표시.",
      imagePlacement,
    ].join("\n");
  }
  if (imageCount <= 9) {
    return [
      `- 분량: 본문 1,700~4,500자. (이미지 ${imageCount}장)`,
      "- 구조: 표준 후기 골격. 단락 8~14개. 섹션 2~4개 (인용블록 / 번호Bold / 이모지Bold 헤더 중 하나로 구분).",
      "- 사진을 섹션마다 분산 배치하고 마커 한 줄로 표시.",
      imagePlacement,
    ].join("\n");
  }
  if (imageCount <= 14) {
    return [
      `- 분량: 본문 2,800~5,500자. (이미지 ${imageCount}장)`,
      "- 구조: 페르소나 동기 + 본문 섹션 + 결론. 단락 12~18개. 섹션 3~4개.",
      "- 마지막에 '이런 분들께 추천' / '달라진 점 N가지' 같은 결론 단락 추가.",
      imagePlacement,
    ].join("\n");
  }
  return [
    `- 분량: 본문 3,500~5,500자. (이미지 ${imageCount}장)`,
    "- 구조: 테마 후크 + 본문 섹션 + 위치 안내까지 풍성하게. 단락 14~20개. 섹션 4개 이상.",
    "- 큰 흐름을 4개 이상 소제목 섹션으로 나누고, 사진을 섹션마다 분산. 마지막에 위치·접근성 단락 1개 포함.",
    imagePlacement,
  ].join("\n");
}

// 인스타그램: 이미지 수에 따른 가이드 (간단)
function igLengthGuide(imageCount) {
  return [
    `- 첨부 이미지 ${imageCount}장.`,
    imageCount > 1
      ? "- 캐러셀로 올라갈 가능성이 높으니 첫 사진을 후크로 잡고 캡션은 캐러셀 전체를 아우르는 한 마디로 작성."
      : "- 단일 사진 게시. 사진 한 장의 분위기를 짧게 묘사.",
  ].join("\n");
}

function buildPrompt({ channel, style }) {
  const imageCount = images.downloaded.length;
  const imageRefs = images.downloaded
    .map((d, i) => `@${path.relative(ROOT, d.file)} (#${i + 1})`)
    .join(" ");
  const lengthGuide =
    channel === "naver" ? naverLengthGuide(imageCount) : igLengthGuide(imageCount);
  return [
    imageRefs,
    "",
    "===== 시스템 프롬프트 =====",
    systemMd,
    "",
    `===== 채널: ${channelLabel[channel]} 스타일 가이드 =====`,
    style,
    "",
    `===== 이미지 입력 (총 ${imageCount}장) =====`,
    `첨부된 사진 ${imageCount}장을 자세히 관찰하고 본문에 자연스럽게 녹여라.`,
    "- 사진에서 확인되지 않는 사실 (점수·합격·등록 수 등) 은 만들지 말 것. 보이는 것만, 그러나 보이는 것은 풍부하게.",
    "- 실명·식별 가능한 외모(머리스타일·옷 브랜드·얼굴 특징) 묘사 금지 — \"멤버분\", \"리더님\", \"외국인 친구\", \"조교님\" 등 일반 표현만.",
    "- 카카오 QR/로고 사진은 본문 마커에 \"카카오 채널 안내 이미지\" 류, 네이버 지도 위젯은 \"매장 위치 지도\" 류 묘사로.",
    "",
    "===== 분량·구조 가이드 (이미지 수 기반) =====",
    lengthGuide,
    "",
    "===== 운영자 입력 =====",
    `- 주제: ${issue.subject}`,
    `- 분위기/메모: ${issue.vibe || "(없음)"}`,
    `- 시기: ${issue.when}`,
    "",
    "===== 트렌드 키워드 (선택 — 자연스러우면 0~1 개만 가볍게, 강제 아님) =====",
    JSON.stringify(trends, null, 2),
    "",
    "===== 작업 =====",
    `위 사진(들)과 입력을 바탕으로 ${channelLabel[channel]} 초안을 작성하라.`,
    "스타일 가이드의 길이·구조·톤을 우선 따르되, 이미지 수 기반 분량 가이드를 함께 만족시켜라.",
    "",
    "===== 출력 규칙 (엄수) =====",
    "다음 markers 사이에 운영자가 그대로 복사할 본문 텍스트만 한 번 출력. 다른 어떤 것도 출력 금지:",
    "- 사고 과정·관찰·계획·draft 후보 비교 출력 금지",
    "- markers 밖에 한 글자도 쓰지 말 것 (앞뒤 안내·맺음말·코드블록·markdown 헤더 모두 금지)",
    "- markers 자체를 본문 안에 다시 넣지 말 것",
    "",
    "<<<DRAFT_START>>>",
    "여기에 본문 텍스트만",
    "<<<DRAFT_END>>>",
  ].join("\n");
}

function runGemini(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("gemini", ["--yolo", "-m", "gemini-3-pro-preview", "-p", prompt], {
      env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
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

// Gemini 출력에서 <<<DRAFT_START>>> ... <<<DRAFT_END>>> 사이 본문만 추출.
// 모델이 CoT (`_pq>thought`, "CRITICAL INSTRUCTION", 관찰·계획·draft 후보 비교 등)
// 를 stdout 에 흘려보내는 경우가 있어 markers 기반 추출이 필수.
// markers 가 없으면 best-effort cleanup 으로 fallback.
function extractDraft(raw) {
  const m = raw.match(/<<<DRAFT_START>>>([\s\S]*?)<<<DRAFT_END>>>/);
  if (m) return m[1].trim();
  // markers 미발견 — Gemini 가 markers 자체도 무시한 경우. 가장 마지막 빈 줄 이후
  // 텍스트가 보통 최종 답이라 그 부분만 시도. 그래도 안 잡히면 raw 통째로 반환.
  const startIdx = raw.indexOf("<<<DRAFT_START>>>");
  if (startIdx >= 0) return raw.slice(startIdx + "<<<DRAFT_START>>>".length).trim();
  return raw.trim();
}

// 네이버 본문의 [이미지 #N: 묘사] 마커를 ![이미지 #N: 묘사](원본 URL)로 치환.
// GitHub 코멘트가 렌더될 때 사진이 그 자리에 인라인으로 보인다.
// 운영자는 네이버 에디터에 붙여넣을 때 ![]() 라인 한 줄만 지우고 같은 자리에 사진을 끌어 올린다.
function injectImageUrlsForNaver(draft) {
  return draft.replace(
    /\[이미지\s*#(\d+)(?::\s*([^\]]*))?\]/g,
    (match, n, desc) => {
      const idx = parseInt(n, 10) - 1;
      const img = images.downloaded[idx];
      if (!img) return match;
      const alt = desc ? `이미지 #${n}: ${desc}` : `이미지 #${n}`;
      return `![${alt}](${img.url})`;
    },
  );
}

// mtnb 가 생성한 HTML 의 plain `<p>...</p>` 본문 단락만 중앙정렬 (issue #11).
// 리스트는 `<p class="se-text-paragraph se-text-paragraph-align-left" ...>` 형태로
// class 속성을 갖고 출력되므로 plain `<p>` 만 정확히 매칭하면 본문만 잡힌다.
// `<p>&nbsp;</p>` 같은 간격 단락은 시각적 영향 없으니 그대로 둔다.
function applyCenterAlignToBodyParagraphs(html) {
  return html.replace(
    /<p>(?!&nbsp;<\/p>)([\s\S]*?)<\/p>/g,
    '<p style="text-align: center;">$1</p>',
  );
}

// Gemini가 출력한 마크다운을 mtnb로 변환해 제목/본문 마크다운/HTML을 얻는다.
// - title: 첫 H1 텍스트
// - bodyMd: H1 한 줄을 제거한 마크다운 (GitHub 코멘트 미리보기용)
// - html: 네이버 에디터 호환 HTML (운영자 클립보드 복사용, 본문 단락 중앙정렬 적용)
function convertNaver(rawMarkdown) {
  let md = rawMarkdown.replace(/\r\n/g, "\n").trim();
  // Gemini가 가끔 ```markdown ... ``` 으로 감싸는 경우 벗겨낸다.
  md = md.replace(/^```(?:markdown)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  const result = mdToNaverHtml(md);
  // 첫 번째 # H1 라인을 본문에서 제거 (제목 분리)
  let bodyMd = md;
  const firstH1 = md.match(/^#\s+([^\n]+)\n*/);
  if (firstH1) {
    bodyMd = md.slice(firstH1[0].length).trimStart();
  }
  const html = applyCenterAlignToBodyParagraphs(result.html || "");
  return {
    title: (result.title || (firstH1 ? firstH1[1].trim() : "")).trim(),
    bodyMd,
    html,
    errors: result.errors || [],
  };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const drafts = {};
  for (const channel of issue.channels) {
    console.log(`[draft] channel=${channel}, images=${images.downloaded.length}`);
    const style = await readStyle(channel);
    const prompt = buildPrompt({ channel, style });
    let raw;
    try {
      const geminiOut = await runGemini(prompt);
      raw = extractDraft(geminiOut);
      if (raw !== geminiOut.trim()) {
        const stripped = geminiOut.length - raw.length;
        console.log(`[draft] extracted from markers (${stripped} chars CoT/wrapper stripped)`);
      }
    } catch (e) {
      raw = `(생성 실패: ${e.message})`;
    }
    if (channel === "naver") {
      // 1) 사진 마커를 markdown 이미지 태그로 치환 (mtnb 가 <img>로 렌더링)
      const rawWithImages = injectImageUrlsForNaver(raw);
      // 2) mtnb로 제목/본문/HTML 추출
      const { title, bodyMd, html, errors } = convertNaver(rawWithImages);
      if (errors.length) {
        console.warn(`[draft] mtnb warnings (${errors.length}):`, errors.slice(0, 3));
      }
      drafts[channel] = { title, body: bodyMd, html };
      const mdFile = path.join(OUT_DIR, "naver.md");
      const htmlFile = path.join(OUT_DIR, "naver.html");
      await writeFile(mdFile, rawWithImages + "\n", "utf8");
      await writeFile(htmlFile, html + "\n", "utf8");
      console.log(
        `[draft] wrote ${mdFile} + ${htmlFile} (title=${title.length}자, bodyMd=${bodyMd.length}자, html=${html.length}자)`,
      );
    } else {
      drafts[channel] = { title: "", body: raw, html: "" };
      const file = path.join(OUT_DIR, `${channel}.md`);
      await writeFile(file, raw + "\n", "utf8");
      console.log(`[draft] wrote ${file} (${raw.length} chars)`);
    }
  }

  // 채널별 산출물을 outputs/drafts.json 으로 저장 → compose-comment.mjs 가 읽어서 코멘트 조립.
  const draftsJson = path.join(OUT_DIR, "drafts.json");
  await writeFile(draftsJson, JSON.stringify(drafts, null, 2), "utf8");
  console.log(`[draft] wrote ${draftsJson}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

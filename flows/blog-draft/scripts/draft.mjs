#!/usr/bin/env node
// 채널별로 Gemini를 호출해 초안을 생성한다.
// 입력: outputs/issue.json, outputs/trends.json, outputs/images.json
//       flows/blog-draft/prompts/system.md, prompts/{naver|ig}-style.md
// 출력: outputs/{channel}.md, outputs/comment.md

import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convert as mdToNaverHtml } from "@jjlabsio/md-to-naver-blog";

const ROOT = process.cwd();
const FLOW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMPTS_DIR = path.join(FLOW_DIR, "prompts");
const NAVER_SAMPLES_DIR = path.join(PROMPTS_DIR, "samples/naver");
const OUT_DIR = path.resolve("outputs");
const NAVER_REFERENCE_TOP_N = 3;

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

// samples/naver/*.md 중 frontmatter pubDate 내림차순 top-N 의 본문 섹션을 반환한다.
// archive/ 하위는 무시. corpus-refresh.yml 가 매일 rolling window 로 관리.
// 각 항목: { logNo, pubDate, body } — body 는 `---` 다음 문단 그대로 (위젯 chrome,
// 이미지 마커, 줄바꿈 모두 보존).
async function loadRecentNaverSamples(n) {
  let entries;
  try {
    entries = await readdir(NAVER_SAMPLES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const samples = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const md = await readFile(path.join(NAVER_SAMPLES_DIR, e.name), "utf8");
    const pubMatch = md.match(/^-\s*pubDate:\s*(\d{4}-\d{2}-\d{2})/m);
    const logMatch = md.match(/^-\s*logNo:\s*(\d+)/m);
    const sepIdx = md.indexOf("\n---\n");
    if (sepIdx < 0) continue;
    const body = md.slice(sepIdx + "\n---\n".length).trim();
    samples.push({
      logNo: logMatch ? logMatch[1] : e.name.replace(/\.md$/, ""),
      pubDate: pubMatch ? pubMatch[1] : "",
      body,
    });
  }
  samples.sort((a, b) =>
    (b.pubDate || "0000-00-00").localeCompare(a.pubDate || "0000-00-00"),
  );
  return samples.slice(0, n);
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
    "[위젯 chrome — 카카오 필수, 매장/지도는 선택]",
    "- 카카오 채널 chrome 은 CTA 끝에 항상 출력 (후기 톤의 마무리 패턴). 매장 박스·지도 위젯은 광고 톤이 강해지므로 1/3 이하 글에서만 선택적으로 사용.",
    "- 매장 위치를 명시해야 하는 안내성 글이 아니면 카카오 chrome 만 두고, 매장명·주소는 본문 단락 안에서 평문으로 자연스럽게 흘리는 것을 우선.",
    "- 사용 시 다음 정확한 single-line raw chrome 으로 본문에 출력. 운영자가 그대로 네이버 에디터에 붙여넣으면 카드로 렌더된다.",
    "",
    "  카카오 채널 링크 (필수 — CTA 끝, 카카오 안내 이미지 마커 직후, query 는 반드시 state=hanam,blog):",
    "  `[**카카오톡**pf-link.kakao.com](https://pf-link.kakao.com/qr/_xeMISK/pages/_Hxh?query=state=hanam,blog)`",
    "",
    "  매장 박스 (선택, 매장 안내성 글에만 — 후기 톤에선 미사용 권장):",
    "  `[**컬컴 하남점**경기도 하남시 미사강변중앙로204번길 22 마이움센트럴아케이드 201호, 202호](#)`",
    "",
    "  네이버 지도 위젯 (선택, 위치 강조가 필요한 글에만 — 후기 톤에선 미사용 권장):",
    "  `[**네이버지도**컬컴 하남점map.naver.com](https://map.naver.com/p/entry/place/1965780250)`",
    "",
    "- 위 chrome 블록은 글자·괄호·URL 한 글자도 바꾸지 말 것. 줄바꿈 넣지 말 것 (반드시 single-line).",
    "- plain `[카카오톡](url)` 으로 압축하거나 다른 query 값 사용 금지.",
    "- 매장 박스 + 지도 + 카카오 3 chrome 을 한 글에 다 넣는 패턴은 광고 톤 신호. 카카오 chrome 하나만 두는 것이 후기 톤의 기본.",
    "",
    "[줄바꿈 규칙 — 한 줄 18~28자 권장, 어구·호흡 단위 우선]",
    "- 본문 한 줄은 18~28자 사이가 자연스러움. 한 문장이 16자 이내로 짧으면 한 줄로 두어도 OK.",
    "- 어구 (`~할 때만 해도`, `~정말 편했어요`) 를 가운데서 자르지 말 것. 어절·종속절 경계에서만 줄바꿈.",
    "- 24자 안에 강제로 맞추려고 자연스러운 어구를 두 동강 내지 말 것. 의미·호흡이 우선.",
    "- 단락 사이에는 빈 줄을 1~2개 적극적으로 넣어 모바일 호흡감을 만든다 (sample 다수 패턴).",
    "- 단, 위젯 chrome 라인 (매장 박스 / 지도 / 카카오) 과 마지막 해시태그 한 줄은 single-line 유지 — 줄바꿈 금지.",
    "",
    "[종결·이모지 다양화 — 자연스러움의 핵심]",
    "- 단락의 마지막 문장 종결을 의식적으로 다양화. 마침표 (`~했어요.`) 종결은 전체의 30% 이하로만.",
    "- 말줄임 (`~했었는데...`, `~편했던..!!`), 다중느낌표 (`~생겼어요!!`, `~튀어나오더라고요..!!`), 한글 의성/감탄 (`~생생해요 ㅋㅋㅋㅋㅋ`, `~배웠답니다 ㅎㅎ`, `~왕초보였거든요... ㅠ`) 를 sample 비율로 섞을 것.",
    "- 본문 안 이모지는 페르소나에 맞춰 1~3개 (🥹 💕 😍 🥰 🤍 👋🏼 등). 한 단락에 두 개 이상 X.",
    "- 모든 단락이 마침표로 끝나면 즉시 모델 글로 인식된다. 의식적으로 섞을 것.",
    "",
    "[구어 필러·내면 표면화]",
    "- 자연스러운 1인칭 구어 필러 (`되게`, `뭔가`, `진짜`, `막`) 를 글 전체에 1~2회 정도 흘릴 것 (남용 금지).",
    "- 외관·사실 묘사만으로 끝내지 말고 1인칭 내면 동기·감정·신체 반응 한두 문장을 함께 표면화: `겁이 났다`, `매번 실패한 나에게 속상하고 화도 나서`, `손에서 땀이 났다`, `두려웠다`.",
    "",
    "[모델 누출 금지]",
    "- `update_topic(...)`, `<ctrl##>`, `strategic_intent:`, `tool_call`, `function_call` 같은 도구호출 메타데이터 절대 출력 금지.",
  ].join("\n");
  if (imageCount <= 3) {
    return [
      `- 분량: 본문 1,200~3,000자. (이미지 ${imageCount}장)`,
      "- 구조: 한 가지 인상·에피소드에 집중. 텍스트 단락 5~10개 (단락 사이 빈 줄 별도).",
      "- 사진을 본문 자연스러운 흐름에 1~2번 인용하며 마커 위치 표시.",
      "- 섹션 헤더 (`> **헤더**` / 번호Bold / 이모지Bold) 는 도입하지 말 것 — 자연 흐름으로 충분.",
      imagePlacement,
    ].join("\n");
  }
  if (imageCount <= 9) {
    return [
      `- 분량: 본문 1,700~4,500자. (이미지 ${imageCount}장)`,
      "- 구조: 표준 후기 골격. 텍스트 단락 7~12개 (단락 사이 빈 줄 별도).",
      "- 섹션 헤더는 필요 시 0~2개. 헤더 없이 자연 흐름으로 전환하는 것이 가장 자연스러움. 헤더가 명확히 필요하면 (인용블록 / 번호Bold / 이모지Bold 중) 한 종류로만 통일.",
      "- 사진을 본문 흐름에 분산 배치하고 마커 한 줄로 표시.",
      imagePlacement,
    ].join("\n");
  }
  if (imageCount <= 14) {
    return [
      `- 분량: 본문 2,800~5,500자. (이미지 ${imageCount}장)`,
      "- 구조: 페르소나 동기 + 본문 + 결론. 텍스트 단락 9~14개 (단락 사이 빈 줄 별도, 빈 줄 포함 시 총 라인 수가 더 늘어남).",
      "- 섹션 헤더는 필요 시 0~3개. **헤더 없이 자연 흐름으로 전환하는 것이 짧은 후기에선 가장 자연스러움**. 첫째/둘째/셋째 enumeration 도 헤더 없이 본문 안에 흘려쓰는 것이 흔함.",
      "- 마지막에 '이런 분들께 추천' / '달라진 점 N가지' 같은 결론 단락은 선택 (헤더 없이 평문으로도 OK).",
      imagePlacement,
    ].join("\n");
  }
  return [
    `- 분량: 본문 3,500~5,500자. (이미지 ${imageCount}장)`,
    "- 구조: 테마 후크 + 본문 + 위치 안내까지 풍성하게. 텍스트 단락 12~18개 (단락 사이 빈 줄 별도).",
    "- 큰 흐름이 명확히 갈리면 섹션 헤더 2~4개 도입 (한 종류로 통일). 갈리지 않으면 헤더 없이 자연 흐름도 OK.",
    "- 마지막에 위치·접근성 단락 1개 포함은 선택.",
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

function buildReferenceBlock(samples) {
  if (!samples || !samples.length) return null;
  const lines = [
    "===== 레퍼런스 샘플 (실제 발행글 최근 " + samples.length + "개, 톤·구조 모방 참고) =====",
    "(아래 샘플들의 어휘·문장·이미지 캡션을 그대로 베끼지 말 것. 톤·문단 길이·섹션 흐름·위젯 위치 패턴만 참고하라. 실제 출력은 첨부된 사진과 운영자 입력 기반으로 새로 작성.)",
    "",
  ];
  samples.forEach((s, i) => {
    lines.push(`--- 샘플 ${i + 1} (logNo=${s.logNo}, pubDate=${s.pubDate}) ---`);
    lines.push(s.body);
    lines.push("");
  });
  return lines.join("\n");
}

function buildPrompt({ channel, style, samples }) {
  const imageCount = images.downloaded.length;
  const imageRefs = images.downloaded
    .map((d, i) => `@${path.relative(ROOT, d.file)} (#${i + 1})`)
    .join(" ");
  const lengthGuide =
    channel === "naver" ? naverLengthGuide(imageCount) : igLengthGuide(imageCount);
  const referenceBlock =
    channel === "naver" ? buildReferenceBlock(samples) : null;
  return [
    imageRefs,
    "",
    "===== 시스템 프롬프트 =====",
    systemMd,
    "",
    `===== 채널: ${channelLabel[channel]} 스타일 가이드 =====`,
    style,
    "",
    ...(referenceBlock ? [referenceBlock, ""] : []),
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
    "===== 트렌드 키워드 (선택 — 디폴트 0개. 사진/메모와 강한 연결이 있을 때만 1개) =====",
    "본론(페르소나 동기·회고)으로 바로 진입하는 패턴이 sample 다수의 자연스러운 형태다. 첫 단락에 시즌 인사+트렌드를 자동으로 끼워 넣지 말 것.",
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
    const samples =
      channel === "naver" ? await loadRecentNaverSamples(NAVER_REFERENCE_TOP_N) : [];
    if (channel === "naver") {
      console.log(
        `[draft] naver reference samples: ${samples.map((s) => `${s.logNo}@${s.pubDate}`).join(", ") || "(none)"}`,
      );
    }
    const prompt = buildPrompt({ channel, style, samples });
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

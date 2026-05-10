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

// 네이버 블로그: 이미지 수에 따른 분량·구조 가이드
function naverLengthGuide(imageCount) {
  const imagePlacement = [
    "",
    "[이미지 위치 표기 — 필수]",
    `- 본문에 첨부된 ${imageCount}장의 사진이 들어갈 자리를 모두 표시한다.`,
    "- 형식: `[이미지 #N: 한 줄 묘사]` (예: `[이미지 #1: 멤버분들이 둘러앉아 발표 자료를 보는 모습]`)",
    `- N은 1부터 ${imageCount}까지 정확히 매칭. 같은 번호 두 번 쓰지 말고, 모든 번호가 본문 어딘가에 등장해야 한다.`,
    "- 한 줄 묘사는 사진을 직접 관찰해 분위기·구도·소품 중심으로 짧게 (15자 이내).",
    "- 마크다운 이미지 문법 `![](url)` 으로 쓰지 말 것 — 운영자가 네이버 에디터에서 직접 사진을 끌어 올린다.",
  ].join("\n");
  if (imageCount <= 1) {
    return [
      "- 분량: 본문 1,200~1,800자.",
      "- 구조: 한 가지 인상·에피소드에 집중하는 짧은 후기. 단락 5~7개.",
      "- 사진은 본문 도입 후 한 곳(중간)에 `[이미지 #1: ...]` 한 줄로 위치 표시.",
      imagePlacement,
    ].join("\n");
  }
  if (imageCount <= 3) {
    return [
      `- 분량: 본문 2,000~2,800자. (이미지 ${imageCount}장)`,
      "- 구조: 표준 후기 골격. 단락 7~10개.",
      "- 각 사진을 자연스러운 흐름에 1번씩 인용하며 단락 사이에 위치 표시.",
      imagePlacement,
    ].join("\n");
  }
  return [
    `- 분량: 본문 3,000~3,800자. (이미지 ${imageCount}장)`,
    "- 구조: 풍성한 후기. 단락 10~14개.",
    "- 큰 흐름을 2~4개 소제목 섹션으로 나누고, 사진을 섹션마다 분산 배치.",
    "- 마지막 섹션에 추천 대상·다음 주 예고 같은 가벼운 마무리를 추가한다.",
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
    "각 사진을 자세히 관찰해 다음을 본문에 반영하라:",
    "- 분위기·계절감·시간대 (햇빛, 조명, 옷차림)",
    "- 장소·소품·테이블 위 자료(있을 경우)",
    "- 인물 수와 활동(대화·필기·웃는 모습 등) — 단, 실명·식별 가능한 외모 묘사 금지",
    "- 컬컴 하남 매장 인테리어 단서(LP샵/카페 같은 분위기)가 보이면 자연스럽게 반영",
    "사진에서 확인되지 않는 사실은 만들지 말 것.",
    "",
    "===== 분량·구조 가이드 (이미지 수 기반) =====",
    lengthGuide,
    "",
    "===== 운영자 입력 =====",
    `- 주제: ${issue.subject}`,
    `- 분위기/메모: ${issue.vibe || "(없음)"}`,
    `- 시기: ${issue.when}`,
    "",
    "===== 트렌드 키워드 (이 중 1~2개만 자연스럽게 녹여라) =====",
    JSON.stringify(trends, null, 2),
    "",
    "===== 작업 =====",
    `위 사진(들)과 입력을 바탕으로 ${channelLabel[channel]} 초안을 작성하라.`,
    "스타일 가이드의 길이·구조·톤을 우선 따르되, 이미지 수 기반 분량 가이드를 함께 만족시켜라.",
    "출력은 운영자가 그대로 복사해 붙여넣을 수 있는 본문 텍스트만. 코드블록·머리말·맺음 설명 금지.",
  ].join("\n");
}

function runGemini(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("gemini", ["--yolo", "-p", prompt], {
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

// Gemini가 출력한 마크다운을 mtnb로 변환해 제목/본문 마크다운/HTML을 얻는다.
// - title: 첫 H1 텍스트
// - bodyMd: H1 한 줄을 제거한 마크다운 (GitHub 코멘트 미리보기용)
// - html: 네이버 에디터 호환 HTML (운영자 클립보드 복사용)
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
  return {
    title: (result.title || (firstH1 ? firstH1[1].trim() : "")).trim(),
    bodyMd,
    html: result.html || "",
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
      raw = await runGemini(prompt);
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
      drafts[channel] = { title: "", body: raw };
      const file = path.join(OUT_DIR, `${channel}.md`);
      await writeFile(file, raw + "\n", "utf8");
      console.log(`[draft] wrote ${file} (${raw.length} chars)`);
    }
  }

  // Issue 코멘트 묶음 — 인스타 → 네이버 순서, 큰 제목으로 가독성 강화
  const lines = [];
  lines.push(`# 📝 자동 생성 초안`);
  lines.push("");
  lines.push(`- **주제**: ${issue.subject}`);
  lines.push(`- **분위기**: ${issue.vibe || "(없음)"}`);
  lines.push(`- **기준일**: ${issue.when}`);
  lines.push(`- **이미지**: ${images.downloaded.length}장`);
  lines.push("");
  lines.push(`<details><summary>참고한 트렌드 키워드</summary>`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(trends, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("</details>");
  lines.push("");
  lines.push("---");
  lines.push("");
  const channelEmoji = { insta: "📸", naver: "📰" };
  for (const channel of issue.channels) {
    lines.push(`# ${channelEmoji[channel]} ${channelLabel[channel]}`);
    lines.push("");
    if (channel === "naver" && drafts[channel].title) {
      lines.push("## 📝 제목");
      lines.push("");
      lines.push(drafts[channel].title);
      lines.push("");
      lines.push("## 📄 본문 (마크다운 미리보기)");
      lines.push("");
    }
    lines.push(drafts[channel].body);
    lines.push("");
    if (channel === "naver" && drafts[channel].html) {
      lines.push("<details>");
      lines.push(
        "<summary>🧩 네이버 에디터 호환 HTML (mtnb 변환 결과 — 클릭해서 펼친 뒤 복사)</summary>",
      );
      lines.push("");
      lines.push("```html");
      lines.push(drafts[channel].html);
      lines.push("```");
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }
  lines.push(
    `> 검토 후 그대로 또는 수정해 ${issue.channels.map((c) => channelLabel[c]).join(" → ")} 순으로 게시하세요.`,
  );
  if (issue.channels.includes("naver")) {
    lines.push(
      "> 📰 네이버 게시 방법:",
    );
    lines.push(
      "> - **간편**: 위 \"본문 (마크다운 미리보기)\" 섹션을 그대로 복사해 [mtnb.dev](https://mtnb.dev)에 붙여넣고 \"서식 복사\" 버튼 → 네이버 에디터에 붙여넣기.",
    );
    lines.push(
      "> - **직접**: \"네이버 에디터 호환 HTML\" 블록을 펼쳐 클립보드의 HTML을 그대로 복사해 네이버 에디터에 붙여넣기.",
    );
    lines.push(
      "> - 본문 안의 사진(\`![이미지 #N: ...](...)\`)은 미리보기용입니다. 네이버에 붙여넣은 뒤 그 자리에 실제 사진을 드래그해 교체해 주세요.",
    );
  }
  await writeFile(path.join(OUT_DIR, "comment.md"), lines.join("\n"), "utf8");
  console.log(`[draft] wrote outputs/comment.md`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

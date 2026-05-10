#!/usr/bin/env node
// outputs/{issue,trends,images,drafts}.json + env(NAVER_PREVIEW_URL 등)을 읽어
// outputs/comment.md 를 작성한다. draft.mjs 가 채널 산출물만 만든 뒤 호출한다.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = path.resolve("outputs");
const issue = JSON.parse(await readFile(path.join(OUT_DIR, "issue.json"), "utf8"));
const trends = JSON.parse(await readFile(path.join(OUT_DIR, "trends.json"), "utf8"));
const images = JSON.parse(await readFile(path.join(OUT_DIR, "images.json"), "utf8"));
const drafts = JSON.parse(await readFile(path.join(OUT_DIR, "drafts.json"), "utf8"));

const channelLabel = {
  naver: "네이버 블로그",
  insta: "인스타그램",
};
const channelEmoji = { insta: "📸", naver: "📰" };

const previewUrl = (process.env.NAVER_PREVIEW_URL || "").trim();

const lines = [];

// 1) 헤더 + 메타 정보
lines.push(`# 📝 자동 생성 초안`);
lines.push("");
lines.push(`- **주제**: ${issue.subject}`);
lines.push(`- **분위기**: ${issue.vibe || "(없음)"}`);
lines.push(`- **기준일**: ${issue.when}`);
lines.push(`- **이미지**: ${images.downloaded.length}장`);
lines.push("");

// 2) 트렌드 (접힌 상태)
lines.push(`<details><summary>참고한 트렌드 키워드</summary>`);
lines.push("");
lines.push("```json");
lines.push(JSON.stringify(trends, null, 2));
lines.push("```");
lines.push("");
lines.push("</details>");
lines.push("");

// 3) 채널별 섹션 (인스타 → 네이버 순)
for (const channel of issue.channels) {
  const draft = drafts[channel] || { title: "", body: "", html: "" };
  lines.push(`# ${channelEmoji[channel]} ${channelLabel[channel]}`);
  lines.push("");

  // 네이버 채널이면 헤더 바로 밑에 🚀 미리보기 배너를 깐다.
  if (channel === "naver" && previewUrl) {
    lines.push("## 🚀 네이버 서식 복사용 미리보기");
    lines.push("");
    lines.push(`### 👉 **[새 탭에서 열기](${previewUrl})**`);
    lines.push("");
    lines.push(
      "> 위 링크를 새 탭에서 열고 **Cmd-A → Cmd-C → 네이버 에디터 붙여넣기**. 헤딩·볼드·리스트·인용 서식이 그대로 살아납니다.",
    );
    lines.push("> ");
    lines.push(
      "> 코멘트 안의 마크다운/HTML을 직접 복사하면 GitHub 살균 정책으로 서식이 사라지므로 반드시 위 링크를 사용해 주세요.",
    );
    lines.push("");
  }

  if (channel === "naver" && draft.title) {
    lines.push("## 📝 제목");
    lines.push("");
    lines.push(draft.title);
    lines.push("");
    lines.push("## 📄 본문 (마크다운 미리보기)");
    lines.push("");
  }

  lines.push(draft.body);
  lines.push("");

  lines.push("---");
  lines.push("");
}

// 4) 게시 안내
lines.push(
  `> 검토 후 그대로 또는 수정해 ${issue.channels.map((c) => channelLabel[c]).join(" → ")} 순으로 게시하세요.`,
);
if (issue.channels.includes("naver")) {
  if (previewUrl) {
    lines.push(
      "> 📰 네이버: 위 **🚀 미리보기 링크**에서 Cmd-A → Cmd-C → 네이버 에디터 붙여넣기.",
    );
  } else {
    lines.push(
      "> 📰 네이버: 코멘트 안 마크다운을 [mtnb.dev](https://mtnb.dev)에 붙여넣고 \"서식 복사\" → 네이버 에디터에 붙여넣기.",
    );
  }
  lines.push(
    "> - 본문 안의 사진(\`![이미지 #N: ...](...)\`)이 네이버에서 깨져 보이면 그 자리에 실제 사진을 드래그해 교체해 주세요.",
  );
}

await mkdir(OUT_DIR, { recursive: true });
await writeFile(path.join(OUT_DIR, "comment.md"), lines.join("\n"), "utf8");
console.log(
  `[compose-comment] wrote outputs/comment.md (preview=${previewUrl ? "yes" : "no"}, channels=${issue.channels.join(",")})`,
);

#!/usr/bin/env node
// 채널별로 Gemini를 호출해 초안을 생성한다.
// 입력: outputs/issue.json, outputs/trends.json, outputs/images.json
//       prompts/system.md, prompts/{naver|ig}-style.md
// 출력: outputs/{channel}.md, outputs/comment.md

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const OUT_DIR = path.resolve("outputs");

const issue = JSON.parse(await readFile(path.join(OUT_DIR, "issue.json"), "utf8"));
const trends = JSON.parse(await readFile(path.join(OUT_DIR, "trends.json"), "utf8"));
const images = JSON.parse(await readFile(path.join(OUT_DIR, "images.json"), "utf8"));
const systemMd = await readFile(path.resolve("prompts/system.md"), "utf8");

const styleFiles = {
  naver: "prompts/naver-style.md",
  insta: "prompts/ig-style.md",
};
const channelLabel = {
  naver: "네이버 블로그",
  insta: "인스타그램",
};

async function readStyle(channel) {
  try {
    return await readFile(path.resolve(styleFiles[channel]), "utf8");
  } catch {
    return `# ${channelLabel[channel]} 스타일 가이드\n(가이드 파일이 비어있음 — 일반 톤으로 작성)\n`;
  }
}

function buildPrompt({ channel, style }) {
  const imageRefs = images.downloaded.map((d) => `@${path.relative(ROOT, d.file)}`).join(" ");
  return [
    imageRefs,
    "",
    "===== 시스템 프롬프트 =====",
    systemMd,
    "",
    `===== 채널: ${channelLabel[channel]} 스타일 가이드 =====`,
    style,
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
    "스타일 가이드의 길이·구조·톤을 우선 따른다.",
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

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const drafts = {};
  for (const channel of issue.channels) {
    console.log(`[draft] channel=${channel}`);
    const style = await readStyle(channel);
    const prompt = buildPrompt({ channel, style });
    let body;
    try {
      body = await runGemini(prompt);
    } catch (e) {
      body = `(생성 실패: ${e.message})`;
    }
    const file = path.join(OUT_DIR, `${channel}.md`);
    await writeFile(file, body + "\n", "utf8");
    drafts[channel] = body;
    console.log(`[draft] wrote ${file} (${body.length} chars)`);
  }

  // Issue 코멘트 묶음
  const lines = [];
  lines.push(`## 자동 생성 초안`);
  lines.push("");
  lines.push(`- 주제: ${issue.subject}`);
  lines.push(`- 분위기: ${issue.vibe || "(없음)"}`);
  lines.push(`- 기준일: ${issue.when}`);
  lines.push(`- 이미지: ${images.downloaded.length}장`);
  lines.push("");
  lines.push(`<details><summary>참고한 트렌드 키워드</summary>`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(trends, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("</details>");
  lines.push("");
  for (const channel of issue.channels) {
    lines.push(`### ✏️ ${channelLabel[channel]}`);
    lines.push("");
    lines.push(drafts[channel]);
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  lines.push(`> 검토 후 그대로 또는 수정해 ${issue.channels.map((c) => channelLabel[c]).join(" / ")}에 게시하세요.`);
  await writeFile(path.join(OUT_DIR, "comment.md"), lines.join("\n"), "utf8");
  console.log(`[draft] wrote outputs/comment.md`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

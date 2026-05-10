#!/usr/bin/env node
// Gemini CLI를 호출해 트렌드 키워드를 JSON으로 받아 outputs/trends.json 저장.
// 실패 시 빈 구조의 fallback JSON을 저장하고 0으로 종료(파이프라인 계속).

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FLOW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ISSUE_JSON = path.resolve("outputs/issue.json");
const TREND_PROMPT = path.join(FLOW_DIR, "prompts/trend-research.md");
const OUT = path.resolve("outputs/trends.json");

await mkdir(path.dirname(OUT), { recursive: true });

const issue = JSON.parse(await readFile(ISSUE_JSON, "utf8"));
const date = issue.when || issue.today;
const tmpl = await readFile(TREND_PROMPT, "utf8");
const prompt = tmpl.replace(/\{\{DATE\}\}/g, date);

function runGemini(p) {
  return new Promise((resolve, reject) => {
    const child = spawn("gemini", ["--yolo", "-p", p], {
      env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`gemini exit ${code}: ${err.slice(0, 500)}`));
      } else {
        resolve(out);
      }
    });
  });
}

function extractJson(text) {
  // 첫 '{' 부터 마지막 '}' 까지를 추출 (Gemini가 가끔 설명 붙임)
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e === -1 || e <= s) return null;
  const slice = text.slice(s, e + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

const fallback = {
  english_topics: [],
  local_seasonal: [],
  ig_hashtags: [],
  _note: "trend fetch fallback (parse 실패 또는 gemini 호출 실패)",
};

let trends = fallback;
try {
  console.log(`[fetch-trends] gemini call (date=${date})`);
  const out = await runGemini(prompt);
  const parsed = extractJson(out);
  if (parsed && Array.isArray(parsed.english_topics)) {
    trends = parsed;
    console.log(`[fetch-trends] parsed JSON ok`);
  } else {
    console.warn(`[fetch-trends] JSON parse 실패, fallback 사용. raw:\n${out.slice(0, 500)}`);
  }
} catch (e) {
  console.warn(`[fetch-trends] gemini fail: ${e.message}`);
}

await writeFile(OUT, JSON.stringify(trends, null, 2), "utf8");
console.log(`[fetch-trends] wrote ${OUT}`);
console.log(JSON.stringify(trends, null, 2));

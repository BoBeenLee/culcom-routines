#!/usr/bin/env node
// outputs/issue.json 의 imageUrls를 ./inputs/ 로 다운로드.
// GitHub user-attachments는 보통 익명 다운로드 가능, 단 일부는 토큰 필요.
// GITHUB_TOKEN이 있으면 Bearer 헤더로 인증해서 fetch.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

const ISSUE_JSON = path.resolve("outputs/issue.json");
const IN_DIR = path.resolve("inputs");
const TOKEN = process.env.GITHUB_TOKEN || "";

const issue = JSON.parse(await readFile(ISSUE_JSON, "utf8"));
await mkdir(IN_DIR, { recursive: true });

function extFromUrl(url) {
  const u = new URL(url);
  const m = u.pathname.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : "bin";
}

const downloaded = [];
let i = 0;
for (const url of issue.imageUrls) {
  i++;
  const headers = {
    "User-Agent": "culcom-routines/0.1",
    Accept: "image/*,*/*;q=0.8",
  };
  if (TOKEN && /github\.com\/user-attachments/.test(url)) {
    headers.Authorization = `Bearer ${TOKEN}`;
  }
  let res;
  try {
    res = await fetch(url, { headers, redirect: "follow" });
  } catch (e) {
    console.warn(`[extract-images] fetch fail ${url}: ${e.message}`);
    continue;
  }
  if (!res.ok) {
    console.warn(`[extract-images] HTTP ${res.status} ${url}`);
    continue;
  }
  const ct = res.headers.get("content-type") || "";
  const ext =
    ct.includes("png") ? "png"
    : ct.includes("webp") ? "webp"
    : ct.includes("gif") ? "gif"
    : ct.includes("heic") ? "heic"
    : ct.includes("jpeg") || ct.includes("jpg") ? "jpg"
    : extFromUrl(url);
  const file = path.join(IN_DIR, `img${String(i).padStart(2, "0")}.${ext}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(file, buf);
  downloaded.push({ url, file, bytes: buf.length });
  console.log(`[ok] ${file} (${buf.length}B) ← ${url}`);
}

await writeFile(
  path.resolve("outputs/images.json"),
  JSON.stringify({ downloaded }, null, 2),
);

if (downloaded.length === 0) {
  console.error(`[extract-images] 다운로드된 이미지 0개`);
  process.exit(4);
}
console.log(`[extract-images] ${downloaded.length} files in ${IN_DIR}`);

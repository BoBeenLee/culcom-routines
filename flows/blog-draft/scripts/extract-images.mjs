#!/usr/bin/env node
// outputs/issue.json 의 imageUrls를 ./inputs/ 로 다운로드.
// GitHub user-attachments는 보통 익명 다운로드 가능, 단 일부는 토큰 필요.
// GITHUB_TOKEN이 있으면 Bearer 헤더로 인증해서 fetch.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import heicConvert from "heic-convert";

const ISSUE_JSON = path.resolve("outputs/issue.json");
const IN_DIR = path.resolve("inputs");
const TOKEN = process.env.GITHUB_TOKEN || "";

const MAX_DIM = 1600;
const JPEG_QUALITY = 88;

async function normalizeImage(buf, ext) {
  if (ext === "heic" || ext === "heif") {
    const jpegBuf = await heicConvert({ buffer: buf, format: "JPEG", quality: 1 });
    buf = Buffer.from(jpegBuf);
    ext = "jpg";
  }
  if (ext === "gif") return { buf, ext };
  let meta;
  try {
    meta = await sharp(buf).metadata();
  } catch {
    return { buf, ext };
  }
  const longEdge = Math.max(meta.width || 0, meta.height || 0);
  const needsResize = longEdge > MAX_DIM;
  if (!needsResize && ext !== "jpg" && ext !== "jpeg") {
    return { buf, ext };
  }
  let pipeline = sharp(buf).rotate();
  if (needsResize) {
    pipeline = pipeline.resize({ width: MAX_DIM, height: MAX_DIM, fit: "inside", withoutEnlargement: true });
  }
  if (ext === "jpg" || ext === "jpeg") {
    return { buf: await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer(), ext: "jpg" };
  }
  if (ext === "png") {
    return { buf: await pipeline.png({ compressionLevel: 9 }).toBuffer(), ext: "png" };
  }
  if (ext === "webp") {
    return { buf: await pipeline.webp({ quality: JPEG_QUALITY }).toBuffer(), ext: "webp" };
  }
  return { buf, ext };
}

const issue = JSON.parse(await readFile(ISSUE_JSON, "utf8"));
await mkdir(IN_DIR, { recursive: true });

function extFromUrl(url) {
  const u = new URL(url);
  const m = u.pathname.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : "bin";
}

// Private 레포의 user-attachments는 GitHub 토큰으로 인증해야 302 redirect를 받는다.
// 그러나 S3 presigned URL은 Authorization 헤더가 있으면 거부하므로, 수동으로 redirect를
// 처리해서 1차(github.com)에는 토큰을, 2차(s3.amazonaws.com)에는 토큰 없이 fetch한다.
async function fetchAttachment(url) {
  const isUserAttachment = /github\.com\/user-attachments/.test(url);
  if (!isUserAttachment) {
    return await fetch(url, {
      headers: {
        "User-Agent": "culcom-routines/0.1",
        Accept: "image/*,*/*;q=0.8",
      },
      redirect: "follow",
    });
  }
  // 1차: github.com (수동 redirect)
  const headers = {
    "User-Agent": "culcom-routines/0.1",
    Accept: "image/*,*/*;q=0.8",
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  let cur = await fetch(url, { headers, redirect: "manual" });
  let hops = 0;
  while ((cur.status === 301 || cur.status === 302 || cur.status === 303 || cur.status === 307 || cur.status === 308) && hops < 5) {
    const next = cur.headers.get("location");
    if (!next) break;
    const nextUrl = new URL(next, url).href;
    const sameOrigin = new URL(nextUrl).origin === new URL(url).origin;
    cur = await fetch(nextUrl, {
      headers: sameOrigin ? headers : { "User-Agent": headers["User-Agent"], Accept: headers.Accept },
      redirect: "manual",
    });
    hops++;
  }
  return cur;
}

const downloaded = [];
let i = 0;
for (const url of issue.imageUrls) {
  i++;
  let res;
  try {
    res = await fetchAttachment(url);
  } catch (e) {
    console.warn(`[extract-images] fetch fail ${url}: ${e.message}`);
    continue;
  }
  if (!res.ok) {
    console.warn(`[extract-images] HTTP ${res.status} ${url}`);
    if (res.status === 404 && /github\.com\/user-attachments/.test(url)) {
      console.warn(
        `  → Private 레포의 user-attachments는 자동 GITHUB_TOKEN으로 접근할 수 없다.\n` +
          `    개인 PAT(repo scope)를 생성해 ATTACHMENTS_PAT secret에 등록하면 해결된다.\n` +
          `    https://github.com/settings/tokens/new?scopes=repo&description=culcom-routines%20attachments`,
      );
    }
    continue;
  }
  const ct = res.headers.get("content-type") || "";
  let ext =
    ct.includes("png") ? "png"
    : ct.includes("webp") ? "webp"
    : ct.includes("gif") ? "gif"
    : ct.includes("heic") || ct.includes("heif") ? "heic"
    : ct.includes("jpeg") || ct.includes("jpg") ? "jpg"
    : extFromUrl(url);
  let buf = Buffer.from(await res.arrayBuffer());
  const originalBytes = buf.length;
  try {
    const normalized = await normalizeImage(buf, ext);
    buf = normalized.buf;
    ext = normalized.ext;
  } catch (e) {
    console.warn(`[extract-images] normalize 실패 (원본 유지) ${url}: ${e.message}`);
  }
  const file = path.join(IN_DIR, `img${String(i).padStart(2, "0")}.${ext}`);
  await writeFile(file, buf);
  downloaded.push({ url, file, bytes: buf.length, originalBytes });
  console.log(`[ok] ${file} (${buf.length}B, 원본 ${originalBytes}B) ← ${url}`);
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

#!/usr/bin/env node
// 네이버 블로그(blog.naver.com/culcom-) 최근 글 수집 → flows/blog-draft/prompts/samples/naver/
// 1회성 스크립트. 실행: node flows/blog-draft/scripts/scrape-naver.mjs [--limit 5]

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const FLOW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BLOG_ID = "culcom-";
const RSS_URL = `https://rss.blog.naver.com/${BLOG_ID}.xml`;
const OUT_DIR = path.join(FLOW_DIR, "prompts/samples/naver");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const args = process.argv.slice(2);
const limit = Number(args[args.indexOf("--limit") + 1]) || 5;

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return await res.text();
}

async function getRecentPosts() {
  const xml = await fetchText(RSS_URL);
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  $("item").each((_, el) => {
    const title = $(el).find("title").text().trim();
    const link = $(el).find("link").text().trim();
    const pubDate = $(el).find("pubDate").text().trim();
    const m =
      link.match(/logNo=(\d+)/) ||
      link.match(/\/(\d{6,})(?:[/?#]|$)/);
    const logNo = m ? m[1] : null;
    if (logNo) items.push({ title, link, pubDate, logNo });
  });
  return items.slice(0, limit);
}

async function getPostBody(logNo) {
  const url = `https://blog.naver.com/PostView.naver?blogId=${BLOG_ID}&logNo=${logNo}&redirect=Dlog&widgetTypeCall=true&directAccess=false`;
  const html = await fetchText(url);
  const $ = cheerio.load(html);
  // SmartEditor3
  let body = $(".se-main-container").text().trim();
  if (!body) body = $("#postViewArea").text().trim();
  if (!body) body = $(".post_ct").text().trim();
  return body.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`[scrape-naver] RSS: ${RSS_URL}`);
  const posts = await getRecentPosts();
  console.log(`[scrape-naver] Found ${posts.length} posts`);

  let saved = 0;
  for (const p of posts) {
    try {
      const body = await getPostBody(p.logNo);
      if (!body || body.length < 80) {
        console.warn(`[skip] ${p.logNo} body too short (${body.length}) — fallback recommended`);
        continue;
      }
      const file = path.join(OUT_DIR, `${p.logNo}.md`);
      const md = [
        `# ${p.title}`,
        ``,
        `- pubDate: ${p.pubDate}`,
        `- url: ${p.link}`,
        `- logNo: ${p.logNo}`,
        ``,
        `---`,
        ``,
        body,
        ``,
      ].join("\n");
      await writeFile(file, md, "utf8");
      saved++;
      console.log(`[ok] ${file}`);
    } catch (e) {
      console.warn(`[fail] ${p.logNo}: ${e.message}`);
    }
  }
  console.log(`[scrape-naver] Saved ${saved}/${posts.length} → ${OUT_DIR}`);
  if (saved === 0) {
    console.error(
      `[scrape-naver] 모두 실패. Claude Chrome MCP fallback이 필요합니다.\n` +
        `  - mcp__Claude_in_Chrome__navigate 로 글 URL 접근 후\n` +
        `  - get_page_text 로 본문을 ${OUT_DIR}/<logNo>.md 에 저장`,
    );
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

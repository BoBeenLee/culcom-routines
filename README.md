# culcom-routines

컬컴 영어회화 하남 지점의 **블로그/인스타 초안 자동 생성** 시스템.

운영자가 GitHub Issue에 사진과 짧은 메모를 올리면, GitHub Actions가 Gemini를 호출해 네이버 블로그 / 인스타그램 두 채널의 초안을 생성하고 같은 이슈에 코멘트로 달아준다. 자동 게시는 하지 않는다 — 운영자가 검토 후 직접 붙여넣는다.

## 운영자 사용법

1. GitHub 레포의 **Issues → New issue → "블로그/인스타 초안 요청"** 템플릿 선택.
2. 사진을 본문에 드래그&드롭으로 첨부 (필수).
3. 나머지는 비워둬도 OK. 채널 드롭다운 기본값은 "둘 다 (기본)".
4. 제출하면 1~3분 안에 같은 이슈에 초안 코멘트가 달린다.
5. 코멘트의 본문을 복사해 네이버 블로그 / 인스타그램에 붙여넣어 게시.

다시 생성하고 싶으면 이슈에서 `drafted` 라벨을 떼고 다시 부여하면 새로 돈다.

## 동작

```
Issue (이미지 첨부) → workflow trigger
  → parse-issue.mjs   (폼 본문 파싱, 채널 라벨 부여)
  → extract-images.mjs (이미지 다운로드)
  → fetch-trends.mjs   (Gemini로 최근 트렌드 키워드 JSON)
  → draft.mjs          (스타일 가이드 + 트렌드 + 사진 → 채널별 초안 생성)
  → gh issue comment   (한 코멘트에 트렌드 메타 + 채널별 초안)
```

## 핵심 파일

| 경로 | 설명 |
| --- | --- |
| `.github/workflows/blog-draft.yml` | 메인 워크플로우 |
| `.github/workflows/gemini.yml` | Gemini OAuth 만료 방지용 smoke test (기존) |
| `.github/ISSUE_TEMPLATE/blog-draft.yml` | 이슈 입력 폼 |
| `prompts/system.md` | 공통 시스템 프롬프트 |
| `prompts/naver-style.md` | 네이버 블로그 톤·구조 가이드 |
| `prompts/ig-style.md` | 인스타 캡션·해시태그 가이드 |
| `prompts/trend-research.md` | 트렌드 리서치 단계 프롬프트 |
| `prompts/samples/naver/*` | 네이버 블로그 최근 글 raw 텍스트 |
| `prompts/samples/ig/*` | 인스타 캡션 raw 텍스트 |
| `scripts/*.mjs` | 워크플로우 단계별 노드 스크립트 |

## 셋업이 처음 끝날 때 필요한 것

- GitHub repo secrets:
  - `GEMINI_OAUTH_CREDS` — Gemini CLI OAuth 자격 증명(base64). [.github/workflows/gemini.yml](.github/workflows/gemini.yml)와 동일.
  - `GITHUB_TOKEN` — Actions 기본 토큰 (자동).
- Issue 라벨 (워크플로우가 자동 부여하지만 사전 생성 권장):
  - `draft-request`, `naver`, `insta`, `drafted`, `error`

## 스타일 가이드 갱신

1년에 한 번 정도 다음을 다시 돌려 샘플과 가이드를 최신화한다.

```bash
# 네이버 (RSS + cheerio, 1차)
npm ci
node scripts/scrape-naver.mjs --limit 5

# 인스타는 Claude Chrome MCP 또는 운영자가 캡션 텍스트로 직접 prompts/samples/ig/ 에 추가
# 그 후 prompts/{naver,ig}-style.md 를 사람 손으로 보강
```

## 직접 실행 / 디버깅

워크플로우를 흉내내서 로컬에서 dry-run:

```bash
export ISSUE_BODY="$(cat <<'EOF'
### 채널

둘 다 (기본)

### 주제 / 수업 종류 (선택)

5월 둘째주 성인 회화

### 분위기 / 강조 포인트 (선택)

발표 수업, 학생들 많이 웃었음

### 시기 / 날짜 (선택, 트렌드 리서치 기준)

2026-05-10

### 사진 (이 영역에 드래그&드롭) — 필수

![](https://example.com/sample.jpg)
EOF
)"

node scripts/parse-issue.mjs
node scripts/extract-images.mjs   # 실제 이미지 URL이 필요
node scripts/fetch-trends.mjs     # gemini CLI 필요
node scripts/draft.mjs
cat outputs/comment.md
```

## 향후

- Instagram Graph API 자동 게시 (Business 계정 + FB 페이지 연결 필요)
- 네이버 블로그 Playwright 자동 게시 (쿠키 secret 관리 필요)
- 당근(Daangn) 비즈프로필 동시 갱신

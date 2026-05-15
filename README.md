# culcom-routines

컬컴 영어회화 하남 지점 운영 자동화 모음. 첫 번째 flow는 **블로그/인스타 초안 자동 생성**(`flows/blog-draft/`).

## 구조 — 여러 flow를 prefix로 분리

```
.github/
  workflows/
    blog-draft.yml          (flow별 워크플로우, 파일명에 prefix)
    gemini.yml              (공통 OAuth smoke test)
  ISSUE_TEMPLATE/
    blog-draft.yml          (flow별 입력 폼, 파일명에 prefix)
    config.yml
flows/
  blog-draft/               ← 이 flow 전용 prompts/scripts/samples 모음
    prompts/
      system.md, naver-style.md, ig-style.md, trend-research.md
      samples/naver/*.md, samples/ig/*.md
    scripts/
      parse-issue.mjs, extract-images.mjs, fetch-trends.mjs, draft.mjs, scrape-naver.mjs
inputs/  outputs/            (런타임 임시, gitignored)
```

새 자동화 flow를 추가할 때:
1. `.github/workflows/<flow-name>.yml`, `.github/ISSUE_TEMPLATE/<flow-name>.yml` 추가
2. `flows/<flow-name>/{prompts,scripts}/` 디렉터리 생성
3. 라벨 prefix는 `<flow-name>:` 또는 그대로 flow별 단어 사용 (현재는 `draft-request`, `naver`, `insta`, `drafted`, `error`)

## flow: blog-draft

### 운영자 사용법

1. **Issues → New issue → "블로그/인스타 글 자동 생성 (초안)"** 템플릿 선택.
2. 사진을 본문 첫 번째 영역에 드래그&드롭으로 첨부 (필수).
3. 나머지(채널·주제·분위기·날짜)는 비워둬도 OK. 채널 기본값 "둘 다".
4. 제출 → 1~3분 안에 같은 이슈에 초안 코멘트가 달림.
5. 코멘트 본문을 복사해 네이버 블로그/인스타에 직접 붙여넣어 게시.

다시 생성하려면 이슈에서 `drafted` 라벨을 떼고 다시 부여.

### 동작

```
Issue (이미지 첨부) → blog-draft.yml workflow trigger
  → flows/blog-draft/scripts/parse-issue.mjs    (폼 본문 파싱, 채널 라벨 부여)
  → 이슈 제목 자동 갱신 "[YYYY-MM-DD] 스터디 블로그·인스타 자동 생성"
  → flows/blog-draft/scripts/extract-images.mjs (이미지 다운로드)
  → flows/blog-draft/scripts/fetch-trends.mjs   (Gemini + 웹검색으로 트렌드 JSON)
  → flows/blog-draft/scripts/draft.mjs          (스타일 + 트렌드 + 사진 + imageCount → 채널별 초안 + outputs/naver.html)
  → gh-pages 브랜치 push                        (previews/issue-N.html → https://<owner>.github.io/<repo>/previews/issue-N.html?v=<run_id>)
  → flows/blog-draft/scripts/compose-comment.mjs (미리보기 배너 최상단 + 채널별 초안 → outputs/comment.md)
  → gh issue comment                            (서식 복사용 미리보기 링크 + 채널별 초안 한 코멘트)
```

### 분량 — 이미지 수에 따라 자동 가변 (네이버 블로그)

| 이미지 수 | 본문 분량 | 단락 수 | 구조 |
| --- | --- | --- | --- |
| 1장 | 1,200~1,800자 | 5~7개 | 한 인상에 집중하는 짧은 후기 |
| 2~3장 | 2,000~2,800자 | 7~10개 | 표준 골격, 사진 별 1번 인용 |
| 4장 이상 | 3,000~3,800자 | 10~14개 | 2~4개 소제목 섹션 분할 |

`flows/blog-draft/scripts/draft.mjs` 가 이미지 수를 계산해 분량·구조 가이드를 프롬프트에 자동 주입.

### 이미지 관찰

Gemini가 멀티모달이므로 첨부 사진을 직접 읽고, 분위기·계절감·시간대·장소·소품·인물 활동을 본문에 자연스럽게 녹임. 사진에 없는 사실은 만들지 않음. 학생 실명·식별 외모 묘사 금지.

### 핵심 파일

| 경로 | 설명 |
| --- | --- |
| `.github/workflows/blog-draft.yml` | 메인 워크플로우 |
| `.github/workflows/gemini.yml` | Gemini OAuth 만료 방지 smoke test |
| `.github/ISSUE_TEMPLATE/blog-draft.yml` | 이슈 입력 폼 |
| `flows/blog-draft/prompts/system.md` | 공통 시스템 프롬프트 |
| `flows/blog-draft/prompts/naver-style.md` | 네이버 블로그 스타일 가이드 |
| `flows/blog-draft/prompts/ig-style.md` | 인스타 캡션 스타일 가이드 |
| `flows/blog-draft/prompts/trend-research.md` | 트렌드 리서치 프롬프트 |
| `flows/blog-draft/prompts/samples/{naver,ig}/*` | 스타일 가이드 출처 raw 텍스트 |
| `flows/blog-draft/scripts/*.mjs` | 단계별 Node 스크립트 |

## 셋업

- GitHub repo secrets:
  - `GEMINI_OAUTH_CREDS` — Gemini CLI OAuth (base64).
  - `GITHUB_TOKEN` — Actions 기본 토큰 (자동). 네이버 미리보기는 이 토큰으로 `gh-pages` 브랜치에 push 한다(`contents: write`).
  - `ATTACHMENTS_PAT` — **private 레포에서만 필요**. classic PAT(`ghp_...`)에 `repo` scope 체크. user-attachments 다운로드 용도. [토큰 생성](https://github.com/settings/tokens/new?scopes=repo&description=culcom-routines%20attachments). fine-grained PAT(`github_pat_...`)는 user-attachments에서 거부될 수 있어 classic 권장. **public 전환 후에는 불필요** — 공개 레포의 user-attachments는 인증 없이 접근 가능.
- Issue 라벨 (사전 생성 권장):
  - `draft-request`, `naver`, `insta`, `drafted`, `error`
- GitHub Pages 활성화 (네이버 미리보기 호스팅):
  - 워크플로우가 첫 실행에서 `gh-pages` 브랜치를 자동 생성한다.
  - Settings → Pages → Source = "Deploy from a branch", Branch = `gh-pages` `/` (root) 로 설정.
  - 미리보기 URL: `https://<owner>.github.io/<repo>/previews/issue-N.html?v=<run_id>`.
  - 무료 plan에서는 **public 레포에서만 Pages 동작**. private 동안은 push만 되고 사이트는 비활성.
- 외부 abuse 방지:
  - `blog-draft.yml` precheck에서 `author_association == OWNER|MEMBER|COLLABORATOR` 만 통과시킨다. public 레포에서 외부인이 issue로 워크플로우를 트리거해 Gemini 쿼터·Actions 분량을 소진하는 abuse 방지.
  - 협업자 추가가 필요하면 Settings → Collaborators 에서 추가.

## 스타일 가이드 갱신 — 네이버 샘플 (자가 성장 corpus)

네이버 본문 import 는 [lazyyoyo/naver-blog-importer](https://github.com/lazyyoyo/naver-blog-importer) Python 도구를 사용한다 (cheerio + turndown 기반 자체 스크립트는 위젯 chrome / 이미지 위치 식별이 불안정해 폐기).

[corpus-refresh.yml](.github/workflows/corpus-refresh.yml) 가 매일 KST 01:00 (UTC 16:00) 에 자동 실행되어:

1. importer 로 `culcom-` 블로그 최신 30개 글을 조회
2. `samples/naver/` 에 없는 신규 logNo 만 추출
3. `migrate-from-importer.mjs` + `describe-images.mjs` 로 신규만 처리
4. `prune-samples.mjs --window 15` 로 rolling window 외 글을 `samples/naver/archive/` 로 이동
5. 변경 있으면 main 브랜치에 commit + push

draft.mjs 는 매 호출마다 `samples/naver/*.md` 중 pubDate 내림차순 top-3 의 본문을 reference block 으로 프롬프트에 주입한다 — corpus 가 자동 갱신되면 draft 톤도 자동으로 최신 발행 글에 정렬된다.

GitHub Pages, Actions secret, 라벨은 모두 [셋업](#셋업) 절에 따라 사전 구성된다 (`GEMINI_OAUTH_CREDS` 필수).

### 수동 실행 (디버깅용)

```bash
npm ci

# 1. importer 셋업 (한 번만)
git clone https://github.com/lazyyoyo/naver-blog-importer.git /tmp/naver-blog-importer
cd /tmp/naver-blog-importer/skills/naver-blog-importer
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 2. images.py 패치 — host-별 type 파라미터 (이미지 다운로드 100% 성공률 위해 필수)
#    - mblogthumb-phinf.pstatic.net 호스트: ?type=w800 추가
#    - blogfiles.pstatic.net 호스트: type 파라미터 제거
#    이 패치 안 하면 일부 원본 이미지가 404 로 실패한다. cron 워크플로우는
#    패치 없이 동작하며 다운로드 실패한 이미지는 [이미지 #N: TBD] 로 남는다.

# 3. 본문 import (예: 최신 30개)
python scripts/import_blog.py culcom- --out /tmp/naver-import --limit 30

# 4. importer 출력을 samples/naver/{logNo}.md 형식으로 옮긴다 (이미지 자리는 [이미지 #N: TBD] 로 치환)
#    logNos 는 신규로 추가하고 싶은 글만 콤마로 나열 (cron 은 자동 감지).
cd -  # culcom-routines 로 복귀
node flows/blog-draft/scripts/migrate-from-importer.mjs \
  --in /tmp/naver-import \
  --logNos 224241400842,224249814155

# 5. [이미지 #N: TBD] 마커를 Gemini Flash 로 한 줄 묘사로 채운다 (한 장씩 호출, idempotent)
node flows/blog-draft/scripts/describe-images.mjs \
  --samples flows/blog-draft/prompts/samples/naver \
  --assets /tmp/naver-import/assets \
  --logNos 224241400842,224249814155

# 6. rolling window 외 글을 archive/ 로 이동 (cron 도 동일 호출)
node flows/blog-draft/scripts/prune-samples.mjs --window 15 --dry-run  # 검토
node flows/blog-draft/scripts/prune-samples.mjs --window 15            # 실제 이동
```

## 스타일 가이드 갱신 — 인스타

Claude Chrome MCP 또는 운영자가 캡션 텍스트를 직접 `flows/blog-draft/prompts/samples/ig/` 에 추가. 그 후 `flows/blog-draft/prompts/{naver,ig}-style.md` 를 사람 손으로 보강.

## 직접 실행 / 디버깅

```bash
export ISSUE_BODY="$(cat <<'EOF'
### 사진 (이 영역에 드래그&드롭) — 필수

![](https://example.com/sample.jpg)

### 채널

둘 다 (기본)

### 주제 / 수업 종류 (선택)

5월 둘째주 성인 회화

### 분위기 / 강조 포인트 (선택)

발표 수업, 학생들 많이 웃었음

### 시기 / 날짜 (선택, 트렌드 리서치 기준)

2026-05-10
EOF
)"

node flows/blog-draft/scripts/parse-issue.mjs
node flows/blog-draft/scripts/extract-images.mjs   # 실제 이미지 URL 필요
node flows/blog-draft/scripts/fetch-trends.mjs     # gemini CLI 필요
node flows/blog-draft/scripts/draft.mjs
cat outputs/comment.md
```

## 향후

- Instagram Graph API 자동 게시 (Business 계정 + FB 페이지 연결 필요)
- 네이버 블로그 Playwright 자동 게시 (쿠키 secret 관리 필요)
- 당근(Daangn) 비즈프로필 동시 갱신
- 다른 운영 자동화 flow 추가 시 `flows/<flow-name>/` 패턴 그대로 사용

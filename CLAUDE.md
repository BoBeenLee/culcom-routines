# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo purpose

운영 자동화 모음 (영어회화 학원 컬컴 하남점 운영용). 첫 flow는 GitHub Issue로 사진을 받아 네이버 블로그 + 인스타 초안을 Gemini CLI로 생성해 같은 이슈에 코멘트로 돌려주는 `flows/blog-draft/`. 운영자 1인이 사용한다.

새 flow 추가 규약: `.github/workflows/<flow>.yml` + `.github/ISSUE_TEMPLATE/<flow>.yml` + `flows/<flow>/{prompts,scripts}/`. flow 간 코드 공유 없음 — 의도적으로 자기완결적 트리.

## Architecture — file-based pipeline

핵심 패턴: 각 step은 독립 Node 스크립트로, `outputs/*.json` 을 읽고 다음 `outputs/*.json` 을 쓴다. step 간 통신은 전부 파일 디스크 IO. GitHub Actions가 step들을 순서대로 호출하고, 같은 작업 디렉터리를 공유한다.

```
Issue submit
  → parse-issue.mjs       (ENV ISSUE_BODY → outputs/issue.json, exit 3 if no photos)
  → collapse-photos.mjs   (사진 섹션을 <details>로 감쌈, idempotent)
  → extract-images.mjs    (outputs/issue.json → ./inputs/img*.{jpg,png,...} + outputs/images.json)
  → fetch-trends.mjs      (cached per-date; outputs/trends.json, fallback on Gemini fail)
  → draft.mjs             (사진 + 가이드 + 트렌드 → outputs/{naver,insta}.md + outputs/naver.html + outputs/drafts.json)
  → gh-pages push         (outputs/naver.html → previews/issue-N.html, cache-busted ?v=run_id)
  → compose-comment.mjs   (outputs/comment.md)
  → gh issue comment      (drafted 라벨 추가)
```

`drafted` 라벨이 재실행 가드. `concurrency: blog-draft-issue-${N}` + `cancel-in-progress: false` 로 직렬화하고, precheck job이 live API로 라벨 재확인 후 두 번째 런을 종료한다 (Issue 본문 edit이 `issues:edited` 를 한 번 더 트리거하기 때문). `collapse-photos.mjs` 의 본문 edit이 이 패턴의 주된 원인.

abuse 가드 (public 레포): precheck의 `author_association` 체크가 OWNER/MEMBER/COLLABORATOR 만 통과.

## Gemini CLI 의존성

LLM은 전부 Gemini CLI 셸 호출 (Node SDK 아님). 두 모델을 쓴다:
- 본문 초안 + 트렌드: `gemini --yolo -m gemini-3-pro-preview -p <prompt>`
- 이미지 묘사 (샘플 빌드용): `gemini --yolo -m gemini-2.5-flash --include-directories <assets> -p <prompt>`

draft.mjs는 CoT 누출 방어로 프롬프트에 `<<<DRAFT_START>>>...<<<DRAFT_END>>>` markers 를 박고 `extractDraft()` 로 그 사이만 추출한다. markers 못 찾으면 raw fallback. `update_topic(...)`, `<ctrl##>`, `strategic_intent:` 같은 도구호출 메타 누출 패턴은 시스템 프롬프트에서 명시적으로 금지하고, describe-images.mjs의 `cleanDescription()` 에서도 거른다.

OAuth: GitHub Actions는 secret `GEMINI_OAUTH_CREDS` (base64) 를 `~/.gemini/oauth_creds.json` 으로 복원. `.github/workflows/gemini.yml` 은 토큰 6개월 미사용 만료 방지용 smoke test (수동 트리거).

## Naver HTML 출력 파이프

`@jjlabsio/md-to-naver-blog` (mtnb) 가 마크다운 → 네이버 에디터 호환 HTML 로 변환한다. draft.mjs:
1. Gemini가 출력한 `[이미지 #N: 묘사]` 마커를 `![alt](원본 url)` 로 치환 (`injectImageUrlsForNaver`) — GitHub 코멘트 미리보기에서 사진이 인라인으로 보이게.
2. mtnb로 HTML 변환 후 `<p>...</p>` (class 없는 본문 단락만) 을 `<p style="text-align: center;">` 로 감싼다 (`applyCenterAlignToBodyParagraphs`). 리스트는 mtnb가 `class` 를 붙여 출력하므로 매칭에서 제외됨. 이 정렬 처리는 issue #11 산물.
3. HTML을 `gh-pages` 브랜치의 `previews/issue-N.html` 로 push. 운영자는 그 페이지에서 Cmd-A → Cmd-C → 네이버 에디터 붙여넣기로 서식을 보존한다. GitHub 코멘트로 직접 복사하면 살균돼 서식이 사라짐.

## 분량/길이 가이드 — 이미지 수 기반

`draft.mjs:naverLengthGuide(imageCount)` 가 4개 tier (1-3 / 4-9 / 10-14 / 15+) 로 분기해 분량·단락 수·섹션 헤더 정책을 프롬프트에 주입한다. tier별 분량은 `flows/blog-draft/prompts/samples/naver/*.md` 의 실측 char count 에 기반 — sample 을 갱신하면 함수도 같이 보정하는 것이 원칙. 인스타는 캐러셀/단일 분기만 있는 짧은 가이드.

## 위젯 chrome canonical 형식

네이버 위젯 (카카오 채널 / 매장 박스 / 지도) 은 항상 **single-line** raw markdown link 로 출력한다 (운영자가 네이버 에디터에 붙여넣으면 카드로 렌더됨). multi-line 출력 금지. canonical 형식은 `flows/blog-draft/prompts/naver-style.md` §2 에 박혀 있고, draft.mjs 프롬프트 + migrate-from-importer.mjs (`collapseWidget()`) + 시스템 프롬프트가 같은 규칙을 강제한다. 카카오 링크의 `state=hanam,blog` query 는 한 글자도 바꾸지 말 것 (네이버 블로그용; 인스타용은 `state=hanam,instanoad,1`).

## Private repo의 user-attachments

Public 레포는 익명으로 user-attachments 다운로드 가능. Private 일 땐 classic PAT (`ghp_...`, `repo` scope) 를 `ATTACHMENTS_PAT` secret 에 등록 — fine-grained PAT 은 user-attachments 에서 거부될 수 있다. `extract-images.mjs:fetchAttachment` 가 redirect를 수동 처리하는 이유: 1차 github.com 응답은 토큰 인증이 필요하지만, redirect 대상인 S3 presigned URL은 Authorization 헤더가 있으면 거부한다. 같은 origin 끼리만 헤더를 forward.

## 로컬 실행 / 디버깅

테스트 스위트나 lint 없음. 스크립트 단위로 직접 실행 — `gemini` CLI 와 OAuth 가 호스트에 셋업돼 있어야 한다.

```bash
npm install
export ISSUE_BODY="$(cat <<'EOF'
### 사진 (이 영역에 드래그&드롭) — 필수

![](https://example.com/sample.jpg)

### 채널

둘 다 (기본)

### 주제 / 수업 종류 (선택)

5월 둘째주 성인 회화
EOF
)"
node flows/blog-draft/scripts/parse-issue.mjs    # outputs/issue.json
node flows/blog-draft/scripts/extract-images.mjs # 실제 reachable URL 필요
node flows/blog-draft/scripts/fetch-trends.mjs   # gemini CLI 필요
node flows/blog-draft/scripts/draft.mjs          # gemini CLI + 이미지 필요
cat outputs/comment.md
```

각 step은 `outputs/{이전 step의 산출물}.json` 이 있다고 가정하므로 순서를 건너뛰면 실패한다. `inputs/`, `outputs/` 는 `.gitignore` 됨 — 안 들어가야 정상.

## 샘플 corpus 갱신 (네이버 스타일 가이드 출처)

`flows/blog-draft/prompts/samples/naver/{logNo}.md` 는 lazyyoyo/naver-blog-importer (Python) + Gemini Flash 이미지 묘사로 빌드된 reference corpus. 갱신 절차는 README §"스타일 가이드 갱신 — 네이버 샘플" 참조. 핵심은:
- 이전 cheerio + turndown 자체 스크래퍼는 위젯 chrome / 이미지 위치 식별 불안정으로 폐기.
- importer는 `images.py` 호스트별 type 파라미터 패치가 필요 (없으면 일부 원본 404).
- `migrate-from-importer.mjs` 가 importer 출력 → samples 형식으로 변환 + 위젯 chrome single-line 압축 + 이미지를 `[이미지 #N: TBD]` 마커로 치환.
- `describe-images.mjs` 가 TBD 마커를 한 장씩 Gemini Flash 호출로 채움 (idempotent).

## 이슈 템플릿 날짜 자동 갱신

`.github/workflows/refresh-template-date.yml` 가 매일 KST 자정에 `.github/ISSUE_TEMPLATE/blog-draft.yml` 의 `title: "[YYYY-MM-DD] ..."` 자리를 그날 날짜로 sed 치환해 커밋 push. GitHub Issue Forms 가 동적 title을 지원 안 해서 파일을 다시 쓰는 우회. 이로 인한 매일 커밋은 노이즈가 아니라 의도된 동작.

## 의도적으로 안 하는 것

- 테스트 스위트, lint, CI 검증 없음. 운영 자동화 워크플로우 자체가 통합 테스트 역할.
- flow 간 공유 라이브러리 없음. 새 flow는 `flows/<name>/` 으로 격리.
- 인스타 자동 게시, 네이버 자동 게시 미구현 (운영자가 코멘트를 직접 복사·붙여넣기). API 키/쿠키 운영 부담을 피하기 위해 의도적으로 사람이 마지막 단계.

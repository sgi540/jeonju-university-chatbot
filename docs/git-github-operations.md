# Git/GitHub Operations Guide

전주대학교 챗봇 프로젝트를 MacBook, Mac Studio, Synology 서버에서 같은 기준으로 관리하기 위한 운영 가이드입니다.

## 기준 저장소

- GitHub: `https://github.com/sgi540/jeonju-university-chatbot.git`
- 기본 브랜치: `main`
- 로컬 Git 저장소: 각 장비에 clone 또는 pull 해서 사용

역할은 이렇게 나눕니다.

| 구분 | 역할 |
| --- | --- |
| Git | 각 장비에서 변경 이력, 커밋, 이전 상태 복구 관리 |
| GitHub | 중앙 저장소, 백업, 장비 간 동기화, 서버 배포 기준점 |
| Synology DS925+ | 웹앱 실행, RAG 데이터 보관, 백업, 리버스 프록시 |
| Mac Studio | LM Studio 또는 로컬 LLM 서버 실행 |

## 처음 받기

새 장비에서 처음 받을 때는 아래처럼 진행합니다.

```bash
git clone https://github.com/sgi540/jeonju-university-chatbot.git
cd jeonju-university-chatbot
npm install
cp .env.example .env.local
```

`.env.local`에는 해당 장비에서 사용할 LM Studio 주소와 모델 ID를 넣습니다.

```bash
LM_STUDIO_BASE_URL=http://127.0.0.1:1234
LM_STUDIO_API_KEY=
LM_STUDIO_MODEL=qwen/qwen3.6-35b-a3b
LM_STUDIO_EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
```

`.env.local`은 비밀값과 장비별 설정이 들어가므로 GitHub에 올리지 않습니다.

## 평소 작업 흐름

작업 전에는 항상 최신 코드를 먼저 받습니다.

```bash
git pull
```

수정 후에는 상태를 확인합니다.

```bash
git status
git diff
```

검증을 실행합니다.

```bash
npm run lint
npm run typecheck
npm run check:intents
npm run build
```

문제가 없으면 커밋하고 GitHub에 올립니다.

```bash
git add .
git commit -m "작업 내용을 짧게 설명"
git push
```

## 장비별 권장 흐름

### MacBook 또는 작업용 Mac

개발과 UI 수정은 작업용 Mac에서 진행합니다.

```bash
git pull
npm install
npm run dev
```

작업이 끝나면:

```bash
npm run lint
npm run typecheck
npm run check:intents
git add .
git commit -m "Update chatbot behavior"
git push
```

### Mac Studio

Mac Studio는 LLM 서버 전용으로 두는 것을 권장합니다.

- LM Studio를 실행합니다.
- Qwen 모델을 로드합니다.
- Local Server를 켭니다.
- 네트워크에서 접근 가능한 주소를 확인합니다. 예: `http://192.168.4.187:1234`

Mac Studio에서도 코드를 수정해야 한다면 GitHub에서 최신 코드를 받은 뒤 작업합니다.

```bash
git pull
npm install
```

### Synology DS925+

Synology는 운영 웹서버 역할을 맡습니다.

권장 방식:

1. GitHub에서 최신 코드를 받습니다.
2. `.env.production` 또는 Synology Container 환경변수에 운영 값을 넣습니다.
3. Docker 또는 Container Manager로 Next.js 앱을 실행합니다.
4. Synology Reverse Proxy에서 HTTPS 도메인을 웹앱 컨테이너로 연결합니다.
5. 웹앱은 내부망 또는 Tailscale 주소로 Mac Studio LLM 서버를 호출합니다.

운영 서버에서 직접 코드를 수정하지 않는 것을 권장합니다. 수정은 작업용 Mac에서 하고, Synology는 `pull` 또는 Docker 이미지 갱신만 수행합니다.

## Git에 포함할 것

- `src/`
- `rag/`
- `scripts/`
- `data/rag/jj-official-index.json`
- `package.json`
- `package-lock.json`
- `README.md`
- `HANDOFF.md`
- `docs/`

## Git에 포함하지 않을 것

- `.env.local`
- `.env.production`
- `node_modules/`
- `.next/`
- `tsconfig.tsbuildinfo`
- `.DS_Store`
- LM Studio 모델 파일
- 서버 로그 파일

## 배포 기준

운영 배포 전 최소 확인:

```bash
git status
npm run lint
npm run typecheck
npm run check:intents
npm run build
```

`git status`가 깨끗해야 배포 기준으로 삼기 좋습니다.

```bash
git status --short
```

아무 출력이 없으면 현재 작업 폴더에 커밋되지 않은 변경이 없는 상태입니다.

## 장애 대응 기본 순서

1. 웹앱이 안 열리면 Synology 컨테이너 상태와 Reverse Proxy를 확인합니다.
2. 챗봇 답변이 안 오면 Mac Studio의 LM Studio Local Server가 켜져 있는지 확인합니다.
3. RAG 답변이 이상하면 `npm run check:intents`로 대표 의도 테스트를 돌립니다.
4. 공식자료가 오래되었으면 LM Studio와 임베딩 모델을 켠 뒤 `npm run rag:build`를 실행합니다.
5. 최근 수정 이후 문제가 생겼다면 GitHub 커밋 로그에서 정상 커밋으로 비교합니다.

## 안전 원칙

- 운영 서버에서는 직접 수정하지 않습니다.
- 비밀값은 GitHub에 올리지 않습니다.
- 배포 전에는 반드시 빌드와 의도 회귀 테스트를 실행합니다.
- LLM 엔드포인트 입력 UI는 시연에는 편하지만, 실제 공개 운영에서는 관리자 전용으로 숨기거나 서버 환경변수로 고정하는 것이 안전합니다.

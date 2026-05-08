# Jeonju University Chatbot Studio

전주대학교 범용 챗봇 프로젝트를 위한 Next.js 기반 UI 작업용 워크스페이스입니다.
현재 구조는 `LM Studio + Qwen 3.6 35B` 조합을 기준으로 맞춰져 있으며, 브라우저는 Next.js 서버 라우트를 통해 로컬 모델과 통신합니다.

## Stack

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS 4
- LM Studio OpenAI-compatible API

## Quick Start

1. 의존성 설치

```bash
npm install
```

2. 환경 변수 파일 준비

```bash
cp .env.example .env.local
```

3. LM Studio에서 모델을 로드하고 로컬 서버를 활성화

- 예시 엔드포인트: `http://127.0.0.1:1234/v1`
- 예시 모델 라벨: `Qwen 3.6 35B`

4. 개발 서버 실행

```bash
npm run dev
```

5. 브라우저에서 확인

```text
http://localhost:3000
```

## Environment Variables

```bash
LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1
LM_STUDIO_API_KEY=
LM_STUDIO_MODEL=qwen3-35b
LM_STUDIO_EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
LM_STUDIO_TEMPERATURE=0.3
LM_STUDIO_MAX_TOKENS=1200
LM_STUDIO_REQUEST_TIMEOUT_MS=90000
LM_STUDIO_CONNECT_TIMEOUT_MS=5000
NEXT_PUBLIC_MODEL_LABEL=Qwen 3.6 35B
NEXT_PUBLIC_ASSISTANT_NAME=JJ Campus Copilot
NEXT_PUBLIC_LM_STUDIO_ENDPOINT_LABEL=127.0.0.1:1234
```

`LM_STUDIO_MODEL`은 LM Studio에서 실제로 로드된 모델 ID와 맞춰 주세요.
원격 LM Studio 서버를 쓴다면 `LM_STUDIO_API_KEY`도 함께 설정하세요.

## Project Notes

- 현재 UI는 전주대학교 안내 챗봇 시연과 추후 실제 고도화를 모두 고려한 형태입니다.
- 채팅 요청은 `src/app/api/chat/route.ts`에서 LM Studio로 전달됩니다.
- 공식문서 RAG 소스 목록은 `rag/source-manifest.json`에서 관리합니다.
- 공식문서 RAG 인덱스는 `npm run rag:build`로 생성하며 `data/rag/jj-official-index.json`에 저장됩니다.

## Useful Commands

```bash
npm run dev
npm run lint
npm run typecheck
npm run build
npm run rag:build
```

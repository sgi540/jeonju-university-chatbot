# Handoff Notes

이 문서는 다른 Mac에서 전주대학교 챗봇 프로젝트를 이어서 작업하기 위한 간단한 인수인계 메모입니다.

## Current State

- Next.js 기반 챗봇 UI가 구성되어 있습니다.
- LM Studio의 Qwen 3.6 35B 계열 모델을 서버 라우트에서 호출합니다.
- 전주대학교 공식문서 기반 RAG 구조가 붙어 있습니다.
- 교수 명단, 교수 총원, 식단, 교통편 일부는 구조화 응답으로 처리합니다.
- 공식 RAG 소스 목록은 `rag/source-manifest.json`에서 관리합니다.
- 현재 RAG 인덱스 파일은 `data/rag/jj-official-index.json`입니다.

## First Setup On Another Mac

```bash
npm install
cp .env.example .env.local
```

`.env.local`에는 실제 LM Studio 주소, 모델 ID, API 키를 넣습니다. 이 파일은 Git에 올리지 않습니다.

## LM Studio Checklist

- Qwen 3.6 35B 모델을 로드합니다.
- 임베딩 재생성이 필요하면 임베딩 모델도 로드합니다.
- 로컬에서 LM Studio를 띄우면 보통 `LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1`을 사용합니다.
- 다른 장비의 LM Studio를 호출할 경우 해당 장비 IP와 포트로 변경합니다.

## Useful Commands

```bash
npm run dev
npm run lint
npm run typecheck
npm run build
npm run rag:build
```

## Switching Computers Safely

권장 방식은 Private Git 저장소를 만들고 MacBook에서 `push`, Mac Studio에서 `pull`하는 것입니다.

Git에 포함할 것:
- `src`
- `rag`
- `scripts`
- `data/rag/jj-official-index.json`
- `package.json`
- `package-lock.json`
- `README.md`
- `HANDOFF.md`

Git에 포함하지 않을 것:
- `.env.local`
- `node_modules`
- `.next`
- `tsconfig.tsbuildinfo`
- `.DS_Store`

## Current Caveat

교통편 공식 소스는 `rag/source-manifest.json`에 추가되어 있지만, LM Studio가 꺼져 있던 동안 추가했기 때문에 전체 벡터 인덱스 재생성은 아직 하지 못했습니다. LM Studio를 다시 켠 뒤 아래 명령을 한 번 실행하면 됩니다.

```bash
npm run rag:build
```


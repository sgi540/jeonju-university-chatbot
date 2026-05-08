"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  assistantName,
  createMessage,
  endpointLabel,
  formatKoreanTime,
  modelLabel,
  officialLinks,
  scenarioBadges,
  starterPrompts,
  type ChatMessage,
  type ChatSourceCard,
} from "@/lib/chat";

interface ChatApiResponse {
  message?: string;
  model?: string;
  responseId?: string;
  sources?: ChatSourceCard[];
  rag?: {
    enabled?: boolean;
    retrievalQuery?: string;
    indexSummary?: {
      generatedAt: string;
      documentCount: number;
      chunkCount: number;
    } | null;
  };
  error?: string;
  details?: string;
}

const initialMessages = [
  createMessage(
    "assistant",
    [
      "전주대학교 범용 챗봇 프로토타입에 연결되었습니다.",
      "질문을 입력하면 LM Studio에서 실행 중인 로컬 모델로 응답을 전달합니다.",
      "현재 화면은 향후 RAG, 출처 카드, 학사 시스템 연결을 확장하기 쉽도록 설계되어 있습니다.",
    ].join("\n\n"),
    {
      id: "initial-assistant-message",
      createdAt: "2026-04-22T13:00:00+09:00",
    },
  ),
];

export function ChatShell() {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastModel, setLastModel] = useState(modelLabel);
  const [ragMeta, setRagMeta] = useState<ChatApiResponse["rag"] | null>(null);
  const [previousResponseId, setPreviousResponseId] = useState<string | null>(
    null,
  );
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  async function submitPrompt(prompt: string) {
    const trimmedPrompt = prompt.trim();

    if (!trimmedPrompt || isLoading) {
      return;
    }

    const nextUserMessage = createMessage("user", trimmedPrompt);
    const nextMessages = [...messages, nextUserMessage];

    setMessages(nextMessages);
    setInput("");
    setError(null);
    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: trimmedPrompt,
          messages: nextMessages.map(({ role, content }) => ({ role, content })),
          previousResponseId,
        }),
      });

      const data = (await response.json()) as ChatApiResponse;

      if (!response.ok || !data.message) {
        throw new Error(data.details || data.error || "챗봇 응답을 받을 수 없습니다.");
      }

      setMessages((current) => [
        ...current,
        createMessage("assistant", data.message as string, {
          sources: data.sources,
        }),
      ]);
      setLastModel(data.model || modelLabel);
      setPreviousResponseId(data.responseId ?? null);
      setRagMeta(data.rag ?? null);
    } catch (caughtError) {
      const nextError =
        caughtError instanceof Error
          ? caughtError.message
          : "알 수 없는 오류가 발생했습니다.";

      setError(nextError);
    } finally {
      setIsLoading(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitPrompt(input);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitPrompt(input);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1600px] flex-col px-4 py-4 md:px-6 md:py-6">
      <div className="mb-4 flex items-center justify-between gap-4 rounded-[28px] border border-[var(--line)] bg-[rgba(255,251,246,0.64)] px-5 py-4 backdrop-blur-xl">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,var(--primary),var(--primary-strong))] text-sm font-semibold tracking-[0.18em] text-white shadow-[0_18px_40px_rgba(107,31,31,0.35)]">
            JJ
          </div>
          <div>
            <p className="section-title text-lg font-semibold text-[var(--foreground)]">
              Jeonju University Chatbot Studio
            </p>
            <p className="text-sm text-[var(--muted)]">
              LM Studio 로컬 모델 기반의 UI 실험실
            </p>
          </div>
        </div>

        <div className="hidden items-center gap-2 rounded-full border border-[var(--line)] bg-white/60 px-4 py-2 text-sm text-[var(--muted)] md:flex">
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--teal)] shadow-[0_0_18px_var(--glow)]" />
          {lastModel}
        </div>
      </div>

      <div className="grid flex-1 gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="glass-panel flex flex-col gap-5 rounded-[30px] p-5">
          <div className="rounded-[24px] bg-[linear-gradient(135deg,rgba(107,31,31,0.96),rgba(64,16,17,0.9))] p-5 text-white shadow-[0_24px_80px_rgba(73,19,20,0.24)]">
            <p className="mb-2 text-xs uppercase tracking-[0.32em] text-white/72">
              Design Direction
            </p>
            <h1 className="section-title text-[2rem] font-semibold leading-[1.02]">
              학사와 행정을 한 화면으로 묶는 전주대 챗봇
            </h1>
            <p className="mt-4 text-sm leading-6 text-white/78">
              지금은 시연과 UI 구축에 맞춘 구조지만, 이후 작은 보완만으로
              실제 운영형 정보 챗봇으로 확장할 수 있게 준비했습니다.
            </p>
          </div>

          <section>
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
              Ready For
            </p>
            <div className="flex flex-wrap gap-2">
              {scenarioBadges.map((badge) => (
                <span
                  key={badge}
                  className="rounded-full border border-[var(--line)] bg-white/66 px-3 py-2 text-xs font-medium text-[var(--foreground)]"
                >
                  {badge}
                </span>
              ))}
            </div>
          </section>

          <section className="rounded-[24px] border border-[var(--line)] bg-white/58 p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-[var(--muted)]">
                  Runtime
                </p>
                <h2 className="section-title text-xl font-semibold">
                  LM Studio + Qwen
                </h2>
              </div>
              <div className="rounded-full bg-[rgba(31,91,89,0.12)] px-3 py-1 text-xs font-semibold text-[var(--teal)]">
                local
              </div>
            </div>
            <div className="space-y-3 text-sm text-[var(--muted)]">
              <div className="flex items-start justify-between gap-4 rounded-2xl border border-[var(--line)] bg-white/70 px-3 py-3">
                <span>엔드포인트</span>
                <span className="text-right font-medium text-[var(--foreground)]">
                  {endpointLabel}
                </span>
              </div>
              <div className="flex items-start justify-between gap-4 rounded-2xl border border-[var(--line)] bg-white/70 px-3 py-3">
                <span>기본 모델 라벨</span>
                <span className="text-right font-medium text-[var(--foreground)]">
                  {modelLabel}
                </span>
              </div>
              <div className="flex items-start justify-between gap-4 rounded-2xl border border-[var(--line)] bg-white/70 px-3 py-3">
                <span>공식문서 RAG</span>
                <span className="text-right font-medium text-[var(--foreground)]">
                  {ragMeta?.enabled ? "활성" : "대기"}
                </span>
              </div>
              {ragMeta?.indexSummary ? (
                <div className="rounded-2xl border border-[var(--line)] bg-white/70 px-3 py-3">
                  <p className="mb-2 text-xs uppercase tracking-[0.24em]">
                    Indexed Corpus
                  </p>
                  <p className="font-medium text-[var(--foreground)]">
                    문서 {ragMeta.indexSummary.documentCount}건 · 청크{" "}
                    {ragMeta.indexSummary.chunkCount}건
                  </p>
                </div>
              ) : null}
              <p className="leading-6">
                프런트는 `/api/chat`만 바라보고, 실제 LLM 호출은 서버 라우트가
                대신 처리합니다. 나중에 RAG나 인증 로직을 붙이기 쉽습니다.
              </p>
            </div>
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                Official Links
              </p>
              <span className="text-xs text-[var(--muted)]">확장 가능한 소스 후보</span>
            </div>
            <div className="space-y-3">
              {officialLinks.map((link) => (
                <a
                  key={link.title}
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-[22px] border border-[var(--line)] bg-white/62 p-4 transition-transform duration-200 hover:-translate-y-0.5 hover:border-[var(--line-strong)]"
                >
                  <p className="mb-1 font-semibold text-[var(--foreground)]">
                    {link.title}
                  </p>
                  <p className="text-sm leading-6 text-[var(--muted)]">
                    {link.description}
                  </p>
                </a>
              ))}
            </div>
          </section>
        </aside>

        <section className="glass-panel flex min-h-[78vh] flex-col overflow-hidden rounded-[32px]">
          <header className="border-b border-[var(--line)] px-5 py-4 md:px-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <div className="mb-2 flex flex-wrap gap-2">
                  <span className="rounded-full bg-[rgba(107,31,31,0.1)] px-3 py-1 text-xs font-semibold text-[var(--primary)]">
                    campus assistant
                  </span>
                  <span className="rounded-full bg-[rgba(31,91,89,0.1)] px-3 py-1 text-xs font-semibold text-[var(--teal)]">
                    near-production UI
                  </span>
                </div>
                <h2 className="section-title text-3xl font-semibold text-[var(--foreground)]">
                  {assistantName}
                </h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--muted)]">
                  학생이 많이 찾는 질문을 자연어로 처리하고, 현재는 전주대학교
                  공식문서 기반 RAG를 붙일 수 있도록 검색과 근거 표시 구조까지
                  포함하고 있습니다.
                </p>
              </div>

              <div className="grid gap-2 rounded-[24px] border border-[var(--line)] bg-white/58 p-3 text-sm text-[var(--muted)] sm:grid-cols-2">
                <div className="rounded-2xl bg-white/70 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.24em]">Mode</p>
                  <p className="mt-1 font-medium text-[var(--foreground)]">
                    Design + local inference
                  </p>
                </div>
                <div className="rounded-2xl bg-white/70 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.24em]">Focus</p>
                  <p className="mt-1 font-medium text-[var(--foreground)]">
                    다양한 질문 대응용 챗 UI
                  </p>
                </div>
              </div>
            </div>
          </header>

          <div className="border-b border-[var(--line)] px-5 py-4 md:px-6">
            <div className="mb-3 flex flex-wrap gap-2">
              {starterPrompts.map((promptCard) => (
                <button
                  key={promptCard.label}
                  type="button"
                  onClick={() => void submitPrompt(promptCard.prompt)}
                  className="rounded-full border border-[var(--line)] bg-white/72 px-4 py-2 text-left transition-colors duration-200 hover:border-[var(--line-strong)] hover:bg-white"
                >
                  <span className="mr-2 font-semibold text-[var(--foreground)]">
                    {promptCard.label}
                  </span>
                  <span className="text-xs text-[var(--muted)]">
                    {promptCard.tone}
                  </span>
                </button>
              ))}
            </div>
            <div className="text-sm text-[var(--muted)]">
              {ragMeta?.enabled && ragMeta.retrievalQuery ? (
                <p>최근 검색 쿼리: {ragMeta.retrievalQuery}</p>
              ) : (
                <p>질문이 들어오면 전주대학교 공식문서 인덱스에서 관련 근거를 먼저 찾습니다.</p>
              )}
            </div>
          </div>

          <div className="subtle-scrollbar flex-1 space-y-4 overflow-y-auto px-5 py-5 md:px-6">
            {messages.map((message) => {
              const isAssistant = message.role === "assistant";

              return (
                <article
                  key={message.id}
                  className={`max-w-[88%] rounded-[28px] border px-5 py-4 shadow-[0_12px_44px_rgba(45,29,19,0.06)] ${
                    isAssistant
                      ? "border-[var(--line)] bg-[rgba(255,252,248,0.92)]"
                      : "ml-auto border-[rgba(107,31,31,0.18)] bg-[linear-gradient(135deg,rgba(107,31,31,0.96),rgba(140,59,35,0.92))] text-white"
                  }`}
                >
                  <div className="mb-3 flex items-center gap-3">
                    <div
                      className={`flex h-9 w-9 items-center justify-center rounded-2xl text-xs font-semibold tracking-[0.18em] ${
                        isAssistant
                          ? "bg-[rgba(31,91,89,0.12)] text-[var(--teal)]"
                          : "bg-white/14 text-white"
                      }`}
                    >
                      {isAssistant ? "AI" : "ME"}
                    </div>
                    <div>
                      <p
                        className={`text-sm font-semibold ${
                          isAssistant ? "text-[var(--foreground)]" : "text-white"
                        }`}
                      >
                        {isAssistant ? assistantName : "나"}
                      </p>
                      <p
                        className={`text-xs ${
                          isAssistant ? "text-[var(--muted)]" : "text-white/72"
                        }`}
                      >
                        {formatKoreanTime(message.createdAt)}
                      </p>
                    </div>
                  </div>

                  <p className="whitespace-pre-wrap text-[15px] leading-7">
                    {message.content}
                  </p>

                  {isAssistant && message.sources?.length ? (
                    <div className="mt-4 grid gap-3 border-t border-[var(--line)] pt-4">
                      {message.sources.map((source) => (
                        <a
                          key={`${message.id}-${source.url}`}
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-[20px] border border-[var(--line)] bg-white/72 px-4 py-3 transition-colors duration-200 hover:bg-white"
                        >
                          <div className="mb-2 flex items-center justify-between gap-3">
                            <p className="font-semibold text-[var(--foreground)]">
                              {source.title}
                            </p>
                            <span className="rounded-full bg-[rgba(31,91,89,0.1)] px-3 py-1 text-xs font-semibold text-[var(--teal)]">
                              {source.category}
                            </span>
                          </div>
                          <p className="text-sm leading-6 text-[var(--muted)]">
                            {source.excerpt}
                          </p>
                        </a>
                      ))}
                    </div>
                  ) : null}
                </article>
              );
            })}

            {isLoading ? (
              <article className="max-w-[88%] rounded-[28px] border border-[var(--line)] bg-[rgba(255,252,248,0.92)] px-5 py-4 shadow-[0_12px_44px_rgba(45,29,19,0.06)]">
                <div className="mb-3 flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-[rgba(31,91,89,0.12)] text-xs font-semibold tracking-[0.18em] text-[var(--teal)]">
                    AI
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[var(--foreground)]">
                      {assistantName}
                    </p>
                    <p className="text-xs text-[var(--muted)]">응답 생성 중</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--accent)]" />
                  <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--accent)] [animation-delay:120ms]" />
                  <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--accent)] [animation-delay:240ms]" />
                </div>
              </article>
            ) : null}

            <div ref={messagesEndRef} />
          </div>

          <footer className="border-t border-[var(--line)] px-4 py-4 md:px-6 md:py-5">
            <form onSubmit={handleSubmit} className="space-y-3">
              {error ? (
                <div className="rounded-[20px] border border-[rgba(107,31,31,0.22)] bg-[rgba(107,31,31,0.08)] px-4 py-3 text-sm text-[var(--primary)]">
                  {error}
                </div>
              ) : null}

              <div className="rounded-[28px] border border-[var(--line)] bg-white/84 p-3 shadow-[0_22px_60px_rgba(53,36,24,0.08)]">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="예: 수강신청 정정 기간, 증명서 발급 방법, 국제학생 문의처를 알려줘"
                  rows={4}
                  className="min-h-[120px] w-full resize-none rounded-[22px] border-none bg-transparent px-2 py-1 text-[15px] leading-7 text-[var(--foreground)] outline-none placeholder:text-[var(--muted)]"
                />

                <div className="mt-3 flex flex-col gap-3 border-t border-[var(--line)] pt-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-[var(--muted)]">
                    Enter 로 전송, Shift + Enter 로 줄바꿈
                  </p>

                  <button
                    type="submit"
                    disabled={isLoading || !input.trim()}
                    className="inline-flex items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--primary),var(--primary-strong))] px-5 py-3 text-sm font-semibold text-white transition-transform duration-200 hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isLoading ? "응답 받는 중..." : "질문 보내기"}
                  </button>
                </div>
              </div>
            </form>
          </footer>
        </section>
      </div>
    </main>
  );
}

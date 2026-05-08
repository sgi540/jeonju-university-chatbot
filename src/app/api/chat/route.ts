import { NextResponse } from "next/server";
import {
  assertLmStudioReachable,
  getLmStudioConfig,
  requestLmStudioChat,
} from "@/lib/lm-studio";
import { classifyOfficialQuestion } from "@/lib/question-router";
import {
  buildGroundedPrompt,
  retrieveOfficialContext,
  tryBuildOfficialShortcutAnswer,
} from "@/lib/rag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface IncomingMessage {
  role: "assistant" | "user";
  content: string;
}

function isIncomingMessage(value: unknown): value is IncomingMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    (candidate.role === "assistant" || candidate.role === "user") &&
    typeof candidate.content === "string" &&
    candidate.content.trim().length > 0
  );
}

function extractLatestUserPrompt(messages: IncomingMessage[]) {
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");

  return latestUserMessage?.content.trim() ?? "";
}

function buildRetrievalQuery(prompt: string, messages: IncomingMessage[]) {
  const recentUserMessages = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .slice(-2);

  return recentUserMessages.length ? recentUserMessages.join("\n") : prompt;
}

function isLmStudioConnectionError(message: string) {
  return /(fetch failed|timeout|timed out|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|Failed to connect)/iu.test(message);
}

function formatChatError(error: unknown) {
  const rawMessage =
    error instanceof Error
      ? error.message
      : "Unknown error while contacting LM Studio.";

  if (!isLmStudioConnectionError(rawMessage)) {
    return {
      status: 500,
      details: rawMessage,
    };
  }

  const config = getLmStudioConfig();

  return {
    status: 503,
    details: [
      `LM Studio 서버에 연결하지 못했습니다. 현재 설정된 주소는 ${config.serverBaseUrl} 입니다.`,
      "LM Studio의 Local Server가 켜져 있는지, 모델과 임베딩 모델이 로드되어 있는지, 같은 네트워크에서 접근 가능한지 확인해 주세요.",
    ].join(" "),
  };
}

function buildRoutedRetrievalQuery(
  fallbackQuery: string,
  route: Awaited<ReturnType<typeof classifyOfficialQuestion>>,
) {
  if (!route?.searchQuery || route.confidence < 0.55) {
    return fallbackQuery;
  }

  return route.searchQuery;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      prompt?: unknown;
      previousResponseId?: unknown;
      messages?: unknown;
    };
    const rawMessages = Array.isArray(body.messages)
      ? body.messages.filter(isIncomingMessage)
      : [];
    const prompt =
      typeof body.prompt === "string" && body.prompt.trim().length > 0
        ? body.prompt.trim()
        : extractLatestUserPrompt(rawMessages);
    const previousResponseId =
      typeof body.previousResponseId === "string" &&
      body.previousResponseId.startsWith("resp_")
        ? body.previousResponseId
        : undefined;

    if (!prompt) {
      return NextResponse.json(
        { error: "A prompt is required." },
        { status: 400 },
      );
    }

    const retrievalQuery = buildRetrievalQuery(prompt, rawMessages);
    const shortcutAnswer = await tryBuildOfficialShortcutAnswer(retrievalQuery);

    if (shortcutAnswer) {
      return NextResponse.json({
        message: shortcutAnswer.message,
        model: "official-structured",
        responseId: undefined,
        usage: null,
        sources: shortcutAnswer.sources,
        rag: {
          enabled: true,
          retrievalQuery: shortcutAnswer.retrievalQuery,
          indexSummary: shortcutAnswer.indexSummary,
        },
      });
    }

    await assertLmStudioReachable();

    const questionRoute = await classifyOfficialQuestion(retrievalQuery).catch(() => null);
    const routedShortcutAnswer = await tryBuildOfficialShortcutAnswer(
      retrievalQuery,
      questionRoute,
    );

    if (routedShortcutAnswer) {
      return NextResponse.json({
        message: routedShortcutAnswer.message,
        model: "official-structured",
        responseId: undefined,
        usage: null,
        sources: routedShortcutAnswer.sources,
        rag: {
          enabled: true,
          retrievalQuery: routedShortcutAnswer.retrievalQuery,
          indexSummary: routedShortcutAnswer.indexSummary,
          router: questionRoute,
        },
      });
    }

    const officialContext = await retrieveOfficialContext(
      buildRoutedRetrievalQuery(retrievalQuery, questionRoute),
    );
    const groundedPrompt = buildGroundedPrompt(prompt, officialContext.groundedContext);

    const result = await requestLmStudioChat({
      prompt: groundedPrompt,
      previousResponseId,
    });

    return NextResponse.json({
      ...result,
      sources: officialContext.sources,
      rag: {
        enabled: Boolean(officialContext.groundedContext),
        retrievalQuery: officialContext.retrievalQuery,
        indexSummary: officialContext.indexSummary,
        router: questionRoute,
      },
    });
  } catch (error) {
    const { status, details } = formatChatError(error);

    return NextResponse.json(
      {
        error: "Unable to complete the chat request.",
        details,
      },
      { status },
    );
  }
}

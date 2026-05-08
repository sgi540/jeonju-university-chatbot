import { NextResponse } from "next/server";
import { requestLmStudioChat } from "@/lib/lm-studio";
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

    const officialContext = await retrieveOfficialContext(retrievalQuery);
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
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown error while contacting LM Studio.";

    return NextResponse.json(
      {
        error: "Unable to complete the chat request.",
        details: message,
      },
      { status: 500 },
    );
  }
}

const fallbackBaseUrl = "http://127.0.0.1:1234/v1";
const fallbackModel = "qwen3-35b";

function normalizeOpenAiBaseUrl(rawBaseUrl: string) {
  const trimmed = rawBaseUrl.replace(/\/$/, "");

  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function normalizeServerBaseUrl(rawBaseUrl: string) {
  return rawBaseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
}

interface LmStudioNativeChatRequest {
  model: string;
  input: string;
  system_prompt: string;
  reasoning: "off" | "low" | "medium" | "high" | "on";
  temperature: number;
  max_output_tokens: number;
  previous_response_id?: string;
}

interface LmStudioOutputItem {
  type: "message" | "reasoning" | "tool_call" | "invalid_tool_call";
  content?: string;
}

interface LmStudioEmbeddingRequest {
  model: string;
  input: string | string[];
}

interface LmStudioEmbeddingResponse {
  data?: Array<{
    embedding?: number[];
  }>;
}

interface LmStudioNativeChatResponse {
  model_instance_id?: string;
  output?: LmStudioOutputItem[];
  stats?: {
    input_tokens?: number;
    total_output_tokens?: number;
    reasoning_output_tokens?: number;
    tokens_per_second?: number;
    time_to_first_token_seconds?: number;
  };
  response_id?: string;
}

export function getLmStudioConfig() {
  const rawBaseUrl = process.env.LM_STUDIO_BASE_URL ?? fallbackBaseUrl;

  return {
    openAiBaseUrl: normalizeOpenAiBaseUrl(rawBaseUrl),
    serverBaseUrl: normalizeServerBaseUrl(rawBaseUrl),
    model: process.env.LM_STUDIO_MODEL ?? fallbackModel,
    embeddingModel:
      process.env.LM_STUDIO_EMBEDDING_MODEL ??
      "text-embedding-nomic-embed-text-v1.5",
    temperature: Number(process.env.LM_STUDIO_TEMPERATURE ?? 0.3),
    maxTokens: Number(process.env.LM_STUDIO_MAX_TOKENS ?? 1200),
    requestTimeoutMs: Number(process.env.LM_STUDIO_REQUEST_TIMEOUT_MS ?? 90_000),
    apiKey: process.env.LM_STUDIO_API_KEY,
  };
}

export function buildSystemPrompt() {
  return [
    "You are JJ Campus Copilot, a university information assistant for Jeonju University.",
    "Default to Korean unless the user explicitly writes in another language.",
    "Answer with a calm, helpful, service-oriented tone.",
    "Prefer concise structured responses that fit student support use cases.",
    "If a question requires official confirmation, say that clearly instead of inventing details.",
    "Do not fabricate dates, policies, phone numbers, or campus rules.",
    "If the user asks about procedures, explain them as short steps.",
    "If the user asks about where to go, recommend checking the official university site or the responsible office.",
  ].join(" ");
}

interface RequestLmStudioChatOptions {
  prompt: string;
  previousResponseId?: string;
}

export async function requestLmStudioChat({
  prompt,
  previousResponseId,
}: RequestLmStudioChatOptions) {
  const config = getLmStudioConfig();
  const payload: LmStudioNativeChatRequest = {
    model: config.model,
    input: prompt,
    system_prompt: buildSystemPrompt(),
    reasoning: "off",
    temperature: config.temperature,
    max_output_tokens: config.maxTokens,
    ...(previousResponseId
      ? {
          previous_response_id: previousResponseId,
        }
      : {}),
  };

  const response = await fetch(`${config.serverBaseUrl}/api/v1/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey
        ? {
            Authorization: `Bearer ${config.apiKey}`,
          }
        : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      `LM Studio request failed (${response.status}): ${details || "No details"}`,
    );
  }

  const data = (await response.json()) as LmStudioNativeChatResponse;
  const message = data.output
    ?.filter((item) => item.type === "message")
    .map((item) => item.content?.trim() ?? "")
    .filter(Boolean)
    .at(-1);

  if (!message) {
    throw new Error("LM Studio returned an empty response.");
  }

  return {
    message,
    model: config.model,
    responseId: data.response_id,
    usage: data.stats,
  };
}

interface RequestLmStudioEmbeddingsOptions {
  model?: string;
}

export async function requestLmStudioEmbeddings(
  input: string | string[],
  options: RequestLmStudioEmbeddingsOptions = {},
) {
  const config = getLmStudioConfig();
  const payload: LmStudioEmbeddingRequest = {
    model: options.model ?? config.embeddingModel,
    input,
  };

  const response = await fetch(`${config.openAiBaseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey
        ? {
            Authorization: `Bearer ${config.apiKey}`,
          }
        : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      `LM Studio embedding request failed (${response.status}): ${details || "No details"}`,
    );
  }

  const data = (await response.json()) as LmStudioEmbeddingResponse;
  const embeddings =
    data.data
      ?.map((item) => item.embedding)
      .filter((embedding): embedding is number[] => Array.isArray(embedding)) ?? [];

  if (!embeddings.length) {
    throw new Error("LM Studio returned no embeddings.");
  }

  return embeddings;
}

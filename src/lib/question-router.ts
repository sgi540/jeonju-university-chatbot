import {
  requestLmStudioText,
  type LmStudioRuntimeOverrides,
} from "@/lib/lm-studio";

export type OfficialQuestionIntent =
  | "campus_place_lookup"
  | "cafeteria_lookup"
  | "department_lookup"
  | "transport_lookup"
  | "professor_lookup"
  | "official_rag"
  | "unknown";

export interface OfficialQuestionRoute {
  intent: OfficialQuestionIntent;
  searchQuery: string | null;
  date: string | null;
  meal: "조식" | "중식" | "석식" | null;
  confidence: number;
}

const VALID_INTENTS = new Set<OfficialQuestionIntent>([
  "campus_place_lookup",
  "cafeteria_lookup",
  "department_lookup",
  "transport_lookup",
  "professor_lookup",
  "official_rag",
  "unknown",
]);
const VALID_MEALS = new Set(["조식", "중식", "석식"]);

export async function classifyOfficialQuestion(
  question: string,
  configOverrides: LmStudioRuntimeOverrides = {},
): Promise<OfficialQuestionRoute | null> {
  const content = await requestLmStudioText({
    prompt: buildRouterPrompt(question),
    systemPrompt: buildRouterSystemPrompt(),
    temperature: 0,
    maxTokens: 360,
    configOverrides,
  });

  return parseRouterResponse(content);
}

function buildRouterSystemPrompt() {
  return [
    "You classify Korean Jeonju University chatbot questions.",
    "Return only one valid JSON object. Do not use markdown.",
    "Never answer the user question.",
    "Allowed intent values: campus_place_lookup, cafeteria_lookup, department_lookup, transport_lookup, professor_lookup, official_rag, unknown.",
    "Use campus_place_lookup for campus map facilities, buildings, rooms, stops, welfare spaces, or existence/location questions about places.",
    "If the user asks where a cafeteria, restaurant, cafe, convenience store, or food facility is, use campus_place_lookup, not cafeteria_lookup.",
    "Use cafeteria_lookup only for cafeteria menus, meal contents, 학식 메뉴, 식단, 조식, 중식, 석식.",
    "Use department_lookup for lists of colleges, departments, majors, 학과, 학부, 전공, or all undergraduate academic units.",
    "Use transport_lookup for address, getting to campus, public transit, terminal, station, taxi, shuttle/bus access.",
    "Use professor_lookup for professors, faculty lists, professor phone numbers, and faculty counts.",
    "Use official_rag for policies, scholarships, certificates, academic affairs, portal, library, and general official information.",
    "For searchQuery, extract only the core lookup target. Examples: '학교 안에 변전 시설 있나?' -> '변전소'; '초막 교회 위치' -> '초막교회'; '학교에 식당은 어디에 있어?' -> '식당'; '전주대학교 학과 전부 알려줘' -> null; '오늘 점심 학식' -> null; '전주역에서 가는 법' -> null.",
    "For date, use YYYY-MM-DD when explicit or relative. Current date is 2026-05-08 in Asia/Seoul. Otherwise null.",
    "For meal, use one of 조식, 중식, 석식, or null.",
    "confidence must be a number from 0 to 1.",
  ].join(" ");
}

function buildRouterPrompt(question: string) {
  return [
    "Classify this user question into JSON.",
    "",
    "Schema:",
    '{"intent":"campus_place_lookup|cafeteria_lookup|transport_lookup|professor_lookup|official_rag|unknown","searchQuery":"string|null","date":"YYYY-MM-DD|null","meal":"조식|중식|석식|null","confidence":0.0}',
    "",
    `Question: ${question.trim()}`,
  ].join("\n");
}

function parseRouterResponse(content: string): OfficialQuestionRoute | null {
  const jsonText = extractJsonObject(content);

  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText) as Partial<OfficialQuestionRoute>;
    const intent = normalizeIntent(parsed.intent);

    if (!intent) {
      return null;
    }

    return {
      intent,
      searchQuery: normalizeNullableString(parsed.searchQuery),
      date: normalizeDate(parsed.date),
      meal: normalizeMeal(parsed.meal),
      confidence: normalizeConfidence(parsed.confidence),
    };
  } catch {
    return null;
  }
}

function extractJsonObject(content: string) {
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const candidate = fenceMatch?.[1] ?? content;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start < 0 || end <= start) {
    return "";
  }

  return candidate.slice(start, end + 1);
}

function normalizeIntent(value: unknown) {
  return typeof value === "string" && VALID_INTENTS.has(value as OfficialQuestionIntent)
    ? value as OfficialQuestionIntent
    : null;
}

function normalizeNullableString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();

  return normalized ? normalized : null;
}

function normalizeDate(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();

  return /^\d{4}-\d{2}-\d{2}$/u.test(normalized) ? normalized : null;
}

function normalizeMeal(value: unknown) {
  return typeof value === "string" && VALID_MEALS.has(value)
    ? value as OfficialQuestionRoute["meal"]
    : null;
}

function normalizeConfidence(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

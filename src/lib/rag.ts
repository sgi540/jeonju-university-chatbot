import { readFile } from "node:fs/promises";
import path from "node:path";
import { requestLmStudioEmbeddings } from "@/lib/lm-studio";
import type { OfficialQuestionRoute } from "@/lib/question-router";

const RAG_INDEX_PATH = path.join(process.cwd(), "data", "rag", "jj-official-index.json");
const MAX_CHUNKS_PER_DOCUMENT = 2;
const DEFAULT_RETRIEVAL_LIMIT = 5;
const MIN_SIGNIFICANT_SCORE = 0.2;
const MIN_RELEVANCE_RATIO = 0.75;
const CAFETERIA_SOURCE_URL = "https://www.jj.ac.kr/jj/campuslife/food.do";
const CAMPUS_MAP_SOURCE_URL = "https://www.jj.ac.kr/jj/introduction/campus-map.do";
const CAMPUS_MAP_DIRECTION_URL = "https://www.jj.ac.kr/jj/introduction/campus-map-info.do";
const TRANSPORT_SOURCE_URL = "https://www.jj.ac.kr/jj/introduction/location.do";
const SOUTH_TERMINAL_SOURCE_URL = "https://www.jj.ac.kr/jj/campuslife/southterminal-bus.do";
const TRANSPORT_CACHE_TTL_MS = 1000 * 60 * 30;
const CAFETERIA_CACHE_TTL_MS = 1000 * 60 * 5;
const CAMPUS_PLACE_CACHE_TTL_MS = 1000 * 60 * 30;
const GENERIC_QUERY_TOKENS = new Set([
  "같은",
  "내용",
  "내용은",
  "내용이",
  "내용좀",
  "내용도",
  "정보",
  "종류",
  "관련",
  "문의",
  "방법",
  "바로가기",
  "사항",
  "서비스",
  "안내",
  "알려줘",
  "알려주",
  "어디",
  "어디서",
  "어떻게",
  "언제",
  "있나요",
  "있어",
  "주세요",
  "찾아줘",
  "확인",
]);

function isPresent<T>(value: T | null | undefined | false): value is T {
  return Boolean(value);
}

export interface RagSourceCard {
  title: string;
  category: string;
  url: string;
  excerpt: string;
  score: number;
}

interface RagChunkRecord {
  id: string;
  documentId: string;
  sourceId: string;
  title: string;
  category: string;
  url: string;
  excerpt: string;
  text: string;
  updatedAt?: string | null;
  embedding: number[];
}

interface RagDocumentRecord {
  sourceId: string;
  url: string;
  excerpt?: string;
}

interface RagSourceMeta {
  id: string;
  title: string;
  category: string;
  url: string;
  keywords?: string[];
}

interface RagIndexFile {
  generatedAt: string;
  embeddingModel: string;
  documentCount: number;
  chunkCount: number;
  sources?: RagSourceMeta[];
  documents?: RagDocumentRecord[];
  chunks: RagChunkRecord[];
}

interface RagSearchResult {
  sources: RagSourceCard[];
  groundedContext: string;
  retrievalQuery: string;
  indexSummary: {
    generatedAt: string;
    documentCount: number;
    chunkCount: number;
  } | null;
}

interface RagShortcutAnswer {
  message: string;
  sources: RagSourceCard[];
  retrievalQuery: string;
  indexSummary: {
    generatedAt: string;
    documentCount: number;
    chunkCount: number;
  } | null;
}

interface CafeteriaDayMenu {
  weekday: string;
  date: string;
  note?: string | null;
  meals: {
    name: "조식" | "중식" | "석식";
    hours: string | null;
    items: string[];
  }[];
}

interface ResolvedMenuDate {
  date: string;
  weekday: string;
  label: string;
  allowWeekdayFallback: boolean;
}

interface TransportationSnapshot {
  address: string | null;
  publicTransitLines: string[];
  taxiLine: string | null;
  cityBusLine: string | null;
  southTerminalBus: {
    summary: string | null;
    upwardLine: string | null;
    upwardTimesLine: string | null;
    downwardLine: string | null;
    downwardTimesLine: string | null;
    fareLine: string | null;
    durationLine: string | null;
    bookingLine: string | null;
  } | null;
}

interface CampusPlace {
  id: number;
  placeName: string;
  orderNo: number;
  latitude: number | null;
  longitude: number | null;
  placeType: "BUILDING" | "WELFARE" | "BUS";
  useYn?: string | null;
  welfareCategory?: string | null;
  description?: string | null;
}

let transportCache:
  | {
      fetchedAt: number;
      data: TransportationSnapshot | null;
    }
  | null = null;
let cafeteriaCache:
  | {
      fetchedAt: number;
      data: CafeteriaDayMenu[];
    }
  | null = null;
const campusPlaceCache = new Map<
  string,
  {
    fetchedAt: number;
    data: CampusPlace[];
  }
>();

export async function retrieveOfficialContext(
  retrievalQuery: string,
  limit = DEFAULT_RETRIEVAL_LIMIT,
): Promise<RagSearchResult> {
  const normalizedQuery = retrievalQuery.trim();

  if (!normalizedQuery) {
    return {
      sources: [],
      groundedContext: "",
      retrievalQuery: "",
      indexSummary: null,
    };
  }

  const index = await loadRagIndex();

  if (!index?.chunks.length) {
    return {
      sources: [],
      groundedContext: "",
      retrievalQuery: normalizedQuery,
      indexSummary: null,
    };
  }

  const [queryEmbedding] = await requestLmStudioEmbeddings(normalizedQuery, {
    model: index.embeddingModel,
  });
  const queryTokens = tokenize(normalizedQuery);
  const sourceMap = new Map((index.sources ?? []).map((source) => [source.id, source]));

  const scoredChunks = index.chunks
    .map((chunk) => {
      const semanticScore = cosineSimilarity(queryEmbedding, chunk.embedding);
      const lexicalScore = computeLexicalScore(queryTokens, chunk);
      const titleScore = computeTitleScore(queryTokens, chunk.title);
      const sourceScore = computeSourceMetadataScore(
        queryTokens,
        sourceMap.get(chunk.sourceId),
      );
      let finalScore =
        semanticScore * 0.43 +
        lexicalScore * 0.2 +
        titleScore * 0.15 +
        sourceScore * 0.22;
      const anchorScore = Math.max(lexicalScore, titleScore, sourceScore);

      if (titleScore >= 0.5) {
        finalScore += 0.08;
      }

      if (lexicalScore >= 0.6) {
        finalScore += 0.05;
      }

      if (sourceScore >= 0.5) {
        finalScore += 0.08;
      }

      if (sourceScore >= 0.75 && titleScore >= 0.25) {
        finalScore += 0.04;
      }

      if (anchorScore < 0.2) {
        finalScore *= 0.72;
      }

      if (anchorScore < 0.1 && semanticScore < 0.72) {
        finalScore *= 0.65;
      }

      return {
        chunk,
        score: finalScore,
      };
    })
    .filter((entry) => entry.score > 0.12)
    .sort((left, right) => right.score - left.score);

  const topScore = scoredChunks[0]?.score ?? 0;
  const significanceThreshold = Math.max(MIN_SIGNIFICANT_SCORE, topScore * MIN_RELEVANCE_RATIO);
  const selected = [];
  const perDocumentCounts = new Map<string, number>();

  for (const candidate of scoredChunks) {
    if (selected.length && candidate.score < significanceThreshold) {
      continue;
    }

    const currentCount = perDocumentCounts.get(candidate.chunk.documentId) ?? 0;

    if (currentCount >= MAX_CHUNKS_PER_DOCUMENT) {
      continue;
    }

    selected.push(candidate);
    perDocumentCounts.set(candidate.chunk.documentId, currentCount + 1);

    if (selected.length >= limit) {
      break;
    }
  }

  const sources = [...new Map(
    selected.map(({ chunk, score }) => {
      const normalizedUrl = normalizeSourceUrl(chunk.url);

      return [
        normalizedUrl,
        {
          title: chunk.title,
          category: chunk.category,
          url: normalizedUrl,
          excerpt: chunk.excerpt,
          score: Number(score.toFixed(4)),
        },
      ];
    }),
  ).values()];

  const groundedContext = selected
    .map(
      ({ chunk, score }, indexNumber) =>
        [
          `[공식자료 ${indexNumber + 1}]`,
          `제목: ${chunk.title}`,
          `분류: ${chunk.category}`,
          `URL: ${chunk.url}`,
          `관련도: ${score.toFixed(4)}`,
          `본문 발췌:`,
          chunk.text,
        ].join("\n"),
    )
    .join("\n\n");

  return {
    sources,
    groundedContext,
    retrievalQuery: normalizedQuery,
    indexSummary: {
      generatedAt: index.generatedAt,
      documentCount: index.documentCount,
      chunkCount: index.chunkCount,
    },
  };
}

export async function tryBuildOfficialShortcutAnswer(
  retrievalQuery: string,
  route?: OfficialQuestionRoute | null,
): Promise<RagShortcutAnswer | null> {
  const normalizedQuery = retrievalQuery.trim();

  if (shouldPreferFoodFacilityLocationLookup(normalizedQuery, route)) {
    const campusPlaceAnswer = await buildCampusPlaceAnswer(
      normalizedQuery,
      route?.searchQuery ?? undefined,
    );

    if (campusPlaceAnswer) {
      return campusPlaceAnswer;
    }
  }

  if (route?.intent === "campus_place_lookup") {
    const campusPlaceAnswer = await buildCampusPlaceAnswer(
      normalizedQuery,
      route.searchQuery ?? undefined,
    );

    if (campusPlaceAnswer) {
      return campusPlaceAnswer;
    }
  }

  if (!route && isCampusPlaceQuery(normalizedQuery)) {
    const campusPlaceAnswer = await buildCampusPlaceAnswer(normalizedQuery);

    if (campusPlaceAnswer) {
      return campusPlaceAnswer;
    }
  }

  if (route?.intent === "transport_lookup" || (!route && isTransportationAccessQuery(normalizedQuery))) {
    const transportationAnswer = await buildTransportationAnswer(normalizedQuery);

    if (transportationAnswer) {
      return transportationAnswer;
    }
  }

  const index = await loadRagIndex();

  if (route?.intent === "professor_lookup" && /(몇\s*명|몇명|총합|총원|인원|숫자|수는|수는\s*몇|얼마나)/u.test(normalizedQuery)) {
    if (!index?.chunks.length) {
      return null;
    }

    return buildProfessorCountAnswer(normalizedQuery, index);
  }

  if (!route && isProfessorCountQuery(normalizedQuery)) {
    if (!index?.chunks.length) {
      return null;
    }

    return buildProfessorCountAnswer(normalizedQuery, index);
  }

  if (route?.intent !== "cafeteria_lookup" && !isCafeteriaQuery(normalizedQuery)) {
    return null;
  }

  const cafeteriaChunks = index?.chunks
    ?.filter((chunk) => chunk.sourceId === "cafeteria")
    .sort((left, right) => compareChunkId(left.id, right.id));
  const liveMenus = await loadLiveCafeteriaMenus();
  const indexedMenus = cafeteriaChunks?.length
    ? parseCafeteriaMenus(cafeteriaChunks)
    : [];
  const sourceMenus = liveMenus.length ? liveMenus : indexedMenus;

  if (!sourceMenus.length && !indexedMenus.length) {
    return null;
  }

  const cafeteriaQuery = buildCafeteriaQuery(normalizedQuery, route);
  const targetDate = resolveRequestedMenuDate(cafeteriaQuery);
  const targetDayMenu =
    findMenuByDate(liveMenus, targetDate.date) ??
    findMenuByDate(indexedMenus, targetDate.date) ??
    (
      targetDate.allowWeekdayFallback
        ? findMenuByWeekday(sourceMenus, targetDate.weekday)
        : null
    );

  const sourceUrl = normalizeSourceUrl(cafeteriaChunks?.[0]?.url ?? CAFETERIA_SOURCE_URL);
  const indexSummary = {
    generatedAt: index?.generatedAt ?? new Date().toISOString(),
    documentCount: index?.documentCount ?? sourceMenus.length,
    chunkCount: index?.chunkCount ?? sourceMenus.length,
  };

  if (!targetDayMenu) {
    const availableRange = formatAvailableMenuRange(sourceMenus);

    return {
      message: [
        `전주대학교 식단조회 공식자료에서는 ${targetDate.label} 식단을 현재 확인하지 못했습니다.`,
        availableRange ? `현재 공식 식단조회에서 확인되는 범위는 ${availableRange}입니다.` : null,
        `식단조회 페이지에서 최신 등록 여부를 다시 확인해 주세요.`,
      ].filter(isPresent).join(" "),
      sources: [
        {
          title: "식단조회",
          category: "생활",
          url: sourceUrl,
          excerpt: availableRange
            ? `현재 확인 가능한 식단 범위: ${availableRange}`
            : cafeteriaChunks?.[0]?.excerpt ?? "",
          score: 1,
        },
      ],
      retrievalQuery: normalizedQuery,
      indexSummary,
    };
  }

  if (!targetDayMenu.meals.length) {
    return {
      message: [
        `전주대학교 ${targetDayMenu.date}(${targetDayMenu.weekday}) 식단은 공식자료에 등록된 식단정보가 없습니다.`,
        `자세한 내용은 전주대학교 식단조회 공식 페이지를 확인해 주세요.`,
      ].join(" "),
      sources: [
        {
          title: "식단조회",
          category: "생활",
          url: sourceUrl,
          excerpt: targetDayMenu.note ?? "등록된 식단정보가 없습니다.",
          score: 1,
        },
      ],
      retrievalQuery: normalizedQuery,
      indexSummary,
    };
  }

  const requestedMeal = route?.meal ?? resolveRequestedMeal(cafeteriaQuery);
  const meals = requestedMeal
    ? targetDayMenu.meals.filter((meal) => meal.name === requestedMeal)
    : targetDayMenu.meals;

  const mealLines = meals.length
    ? meals.map((meal) => formatMealLine(meal))
    : ["- 요청하신 식사 구분은 공식자료에서 확인되지 않았습니다."];
  const excerpt = meals.map((meal) => formatMealLine(meal)).join("\n");

  return {
    message: [
      `전주대학교 ${targetDayMenu.date}(${targetDayMenu.weekday}) 식단입니다.`,
      ...mealLines,
      `자세한 내용은 전주대학교 식단조회 공식 페이지를 확인해 주세요.`,
    ].join("\n"),
    sources: [
      {
        title: "식단조회",
        category: "생활",
        url: sourceUrl,
        excerpt,
        score: 1,
      },
    ],
    retrievalQuery: normalizedQuery,
    indexSummary,
  };
}

export function buildGroundedPrompt(question: string, groundedContext: string) {
  if (!groundedContext.trim()) {
    return question;
  }

  return [
    "아래 전주대학교 공식자료만 근거로 답변하세요.",
    "자료에 없는 사실은 추정하지 말고 '현재 확보된 공식자료에서는 확인되지 않습니다.'라고 답변하세요.",
    "날짜, 절차, 서류명, 문의처는 자료에 있는 내용만 사용하세요.",
    "가능하면 답변 마지막에 간단히 관련 부서 또는 공식 페이지 확인을 안내하세요.",
    "",
    `[사용자 질문]`,
    question.trim(),
    "",
    `[전주대학교 공식자료]`,
    groundedContext,
  ].join("\n");
}

async function loadRagIndex() {
  return readFile(RAG_INDEX_PATH, "utf8")
    .then((raw) => JSON.parse(raw) as RagIndexFile)
    .catch(() => null);
}

function tokenize(value: string) {
  const rawTokens =
    value
    .toLowerCase()
    .match(/[가-힣a-z0-9]{2,}/g)
    ?.filter((token) => token.length >= 2) ?? [];

  const expandedTokens = rawTokens.flatMap((token) => {
    const stripped = stripKoreanParticle(token);
    const normalized = normalizeToken(stripped);

    return [token, stripped, normalized, ...expandToken(normalized)];
  });

  return [...new Set(
    expandedTokens.filter(
      (token) => token.length >= 2 && !GENERIC_QUERY_TOKENS.has(token),
    ),
  )];
}

function computeLexicalScore(tokens: string[], chunk: RagChunkRecord) {
  if (!tokens.length) {
    return 0;
  }

  const haystack = `${chunk.title} ${chunk.excerpt} ${chunk.text}`.toLowerCase();
  let matches = 0;

  for (const token of tokens) {
    if (haystack.includes(token)) {
      matches += 1;
    }
  }

  return matches / tokens.length;
}

function computeTitleScore(tokens: string[], title: string) {
  if (!tokens.length) {
    return 0;
  }

  const loweredTitle = title.toLowerCase();
  const matches = tokens.filter((token) => loweredTitle.includes(token)).length;

  return matches / tokens.length;
}

function computeSourceMetadataScore(tokens: string[], source?: RagSourceMeta) {
  if (!tokens.length || !source) {
    return 0;
  }

  const haystack =
    `${source.title} ${source.category} ${(source.keywords ?? []).join(" ")}`
      .toLowerCase();
  const matches = tokens.filter((token) => haystack.includes(token)).length;

  return matches / tokens.length;
}

function cosineSimilarity(left: number[], right: number[]) {
  if (left.length !== right.length || !left.length) {
    return 0;
  }

  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dotProduct += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }

  if (!leftMagnitude || !rightMagnitude) {
    return 0;
  }

  return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function stripKoreanParticle(token: string) {
  return token.replace(
    /(으로부터|에게서|이랑|이나|랑|은|는|이|가|을|를|와|과|에|에서|으로|로|도|만|의|께|까지|부터|처럼|보다|한테|에게|마다|나)$/u,
    "",
  );
}

function normalizeToken(token: string) {
  return token
    .replace(/(인가요|인가|일까|일까요|해요|해줘|해주|하려면|하기|하고|하는)$/u, "")
    .replace(/(받아야|받아|받을|받는|입니다|종류는|기간은|방법은|일정은)$/u, "");
}

function expandToken(token: string) {
  const expansions = new Set<string>();

  if (token.includes("증명")) {
    expansions.add("증명서");
    expansions.add("발급");
  }

  if (token.includes("재학증명")) {
    expansions.add("재학증명서");
    expansions.add("재학");
  }

  if (token.includes("수강")) {
    expansions.add("수강신청");
    expansions.add("수강편람");
  }

  if (token.includes("생활관") || token.includes("기숙사")) {
    expansions.add("생활관");
    expansions.add("기숙사");
  }

  if (token.includes("버스") || token.includes("셔틀")) {
    expansions.add("통학버스");
    expansions.add("셔틀버스");
  }

  if (token === "lms") {
    expansions.add("사이버캠퍼스");
  }

  if (token.includes("포털")) {
    expansions.add("포털서비스");
  }

  return [...expansions];
}

function normalizeSourceUrl(value: string) {
  try {
    const url = new URL(value);

    url.searchParams.delete("article.offset");
    url.searchParams.delete("articleLimit");

    const normalized = url.toString();

    return normalized.endsWith("?") ? normalized.slice(0, -1) : normalized;
  } catch {
    return value;
  }
}

function isCafeteriaQuery(query: string) {
  return /(식단|학식|메뉴|조식|중식|석식|점심|저녁|아침)/u.test(query);
}

function isProfessorCountQuery(query: string) {
  return /(교수|교수님|교수진|교원)/u.test(query) && /(몇\s*명|몇명|총합|총원|인원|숫자|수는|수는\s*몇|얼마나)/u.test(query);
}

function isCampusPlaceQuery(query: string) {
  const normalized = normalizeWhitespace(query);

  if (/(주소|전주역|버스터미널|고속버스|직행버스|남부터미널|택시|시내버스|통학버스|셔틀)/u.test(normalized)) {
    return false;
  }

  return /(위치|어디|건물|몇\s*번|캠퍼스맵|길찾기|있어|있나요|있니|있습니까|있는지|있을까)/u.test(normalized);
}

function isTransportationAccessQuery(query: string) {
  const normalized = normalizeWhitespace(query);

  if (/(통학버스|셔틀|승차|노선|신청|탑승|시간표)/u.test(normalized)) {
    return false;
  }

  return (
    /(오시는길|교통편|대중교통|전주역|버스터미널|터미널|고속버스|직행버스|남부터미널|택시|시내버스|찾아가는\s*법|가는\s*법|오는\s*방법)/u.test(normalized) ||
    (
      /(전주대|전주대학교|학교)/u.test(normalized) &&
      /(주소|위치)/u.test(normalized)
    )
  );
}

function parseCafeteriaMenus(chunks: RagChunkRecord[]) {
  const text = chunks
    .map((chunk) => chunk.text)
    .join("\n")
    .replace(/<br\s*\/?>/giu, "\n");
  const lines = text
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);

  return parseCafeteriaMenuLines(lines);
}

function parseCafeteriaMenuLines(lines: string[]) {
  const datePattern = /^([월화수목금토일]) \((\d{4}-\d{2}-\d{2})\)$/u;
  const days: CafeteriaDayMenu[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const dateMatch = line.match(datePattern);

    if (dateMatch) {
      days.push({
        weekday: dateMatch[1],
        date: dateMatch[2],
        note: null,
        meals: [],
      });
    }
  }

  if (!days.length) {
    return [];
  }

  const blockMenus = parseCafeteriaBlocks(lines, days.length);

  if (blockMenus.length) {
    return days.map((day, index) => ({
      ...day,
      note: blockMenus[index]?.note ?? null,
      meals: blockMenus[index]?.meals ?? [],
    }));
  }

  const mealEntries = parseCafeteriaMealEntries(lines, 0);

  return days.map((day, index) => ({
    ...day,
    meals: mealEntries.slice(index * 3, index * 3 + 3),
  }));
}

function parseCafeteriaBlocks(lines: string[], dayCount: number) {
  const datePattern = /^([월화수목금토일]) \((\d{4}-\d{2}-\d{2})\)$/u;
  const lastDateIndex = lines.reduce(
    (lastIndex, line, index) => datePattern.test(line) ? index : lastIndex,
    -1,
  );

  if (lastDateIndex < 0) {
    return [];
  }

  const blocks: string[][] = [];

  for (let index = lastDateIndex + 1; index < lines.length; index += 1) {
    if (lines[index] !== "전주대학교 내 식당 식단정보입니다.") {
      continue;
    }

    const block: string[] = [];
    let cursor = index + 1;

    while (
      cursor < lines.length &&
      lines[cursor] !== "전주대학교 내 식당 식단정보입니다."
    ) {
      if (/^(기관\/부서|기관 · 부서|대학\/대학원)$/u.test(lines[cursor])) {
        break;
      }

      block.push(lines[cursor]);
      cursor += 1;
    }

    blocks.push(block);

    if (blocks.length >= dayCount) {
      break;
    }
  }

  if (!blocks.length) {
    return [];
  }

  return blocks.map((block) => ({
    note: block.includes("등록된 식단정보가 없습니다.")
      ? "등록된 식단정보가 없습니다."
      : null,
    meals: parseCafeteriaMealEntries(block, 0),
  }));
}

function parseCafeteriaMealEntries(lines: string[], startIndex: number) {
  const mealEntries: CafeteriaDayMenu["meals"] = [];

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    const mealMatch = matchCafeteriaMealLine(line);

    if (!mealMatch) {
      continue;
    }

    const items: string[] = [];
    const hoursFromNextLine = mealMatch.hours ? null : matchCafeteriaHoursLine(lines[index + 1]);
    const hours = mealMatch.hours ?? hoursFromNextLine;
    let cursor = hoursFromNextLine ? index + 2 : index + 1;

    while (cursor < lines.length) {
      const nextLine = lines[cursor];

      if (
        /^([월화수목금토일]) \((\d{4}-\d{2}-\d{2})\)$/u.test(nextLine) ||
        matchCafeteriaMealLine(nextLine) ||
        nextLine === "전주대학교 내 식당 식단정보입니다."
      ) {
        break;
      }

      if (
        nextLine !== "전주대학교 내 식당 식단정보입니다." &&
        nextLine !== "등록된 식단정보가 없습니다." &&
        !nextLine.startsWith("운영업체 :")
      ) {
        items.push(nextLine);
      }

      cursor += 1;
    }

    mealEntries.push({
      name: mealMatch.name,
      hours,
      items,
    });
  }

  return mealEntries;
}

function matchCafeteriaMealLine(line: string) {
  const inlineMatch = line.match(/^(조식|중식|석식) \(운영시간: ([^)]+)\)$/u);

  if (inlineMatch) {
    return {
      name: inlineMatch[1] as "조식" | "중식" | "석식",
      hours: inlineMatch[2],
    };
  }

  const mealOnlyMatch = line.match(/^(조식|중식|석식)$/u);

  if (mealOnlyMatch) {
    return {
      name: mealOnlyMatch[1] as "조식" | "중식" | "석식",
      hours: null,
    };
  }

  return null;
}

function matchCafeteriaHoursLine(line?: string) {
  return line?.match(/^\(운영시간: ([^)]+)\)$/u)?.[1] ?? null;
}

function buildProfessorCountAnswer(
  retrievalQuery: string,
  index: RagIndexFile,
): RagShortcutAnswer | null {
  const detailDocuments = dedupeByUrl(
    index.documents
      ?.filter((document) => (
        document.sourceId === "faculty-directory" &&
        document.url.includes("-02.do?mode=view")
      )) ?? [],
  );

  if (!detailDocuments.length) {
    return null;
  }

  const entries = detailDocuments
    .map((document) => parseProfessorEntry(document.excerpt ?? ""))
    .filter((entry): entry is { name: string; rank: string } => Boolean(entry));

  if (!entries.length) {
    return null;
  }

  const rankCounts = entries.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.rank] = (counts[entry.rank] ?? 0) + 1;

    return counts;
  }, {});
  const honoraryCount = rankCounts["명예교수"] ?? 0;
  const activeCount = entries.length - honoraryCount;
  const breakdown = [
    rankCounts["교수"] ? `교수 ${rankCounts["교수"]}명` : null,
    rankCounts["부교수"] ? `부교수 ${rankCounts["부교수"]}명` : null,
    rankCounts["조교수"] ? `조교수 ${rankCounts["조교수"]}명` : null,
    rankCounts["겸임교수"] ? `겸임교수 ${rankCounts["겸임교수"]}명` : null,
    rankCounts["초빙교수"] ? `초빙교수 ${rankCounts["초빙교수"]}명` : null,
    rankCounts["석좌교수"] ? `석좌교수 ${rankCounts["석좌교수"]}명` : null,
  ].filter(Boolean);

  return {
    message: [
      `전주대학교 공식 교수소개 상세 페이지를 집계한 결과, 현직 교수진은 ${activeCount}명이고 명예교수는 ${honoraryCount}명입니다.`,
      `모두 합치면 총 ${entries.length}명입니다.`,
      breakdown.length ? `현직 기준 세부 구성은 ${breakdown.join(", ")}입니다.` : "",
      `기준은 현재 구축된 공식 교수소개 인덱스입니다.`,
    ].filter(Boolean).join(" "),
    sources: [
      {
        title: "학과별 교수소개",
        category: "교수",
        url: "https://www.jj.ac.kr/jj/colleges/colleges-Introduction.do",
        excerpt: `공식 교수소개 상세 페이지 ${entries.length}건 집계 기준. 현직 교수진 ${activeCount}명, 명예교수 ${honoraryCount}명.`,
        score: 1,
      },
    ],
    retrievalQuery,
    indexSummary: {
      generatedAt: index.generatedAt,
      documentCount: index.documentCount,
      chunkCount: index.chunkCount,
    },
  };
}

async function buildCampusPlaceAnswer(
  retrievalQuery: string,
  routedSearchQuery?: string,
): Promise<RagShortcutAnswer | null> {
  const searchKeyword = routedSearchQuery?.trim() || extractCampusPlaceKeyword(retrievalQuery);

  if (!searchKeyword) {
    return null;
  }

  const places = await loadCampusPlaces(searchKeyword);
  const exactPlace = findBestCampusPlace(places, searchKeyword);

  if (!exactPlace) {
    return null;
  }

  const index = await loadRagIndex();
  const normalizedSearchKeyword = normalizeCampusPlaceName(searchKeyword);
  const matchingPlaces = places.filter((place) => (
    normalizeCampusPlaceName(place.placeName).includes(normalizedSearchKeyword)
  ));
  const listedPlaces = shouldListCampusPlaceMatches(searchKeyword, matchingPlaces)
    ? matchingPlaces.slice(0, 5)
    : [];

  if (listedPlaces.length > 1) {
    return buildCampusPlaceListAnswer({
      retrievalQuery,
      searchKeyword,
      places: listedPlaces,
      index,
    });
  }

  const directionUrl = buildCampusDirectionUrl(exactPlace);
  const coordinateLine =
    exactPlace.latitude && exactPlace.longitude
      ? `좌표는 ${exactPlace.latitude}, ${exactPlace.longitude}로 등록되어 있습니다.`
      : null;
  const descriptionLine = exactPlace.description
    ? `캠퍼스맵 설명: ${normalizeWhitespace(exactPlace.description)}`
    : "다만 공식 캠퍼스맵에는 별도 상세 설명은 등록되어 있지 않습니다.";
  const openingLine = isCampusPlaceExistenceQuestion(retrievalQuery)
    ? `네. 전주대학교 공식 캠퍼스맵 기준으로 ${withTopicParticle(exactPlace.placeName)} ${formatCampusPlaceType(exactPlace.placeType)} ${exactPlace.orderNo}번으로 등록되어 있습니다.`
    : `전주대학교 공식 캠퍼스맵 기준으로 ${withTopicParticle(exactPlace.placeName)} ${formatCampusPlaceType(exactPlace.placeType)} ${exactPlace.orderNo}번으로 등록되어 있습니다.`;

  return {
    message: [
      openingLine,
      coordinateLine,
      descriptionLine,
      `정확한 위치는 전주대학교 캠퍼스맵 또는 길찾기 화면에서 확인해 주세요.`,
    ].filter(isPresent).join("\n"),
    sources: [
      {
        title: "캠퍼스맵",
        category: "캠퍼스안내",
        url: CAMPUS_MAP_SOURCE_URL,
        excerpt: `${exactPlace.placeName}: ${formatCampusPlaceType(exactPlace.placeType)} ${exactPlace.orderNo}번`,
        score: 1,
      },
      {
        title: "캠퍼스맵 길찾기",
        category: "캠퍼스안내",
        url: directionUrl,
        excerpt: exactPlace.latitude && exactPlace.longitude
          ? `${exactPlace.placeName} 좌표: ${exactPlace.latitude}, ${exactPlace.longitude}`
          : `${exactPlace.placeName} 길찾기 화면`,
        score: 0.98,
      },
    ],
    retrievalQuery,
    indexSummary: index
      ? {
          generatedAt: index.generatedAt,
          documentCount: index.documentCount,
          chunkCount: index.chunkCount,
        }
      : null,
  };
}

async function buildTransportationAnswer(
  retrievalQuery: string,
): Promise<RagShortcutAnswer | null> {
  const snapshot = await loadTransportationSnapshot();

  if (!snapshot) {
    return null;
  }

  const index = await loadRagIndex();
  const wantsAddress = /(주소|위치)/u.test(retrievalQuery);
  const wantsStation = /전주역/u.test(retrievalQuery);
  const wantsTerminal = /(버스터미널|고속버스|직행버스|터미널)/u.test(retrievalQuery);
  const wantsSouthTerminal = /(서울|남부터미널|직통버스)/u.test(retrievalQuery);
  const wantsTaxi = /택시/u.test(retrievalQuery);
  const wantsBus = /시내버스/u.test(retrievalQuery);
  const wantsGeneralAccess = /(교통편|오시는길|오는\s*방법|찾아가는\s*법)/u.test(retrievalQuery);
  const wantsDirectionalAccess = /가는\s*법/u.test(retrievalQuery);
  const wantsRegionalTransit =
    /(대중교통|교통편|오시는길|오는\s*방법|찾아가는\s*법)/u.test(retrievalQuery);
  const wantsLocalTransit =
    wantsDirectionalAccess ||
    wantsGeneralAccess ||
    wantsStation ||
    (wantsTerminal && !wantsSouthTerminal);
  const sourceCards: RagSourceCard[] = [
    {
      title: "오시는길",
      category: "교통",
      url: TRANSPORT_SOURCE_URL,
      excerpt: [
        snapshot.address ? `주소: ${snapshot.address}` : null,
        snapshot.taxiLine,
        snapshot.cityBusLine,
      ].filter(isPresent).join(" "),
      score: 1,
    },
  ];
  const lines: string[] = [];

  if ((wantsAddress || wantsGeneralAccess) && snapshot.address) {
    lines.push(`전주대학교 주소는 ${snapshot.address}입니다.`);
  }

  if (wantsRegionalTransit && snapshot.publicTransitLines.length) {
    lines.push(`공식 오시는길 기준 주요 지역 대중교통 안내는 ${snapshot.publicTransitLines.join(", ")}입니다.`);
  }

  if ((wantsStation || wantsTaxi || wantsBus || wantsLocalTransit) && snapshot.cityBusLine) {
    lines.push(snapshot.cityBusLine);
  }

  if ((wantsStation || wantsTaxi || wantsLocalTransit) && snapshot.taxiLine) {
    lines.push(snapshot.taxiLine);
  }

  if ((wantsSouthTerminal || (!lines.length && snapshot.southTerminalBus)) && snapshot.southTerminalBus) {
    if (snapshot.southTerminalBus.summary) {
      lines.push(snapshot.southTerminalBus.summary);
    }

    if (wantsSouthTerminal) {
      const southTerminalDetails = [
        snapshot.southTerminalBus.upwardLine,
        snapshot.southTerminalBus.upwardTimesLine,
        snapshot.southTerminalBus.downwardLine,
        snapshot.southTerminalBus.downwardTimesLine,
        snapshot.southTerminalBus.fareLine,
        snapshot.southTerminalBus.durationLine,
        snapshot.southTerminalBus.bookingLine,
      ].filter(isPresent);

      lines.push(...southTerminalDetails);
    }

    sourceCards.push({
      title: "서울남부터미널직통버스",
      category: "교통",
      url: SOUTH_TERMINAL_SOURCE_URL,
      excerpt: [
        snapshot.southTerminalBus.summary,
        snapshot.southTerminalBus.fareLine,
        snapshot.southTerminalBus.durationLine,
      ].filter(isPresent).join(" "),
      score: 0.96,
    });
  }

  if (!lines.length) {
    lines.push(
      snapshot.address
        ? `전주대학교 주소는 ${snapshot.address}입니다.`
        : "전주대학교 공식 오시는길 자료를 확인해 주세요.",
    );

    if (snapshot.publicTransitLines.length) {
      lines.push(`주요 지역 대중교통 안내는 ${snapshot.publicTransitLines.join(", ")}입니다.`);
    }

    if (snapshot.cityBusLine) {
      lines.push(snapshot.cityBusLine);
    }
  }

  lines.push("자세한 내용은 전주대학교 공식 오시는길 페이지를 확인해 주세요.");

  return {
    message: lines.join("\n"),
    sources: dedupeSourceCards(sourceCards),
    retrievalQuery,
    indexSummary: index
      ? {
          generatedAt: index.generatedAt,
          documentCount: index.documentCount,
          chunkCount: index.chunkCount,
        }
      : null,
  };
}

function resolveRequestedMeal(query: string) {
  if (/(조식|아침)/u.test(query)) {
    return "조식";
  }

  if (/(중식|점심)/u.test(query)) {
    return "중식";
  }

  if (/(석식|저녁)/u.test(query)) {
    return "석식";
  }

  return null;
}

function buildCafeteriaQuery(query: string, route?: OfficialQuestionRoute | null) {
  const datePart = route?.date ? ` ${route.date}` : "";
  const mealPart = route?.meal ? ` ${route.meal}` : "";

  return `${query}${datePart}${mealPart}`;
}

async function loadTransportationSnapshot() {
  if (
    transportCache &&
    Date.now() - transportCache.fetchedAt < TRANSPORT_CACHE_TTL_MS
  ) {
    return transportCache.data;
  }

  const data = await fetchTransportationSnapshot().catch(() => null);

  transportCache = {
    fetchedAt: Date.now(),
    data,
  };

  return data;
}

async function loadLiveCafeteriaMenus() {
  if (
    cafeteriaCache &&
    Date.now() - cafeteriaCache.fetchedAt < CAFETERIA_CACHE_TTL_MS
  ) {
    return cafeteriaCache.data;
  }

  const data = await fetchOfficialPageLines(CAFETERIA_SOURCE_URL)
    .then((lines) => parseCafeteriaMenuLines(lines))
    .catch(() => []);

  cafeteriaCache = {
    fetchedAt: Date.now(),
    data,
  };

  return data;
}

async function loadCampusPlaces(searchKeyword: string) {
  const searchKeywords = buildCampusSearchKeywords(searchKeyword);
  const cacheKey = searchKeywords.map(normalizeCampusPlaceName).join("|");
  const cached = campusPlaceCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.fetchedAt < CAMPUS_PLACE_CACHE_TTL_MS
  ) {
    return cached.data;
  }

  const placeTypes: CampusPlace["placeType"][] = ["BUILDING", "WELFARE", "BUS"];

  for (const keyword of searchKeywords) {
    const results = await Promise.all(
      placeTypes.map((placeType) => fetchCampusPlaces(keyword, placeType)),
    );
    const deduped = dedupeCampusPlaces(results.flat());
    const activePlaces = deduped.filter((place) => place.useYn !== "N");
    const data = activePlaces.length ? activePlaces : deduped;

    if (data.length) {
      campusPlaceCache.set(cacheKey, {
        fetchedAt: Date.now(),
        data,
      });

      return data;
    }
  }

  const data: CampusPlace[] = [];

  campusPlaceCache.set(cacheKey, {
    fetchedAt: Date.now(),
    data,
  });

  return data;
}

async function fetchCampusPlaces(
  searchKeyword: string,
  placeType: CampusPlace["placeType"],
) {
  const url = new URL(CAMPUS_MAP_SOURCE_URL);

  url.searchParams.set("mode", "getPlaceList");
  url.searchParams.set("placeType", placeType);
  url.searchParams.set("search", searchKeyword);

  const response = await fetch(url, {
    headers: {
      "user-agent": "JJ-Campus-Copilot/1.0",
      "x-requested-with": "XMLHttpRequest",
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as { items?: CampusPlace[] };

  return data.items ?? [];
}

async function fetchTransportationSnapshot(): Promise<TransportationSnapshot | null> {
  const [locationLines, southTerminalLines] = await Promise.all([
    fetchOfficialPageLines(TRANSPORT_SOURCE_URL),
    fetchOfficialPageLines(SOUTH_TERMINAL_SOURCE_URL).catch(() => []),
  ]);

  if (!locationLines.length) {
    return null;
  }

  const address = nextLineAfter(locationLines, "전주대학교 주소");
  const publicTransitLines = collectSectionLines(locationLines, "대중교통 이용", [
    /^택시요금/u,
    /^지역별 통학버스/u,
    /^전주대-서울남부터미널직통버스 안내/u,
  ]);
  const taxiLine = firstLineMatching(locationLines, /^택시요금/u);
  const cityBusLine = firstLineMatching(locationLines, /시내버스가 2-3분 간격으로 운행/u);
  const summary =
    firstLineMatching(
      southTerminalLines,
      /전주대\(후문\).*서울 남부터미널.*직통고속버스.*정기 운행/u,
    ) ??
    "전주대(후문)와 서울 남부터미널을 잇는 직통고속버스가 정기 운행됩니다.";

  return {
    address,
    publicTransitLines,
    taxiLine,
    cityBusLine,
    southTerminalBus: southTerminalLines.length
      ? {
          summary,
          upwardLine: firstLineMatching(southTerminalLines, /^상행/u),
          upwardTimesLine: nextLineAfterMatch(southTerminalLines, /^상행/u),
          downwardLine: firstLineMatching(southTerminalLines, /^하행/u),
          downwardTimesLine: nextLineAfterMatch(southTerminalLines, /^하행/u),
          fareLine: firstLineMatching(southTerminalLines, /^소요요금/u),
          durationLine: firstLineMatching(southTerminalLines, /^소요시간/u),
          bookingLine: firstLineMatching(southTerminalLines, /예매 사이트/u),
        }
      : null,
  };
}

async function fetchOfficialPageLines(url: string) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "JJ-Campus-Copilot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch official source: ${url}`);
  }

  const html = await response.text();
  const text = decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/giu, " ")
      .replace(/<style[\s\S]*?<\/style>/giu, " ")
      .replace(/<[^>]+>/g, "\n"),
  ).replace(/<br\s*\/?>/giu, "\n");

  return text
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
}

function nextLineAfter(lines: string[], label: string) {
  const index = lines.findIndex((line) => normalizeWhitespace(line) === label);

  return index >= 0 ? lines[index + 1] ?? null : null;
}

function firstLineMatching(lines: string[], pattern: RegExp) {
  return lines.find((line) => pattern.test(line)) ?? null;
}

function nextLineAfterMatch(lines: string[], pattern: RegExp) {
  const index = lines.findIndex((line) => pattern.test(line));

  return index >= 0 ? lines[index + 1] ?? null : null;
}

function collectSectionLines(lines: string[], label: string, stopPatterns: RegExp[]) {
  const startIndex = lines.findIndex((line) => normalizeWhitespace(line) === label);

  if (startIndex < 0) {
    return [];
  }

  const sectionLines: string[] = [];

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (stopPatterns.some((pattern) => pattern.test(line))) {
      break;
    }

    sectionLines.push(line);
  }

  return sectionLines;
}

function decodeHtmlEntities(value: string) {
  const namedEntities: Record<string, string> = {
    nbsp: " ",
    amp: "&",
    middot: "·",
    rarr: "→",
    larr: "←",
    quot: "\"",
    apos: "'",
    lt: "<",
    gt: ">",
  };

  return value
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&([a-z]+);/gi, (_, entity) => namedEntities[entity.toLowerCase()] ?? `&${entity};`);
}

function dedupeSourceCards(cards: RagSourceCard[]) {
  return [...new Map(
    cards.map((card) => [
      card.url,
      card,
    ]),
  ).values()];
}

function dedupeCampusPlaces(places: CampusPlace[]) {
  return [...new Map(
    places.map((place) => [
      place.id,
      place,
    ]),
  ).values()];
}

function buildCampusSearchKeywords(searchKeyword: string) {
  const normalized = normalizeWhitespace(searchKeyword);
  const compact = normalized.replace(/\s+/g, "");
  const strippedGeneric = normalizeWhitespace(
    normalized.replace(/(시설|설비|공간|장소|건물|위치)$/u, ""),
  );
  const candidates = [
    normalized,
    compact,
    strippedGeneric,
    strippedGeneric.replace(/\s+/g, ""),
  ];

  if (/변전|전력/u.test(normalized)) {
    candidates.push("변전소", "변전");
  }

  if (/(식당|음식점|푸드코트|학생식당)/u.test(normalized)) {
    if (/학생회관/u.test(normalized)) {
      candidates.push("학생회관");
    }

    if (/스타타워/u.test(normalized)) {
      candidates.push("스타타워");
    }

    if (/스타빌/u.test(normalized)) {
      candidates.push("스타빌");
    }

    if (/체육부/u.test(normalized)) {
      candidates.push("체육부");
    }

    candidates.push("식당");
  }

  return [...new Set(candidates.filter((candidate) => candidate.length >= 2))];
}

function extractCampusPlaceKeyword(query: string) {
  const normalized = normalizeWhitespace(query)
    .replace(/전주대학교(?:에서|에는|에|의)?|전주대(?:에서|에는|에|의)?|학교\s*안에?|학교안에?|학교\s*내|학교내|학교(?:에서|에는|에|의)?|교내(?:에서|에는|에|의)?|캠퍼스\s*안에?|캠퍼스안에?|캠퍼스\s*내|캠퍼스내|캠퍼스맵|캠퍼스(?:에서|에는|에|의)?|안에|안쪽|내부|건물리스트|건물번호|건물|공식|기준/gu, " ")
    .replace(/위치|어디|어딘지|어디야|어디에|있어|있나요|있니|몇\s*번|몇번|번호/gu, " ")
    .replace(/알려줘|알려주|찾아줘|찾아주|확인해줘|보여줘|가려면|가는\s*법|길찾기|이야|인가요|인가|이니|이냐/gu, " ")
    .replace(/[?!.]/g, " ");

  const compactKeyword = normalizeWhitespace(normalized)
    .replace(/\s+/g, "")
    .replace(/^(?:으로부터|에게서|에서|으로|에게|한테|부터|까지|처럼|보다|의|를|을|은|는|이|가|에|로|도|만)+/u, "")
    .replace(/(?:으로부터|에게서|에서|으로|에게|한테|부터|까지|처럼|보다|의|를|을|은|는|이|가|에|로|도|만)+$/u, "");

  return compactKeyword.length >= 2 ? compactKeyword : "";
}

function shouldPreferFoodFacilityLocationLookup(
  query: string,
  route?: OfficialQuestionRoute | null,
) {
  if (route?.intent !== "cafeteria_lookup") {
    return false;
  }

  return (
    /(식당|음식점|푸드코트|카페|편의점|매점|학생식당)/u.test(query) &&
    isCampusPlaceQuery(query) &&
    !isCafeteriaMenuContentQuestion(query)
  );
}

function isCafeteriaMenuContentQuestion(query: string) {
  return (
    /(식단|메뉴|조식|중식|석식)/u.test(query) ||
    /(오늘|내일|이번\s*주|월요일|화요일|수요일|목요일|금요일|토요일|일요일|\d{1,2}\s*월|\d{1,2}\s*일)/u.test(query) &&
      /(학식|밥|점심|저녁|아침|뭐|나와|알려)/u.test(query)
  );
}

function shouldListCampusPlaceMatches(searchKeyword: string, places: CampusPlace[]) {
  const normalized = normalizeCampusPlaceName(searchKeyword);

  return /^(식당|음식점|푸드코트|카페|편의점|매점)$/u.test(normalized) && places.length > 1;
}

function findBestCampusPlace(places: CampusPlace[], searchKeyword: string) {
  const normalizedSearchKeyword = normalizeCampusPlaceName(searchKeyword);
  const matchTokens = buildCampusPlaceMatchTokens(searchKeyword);

  return (
    places.find((place) => normalizeCampusPlaceName(place.placeName) === normalizedSearchKeyword) ??
    places.find((place) => {
      const normalizedPlaceName = normalizeCampusPlaceName(place.placeName);

      return matchTokens.length > 1 &&
        matchTokens.every((token) => normalizedPlaceName.includes(token));
    }) ??
    places.find((place) => normalizeCampusPlaceName(place.placeName).includes(normalizedSearchKeyword)) ??
    places[0]
  );
}

function buildCampusPlaceMatchTokens(searchKeyword: string) {
  const normalized = normalizeCampusPlaceName(searchKeyword);
  const knownTokens = [
    "학생회관",
    "스타타워",
    "스타빌",
    "체육부",
    "식당",
    "카페",
    "편의점",
    "매점",
    "초막교회",
    "변전소",
  ];

  return knownTokens.filter((token) => normalized.includes(token));
}

function buildCampusPlaceListAnswer({
  retrievalQuery,
  searchKeyword,
  places,
  index,
}: {
  retrievalQuery: string;
  searchKeyword: string;
  places: CampusPlace[];
  index: RagIndexFile | null;
}): RagShortcutAnswer {
  const placeLines = places.map((place) => (
    `- ${place.placeName}: ${formatCampusPlaceType(place.placeType)} ${place.orderNo}번${formatCampusCoordinateLine(place)}`
  ));

  return {
    message: [
      `전주대학교 공식 캠퍼스맵 기준으로 ${searchKeyword} 위치는 ${places.length}곳이 확인됩니다.`,
      ...placeLines,
      "정확한 위치는 전주대학교 캠퍼스맵 또는 각 장소의 길찾기 화면에서 확인해 주세요.",
    ].join("\n"),
    sources: [
      {
        title: "캠퍼스맵",
        category: "캠퍼스안내",
        url: CAMPUS_MAP_SOURCE_URL,
        excerpt: `${searchKeyword} 위치 ${places.length}곳: ${places.map((place) => place.placeName).join(", ")}`,
        score: 1,
      },
      ...places.slice(0, 4).map((place) => ({
        title: place.placeName,
        category: "캠퍼스안내",
        url: buildCampusDirectionUrl(place),
        excerpt: `${place.placeName}: ${formatCampusPlaceType(place.placeType)} ${place.orderNo}번${formatCampusCoordinateLine(place)}`,
        score: 0.98,
      })),
    ],
    retrievalQuery,
    indexSummary: index
      ? {
          generatedAt: index.generatedAt,
          documentCount: index.documentCount,
          chunkCount: index.chunkCount,
        }
      : null,
  };
}

function formatCampusCoordinateLine(place: CampusPlace) {
  return place.latitude && place.longitude
    ? `, 좌표 ${place.latitude}, ${place.longitude}`
    : "";
}

function withTopicParticle(value: string) {
  return `${value}${hasFinalConsonant(value) ? "은" : "는"}`;
}

function isCampusPlaceExistenceQuestion(query: string) {
  return /(있어|있나요|있니|있습니까|있는지|있을까)/u.test(query);
}

function hasFinalConsonant(value: string) {
  const lastChar = [...value].at(-1);

  if (!lastChar) {
    return false;
  }

  const charCode = lastChar.charCodeAt(0);
  const hangulStart = 0xac00;
  const hangulEnd = 0xd7a3;

  if (charCode < hangulStart || charCode > hangulEnd) {
    return false;
  }

  return (charCode - hangulStart) % 28 !== 0;
}

function normalizeCampusPlaceName(value: string) {
  return normalizeWhitespace(value)
    .replace(/\s+/g, "")
    .toLowerCase();
}

function formatCampusPlaceType(placeType: CampusPlace["placeType"]) {
  return {
    BUILDING: "건물리스트",
    WELFARE: "복지시설",
    BUS: "버스정류장",
  }[placeType];
}

function buildCampusDirectionUrl(place: CampusPlace) {
  const url = new URL(CAMPUS_MAP_DIRECTION_URL);

  url.searchParams.set("place_name", place.placeName);

  if (place.latitude && place.longitude) {
    url.searchParams.set("lat", String(place.latitude));
    url.searchParams.set("lng", String(place.longitude));
  }

  return url.toString();
}

function findMenuByDate(menus: CafeteriaDayMenu[], date: string) {
  return menus.find((menu) => menu.date === date) ?? null;
}

function findMenuByWeekday(menus: CafeteriaDayMenu[], weekday: string) {
  return menus.find((menu) => menu.weekday === weekday) ?? null;
}

function formatAvailableMenuRange(menus: CafeteriaDayMenu[]) {
  const dates = [...new Set(menus.map((menu) => menu.date))].sort();

  if (!dates.length) {
    return "";
  }

  if (dates.length === 1) {
    return dates[0];
  }

  return `${dates[0]}~${dates[dates.length - 1]}`;
}

function resolveRequestedMenuDate(query: string): ResolvedMenuDate {
  const baseDate = getKoreanNow();

  if (/내일/u.test(query)) {
    return buildResolvedDate(shiftDate(baseDate, 1), "내일");
  }

  if (/모레/u.test(query)) {
    return buildResolvedDate(shiftDate(baseDate, 2), "모레");
  }

  if (/어제/u.test(query)) {
    return buildResolvedDate(shiftDate(baseDate, -1), "어제");
  }

  const fullNumericDate = query.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  const shortNumericDate = query.match(/(\d{1,2})[-./](\d{1,2})/);
  const koreanDate = query.match(/(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일/u);
  const explicitDate = fullNumericDate ?? koreanDate ?? shortNumericDate;

  if (explicitDate) {
    const hasExplicitYear = explicitDate.length === 4 && (
      explicitDate[0].includes("년") ||
      /^\d{4}[-./]/u.test(explicitDate[0])
    );
    const year = hasExplicitYear
      ? Number(explicitDate[1])
      : baseDate.getUTCFullYear();
    const month = Number(explicitDate[explicitDate.length - 2]);
    const day = Number(explicitDate[explicitDate.length - 1]);

    return buildResolvedDate(new Date(Date.UTC(year, month - 1, day)));
  }

  const weekdayMatch = query.match(/(월|화|수|목|금|토|일)요일/u);

  if (weekdayMatch) {
    const currentWeekdayIndex = baseDate.getUTCDay();
    const targetWeekdayIndex = weekdayToIndex(weekdayMatch[1]);
    const delta = targetWeekdayIndex - currentWeekdayIndex;

    return buildResolvedDate(shiftDate(baseDate, delta), `${weekdayMatch[1]}요일`, true);
  }

  return buildResolvedDate(baseDate, "오늘");
}

function getKoreanNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);

  return new Date(Date.UTC(year, month - 1, day));
}

function shiftDate(date: Date, amount: number) {
  const shifted = new Date(date);

  shifted.setUTCDate(shifted.getUTCDate() + amount);

  return shifted;
}

function buildResolvedDate(date: Date, label?: string, allowWeekdayFallback = false) {
  const isoDate = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][date.getUTCDay()];
  const dateLabel = `${isoDate}(${weekday})`;

  return {
    date: isoDate,
    weekday,
    label: label ? `${label} ${dateLabel}` : dateLabel,
    allowWeekdayFallback,
  };
}

function weekdayToIndex(weekday: string) {
  return {
    일: 0,
    월: 1,
    화: 2,
    수: 3,
    목: 4,
    금: 5,
    토: 6,
  }[weekday] ?? 0;
}

function formatMealLine(meal: CafeteriaDayMenu["meals"][number]) {
  const itemText = meal.items.length ? meal.items.join(", ") : "메뉴 정보 없음";
  const hours = meal.hours ? ` (${meal.hours})` : "";

  return `- ${meal.name}${hours}: ${itemText}`;
}

function compareChunkId(left: string, right: string) {
  const leftMatch = left.match(/chunk-(\d+)$/);
  const rightMatch = right.match(/chunk-(\d+)$/);

  if (!leftMatch || !rightMatch) {
    return left.localeCompare(right);
  }

  return Number(leftMatch[1]) - Number(rightMatch[1]);
}

function normalizeWhitespace(value = "") {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\t+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeByUrl<T extends { url: string }>(items: T[]) {
  return [...new Map(items.map((item) => [item.url, item])).values()];
}

function parseProfessorEntry(excerpt: string) {
  const firstLine = excerpt
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .find(Boolean);

  if (!firstLine) {
    return null;
  }

  const nameMatch = firstLine.match(/^([^\s(]+)\s/u);

  if (!nameMatch) {
    return null;
  }

  return {
    name: nameMatch[1],
    rank: extractProfessorRank(firstLine),
  };
}

function extractProfessorRank(value: string) {
  if (value.includes("명예교수")) {
    return "명예교수";
  }

  if (value.includes("겸임교수")) {
    return "겸임교수";
  }

  if (value.includes("초빙교수")) {
    return "초빙교수";
  }

  if (value.includes("석좌교수")) {
    return "석좌교수";
  }

  if (value.includes("조교수")) {
    return "조교수";
  }

  if (value.includes("부교수")) {
    return "부교수";
  }

  if (value.includes("교수")) {
    return "교수";
  }

  return "기타";
}

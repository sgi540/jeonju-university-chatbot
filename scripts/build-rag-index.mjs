import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const PROJECT_ROOT = process.cwd();
const MANIFEST_PATH = path.join(PROJECT_ROOT, "rag", "source-manifest.json");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "data", "rag");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "jj-official-index.json");
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 220;
const MIN_DOCUMENT_LENGTH = 160;
const MAX_DOCUMENT_LENGTH = 28_000;
const EMBEDDING_BATCH_SIZE = 12;

loadEnvFile(path.join(PROJECT_ROOT, ".env.local"));
loadEnvFile(path.join(PROJECT_ROOT, ".env"));

const rawBaseUrl = process.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";
const LM_STUDIO_SERVER_URL = rawBaseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
const LM_STUDIO_API_KEY = process.env.LM_STUDIO_API_KEY;
const EMBEDDING_MODEL =
  process.env.LM_STUDIO_EMBEDDING_MODEL ?? "text-embedding-nomic-embed-text-v1.5";

const DISALLOWED_EXTENSIONS =
  /\.(?:jpg|jpeg|png|gif|svg|webp|ico|zip|pdf|hwp|hwpx|xls|xlsx|ppt|pptx|doc|docx|mp4|avi|mov)$/i;

const DISALLOWED_SUBSTRINGS = [
  "javascript:",
  "mailto:",
  "tel:",
  "/login",
  "/logout",
  "mode=download",
  "attachNo=",
];

const REMOVAL_SELECTORS = [
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  "form",
  "button",
  "input",
  "select",
  "option",
  "header",
  "footer",
  "nav",
  "aside",
  ".top-banner-wrap",
  ".top-header-wrap",
  ".bottom-header-wrap",
  ".path-wrap",
  ".path-util-box",
  ".path-share",
  ".path",
  ".skip-navigation",
  ".quick-wrap",
  ".side-menu-wrap",
  ".snb-wrap",
  ".board-search-box",
  ".board-search-wrap",
  ".bn-search01",
  ".board_btn_area",
  ".board-btn-wrap",
  ".board-util",
  ".pagination",
  ".btn-wrap",
  ".sns-share-wrap",
  ".util-list",
  ".banner-control-wrap",
  ".swiper",
  ".fc-toolbar",
  ".fc-button-group",
  ".fc-view-container",
];

const ROOT_SELECTORS = [
  "#cms-content",
  "#page-content",
  "#contents",
  ".board-view-box",
  ".board-wrap",
  ".content-wrap",
  ".sub-wrap",
  ".cont-wrap",
  "main",
  "body",
];

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const sourceEntries = Array.isArray(manifest.sources) ? manifest.sources : [];

  if (!sourceEntries.length) {
    throw new Error("No RAG sources found in rag/source-manifest.json");
  }

  console.log(`Building RAG index from ${sourceEntries.length} official sources...`);

  const visited = new Map();
  const documents = [];

  for (const source of sourceEntries) {
    console.log(`- Fetching seed: ${source.title}`);
    const sourceDocuments = await collectSourceDocuments(source, visited);
    documents.push(...sourceDocuments);
  }

  const chunks = documents.flatMap((document) => {
    const createdChunks = createChunks(document);

    return createdChunks.length
      ? createdChunks
      : [buildChunk(document, 0, document.text.slice(0, CHUNK_SIZE))];
  });

  if (!chunks.length) {
    throw new Error("No document chunks were created. Check the source manifest or crawler rules.");
  }

  console.log(`Embedding ${chunks.length} chunks using ${EMBEDDING_MODEL}...`);
  const embeddings = await createEmbeddings(chunks.map((chunk) => chunk.text));

  const index = {
    siteName: manifest.siteName ?? "Jeonju University Official Sources",
    generatedAt: new Date().toISOString(),
    embeddingModel: EMBEDDING_MODEL,
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
    documentCount: documents.length,
    chunkCount: chunks.length,
    sources: sourceEntries.map((source) => ({
      id: source.id,
      title: source.title,
      category: source.category,
      url: source.url,
      keywords: Array.isArray(source.keywords) ? source.keywords : [],
    })),
    documents: documents.map((document) => ({
      id: document.id,
      sourceId: document.sourceId,
      title: document.title,
      category: document.category,
      url: document.url,
      fetchedAt: document.fetchedAt,
      updatedAt: document.updatedAt,
      excerpt: document.excerpt,
    })),
    chunks: chunks.map((chunk, indexNumber) => ({
      ...chunk,
      embedding: embeddings[indexNumber],
    })),
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(index, null, 2));

  console.log(`Saved RAG index to ${OUTPUT_PATH}`);
  console.log(`Documents: ${documents.length}`);
  console.log(`Chunks: ${chunks.length}`);
}

async function collectSourceDocuments(source, visited) {
  const collected = [];
  const queued = new Set([source.url]);
  const queue = [
    {
      url: source.url,
      depth: 0,
      isSeed: true,
    },
  ];
  const maxDepth = Number.isFinite(source.maxDepth) ? source.maxDepth : 1;
  const maxChildren = Number.isFinite(source.maxChildren) ? source.maxChildren : 0;
  let discoveredChildren = 0;

  while (queue.length) {
    const current = queue.shift();

    queued.delete(current.url);

    if (visited.has(current.url)) {
      continue;
    }

    const document = await fetchDocument(current.url, source, {
      isSeed: current.isSeed,
    });

    if (!document) {
      continue;
    }

    visited.set(document.url, document);
    collected.push(document);

    if (!source.discoverChildren || current.depth >= maxDepth) {
      continue;
    }

    for (const childUrl of document.discoveredUrls) {
      if (visited.has(childUrl) || queued.has(childUrl)) {
        continue;
      }

      if (maxChildren && discoveredChildren >= maxChildren) {
        break;
      }

      queue.push({
        url: childUrl,
        depth: current.depth + 1,
        isSeed: false,
      });
      queued.add(childUrl);
      discoveredChildren += 1;
    }

    if (!current.isSeed) {
      await sleep(250);
    }
  }

  return collected;
}

function loadEnvFile(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");

    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        return;
      }

      const separatorIndex = trimmed.indexOf("=");

      if (separatorIndex === -1) {
        return;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();

      if (!process.env[key]) {
        process.env[key] = value;
      }
    });
  } catch {
    return;
  }
}

async function fetchDocument(url, source, options) {
  try {
    const response = await fetch(url, {
      headers: buildHeaders(),
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });

    if (!response.ok) {
      console.warn(`  skipped ${url} (${response.status})`);
      return null;
    }

    const html = await response.text();
    const extracted = extractDocumentFromHtml(html, url);

    if (extracted.text.length < (options.isSeed ? 40 : MIN_DOCUMENT_LENGTH)) {
      return null;
    }

    return {
      id: createId(url),
      sourceId: source.id,
      category: source.category,
      title: extracted.title,
      url,
      fetchedAt: new Date().toISOString(),
      updatedAt: extracted.updatedAt,
      excerpt: extracted.excerpt,
      text: extracted.text.slice(0, MAX_DOCUMENT_LENGTH),
      isSeed: options.isSeed,
      discoveredUrls: source.discoverChildren
        ? discoverChildUrls({
            links: extracted.links,
            sourceUrl: url,
            maxChildren: source.maxChildren,
          })
        : [],
    };
  } catch (error) {
    console.warn(
      `  failed ${url}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return null;
  }
}

function extractDocumentFromHtml(html, url) {
  const $ = cheerio.load(html);

  for (const selector of REMOVAL_SELECTORS) {
    $(selector).remove();
  }

  const root = pickRoot($);
  const textLines = root
    .find("h1, h2, h3, h4, p, li, td, th, dd, dt, strong, span")
    .map((_, element) => normalizeWhitespace($(element).text()))
    .get()
    .filter((line) => line.length > 1);

  const text = dedupeLines(textLines).join("\n");
  const pageTitle =
    normalizeWhitespace($('meta[property="og:title"]').attr("content")) ||
    normalizeWhitespace(root.find("h1").first().text()) ||
    normalizeWhitespace($("title").text()) ||
    url;
  const updatedAt =
    $('meta[property="og:updated_time"]').attr("content") ||
    $('meta[name="last-modified"]').attr("content") ||
    null;

  const links = root
    .find("a[href]")
    .map((_, element) => normalizeUrl($(element).attr("href"), url))
    .get()
    .filter(Boolean);

  return {
    title: pageTitle,
    updatedAt,
    excerpt: text.slice(0, 220),
    text,
    links,
  };
}

function pickRoot($) {
  for (const selector of ROOT_SELECTORS) {
    const candidate = $(selector).first();

    if (candidate.length) {
      return candidate.clone();
    }
  }

  return $("body").clone();
}

function discoverChildUrls({ links, sourceUrl, maxChildren }) {
  const currentUrl = new URL(sourceUrl);
  const currentPath = currentUrl.pathname;
  const currentDirectory = currentPath.includes("/")
    ? currentPath.slice(0, currentPath.lastIndexOf("/") + 1)
    : "/";

  const uniqueUrls = new Set();
  const derivedProfessorUrl = deriveProfessorListUrl(currentUrl);

  if (derivedProfessorUrl) {
    uniqueUrls.add(derivedProfessorUrl);
  }

  for (const link of links) {
    if (!link || uniqueUrls.has(link) || link === sourceUrl) {
      continue;
    }

    if (DISALLOWED_EXTENSIONS.test(link)) {
      continue;
    }

    if (DISALLOWED_SUBSTRINGS.some((fragment) => link.includes(fragment))) {
      continue;
    }

    const nextUrl = new URL(link);

    if (nextUrl.origin !== currentUrl.origin) {
      continue;
    }

    const sameSection = nextUrl.pathname.startsWith(currentDirectory);
    const detailView =
      nextUrl.pathname === currentPath &&
      (
        nextUrl.search.includes("articleNo=") ||
        nextUrl.search.includes("mode=view") ||
        nextUrl.search.includes("key=")
      );

    if (!sameSection && !detailView) {
      continue;
    }

    uniqueUrls.add(nextUrl.toString());

    if (uniqueUrls.size >= maxChildren) {
      break;
    }
  }

  return [...uniqueUrls];
}

function createChunks(document) {
  const paragraphs = document.text
    .split(/\n+/)
    .map((paragraph) => normalizeWhitespace(paragraph))
    .filter((paragraph) => paragraph.length >= 6);

  if (!paragraphs.length) {
    paragraphs.push(document.text);
  }

  const chunks = [];
  let buffer = [];
  let bufferLength = 0;

  for (const paragraph of paragraphs) {
    const nextLength = bufferLength + paragraph.length + 1;

    if (buffer.length && nextLength > CHUNK_SIZE) {
      chunks.push(buildChunk(document, chunks.length, buffer.join("\n")));

      const overlap = [];
      let overlapLength = 0;

      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        overlap.unshift(buffer[index]);
        overlapLength += buffer[index].length;

        if (overlapLength >= CHUNK_OVERLAP) {
          break;
        }
      }

      buffer = [...overlap, paragraph];
      bufferLength = buffer.reduce((total, item) => total + item.length + 1, 0);
      continue;
    }

    buffer.push(paragraph);
    bufferLength = nextLength;
  }

  if (buffer.length) {
    chunks.push(buildChunk(document, chunks.length, buffer.join("\n")));
  }

  return chunks;
}

function buildChunk(document, index, text) {
  return {
    id: `${document.id}-chunk-${index + 1}`,
    documentId: document.id,
    sourceId: document.sourceId,
    title: document.title,
    category: document.category,
    url: document.url,
    excerpt: text.slice(0, 220),
    text,
    updatedAt: document.updatedAt,
  };
}

async function createEmbeddings(inputs) {
  const allEmbeddings = [];

  for (let start = 0; start < inputs.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = inputs.slice(start, start + EMBEDDING_BATCH_SIZE);
    const response = await fetch(`${LM_STUDIO_SERVER_URL}/v1/embeddings`, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: batch,
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!response.ok) {
      const details = await response.text();

      throw new Error(
        `Embedding request failed (${response.status}): ${details || "No details"}`,
      );
    }

    const payload = await response.json();
    const batchEmbeddings = Array.isArray(payload.data)
      ? payload.data.map((item) => item.embedding)
      : [];

    if (batchEmbeddings.length !== batch.length) {
      throw new Error("Embedding batch length mismatch.");
    }

    allEmbeddings.push(...batchEmbeddings);
    console.log(`  embedded ${Math.min(start + batch.length, inputs.length)} / ${inputs.length}`);
  }

  return allEmbeddings;
}

function buildHeaders() {
  return {
    "Content-Type": "application/json",
    "User-Agent": "JJ-Campus-Copilot/1.0",
    ...(LM_STUDIO_API_KEY
      ? {
          Authorization: `Bearer ${LM_STUDIO_API_KEY}`,
        }
      : {}),
  };
}

function normalizeUrl(href, baseUrl) {
  if (!href) {
    return null;
  }

  const trimmed = href.trim();

  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  if (DISALLOWED_SUBSTRINGS.some((fragment) => trimmed.includes(fragment))) {
    return null;
  }

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function normalizeWhitespace(value = "") {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\t+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeLines(lines) {
  const deduped = [];

  for (const line of lines) {
    if (!line) {
      continue;
    }

    if (deduped.at(-1) === line) {
      continue;
    }

    deduped.push(line);
  }

  return deduped;
}

function deriveProfessorListUrl(currentUrl) {
  if (!currentUrl.pathname.startsWith("/jj/colleges/")) {
    return null;
  }

  if (!currentUrl.pathname.endsWith("-01.do")) {
    return null;
  }

  const nextUrl = new URL(currentUrl.toString());

  nextUrl.pathname = nextUrl.pathname.replace(/-01\.do$/, "-02.do");
  nextUrl.search = "";

  return nextUrl.toString();
}

function createId(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

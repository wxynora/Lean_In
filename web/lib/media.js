const BVID_PATTERN = /BV[0-9A-Za-z]{10}/;

function normalizeUrlInput(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  if (/^(?:www\.)?bilibili\.com\//i.test(input) || /^b23\.tv\//i.test(input)) {
    return `https://${input}`;
  }
  return input;
}

export function parseBilibiliReference(value) {
  const input = normalizeUrlInput(value);
  if (!input) throw new Error("请输入 Bilibili 分享链接或 BV 号");

  const match = input.match(BVID_PATTERN);
  let page = 1;
  let parsedUrl = null;
  if (/^https?:\/\//i.test(input)) {
    try {
      parsedUrl = new URL(input);
      const requestedPage = Number.parseInt(
        parsedUrl.searchParams.get("p") || parsedUrl.searchParams.get("page") || "1",
        10,
      );
      if (Number.isInteger(requestedPage) && requestedPage > 0) page = requestedPage;
    } catch {
      throw new Error("Bilibili 链接格式不正确");
    }
  }

  if (!match) {
    const host = parsedUrl?.hostname.toLowerCase() || "";
    if (host === "b23.tv" || host.endsWith(".b23.tv")) {
      return { requiresResolution: true, url: input, page };
    }
    throw new Error("没有在链接里找到 BV 号");
  }

  const bvid = match[0];
  return {
    requiresResolution: false,
    bvid,
    page,
    mediaId: `bili:${bvid}:p${page}`,
    canonicalUrl: `https://www.bilibili.com/video/${bvid}?p=${page}`,
    embedUrl: `https://player.bilibili.com/player.html?bvid=${bvid}&page=${page}&high_quality=1&danmaku=0`,
  };
}

export function parseBoundaryInput(value) {
  const input = String(value || "").trim();
  if (!input) return null;
  const parts = input.split(":");
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error(`无法识别时间“${input}”`);
  }
  const values = parts.map(Number);
  let seconds = 0;
  if (values.length === 1) seconds = values[0];
  if (values.length === 2) seconds = values[0] * 60 + values[1];
  if (values.length === 3) seconds = values[0] * 3600 + values[1] * 60 + values[2];
  if (!Number.isSafeInteger(seconds)) throw new Error(`时间“${input}”过大`);
  return seconds * 1000;
}

export function formatMediaTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const minuteText = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return [hours > 0 ? String(hours) : null, minuteText, String(seconds).padStart(2, "0")]
    .filter((part) => part !== null)
    .join(":");
}

export function titleFromFileName(name) {
  return String(name || "")
    .replace(/\.[^.]+$/, "")
    .trim();
}

function fallbackHash(bytes) {
  let hash = 2166136261;
  for (const value of bytes) {
    hash ^= value;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createLocalAssetId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function computeMediaRevision(file, durationMs) {
  if (!file || typeof file.slice !== "function") throw new Error("本地文件不可读取");
  const chunkSize = 64 * 1024;
  const offsets = [...new Set([
    0,
    Math.max(0, Math.floor(Number(file.size || 0) / 2) - Math.floor(chunkSize / 2)),
    Math.max(0, Number(file.size || 0) - chunkSize),
  ])];
  const metadata = new TextEncoder().encode([
    file.name || "",
    file.size || 0,
    file.lastModified || 0,
    file.type || "",
    Math.round(Number(durationMs || 0)),
  ].join("\n"));
  const chunks = [metadata];
  for (const offset of offsets) {
    chunks.push(new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer()));
  }
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const material = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    material.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  if (globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", material));
    return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  return fallbackHash(material);
}

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

export function localMediaId(file) {
  const identity = `${file.name}:${file.size}:${file.lastModified}`;
  let hash = 2166136261;
  for (const character of identity) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `local:${(hash >>> 0).toString(16)}`;
}

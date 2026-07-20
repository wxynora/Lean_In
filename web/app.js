import { WatchHostBridge } from "./lib/host.js";
import {
  analysisCostPresentation,
  createAnalysisCostAccumulator,
  recordAnalysisCost,
} from "./lib/analysis-cost.js";
import {
  analysisCoverageLabel,
  coverageAheadMs,
  formatLeadDuration,
} from "./lib/analysis-coverage.js";
import { LocalFrameSampler, validateClientSamplePlan } from "./lib/local-sampler.js";
import {
  computeMediaRevision,
  createLocalAssetId,
  formatMediaTime,
  parseBilibiliReference,
  parseBoundaryInput,
  titleFromFileName,
} from "./lib/media.js";
import { PlaybackTimeline, snapshotFromVideo } from "./lib/timeline.js";


const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const config = globalThis.TogetherWatchConfig || {};
const bridge = new WatchHostBridge(config);
const WATCH_PAGE_STATE_KEY = "togetherWatchPage";
const companionName = new URLSearchParams(location.search).get("companion")
  || config.companion?.name
  || document.documentElement.dataset.companionName
  || "{assistant}";

const state = {
  page: "confirm",
  source: "bilibili",
  localFile: null,
  localSubtitleFile: null,
  localAssetId: "",
  localRevision: "",
  localUrl: "",
  sampler: null,
  knowledgeMode: "",
  replyLeadMs: 30_000,
  fearAction: "warn_only",
  visualMode: "text_plus_contact_sheet",
  session: null,
  status: null,
  timeline: null,
  parts: [],
  currentPart: null,
  unlocked: false,
  awaitingProtection: false,
  starting: false,
  ending: false,
  syncing: false,
  polling: false,
  chatRunning: false,
  planInFlight: "",
  localSamplingError: "",
  completedPlans: new Set(),
  planRetryAfter: new Map(),
  timers: [],
  pendingDanmaku: new Map(),
  seenDanmaku: new Set(),
  bypassedRisks: new Set(),
  ignoreNextPopState: false,
  analysisCost: createAnalysisCostAccumulator(),
};

let analysisCostDialogDestination = null;

for (const node of $$('[data-companion]')) node.textContent = companionName;

function setPage(name, { historyMode = "none" } = {}) {
  state.page = name;
  $("#confirm-page").hidden = name !== "confirm";
  $("#player-page").hidden = name !== "player";
  if (historyMode === "replace") {
    history.replaceState({ ...(history.state || {}), [WATCH_PAGE_STATE_KEY]: name }, "");
  } else if (historyMode === "push" && history.state?.[WATCH_PAGE_STATE_KEY] !== name) {
    history.pushState({ ...(history.state || {}), [WATCH_PAGE_STATE_KEY]: name }, "");
  }
  window.scrollTo({ top: 0, behavior: "instant" });
}

function setError(message = "", target = "setup") {
  const node = target === "preparation"
    ? $("#preparation-error")
    : target === "message"
      ? $("#message-error")
      : $("#setup-error");
  node.textContent = message;
  node.hidden = !message;
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.hidden = false;
  setTimeout(() => { node.hidden = true; }, 2_500);
}

function resetAnalysisCostTracking() {
  state.analysisCost = createAnalysisCostAccumulator();
}

function recordEndedSessionCost(sessionId, payload) {
  const resolvedSessionId = String(payload?.session?.session_id || sessionId || "").trim();
  state.analysisCost = recordAnalysisCost(
    state.analysisCost,
    resolvedSessionId,
    payload?.analysis_cost,
  );
}

function closeAnalysisCostDialog() {
  const dialog = $("#analysis-cost-dialog");
  if (dialog.open) dialog.close();
  const destination = analysisCostDialogDestination;
  analysisCostDialogDestination = null;
  destination?.();
}

function showAnalysisCostDialog(accumulator, destination = null) {
  const presentation = analysisCostPresentation(accumulator);
  $("#analysis-cost-title").textContent = "本次剧情解析费用";
  $("#analysis-cost-amount").textContent = presentation.amountText;
  $("#analysis-cost-amount").hidden = !presentation.amountText;
  $("#analysis-cost-status").textContent = presentation.statusText;
  $("#analysis-cost-detail").textContent = presentation.detailText;
  $("#analysis-cost-detail").hidden = false;
  analysisCostDialogDestination = destination;
  $("#analysis-cost-dialog").showModal();
}

function showAnalysisCostUnavailable() {
  $("#analysis-cost-title").textContent = "费用暂时无法获取";
  $("#analysis-cost-amount").hidden = true;
  $("#analysis-cost-status").textContent = "结束请求没有成功，当前没有生成或推测任何费用。关闭后可以重新结束一次。";
  $("#analysis-cost-detail").hidden = true;
  analysisCostDialogDestination = null;
  $("#analysis-cost-dialog").showModal();
}

function finishAnalysisCostTracking(destination = null) {
  const total = state.analysisCost;
  resetAnalysisCostTracking();
  if (total.recordedSessionIds.size > 0) showAnalysisCostDialog(total, destination);
  else destination?.();
}

function setSelected(nodes, active) {
  for (const node of nodes) node.classList.toggle("is-selected", node === active);
}

function selectedTitle() {
  const explicit = $("#title-input").value.trim();
  if (explicit) return explicit;
  if (state.source === "local") return titleFromFileName(state.localFile?.name || "");
  return $("#bilibili-input").value.trim();
}

function updateSelection() {
  const title = selectedTitle();
  $("#selection-card").hidden = !title;
  $("#selection-title").textContent = title;
  $("#selection-meta").textContent = state.source === "local"
    ? "本地播放器  |  原片不会上传"
    : "Bilibili 官方播放器  |  播放状态需宿主适配器";
  const sourceReady = state.source === "local"
    ? Boolean(state.localFile)
    : Boolean($("#bilibili-input").value.trim());
  $("#start-button").disabled = !sourceReady || !state.knowledgeMode;
}

function selectSource(source) {
  state.source = source;
  for (const button of $$('[data-source]')) {
    const selected = button.dataset.source === source;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-selected", String(selected));
  }
  $("#bilibili-fields").hidden = source !== "bilibili";
  $("#local-fields").hidden = source !== "local";
  updateSelection();
}

function waitFor(target, eventName, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待 ${eventName} 超时`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(eventName, onReady);
      target.removeEventListener("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("播放器无法读取这个视频"));
    };
    target.addEventListener(eventName, onReady, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

function boundaryValues(durationMs) {
  const contentStartMs = parseBoundaryInput($("#content-start-input").value);
  const contentEndMs = parseBoundaryInput($("#content-end-input").value);
  if (contentStartMs !== null && contentStartMs >= durationMs) {
    throw new Error("正片开始必须早于视频结束");
  }
  if (contentEndMs !== null && contentEndMs > durationMs) {
    throw new Error("片尾开始不能超过视频时长");
  }
  if (contentStartMs !== null && contentEndMs !== null && contentStartMs >= contentEndMs) {
    throw new Error("正片开始必须早于片尾开始");
  }
  return { contentStartMs, contentEndMs };
}

function hasAudioBestEffort(video) {
  if (video.audioTracks && typeof video.audioTracks.length === "number") {
    return video.audioTracks.length > 0;
  }
  if (typeof video.mozHasAudio === "boolean") return video.mozHasAudio;
  if (typeof video.webkitAudioDecodedByteCount === "number") {
    return video.webkitAudioDecodedByteCount > 0;
  }
  return true;
}

function selectedSubtitle() {
  if (!state.localSubtitleFile) {
    return {
      kind: "none",
      track_id: "",
      language: "",
      label: "",
      format: "",
      offset_ms: 0,
    };
  }
  const extension = state.localSubtitleFile.name.split(".").pop()?.toLowerCase();
  if (!new Set(["srt", "vtt"]).has(extension)) {
    throw new Error("外挂字幕只支持 SRT 或 VTT");
  }
  const offsetMs = Number.parseInt($("#local-subtitle-offset").value || "0", 10);
  if (!Number.isInteger(offsetMs)) throw new Error("字幕偏移必须是毫秒整数");
  return {
    kind: "external",
    track_id: "external-file",
    language: $("#local-subtitle-language").value.trim(),
    label: state.localSubtitleFile.name,
    format: extension,
    offset_ms: offsetMs,
  };
}

async function prepareLocalMedia() {
  const video = $("#local-video");
  const iframe = $("#bilibili-player");
  const placeholder = $("#player-placeholder");
  iframe.hidden = true;
  placeholder.hidden = true;
  video.hidden = false;
  if (state.localUrl) URL.revokeObjectURL(state.localUrl);
  state.localUrl = URL.createObjectURL(state.localFile);
  video.src = state.localUrl;
  video.load();
  if (video.readyState < 1) await waitFor(video, "loadedmetadata");
  video.pause();
  const durationMs = Math.round(video.duration * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("没有读到本地视频时长");
  state.localAssetId = state.localAssetId || createLocalAssetId();
  state.localRevision = await computeMediaRevision(state.localFile, durationMs);
  state.sampler?.destroy();
  state.sampler = new LocalFrameSampler(state.localUrl);
  let canExportFrames = true;
  try {
    await state.sampler.probe();
  } catch {
    canExportFrames = false;
    state.sampler.destroy();
    state.sampler = null;
  }
  const hasAudio = hasAudioBestEffort(video);
  const subtitle = selectedSubtitle();
  const { contentStartMs, contentEndMs } = boundaryValues(durationMs);
  return {
    id: `local:${state.localAssetId}`,
    source: "local_file",
    title: selectedTitle(),
    duration_ms: durationMs,
    ...(contentStartMs === null ? {} : { content_start_ms: contentStartMs }),
    ...(contentEndMs === null ? {} : { content_end_ms: contentEndMs }),
    local_media: {
      local_asset_id: state.localAssetId,
      media_revision: state.localRevision,
      capabilities: {
        can_play: true,
        can_seek: Number.isFinite(video.duration) && video.duration > 0,
        can_read_future: canExportFrames,
        can_export_frames: canExportFrames,
        can_export_audio: false,
        has_audio: hasAudio,
        is_drm: false,
      },
      selected_audio: hasAudio
        ? { track_id: "browser-default", language: "", label: "浏览器默认音轨" }
        : { track_id: "", language: "", label: "" },
      selected_subtitle: subtitle,
    },
  };
}

async function prepareBilibiliMedia() {
  if (!bridge.canTrackBilibiliPlayback()) {
    throw new Error("Web 无法跨域读取官方播放器状态；请配置 TogetherWatchHost.getPlaybackSnapshot");
  }
  const reference = parseBilibiliReference($("#bilibili-input").value);
  if (reference.requiresResolution) {
    throw new Error("短链接需要宿主先解析为完整 Bilibili 链接或 BV 号");
  }
  const description = await bridge.describeBilibiliParts(reference.bvid, reference.page);
  const current = description.current;
  if (!current?.duration_ms) throw new Error("网关没有返回当前分 P 的真实时长");
  state.parts = description.parts || [];
  state.currentPart = current;
  const iframe = $("#bilibili-player");
  $("#local-video").hidden = true;
  $("#player-placeholder").hidden = true;
  iframe.src = current.embed_url;
  iframe.hidden = false;
  renderPartNavigation();
  const { contentStartMs, contentEndMs } = boundaryValues(current.duration_ms);
  return {
    id: current.media_id,
    source: "bilibili_embed",
    source_url: current.canonical_url,
    embed_url: current.embed_url,
    title: selectedTitle() || description.title,
    part_title: current.title,
    part_index: current.page,
    duration_ms: current.duration_ms,
    ...(contentStartMs === null ? {} : { content_start_ms: contentStartMs }),
    ...(contentEndMs === null ? {} : { content_end_ms: contentEndMs }),
  };
}

function modePayload() {
  return {
    knowledge_mode: state.knowledgeMode,
    fear_mode: $("#fear-mode-input").checked,
    fear_action: state.fearAction,
    danmaku_enabled: $("#danmaku-input").checked,
    reply_lead_ms: state.replyLeadMs,
    visual_context_mode: state.visualMode,
  };
}

function activeFearMode(payload = {}) {
  const configured = payload.mode?.fear_mode ?? state.session?.mode?.fear_mode;
  return configured === undefined ? $("#fear-mode-input").checked : Boolean(configured);
}

function clearRuntimeTimers() {
  for (const timer of state.timers) clearInterval(timer);
  state.timers = [];
}

function resetSessionState() {
  clearRuntimeTimers();
  state.sampler?.destroy();
  state.sampler = null;
  if (state.localUrl) URL.revokeObjectURL(state.localUrl);
  state.localUrl = "";
  const localVideo = $("#local-video");
  localVideo.pause();
  localVideo.removeAttribute("src");
  localVideo.load();
  state.session = null;
  state.status = null;
  state.timeline = null;
  state.unlocked = false;
  state.awaitingProtection = false;
  state.starting = false;
  state.syncing = false;
  state.polling = false;
  state.chatRunning = false;
  state.planInFlight = "";
  state.localSamplingError = "";
  state.completedPlans.clear();
  state.planRetryAfter.clear();
  state.pendingDanmaku.clear();
  state.seenDanmaku.clear();
  state.bypassedRisks.clear();
  $$("#conversation-list .chat-message").forEach((message) => message.remove());
  $("#conversation-empty").hidden = false;
  $("#message-input").value = "";
  $("#send-button").disabled = true;
  updateConversationState(false);
}

async function uploadSelectedSubtitle(media) {
  const selection = media.local_media?.selected_subtitle;
  if (!state.localSubtitleFile || selection?.kind !== "external") return;
  await bridge.uploadLocalSubtitle(state.session.session_id, {
    media_revision: state.localRevision,
    format: selection.format,
    track_id: selection.track_id,
    subtitle_text: await state.localSubtitleFile.text(),
  });
}

function initialPlayerState(title) {
  $("#player-title").textContent = title || "一起看";
  $("#sync-badge").textContent = "准备中";
  $("#player-lock").hidden = false;
  $("#preparation-panel").hidden = false;
  $("#conversation-panel").hidden = true;
  $("#playback-status").hidden = true;
  $("#preparation-title").textContent = "正在建立观看会话";
  $("#preparation-description").textContent = "播放器保持暂停，正在读取真实准备状态。";
  $("#start-gate-card").hidden = true;
  $("#local-sampling-card").hidden = true;
  document.querySelector(".preparation-actions").hidden = false;
  $("#confirm-start-button").disabled = true;
  $("#skip-button").hidden = true;
  setError("", "preparation");
}

async function enterPlayer() {
  setError();
  resetSessionState();
  initialPlayerState(selectedTitle());
  setPage("player", { historyMode: "push" });
  $("#start-button").querySelector(".button-spinner").hidden = false;
  $("#start-button").disabled = true;
  try {
    const media = state.source === "local"
      ? await prepareLocalMedia()
      : await prepareBilibiliMedia();
    $("#player-title").textContent = media.part_title
      ? `${media.title} · ${media.part_title}`
      : media.title;
    const created = await bridge.createSession({
      window_id: config.windowId || "together-watch:web",
      companion: config.companion || { id: "companion", name: companionName },
      media,
      mode: modePayload(),
    });
    state.session = created.session;
    state.timeline = new PlaybackTimeline(media.id);
    if (state.source === "local") await uploadSelectedSubtitle(media);
    startRuntimeLoops();
    await pollStatus();
  } catch (error) {
    setError(error.message || "建立观看会话失败", "preparation");
    $("#preparation-title").textContent = "准备失败";
    $("#preparation-description").textContent = "没有创建可继续消耗分析资源的会话。";
  } finally {
    $("#start-button").querySelector(".button-spinner").hidden = true;
    updateSelection();
  }
}

function startRuntimeLoops() {
  clearRuntimeTimers();
  const heartbeatMs = Math.max(5_000, Number(config.heartbeatIntervalMs || 30_000));
  const playbackMs = Math.max(500, Number(config.playbackSyncIntervalMs || 2_000));
  const statusMs = Math.max(500, Number(config.statusPollIntervalMs || 2_000));
  state.timers.push(setInterval(() => {
    if (state.session) bridge.heartbeat(state.session.session_id).catch(handleRuntimeError);
  }, heartbeatMs));
  state.timers.push(setInterval(() => { syncPlayback().catch(handleRuntimeError); }, playbackMs));
  state.timers.push(setInterval(() => { pollStatus().catch(handleRuntimeError); }, statusMs));
}

function handleRuntimeError(error) {
  const message = error?.message || "一起看同步失败";
  $("#playback-notice").textContent = message;
  $("#playback-notice").hidden = false;
}

async function captureSnapshot() {
  if (!state.session || !state.timeline) return null;
  if (state.source === "local") return snapshotFromVideo($("#local-video"), state.timeline);
  const raw = await bridge.getPlaybackSnapshot({
    session_id: state.session.session_id,
    media: state.session.media,
  });
  if (!raw) return null;
  const required = ["media_id", "playhead_ms", "is_playing", "playback_rate", "timeline_epoch", "snapshot_seq", "captured_at"];
  if (required.every((key) => raw[key] !== undefined)) return raw;
  return state.timeline.next({
    playheadMs: raw.playhead_ms,
    durationMs: raw.duration_ms || state.session.media.duration_ms,
    isPlaying: raw.is_playing,
    playbackRate: raw.playback_rate,
    capturedAt: raw.captured_at,
  });
}

async function syncPlayback() {
  if (!state.session || state.syncing) return null;
  state.syncing = true;
  try {
    const snapshot = await captureSnapshot();
    if (!snapshot) return null;
    const result = await bridge.updatePlayback(state.session.session_id, snapshot);
    if (result.session) state.session = result.session;
    updatePlaybackClock(snapshot);
    flushDanmaku(snapshot);
    return snapshot;
  } finally {
    state.syncing = false;
  }
}

function updatePlaybackClock(snapshot) {
  $("#playback-clock").textContent = `${formatMediaTime(snapshot.playhead_ms)} / ${formatMediaTime(snapshot.duration_ms || state.session?.media?.duration_ms)}`;
}

function progressIndex(status) {
  return {
    identifying: 0,
    collecting_sources: 1,
    building_card: 2,
    searching_subtitles: 3,
    ready_to_confirm: 4,
    confirmed: 5,
  }[status] ?? 0;
}

function appendKnowledgeSection(node, titleText, body) {
  if (!body) return;
  const section = document.createElement("section");
  section.className = "knowledge-section";
  const title = document.createElement("h4");
  title.textContent = titleText;
  section.append(title, body);
  node.append(section);
}

function textParagraph(value, className = "") {
  const node = document.createElement("p");
  if (className) node.className = className;
  node.textContent = String(value || "");
  return node;
}

function renderKnowledgeCard(card) {
  const node = $("#knowledge-card");
  node.replaceChildren();
  if (!card || !Object.keys(card).length) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  const identity = card.canonical_identity || card.identity || {};
  const header = document.createElement("header");
  header.className = "knowledge-card-header";
  const heading = document.createElement("div");
  const label = textParagraph("作品知识卡", "section-label accent-label");
  const title = document.createElement("h3");
  title.textContent = identity.title || "已核对作品";
  heading.append(label, title);
  if (identity.original_title && identity.original_title !== identity.title) {
    heading.append(textParagraph(identity.original_title, "original-title"));
  }
  const identityMeta = [
    Number(identity.year) > 0 ? identity.year : "",
    { movie: "电影", series: "剧集" }[identity.work_type] || identity.work_type,
    identity.season,
    identity.episode,
  ].filter(Boolean).join(" · ");
  if (identityMeta) heading.append(textParagraph(identityMeta, "identity-meta"));
  header.append(heading);
  if (Number.isFinite(Number(card.confidence))) {
    const confidence = document.createElement("span");
    confidence.className = "confidence-badge";
    confidence.textContent = `可信度 ${Math.round(Number(card.confidence) * 100)}%`;
    header.append(confidence);
  }
  node.append(header);

  if (identity.version_notes) {
    appendKnowledgeSection(node, "版本说明", textParagraph(identity.version_notes));
  }
  if (card.setting?.premise) {
    const setting = document.createElement("div");
    setting.append(textParagraph(card.setting.premise));
    const settingMeta = [card.setting.time_period, ...(card.setting.locations || [])]
      .filter(Boolean)
      .join(" · ");
    if (settingMeta) setting.append(textParagraph(settingMeta, "knowledge-muted"));
    appendKnowledgeSection(node, "故事前提", setting);
  }
  if (card.pre_story) {
    appendKnowledgeSection(node, "理解开场所需", textParagraph(card.pre_story));
  }

  const characters = Array.isArray(card.characters) ? card.characters : [];
  if (characters.length) {
    const list = document.createElement("div");
    list.className = "character-list";
    for (const character of characters) {
      const entry = document.createElement("div");
      entry.className = "character-entry";
      const name = document.createElement("strong");
      const aliases = (character.aliases || []).filter(Boolean);
      name.textContent = `${character.name || "角色"}${aliases.length ? `  ·  ${aliases.join(" / ")}` : ""}`;
      entry.append(name);
      if (character.identity) entry.append(textParagraph(character.identity));
      const relationships = (character.relationships || []).map((relationship) => (
        typeof relationship === "string"
          ? relationship
          : [relationship.target, relationship.relation].filter(Boolean).join(" · ")
      )).filter(Boolean);
      if (relationships.length) {
        const relationLine = document.createElement("small");
        relationLine.textContent = relationships.join("；");
        entry.append(relationLine);
      }
      list.append(entry);
    }
    appendKnowledgeSection(node, "人物与关系", list);
  }

  if (Array.isArray(card.terminology) && card.terminology.length) {
    const list = document.createElement("ul");
    for (const item of card.terminology) {
      const line = document.createElement("li");
      line.textContent = `${item.term || "名词"}  ·  ${item.meaning || ""}`;
      list.append(line);
    }
    appendKnowledgeSection(node, "专有名词", list);
  }
  if (Array.isArray(card.story_outline) && card.story_outline.length) {
    const list = document.createElement("ol");
    for (const item of card.story_outline) {
      const line = document.createElement("li");
      line.textContent = item;
      list.append(line);
    }
    appendKnowledgeSection(node, "剧情主线", list);
  }
  if (Array.isArray(card.limitations) && card.limitations.length) {
    appendKnowledgeSection(node, "资料限制", textParagraph(card.limitations.join("；")));
  }
  const sources = card.source_notes || card.sources || [];
  if (Array.isArray(sources) && sources.length) {
    const list = document.createElement("ul");
    list.className = "source-list";
    for (const source of sources) {
      const line = document.createElement("li");
      if (source.url) {
        const link = document.createElement("a");
        link.href = source.url;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = source.title || source.url;
        line.append(link);
      } else {
        line.textContent = source.title || "公开资料";
      }
      list.append(line);
    }
    appendKnowledgeSection(node, "公开来源", list);
  }
}

function renderSubtitle(preparation) {
  const lookup = preparation.subtitle_lookup || {};
  const status = lookup.status || "pending";
  const pending = new Set(["pending", "queued", "searching", "awaiting_client"]).has(status);
  $("#subtitle-spinner").hidden = !pending;
  $("#subtitle-title").textContent = {
    pending: "等待字幕查找",
    queued: "等待字幕查找",
    searching: "正在查找字幕",
    found: "字幕已找到",
    not_found: "没有找到匹配字幕",
    not_configured: "字幕服务未配置",
    original_title_unavailable: "暂时拿不到作品原名",
    awaiting_client: "等待载入本地字幕",
    failed: "字幕查找失败",
  }[status] || `字幕状态：${status}`;
  $("#subtitle-description").textContent = lookup.error || lookup.message || {
    pending: "作品识别完成后会自动开始查找。",
    queued: "作品识别完成后会自动开始查找。",
    searching: "正在按原名、语言和版本匹配可用字幕。",
    awaiting_client: "已经选好本地字幕轨，客户端正在读取并提交时间轴。",
    found: "开播时会使用这次准备得到的字幕版本。",
    not_found: "当前没有匹配结果，可以重试或按服务端门禁继续。",
    not_configured: "当前环境没有配置字幕来源，可以按服务端门禁继续。",
    original_title_unavailable: "作品原名还没准备好，可以稍后重试。",
    failed: "这次查找没有完成，可以重新发起。",
  }[status] || "字幕状态正在同步。";

  const metadata = $("#subtitle-metadata");
  metadata.replaceChildren();
  if (status === "found") {
    const coverageStart = lookup.coverage_start_ms;
    const coverageEnd = lookup.coverage_end_ms;
    const coverage = coverageStart != null && coverageEnd != null
      ? `${formatMediaTime(coverageStart)} – ${formatMediaTime(coverageEnd)}`
      : coverageStart != null
        ? `从 ${formatMediaTime(coverageStart)} 开始`
        : coverageEnd != null
          ? `截至 ${formatMediaTime(coverageEnd)}`
          : "";
    const rows = [
      ["查询原名", lookup.query_title],
      ["字幕来源", lookup.provider],
      ["语言", (lookup.language_codes || []).join(" / ")],
      ["匹配版本", lookup.release_name],
      ["格式", String(lookup.format || "").toUpperCase()],
      ["条目数", Number(lookup.cue_count) > 0 ? String(lookup.cue_count) : ""],
      ["覆盖区间", coverage],
    ].filter(([, value]) => value);
    for (const [label, value] of rows) {
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      metadata.append(term, detail);
    }
    metadata.hidden = rows.length === 0;
  } else {
    metadata.hidden = true;
  }
  $("#retry-subtitles-button").hidden = !lookup.can_retry || state.source === "local";
}

function renderLocalSampling(payload) {
  const card = $("#local-sampling-card");
  const sampling = payload.sample_plan?.local_sampling || {};
  const reasons = Array.isArray(sampling.reasons) ? sampling.reasons.filter(Boolean) : [];
  const statusText = {
    pending: "正在等待本地剧情取材。",
    queued: "本地剧情取材已经排队。",
    sampling: "正在从本地视频读取当前取材计划。",
    uploading: "正在提交本轮本地剧情素材。",
    ready: "本地剧情素材已经可用于分析。",
    unavailable: "当前本地视频无法可靠取材。",
    failed: "本轮本地剧情取材失败。",
  }[sampling.status] || sampling.status || "";
  const detail = state.localSamplingError
    || reasons.join("；")
    || sampling.audio_degraded_reason
    || statusText;
  const visible = state.source === "local" && Boolean(detail);
  card.hidden = !visible;
  if (!visible) return;
  $("#local-sampling-description").textContent = detail;
  const retryable = Boolean(state.localSamplingError)
    || ["unavailable", "failed"].includes(sampling.status);
  $("#retry-local-sampling-button").hidden = !retryable || !payload.sample_plan?.plan_id;
}

function renderStartGate(preparation, payload) {
  const gate = payload.start_gate || {};
  const protection = payload.fear_protection || {};
  const fearMode = activeFearMode(payload);
  const hasStarted = Boolean(preparation.started_at) || preparation.status === "confirmed";
  const active = hasStarted && !gate.can_play;
  const card = $("#start-gate-card");
  card.hidden = !active;
  if (!active) return false;

  $("#start-gate-description").textContent = {
    local_sampling_unavailable: fearMode
      ? "这个本地文件无法可靠独立取材，剧情分析和胆小模式不能假装已经准备好。"
      : "这个本地文件无法可靠独立取材，剧情分析不能假装已经准备好。",
  }[gate.reason] || (fearMode
    ? "正在等待首段剧情与高能保护达到开播所需的五分钟。"
    : "正在等待首段剧情分析达到开播所需的五分钟。");
  const coverage = $("#start-gate-coverage");
  const playheadMs = Number(payload.playback?.playhead_ms ?? currentPlayheadMs());
  const preparedAheadMs = coverageAheadMs(gate.covered_until_ms, playheadMs);
  const requiredAheadMs = coverageAheadMs(gate.required_until_ms, playheadMs);
  coverage.hidden = !(Number(gate.required_until_ms) > 0);
  coverage.textContent = coverage.hidden
    ? ""
    : `已提前解析 ${formatLeadDuration(preparedAheadMs)}剧情 · 需要 ${formatLeadDuration(requiredAheadMs)}`;
  const protectionState = $("#start-gate-protection");
  protectionState.hidden = protection.status !== "coverage_low";
  protectionState.textContent = protectionState.hidden ? "" : "当前真实状态：保护覆盖不足";
  const wait = $("#wait-protection-button");
  wait.disabled = false;
  wait.textContent = "继续等待";
  $("#continue-unprotected-button").hidden = !gate.can_continue_unprotected;
  return true;
}

function renderPreparation(payload) {
  const preparation = payload.preparation || {};
  const status = preparation.status || preparation.stage || "identifying";
  preparation.status = status;
  const index = progressIndex(status);
  $$("#preparation-progress li").forEach((item, itemIndex) => {
    item.classList.toggle("is-complete", itemIndex < index);
    item.classList.toggle("is-active", itemIndex === index && index < 5);
  });
  const cardStatus = preparation.knowledge_card_status;
  $("#identified-card").hidden = !(status === "ready_to_confirm" && cardStatus === "not_required");
  renderKnowledgeCard(payload.knowledge_card || preparation.knowledge_card);
  renderSubtitle(preparation);
  renderLocalSampling(payload);
  const gate = payload.start_gate || {};
  const fearMode = activeFearMode(payload);
  const hasStarted = Boolean(preparation.started_at) || status === "confirmed";
  $("#preparation-title").textContent = hasStarted && !gate.can_play
    ? fearMode
      ? "正在准备首段剧情与高能保护"
      : "正在准备首段剧情"
    : {
        identifying: "正在识别作品",
        collecting_sources: "正在搜集资料",
        building_card: "正在整理知识卡",
        searching_subtitles: "正在查找匹配字幕",
        ready_to_confirm: "准备好了，等你确认",
        knowledge_failed: "这次资料没准备好",
      }[status] || "正在准备一起看";
  $("#preparation-description").textContent = hasStarted && !gate.can_play
    ? fearMode
      ? "播放器仍保持暂停。首段五分钟剧情与高能保护准备好后会自动开始，也可以明确选择无保护继续。"
      : "播放器仍保持暂停。首段五分钟剧情准备好后会自动开始。"
    : {
        identifying: "先核对作品、版本和分 P，避免认错片。",
        collecting_sources: "正在从公开来源核对人物、背景和剧情资料。",
        building_card: "正在把资料整理成之后能反复使用的固定卡片。",
        searching_subtitles: "正在按作品原名和版本查找可用字幕。",
        ready_to_confirm: "看过卡片后再开播；你也可以明确跳过。",
        knowledge_failed: "可以重新搜集，也可以不等资料直接开始。",
      }[status] || "确认完成前不会解锁播放。";

  const analysis = payload.analysis || {};
  $("#analysis-state-card").hidden = !analysis.error && !preparation.knowledge_card_error;
  $("#analysis-state-title").textContent = analysis.status === "failed" ? "剧情分析不可用" : "当前为降级状态";
  $("#analysis-state-description").textContent = analysis.error || preparation.knowledge_card_error || "";
  const visual = payload.visual_context || {};
  $("#visual-state-card").hidden = !visual.degraded_reason;
  $("#visual-state-description").textContent = visual.degraded_reason || "";

  const gateActive = renderStartGate(preparation, payload);
  document.querySelector(".preparation-actions").hidden = gateActive;
  if (!gateActive) {
    $("#confirm-start-button").disabled = !preparation.can_confirm;
    $("#confirm-start-button").textContent = "确认开始";
    $("#skip-button").hidden = !preparation.can_skip;
    $("#skip-button").textContent = "跳过准备";
  }
  $("#regenerate-button").hidden = !["failed", "ready"].includes(cardStatus);
}

async function processSamplePlan(plan) {
  if (
    state.source !== "local"
    || !state.sampler
    || plan?.managed_by !== "client"
    || !plan.client_upload_required
    || !plan.plan_id
  ) return;
  if (state.planInFlight || state.completedPlans.has(plan.plan_id)) return;
  if ((state.planRetryAfter.get(plan.plan_id) || 0) > Date.now()) return;
  if (plan.audio_required) {
    state.localSamplingError = "当前浏览器不能从未来位置导出所选音轨，无法执行这份音频取材计划。";
    setError(state.localSamplingError, "preparation");
    return;
  }
  state.planInFlight = plan.plan_id;
  try {
    validateClientSamplePlan(plan, {
      mediaId: state.session.media.id,
      mediaRevision: state.localRevision,
      timelineEpoch: state.timeline?.timelineEpoch ?? state.status?.playback?.timeline_epoch ?? 0,
    });
    const exported = await state.sampler.exportPlan(plan);
    await bridge.uploadSamples(
      state.session.session_id,
      {
        plan_id: plan.plan_id,
        media_revision: state.localRevision,
        purpose: plan.purpose,
        timeline_epoch: plan.timeline_epoch,
        actual_range_start_ms: plan.allowed_start_ms,
        actual_range_end_ms: plan.allowed_end_ms,
        audio_track_id: state.session.media.local_media?.selected_audio?.track_id || "",
        samples: exported.samples,
      },
      exported.files,
    );
    state.completedPlans.add(plan.plan_id);
    state.localSamplingError = "";
    setError("", "preparation");
  } catch (error) {
    state.planRetryAfter.set(plan.plan_id, Date.now() + 5_000);
    state.localSamplingError = error.message || "本地取材失败";
    setError(state.localSamplingError, "preparation");
  } finally {
    state.planInFlight = "";
  }
}

async function pollStatus() {
  if (!state.session || state.polling) return;
  state.polling = true;
  try {
    const payload = await bridge.getStatus(state.session.session_id);
    state.status = payload;
    if (payload.playback) updatePlaybackClock(payload.playback);
    renderPreparation(payload);
    renderWatchingStatus(payload);
    await processSamplePlan(payload.sample_plan);
    if (payload.start_gate?.can_play && !state.unlocked) unlockPlayback();
  } finally {
    state.polling = false;
  }
}

function renderWatchingStatus(payload) {
  const analysis = payload.analysis || {};
  const playheadMs = Number(payload.playback?.playhead_ms ?? currentPlayheadMs());
  $("#analysis-label").textContent = analysisCoverageLabel(
    analysis.status,
    analysis.covered_until_ms,
    playheadMs,
  );
  const notice = $("#playback-notice");
  const protection = payload.fear_protection || {};
  if (state.unlocked && protection.status === "protected") {
    notice.textContent = `胆小模式已保护 · 前方覆盖 ${formatMediaTime(protection.coverage_remaining_ms)}`;
    notice.hidden = false;
  } else if (state.unlocked && protection.status === "coverage_low") {
    notice.textContent = "胆小模式当前覆盖不足，不会假装能完整预警或遮挡。";
    notice.hidden = false;
  } else {
    notice.hidden = true;
    notice.textContent = "";
  }
  renderRisk(payload.upcoming_risks || []);
}

async function startWithAction(action, protectionAction = "wait") {
  if (!state.session || state.starting) return;
  state.starting = true;
  setError("", "preparation");
  try {
    const preparation = state.status?.preparation || {};
    const result = await bridge.startSession(state.session.session_id, {
      knowledge_card_action: action,
      knowledge_card_key: state.status?.knowledge_card?.cache_key || "",
      subtitle_lookup_id: preparation.subtitle_lookup?.lookup_id || "",
      protection_action: protectionAction,
    });
    state.session = result.session || state.session;
    if (result.start_gate?.can_play) {
      unlockPlayback();
    } else {
      state.awaitingProtection = true;
      await pollStatus();
    }
  } catch (error) {
    setError(error.message || "确认开播失败", "preparation");
  } finally {
    state.starting = false;
  }
}

async function continueUnprotected() {
  if (!state.session || state.starting) return;
  state.starting = true;
  try {
    const result = await bridge.startSession(state.session.session_id, {
      protection_action: "continue_unprotected",
    });
    state.session = result.session || state.session;
    if (result.start_gate?.can_play) unlockPlayback();
  } catch (error) {
    setError(error.message || "无法继续播放", "preparation");
  } finally {
    state.starting = false;
  }
}

function unlockPlayback() {
  state.unlocked = true;
  state.awaitingProtection = false;
  $("#player-lock").hidden = true;
  $("#preparation-panel").hidden = true;
  $("#conversation-panel").hidden = false;
  $("#playback-status").hidden = false;
  $("#sync-badge").textContent = "播放已同步";
  const chatReady = bridge.canSendMessage();
  $("#message-input").disabled = !chatReady;
  updateConversationState(false);
  if (!chatReady) setError("聊天宿主未配置；播放与分析仍会正常同步。", "message");
}

function updateConversationState(runActive = state.chatRunning) {
  const chatReady = bridge.canSendMessage();
  $("#conversation-state").textContent = runActive
    ? `${companionName}正在回复`
    : $("#danmaku-input").checked
      ? `${companionName}的弹幕已开启`
      : `${companionName}的弹幕已关闭`;
  $("#message-input").placeholder = chatReady
    ? `和${companionName}说点什么...`
    : "等待观看会话同步...";
  $("#send-button").textContent = runActive ? "等他" : "发送";
}

function appendMessage(speaker, text, isUser = false) {
  if (!String(text || "").trim()) return;
  $("#conversation-empty").hidden = true;
  const fragment = $("#message-template").content.cloneNode(true);
  const message = fragment.querySelector(".chat-message");
  if (isUser) message.classList.add("is-user");
  fragment.querySelector(".message-speaker").textContent = speaker;
  fragment.querySelector(".message-body").textContent = text;
  $("#conversation-list").append(fragment);
  $("#conversation-list").scrollTop = $("#conversation-list").scrollHeight;
}

async function sendMessage(text) {
  if (!bridge.canSendMessage()) throw new Error("请先配置 TogetherWatchHost.sendMessage");
  const snapshot = await captureSnapshot();
  if (!snapshot) throw new Error("当前读不到准确播放位置");
  await bridge.updatePlayback(state.session.session_id, snapshot);
  const result = await bridge.sendMessage({
    text,
    watch_session_id: state.session.session_id,
    watch_snapshot: snapshot,
  });
  appendMessage("你", text, true);
  if (result?.assistant_text) appendMessage(companionName, result.assistant_text, false);
  for (const message of result?.messages || []) {
    if (message?.role === "assistant") appendMessage(companionName, message.content, false);
  }
}

function currentPlayheadMs() {
  if (state.source === "local" && Number.isFinite($("#local-video").currentTime)) {
    return Math.round($("#local-video").currentTime * 1000);
  }
  return Number(state.status?.playback?.playhead_ms || 0);
}

function renderDanmaku(action) {
  const layer = $("#danmaku-layer");
  while (layer.children.length >= 3) layer.firstElementChild?.remove();
  [...layer.children].forEach((child, index) => {
    child.style.top = `${index * 30}px`;
  });
  const item = document.createElement("span");
  item.className = "danmaku-item";
  item.textContent = action.text;
  item.style.top = `${layer.children.length * 30}px`;
  layer.append(item);
  item.addEventListener("animationend", () => {
    item.remove();
    [...layer.children].forEach((child, index) => {
      child.style.top = `${index * 30}px`;
    });
  }, { once: true });
}

function acceptDanmaku(raw) {
  const action = raw?.action || raw;
  if (!state.session || !action?.action_id || state.seenDanmaku.has(action.action_id)) return;
  const playback = state.status?.playback || state.session.playback || {};
  if (
    action.session_id !== state.session.session_id
    || action.media_id !== state.session.media.id
    || Number(action.timeline_epoch) !== Number(playback.timeline_epoch || 0)
  ) return;
  const playhead = currentPlayheadMs();
  if (Number(action.target_ms) < playhead - 5_000 || Number(action.target_ms) > playhead + 120_000) return;
  state.seenDanmaku.add(action.action_id);
  state.pendingDanmaku.set(action.action_id, action);
  flushDanmaku({ playhead_ms: playhead });
}

function flushDanmaku(snapshot) {
  const playhead = Number(snapshot?.playhead_ms || 0);
  for (const [actionId, action] of state.pendingDanmaku) {
    if (Number(action.target_ms) > playhead + 500) continue;
    state.pendingDanmaku.delete(actionId);
    if (Number(action.target_ms) >= playhead - 5_000) renderDanmaku(action);
  }
}

function renderRisk(risks) {
  if (!state.unlocked || !$("#fear-mode-input").checked) return clearRisk();
  const playhead = currentPlayheadMs();
  const risk = risks.find((item) => (
    !state.bypassedRisks.has(item.id || item.risk_id)
    && playhead >= Number(item.warn_at_ms || item.start_ms || 0)
    && playhead <= Number(item.end_ms || 0)
  ));
  if (!risk) return clearRisk();
  const riskId = risk.id || risk.risk_id;
  const label = risk.companion_hint || risk.label || "前面有一小段突发高能。";
  if (state.fearAction === "cover_video") {
    $("#risk-cover-label").textContent = label;
    $("#risk-cover-clock").textContent = `${formatMediaTime(playhead)} / ${formatMediaTime(risk.end_ms)}`;
    $("#risk-cover").dataset.riskId = riskId;
    $("#risk-cover").hidden = false;
    $("#risk-warning").hidden = true;
  } else {
    $("#risk-warning-label").textContent = label;
    $("#risk-warning").dataset.riskId = riskId;
    $("#risk-warning").hidden = false;
    $("#risk-cover").hidden = true;
  }
}

function clearRisk() {
  $("#risk-warning").hidden = true;
  $("#risk-cover").hidden = true;
  $("#risk-warning").dataset.riskId = "";
  $("#risk-cover").dataset.riskId = "";
}

function renderPartNavigation() {
  const nav = $("#part-navigation");
  renderPreparationPartSelector();
  nav.hidden = state.parts.length <= 1;
  if (nav.hidden) return;
  const index = state.parts.findIndex((item) => item.media_id === state.currentPart?.media_id);
  $("#previous-part-button").disabled = index <= 0;
  $("#next-part-button").disabled = index < 0 || index >= state.parts.length - 1;
  $("#part-selector-meta").textContent = `P${state.currentPart?.page || 1} / ${state.parts.length} · ${formatMediaTime(state.currentPart?.duration_ms)}`;
  $("#part-selector-title").textContent = state.currentPart?.title || "";
  const list = $("#part-list");
  list.replaceChildren();
  for (const part of state.parts) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `P${part.page} · ${part.title}`;
    button.classList.toggle("is-selected", part.media_id === state.currentPart?.media_id);
    button.addEventListener("click", () => switchPart(part));
    list.append(button);
  }
}

function renderPreparationPartSelector() {
  const node = $("#preparation-part-selector");
  node.replaceChildren();
  node.hidden = state.parts.length <= 1 || !state.currentPart;
  if (node.hidden) return;
  for (const part of state.parts) {
    const button = document.createElement("button");
    button.type = "button";
    button.classList.toggle("is-selected", part.media_id === state.currentPart.media_id);
    button.textContent = `P${part.page}`;
    button.setAttribute("aria-label", `P${part.page} · ${part.title}`);
    if (part.media_id !== state.currentPart.media_id) {
      button.addEventListener("click", () => switchPart(part));
    }
    node.append(button);
  }
}

async function switchPart(part) {
  const ended = await leaveSession({ returnToConfirm: false, showCost: false });
  if (!ended) return;
  $("#bilibili-input").value = part.canonical_url;
  $("#part-list").hidden = true;
  await enterPlayer();
}

async function leaveSession({ returnToConfirm = true, consumeHistory = true, showCost = true } = {}) {
  if (state.ending) return false;
  state.ending = true;
  const sessionId = state.session?.session_id;
  clearRuntimeTimers();
  $("#local-video").pause();
  try {
    if (sessionId) {
      const ended = await bridge.endSession(sessionId);
      recordEndedSessionCost(sessionId, ended);
    }
  } catch (error) {
    state.ending = false;
    if (state.session) startRuntimeLoops();
    if (showCost) showAnalysisCostUnavailable();
    else toast(error.message || "结束会话失败；客户端租约会自动过期");
    return false;
  }

  resetSessionState();
  state.ending = false;
  if (returnToConfirm) {
    setPage("confirm");
    if (consumeHistory && history.state?.[WATCH_PAGE_STATE_KEY] === "player") {
      state.ignoreNextPopState = true;
      history.back();
    }
  }
  if (showCost) finishAnalysisCostTracking();
  return true;
}

async function loadRecentSessions() {
  try {
    const payload = await bridge.listSessions(config.windowId || "together-watch:web");
    const sessions = payload.sessions || [];
    $("#recent-section").hidden = sessions.length === 0;
    const list = $("#recent-list");
    list.replaceChildren();
    for (const session of sessions) {
      const fragment = $("#recent-template").content.cloneNode(true);
      fragment.querySelector(".recent-title").textContent = session.media?.title || "一起看";
      fragment.querySelector(".recent-part").textContent = session.media?.part_title || "";
      fragment.querySelector(".recent-time").textContent = formatMediaTime(session.playback?.playhead_ms || 0);
      list.append(fragment);
    }
  } catch {
    $("#recent-section").hidden = true;
  }
}

for (const button of $$('[data-source]')) {
  button.addEventListener("click", () => selectSource(button.dataset.source));
}

$("#local-file-input").addEventListener("change", (event) => {
  state.localFile = event.target.files?.[0] || null;
  state.localAssetId = state.localFile ? createLocalAssetId() : "";
  state.localRevision = "";
  $("#local-file-title").textContent = state.localFile?.name || "选择本地视频";
  $("#local-file-detail").textContent = state.localFile
    ? `${(state.localFile.size / 1024 / 1024).toFixed(1)} MB · 原片不会上传`
    : "原片留在浏览器内，不会自动上传";
  if (state.localFile && !$("#title-input").value.trim()) {
    $("#title-input").value = titleFromFileName(state.localFile.name);
  }
  updateSelection();
});

$("#local-subtitle-input").addEventListener("change", (event) => {
  state.localSubtitleFile = event.target.files?.[0] || null;
  $("#local-subtitle-title").textContent = state.localSubtitleFile?.name || "选择外挂字幕（可选）";
  $("#local-subtitle-detail").textContent = state.localSubtitleFile
    ? "只上传字幕文本，不上传原片"
    : "支持 SRT / VTT；只上传字幕文本，不上传原片";
});

for (const input of [$("#bilibili-input"), $("#title-input")]) {
  input.addEventListener("input", updateSelection);
}

for (const radio of $$('input[name="knowledge-mode"]')) {
  radio.addEventListener("change", () => {
    state.knowledgeMode = radio.value;
    updateSelection();
  });
}

$("#fear-mode-input").addEventListener("change", (event) => {
  $("#fear-action-row").hidden = !event.target.checked;
  if (!event.target.checked) clearRisk();
});

$("#danmaku-input").addEventListener("change", () => updateConversationState());

for (const button of $$('[data-fear-action]')) {
  button.addEventListener("click", () => {
    state.fearAction = button.dataset.fearAction;
    setSelected($$('[data-fear-action]'), button);
  });
}

for (const button of $$('[data-visual-mode]')) {
  button.addEventListener("click", () => {
    state.visualMode = button.dataset.visualMode;
    setSelected($$('[data-visual-mode]'), button);
  });
}

for (const button of $$('[data-delay]')) {
  button.addEventListener("click", () => {
    setSelected($$('[data-delay]'), button);
    const custom = button.dataset.delay === "custom";
    $("#custom-delay-field").hidden = !custom;
    if (!custom) state.replyLeadMs = Number(button.dataset.delay);
  });
}

$("#custom-delay-input").addEventListener("input", (event) => {
  const seconds = Number.parseInt(event.target.value, 10);
  const valid = Number.isInteger(seconds) && seconds >= 0 && seconds <= 120;
  $("#custom-delay-help").classList.toggle("is-error", !valid);
  $("#custom-delay-help").textContent = valid
    ? `当前会在 ${seconds} 秒后回复`
    : "请输入 0–120 之间的整数";
  if (valid) {
    state.replyLeadMs = seconds * 1000;
  }
});

$("#setup-form").addEventListener("submit", (event) => {
  event.preventDefault();
  resetAnalysisCostTracking();
  enterPlayer();
});

$("#confirm-back").addEventListener("click", () => {
  window.dispatchEvent(new CustomEvent("togetherwatch:back"));
});
$("#open-chat-button").addEventListener("click", () => bridge.openChat({ source: state.source }));
$("#player-back").addEventListener("click", () => leaveSession());
$("#return-confirm-button").addEventListener("click", () => leaveSession());
$("#end-session-button").addEventListener("click", () => leaveSession());
$("#confirm-start-button").addEventListener("click", () => startWithAction("confirm"));
$("#wait-protection-button").addEventListener("click", async () => {
  if (!state.session || state.polling) return;
  state.awaitingProtection = true;
  try {
    await pollStatus();
  } catch (error) {
    setError(error.message || "继续等待失败", "preparation");
  }
});
$("#continue-unprotected-button").addEventListener("click", () => continueUnprotected());
$("#skip-button").addEventListener("click", () => {
  if (state.status?.preparation?.started_at) continueUnprotected();
  else startWithAction("skip");
});
$("#regenerate-button").addEventListener("click", async () => {
  try {
    await bridge.regenerateKnowledge(state.session.session_id);
    await pollStatus();
  } catch (error) {
    setError(error.message || "重新搜集失败", "preparation");
  }
});
$("#retry-subtitles-button").addEventListener("click", async () => {
  try {
    await bridge.retrySubtitles(state.session.session_id);
    await pollStatus();
  } catch (error) {
    setError(error.message || "重新查找字幕失败", "preparation");
  }
});
$("#retry-local-sampling-button").addEventListener("click", async () => {
  const plan = state.status?.sample_plan;
  if (!plan?.plan_id) return;
  state.localSamplingError = "";
  state.planRetryAfter.delete(plan.plan_id);
  state.completedPlans.delete(plan.plan_id);
  await processSamplePlan(plan);
  renderLocalSampling(state.status || {});
});

$("#fullscreen-button").addEventListener("click", async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await $("#video-stage").requestFullscreen();
});

$("#message-input").addEventListener("input", (event) => {
  $("#send-button").disabled = !event.target.value.trim();
});
$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#message-input");
  const text = input.value.trim();
  if (!text) return;
  state.chatRunning = true;
  input.disabled = true;
  $("#send-button").disabled = true;
  updateConversationState(true);
  setError("", "message");
  try {
    await sendMessage(text);
    input.value = "";
  } catch (error) {
    setError(error.message || "消息发送失败", "message");
  } finally {
    state.chatRunning = false;
    input.disabled = !bridge.canSendMessage();
    $("#send-button").disabled = !input.value.trim();
    updateConversationState(false);
  }
});

$("#local-video").addEventListener("play", (event) => {
  if (!state.unlocked) event.currentTarget.pause();
});
$("#local-video").addEventListener("seeking", () => {
  if (state.session && state.timeline) state.timeline.beginNewEpoch();
});
$("#local-video").addEventListener("timeupdate", () => {
  const snapshot = {
    playhead_ms: Math.round($("#local-video").currentTime * 1000),
    duration_ms: Math.round($("#local-video").duration * 1000),
  };
  updatePlaybackClock(snapshot);
  flushDanmaku(snapshot);
  renderRisk(state.status?.upcoming_risks || []);
});

$("#bypass-risk-button").addEventListener("click", () => {
  const riskId = $("#risk-cover").dataset.riskId;
  if (riskId) state.bypassedRisks.add(riskId);
  clearRisk();
});
$("#dismiss-risk-button").addEventListener("click", () => {
  const riskId = $("#risk-warning").dataset.riskId;
  if (riskId) state.bypassedRisks.add(riskId);
  clearRisk();
});
$("#part-selector-button").addEventListener("click", () => {
  $("#part-list").hidden = !$("#part-list").hidden;
});
$("#previous-part-button").addEventListener("click", () => {
  const index = state.parts.findIndex((item) => item.media_id === state.currentPart?.media_id);
  if (index > 0) switchPart(state.parts[index - 1]);
});
$("#next-part-button").addEventListener("click", () => {
  const index = state.parts.findIndex((item) => item.media_id === state.currentPart?.media_id);
  if (index >= 0 && index < state.parts.length - 1) switchPart(state.parts[index + 1]);
});
$("#analysis-cost-confirm").addEventListener("click", closeAnalysisCostDialog);
$("#analysis-cost-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeAnalysisCostDialog();
});

window.addEventListener("togetherwatch:danmaku", (event) => acceptDanmaku(event.detail));
window.addEventListener("togetherwatch:message", (event) => {
  const detail = event.detail || {};
  if (detail.session_id && detail.session_id !== state.session?.session_id) return;
  appendMessage(detail.speaker || companionName, detail.text, detail.role === "user");
});
window.addEventListener("popstate", () => {
  if (state.ignoreNextPopState) {
    state.ignoreNextPopState = false;
    return;
  }
  if (state.page === "player") {
    leaveSession({ consumeHistory: false });
  }
});
window.addEventListener("pagehide", () => {
  if (state.session?.session_id) bridge.endSession(state.session.session_id).catch(() => {});
});

setPage("confirm", { historyMode: "replace" });
selectSource("bilibili");
updateSelection();
updateConversationState(false);
loadRecentSessions();

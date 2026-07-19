import { WatchHostBridge } from "./lib/host.js";
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
const companionName = new URLSearchParams(location.search).get("companion")
  || config.companion?.name
  || document.documentElement.dataset.companionName
  || "陪伴者";

const state = {
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
  planInFlight: "",
  completedPlans: new Set(),
  planRetryAfter: new Map(),
  timers: [],
  pendingDanmaku: new Map(),
  seenDanmaku: new Set(),
  bypassedRisks: new Set(),
};

for (const node of $$('[data-companion]')) node.textContent = companionName;

function setPage(name) {
  $("#confirm-page").hidden = name !== "confirm";
  $("#player-page").hidden = name !== "player";
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
  state.planInFlight = "";
  state.completedPlans.clear();
  state.planRetryAfter.clear();
  state.pendingDanmaku.clear();
  state.seenDanmaku.clear();
  state.bypassedRisks.clear();
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
  $("#confirm-start-button").disabled = true;
  $("#skip-button").hidden = true;
  setError("", "preparation");
}

async function enterPlayer() {
  setError();
  resetSessionState();
  initialPlayerState(selectedTitle());
  setPage("player");
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

function renderKnowledgeCard(card) {
  const node = $("#knowledge-card");
  node.replaceChildren();
  if (!card || !Object.keys(card).length) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  const label = document.createElement("p");
  label.className = "section-label accent-label";
  label.textContent = "剧情背景";
  const title = document.createElement("h3");
  title.textContent = card.canonical_identity?.title || "作品资料";
  const setting = document.createElement("p");
  setting.textContent = card.setting?.premise || card.pre_story || "";
  node.append(label, title);
  if (setting.textContent) node.append(setting);
  const characters = Array.isArray(card.characters) ? card.characters : [];
  for (const character of characters) {
    const line = document.createElement("p");
    const name = character.name || character.canonical_name || "角色";
    const role = character.role || character.description || "";
    line.textContent = role ? `${name}：${role}` : name;
    node.append(line);
  }
}

function renderSubtitle(preparation) {
  const lookup = preparation.subtitle_lookup || {};
  const pending = new Set(["pending", "queued", "searching", "awaiting_client"]).has(lookup.status);
  $("#subtitle-spinner").hidden = !pending;
  $("#subtitle-title").textContent = {
    found: "字幕已准备",
    not_found: "没有找到匹配字幕",
    not_configured: "字幕服务未配置",
    awaiting_client: "等待本地字幕",
    failed: "字幕准备失败",
  }[lookup.status] || "正在准备字幕";
  $("#subtitle-description").textContent = lookup.message || "字幕只用于辅助理解，实际音画优先。";
  $("#retry-subtitles-button").hidden = !lookup.can_retry || state.source === "local";
}

function renderPreparation(payload) {
  const preparation = payload.preparation || {};
  const index = progressIndex(preparation.status);
  $$("#preparation-progress li").forEach((item, itemIndex) => {
    item.classList.toggle("is-complete", itemIndex < index);
    item.classList.toggle("is-active", itemIndex === index && index < 5);
  });
  const cardStatus = preparation.knowledge_card_status;
  $("#identified-card").hidden = cardStatus !== "not_required";
  renderKnowledgeCard(payload.knowledge_card);
  renderSubtitle(preparation);
  $("#preparation-title").textContent = preparation.status === "ready_to_confirm"
    ? "准备好了，等你确认"
    : preparation.started_at
      ? "正在准备开播保护范围"
      : "正在准备这次一起看";
  $("#preparation-description").textContent = preparation.started_at
    ? "会话已经确认，播放器仍会保持暂停，直到保护范围就绪或你明确继续。"
    : "识别、资料和字幕状态都来自真实后端。";

  const analysis = payload.analysis || {};
  $("#analysis-state-card").hidden = !analysis.error && !preparation.knowledge_card_error;
  $("#analysis-state-title").textContent = analysis.status === "failed" ? "剧情分析不可用" : "当前为降级状态";
  $("#analysis-state-description").textContent = analysis.error || preparation.knowledge_card_error || "";
  const visual = payload.visual_context || {};
  $("#visual-state-card").hidden = !visual.degraded_reason;
  $("#visual-state-description").textContent = visual.degraded_reason || "";

  const gate = payload.start_gate || {};
  if (preparation.started_at && !gate.can_play) {
    $("#confirm-start-button").disabled = true;
    $("#confirm-start-button").textContent = "正在准备保护范围";
    $("#skip-button").hidden = !gate.can_continue_unprotected;
    $("#skip-button").textContent = "明确无保护继续";
  } else {
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
    setError("当前浏览器不能从未来位置导出所选音轨，无法执行这份音频取材计划。", "preparation");
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
    setError("", "preparation");
  } catch (error) {
    state.planRetryAfter.set(plan.plan_id, Date.now() + 5_000);
    setError(error.message || "本地取材失败", "preparation");
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
    renderPreparation(payload);
    renderWatchingStatus(payload);
    await processSamplePlan(payload.sample_plan);
    if (
      state.awaitingProtection
      && payload.start_gate?.status === "ready_to_unlock"
      && !state.starting
    ) {
      state.starting = true;
      try {
        const started = await bridge.startSession(state.session.session_id, { protection_action: "wait" });
        state.session = started.session || state.session;
        if (started.start_gate?.can_play) unlockPlayback();
      } finally {
        state.starting = false;
      }
    }
  } finally {
    state.polling = false;
  }
}

function renderWatchingStatus(payload) {
  const analysis = payload.analysis || {};
  $("#analysis-label").textContent = analysis.status === "ready"
    ? "剧情已同步"
    : analysis.status === "failed"
      ? "剧情分析不可用"
      : "正在追上当前剧情";
  const notice = $("#playback-notice");
  const protection = payload.fear_protection || {};
  if (state.unlocked && protection.status === "coverage_low") {
    notice.textContent = "胆小模式保护范围不足";
    notice.hidden = false;
  } else if (!notice.textContent || notice.textContent === "胆小模式保护范围不足") {
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
  if (!chatReady) setError("聊天宿主未配置；播放与分析仍会正常同步。", "message");
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
  const item = document.createElement("span");
  item.className = "danmaku-item";
  item.textContent = action.text;
  layer.append(item);
  item.addEventListener("animationend", () => item.remove(), { once: true });
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
    !state.bypassedRisks.has(item.id)
    && playhead >= Number(item.warn_at_ms || item.start_ms || 0)
    && playhead <= Number(item.end_ms || 0)
  ));
  if (!risk) return clearRisk();
  const label = risk.label || "即将出现强烈画面";
  if (state.fearAction === "cover_video") {
    $("#risk-cover-label").textContent = label;
    $("#risk-cover").dataset.riskId = risk.id;
    $("#risk-cover").hidden = false;
    $("#risk-warning").hidden = true;
  } else {
    $("#risk-warning-label").textContent = label;
    $("#risk-warning").hidden = false;
    $("#risk-cover").hidden = true;
  }
}

function clearRisk() {
  $("#risk-warning").hidden = true;
  $("#risk-cover").hidden = true;
  $("#risk-cover").dataset.riskId = "";
}

function renderPartNavigation() {
  const nav = $("#part-navigation");
  nav.hidden = state.parts.length <= 1;
  if (nav.hidden) return;
  const index = state.parts.findIndex((item) => item.media_id === state.currentPart?.media_id);
  $("#previous-part-button").disabled = index <= 0;
  $("#next-part-button").disabled = index < 0 || index >= state.parts.length - 1;
  $("#part-selector-button").textContent = state.currentPart?.title || `P${state.currentPart?.page || 1}`;
  const list = $("#part-list");
  list.replaceChildren();
  for (const part of state.parts) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `P${part.page} · ${part.title}`;
    button.addEventListener("click", () => switchPart(part));
    list.append(button);
  }
}

async function switchPart(part) {
  await leaveSession({ returnToConfirm: false });
  $("#bilibili-input").value = part.canonical_url;
  $("#part-list").hidden = true;
  await enterPlayer();
}

async function leaveSession({ returnToConfirm = true } = {}) {
  if (state.ending) return;
  state.ending = true;
  const sessionId = state.session?.session_id;
  clearRuntimeTimers();
  $("#local-video").pause();
  try {
    if (sessionId) await bridge.endSession(sessionId);
  } catch (error) {
    toast(error.message || "结束会话失败；客户端租约会自动过期");
  } finally {
    resetSessionState();
    state.ending = false;
    if (returnToConfirm) setPage("confirm");
  }
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
  if (Number.isInteger(seconds) && seconds >= 0 && seconds <= 120) {
    state.replyLeadMs = seconds * 1000;
  }
});

$("#setup-form").addEventListener("submit", (event) => {
  event.preventDefault();
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
  $("#send-button").disabled = true;
  setError("", "message");
  try {
    await sendMessage(text);
    input.value = "";
  } catch (error) {
    setError(error.message || "消息发送失败", "message");
  } finally {
    $("#send-button").disabled = !input.value.trim();
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

window.addEventListener("togetherwatch:danmaku", (event) => acceptDanmaku(event.detail));
window.addEventListener("togetherwatch:message", (event) => {
  const detail = event.detail || {};
  if (detail.session_id && detail.session_id !== state.session?.session_id) return;
  appendMessage(detail.speaker || companionName, detail.text, detail.role === "user");
});
window.addEventListener("pagehide", () => {
  if (state.session?.session_id) bridge.endSession(state.session.session_id).catch(() => {});
});

setPage("confirm");
selectSource("bilibili");
updateSelection();
loadRecentSessions();

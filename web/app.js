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
import {
  createConversationFollowState,
  formatMessageTimestamp,
  noteConversationMessage,
  pauseConversationFollow,
} from "./lib/conversation.js";
import { PlaybackTimeline, snapshotFromVideo } from "./lib/timeline.js";
import {
  analysisDegradedReason,
  shouldResumeDirectly,
} from "./lib/watch-status.js";
import {
  createTicketStore,
  createViewingDurationAccumulator,
  detachViewingDuration,
  formatTicketDuration,
  normalizeRecentViewing,
  normalizeTicket,
  normalizeTicketCapture,
  observeViewingDuration,
  sortTicketsByEndedAt,
  updateTicketAvatar,
} from "./lib/tickets.js";


const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const config = globalThis.TogetherWatchConfig || {};
const bridge = new WatchHostBridge(config);
const WATCH_PAGE_STATE_KEY = "togetherWatchPage";
const companionName = new URLSearchParams(location.search).get("companion")
  || config.companion?.name
  || document.documentElement.dataset.companionName
  || "{assistant}";
const ticketStore = createTicketStore();

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
  statusPollFailures: 0,
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
  conversationMessages: new Map(),
  conversationFollow: createConversationFollowState(),
  ignoreConversationScroll: false,
  fallbackStreamMessageId: "",
  viewingId: "",
  viewingDuration: createViewingDurationAccumulator(),
  viewedPartLabels: new Set(),
  currentEndTicket: null,
  endTicketSaved: false,
  endAction: "",
  resumeViewing: null,
  resumePlayheadMs: 0,
  ticketCaptures: [],
  ticketCapturesLoading: false,
  capturePreview: null,
  captureWasPlaying: false,
  captureBusy: false,
  selectedTicket: null,
  ticketAssetRole: "",
  ticketImageTarget: null,
  ticketImageDraft: null,
  ticketDeleteMode: false,
  ticketDeleteSelection: new Set(),
  ticketSortNewestFirst: true,
};

let watchEndDialogDestination = null;

for (const node of $$('[data-companion]')) node.textContent = companionName;

function setPage(name, { historyMode = "none" } = {}) {
  state.page = name;
  $("#confirm-page").hidden = name !== "confirm";
  $("#player-page").hidden = name !== "player";
  $("#tickets-page").hidden = name !== "tickets";
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

function closeWatchEndDialog() {
  const dialog = $("#watch-end-dialog");
  if (dialog.open) dialog.close();
  const destination = watchEndDialogDestination;
  watchEndDialogDestination = null;
  state.currentEndTicket = null;
  state.endTicketSaved = false;
  destination?.();
}

function setEndChoiceBusy(action = "") {
  state.endAction = action;
  const busy = Boolean(action);
  $("#watch-end-choice-close").disabled = busy;
  $("#save-progress-button").disabled = busy;
  $("#complete-viewing-button").disabled = busy;
  $("#save-progress-button").textContent = action === "save_progress"
    ? "正在保存…"
    : "保存进度";
  $("#complete-viewing-button").textContent = action === "complete"
    ? "正在结束…"
    : "已看完";
}

function showEndChoiceDialog() {
  if (!state.session || state.ending) return;
  setEndChoiceBusy();
  $("#watch-end-choice-dialog").showModal();
}

function closeEndChoiceDialog() {
  if (state.endAction) return;
  const dialog = $("#watch-end-choice-dialog");
  if (dialog.open) dialog.close();
}

function renderAnalysisCost(accumulator) {
  const presentation = analysisCostPresentation(accumulator);
  $("#analysis-cost-amount").textContent = presentation.amountText;
  $("#analysis-cost-amount").hidden = !presentation.amountText;
  $("#analysis-cost-status").textContent = presentation.statusText;
  $("#analysis-cost-detail").textContent = presentation.detailText;
  $("#analysis-cost-detail").hidden = !presentation.detailText;
}

function showWatchEndDialog(ticket, accumulator, destination = null, { savedProgress = false } = {}) {
  state.currentEndTicket = ticket ? normalizeTicket(ticket) : null;
  state.endTicketSaved = false;
  $("#watch-end-title").textContent = state.currentEndTicket
    ? "这场一起看，收好啦"
    : savedProgress
      ? "进度已经保存"
      : "这场一起看已结束";
  $("#watch-end-ticket").hidden = !state.currentEndTicket;
  $("#watch-end-ticket").replaceChildren(
    ...(state.currentEndTicket ? [renderTicketCard(state.currentEndTicket)] : []),
  );
  $("#analysis-cost-title").textContent = "本次剧情解析费用";
  renderAnalysisCost(accumulator);
  $("#watch-end-dismiss").hidden = !state.currentEndTicket;
  $("#watch-end-save").textContent = state.currentEndTicket ? "保存到票夹" : "完成";
  watchEndDialogDestination = destination;
  $("#watch-end-dialog").showModal();
}

function showAnalysisCostUnavailable() {
  state.currentEndTicket = null;
  $("#watch-end-title").textContent = "结束暂未完成";
  $("#watch-end-ticket").hidden = true;
  $("#analysis-cost-title").textContent = "费用暂时无法获取";
  $("#analysis-cost-amount").hidden = true;
  $("#analysis-cost-status").textContent = "结束请求没有成功，当前没有生成或推测任何费用。关闭后可以重新结束一次。";
  $("#analysis-cost-detail").hidden = true;
  $("#watch-end-dismiss").hidden = true;
  $("#watch-end-save").textContent = "知道了";
  watchEndDialogDestination = null;
  $("#watch-end-dialog").showModal();
}

function finishAnalysisCostTracking(ticket, destination = null, options = {}) {
  const total = state.analysisCost;
  resetAnalysisCostTracking();
  if (ticket || options.savedProgress || total.recordedSessionIds.size > 0) {
    showWatchEndDialog(ticket, total, destination, options);
  }
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

function ticketDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { day: "", time: "" };
  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return {
    day: `${part("year")}.${part("month")}.${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

function ticketNumber(value) {
  const date = ticketDate(value).day.replaceAll(".", "");
  return `NO. W-${date.slice(-4) || "0000"}`;
}

function avatarFallback(value, defaultValue) {
  const cleaned = String(value || "").replace(/[{}]/g, "").trim();
  return cleaned.slice(0, 1).toUpperCase() || defaultValue;
}

function ticketIdentityFallback() {
  return {
    companion: {
      id: config.companion?.id || "companion",
      name: companionName,
      avatar_url: config.companion?.avatarUrl || config.companion?.avatar_url || "",
    },
    viewer: {
      name: config.viewer?.name || "我",
      avatar_url: config.viewer?.avatarUrl || config.viewer?.avatar_url || "",
    },
  };
}

function fillTicketAvatar(root, selector, url, fallback, alt) {
  const avatar = root.querySelector(selector);
  const image = avatar.querySelector("img");
  const fallbackNode = avatar.querySelector("b");
  fallbackNode.textContent = fallback;
  if (url) {
    image.src = url;
    image.alt = alt;
    image.hidden = false;
    fallbackNode.hidden = true;
  }
  return avatar;
}

function bindTicketAvatar(avatar, ticket, role) {
  avatar.classList.add("is-editable");
  avatar.tabIndex = 0;
  avatar.setAttribute("role", "button");
  avatar.setAttribute(
    "aria-label",
    role === "companion" ? `更换${ticket.companion.name}头像` : "更换我的头像",
  );
  const activate = (event) => {
    event.stopPropagation();
    pickTicketImage(ticket, role);
  };
  avatar.addEventListener("click", activate);
  avatar.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    activate(event);
  });
}

function renderTicketCard(value, { interactive = false } = {}) {
  const ticket = normalizeTicket(value);
  const card = $("#ticket-card-template").content.firstElementChild.cloneNode(true);
  const date = ticketDate(ticket.ended_at);
  card.querySelector(".ticket-date").textContent = date.day;
  card.querySelector(".ticket-scene-time").textContent = date.time;
  card.querySelector(".ticket-number").textContent = ticketNumber(ticket.ended_at);
  card.querySelector(".ticket-duration").textContent = formatTicketDuration(
    ticket.played_duration_ms,
  );
  card.querySelector(".ticket-work-title").textContent = ticket.title;
  const companionAvatar = fillTicketAvatar(
    card,
    ".ticket-companion-avatar",
    ticket.companion.avatar_url,
    avatarFallback(ticket.companion.name, "A"),
    ticket.companion.name,
  );
  const viewerAvatar = fillTicketAvatar(
    card,
    ".ticket-viewer-avatar",
    ticket.viewer.avatar_url,
    avatarFallback(ticket.viewer.name, "我"),
    ticket.viewer.name,
  );
  if (interactive) {
    bindTicketAvatar(companionAvatar, ticket, "companion");
    bindTicketAvatar(viewerAvatar, ticket, "viewer");
  }
  return card;
}

function renderTicketBack(value, { interactive = false } = {}) {
  const ticket = normalizeTicket(value);
  const card = $("#ticket-back-template").content.firstElementChild.cloneNode(true);
  const imageUrl = ticket.local_back_image_url || ticket.server_back_frame_url;
  const image = card.querySelector(".ticket-back-image");
  if (imageUrl) {
    image.src = imageUrl;
    image.hidden = false;
    card.querySelector(".ticket-back-empty").hidden = true;
  }
  card.querySelector(".ticket-back-title").textContent = ticket.title;
  if (interactive) {
    card.querySelector(".ticket-back-picture").addEventListener("click", (event) => {
      event.stopPropagation();
      openTicketFrameGallery(ticket);
    });
    card.querySelector(".ticket-back-footer").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleTicket(ticket);
    });
  }
  return card;
}

function ticketFromViewingPayload(payload) {
  return payload?.ticket || payload?.viewing_summary?.ticket || payload?.viewing?.ticket || null;
}

function saveAndSelectTicket(value) {
  const saved = ticketStore.save(normalizeTicket(value, ticketIdentityFallback()));
  state.selectedTicket = saved;
  if (state.currentEndTicket?.ticket_id === saved.ticket_id) state.currentEndTicket = saved;
  renderTicketFolder();
  return saved;
}

function activeTicketFrameDialog() {
  return $("#ticket-frame-dialog");
}

function renderTicketCapturePicker(dialog = activeTicketFrameDialog()) {
  if (!dialog) return;
  const list = dialog.querySelector(".ticket-captures-list");
  list.replaceChildren();
  const ticket = state.selectedTicket;
  dialog.querySelector(".ticket-captures-state").textContent = state.ticketCapturesLoading
    ? "读取中…"
    : state.ticketCaptures.length
      ? `${state.ticketCaptures.length} 张`
      : "暂无画面";
  for (const frame of state.ticketCaptures) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ticket-capture-option";
    button.classList.toggle("is-selected", frame.frame_id === ticket?.server_back_frame_id);
    const image = document.createElement("img");
    image.src = frame.image_url;
    image.alt = `${formatMediaTime(frame.at_ms)} 截下的画面`;
    const time = document.createElement("time");
    time.textContent = formatMediaTime(frame.at_ms);
    button.append(image, time);
    button.addEventListener("click", () => selectTicketCapture(frame));
    list.append(button);
  }
}

async function loadTicketCaptures(viewingId) {
  state.ticketCaptures = [];
  state.ticketCapturesLoading = true;
  const errorNode = activeTicketFrameDialog()?.querySelector(".ticket-captures-error");
  if (errorNode) errorNode.hidden = true;
  renderTicketCapturePicker();
  if (!viewingId) {
    state.ticketCapturesLoading = false;
    renderTicketCapturePicker();
    return true;
  }
  let loaded = true;
  try {
    const payload = await bridge.listTicketFrameCaptures(viewingId);
    state.ticketCaptures = (payload.captures || [])
      .map(normalizeTicketCapture)
      .filter((frame) => frame.frame_id && frame.image_url);
  } catch (error) {
    loaded = false;
    const currentError = activeTicketFrameDialog()?.querySelector(".ticket-captures-error");
    if (currentError) {
      currentError.textContent = error.message || "自选画面读取失败";
      currentError.hidden = false;
    }
  }
  state.ticketCapturesLoading = false;
  renderTicketCapturePicker();
  return loaded;
}

function ticketFromFrameSelection(payload, frame = null) {
  const serverTicket = ticketFromViewingPayload(payload);
  if (serverTicket) return normalizeTicket(serverTicket, state.selectedTicket || {});
  return normalizeTicket({
    ...(state.selectedTicket || {}),
    server_back_frame_id: frame?.frame_id || "",
    server_back_frame_url: frame?.image_url || "",
  });
}

async function selectTicketCapture(frame) {
  if (!state.selectedTicket?.viewing_id) return;
  const errorNode = activeTicketFrameDialog()?.querySelector(".ticket-captures-error");
  if (errorNode) errorNode.hidden = true;
  try {
    const payload = await bridge.selectTicketFrameCapture(
      state.selectedTicket.viewing_id,
      frame.frame_id,
    );
    saveAndSelectTicket(ticketFromFrameSelection(payload, frame));
    renderTicketFrameDialog();
  } catch (error) {
    const currentError = activeTicketFrameDialog()?.querySelector(".ticket-captures-error");
    if (currentError) {
      currentError.textContent = error.message || "票根背面选择失败";
      currentError.hidden = false;
    }
  }
}

async function clearTicketBackImage() {
  if (!state.selectedTicket) return;
  const errorNode = activeTicketFrameDialog()?.querySelector(".ticket-captures-error");
  if (errorNode) errorNode.hidden = true;
  try {
    let ticket = normalizeTicket({
      ...state.selectedTicket,
      local_back_image_url: "",
      server_back_frame_id: "",
      server_back_frame_url: "",
    });
    if (state.selectedTicket.server_back_frame_id && state.selectedTicket.viewing_id) {
      const payload = await bridge.clearTicketFrame(state.selectedTicket.viewing_id);
      const serverTicket = ticketFromViewingPayload(payload);
      if (serverTicket) ticket = normalizeTicket(serverTicket, ticket);
    }
    saveAndSelectTicket(ticket);
    renderTicketFrameDialog();
  } catch (error) {
    const currentError = activeTicketFrameDialog()?.querySelector(".ticket-captures-error");
    if (currentError) {
      currentError.textContent = error.message || "票根背面清除失败";
      currentError.hidden = false;
    }
  }
}

function pickTicketImage(ticket, role) {
  if (!ticket) return;
  state.ticketImageTarget = normalizeTicket(ticket);
  state.ticketAssetRole = role;
  const input = $("#ticket-image-input");
  input.value = "";
  input.click();
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
    reader.addEventListener("error", () => reject(new Error("图片读取失败")), { once: true });
    reader.readAsDataURL(file);
  });
}

function clampTicketImageEditorOffset(draft, viewportWidth, viewportHeight) {
  if (!draft?.image || !viewportWidth || !viewportHeight) return;
  const baseScale = Math.max(
    viewportWidth / draft.image.naturalWidth,
    viewportHeight / draft.image.naturalHeight,
  );
  const scaledWidth = draft.image.naturalWidth * baseScale * draft.zoom;
  const scaledHeight = draft.image.naturalHeight * baseScale * draft.zoom;
  const maxX = Math.max(0, (scaledWidth - viewportWidth) / 2);
  const maxY = Math.max(0, (scaledHeight - viewportHeight) / 2);
  draft.offsetX = Math.max(-maxX, Math.min(maxX, draft.offsetX));
  draft.offsetY = Math.max(-maxY, Math.min(maxY, draft.offsetY));
}

function drawTicketImageEditor() {
  const draft = state.ticketImageDraft;
  const canvas = $("#ticket-image-editor-canvas");
  if (!draft?.image || !canvas) return;
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  clampTicketImageEditorOffset(draft, bounds.width, bounds.height);
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.round(bounds.width * pixelRatio);
  const height = Math.round(bounds.height * pixelRatio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);
  context.fillStyle = "#000";
  context.fillRect(0, 0, bounds.width, bounds.height);
  const scale = Math.max(
    bounds.width / draft.image.naturalWidth,
    bounds.height / draft.image.naturalHeight,
  ) * draft.zoom;
  const drawWidth = draft.image.naturalWidth * scale;
  const drawHeight = draft.image.naturalHeight * scale;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    draft.image,
    (bounds.width - drawWidth) / 2 + draft.offsetX,
    (bounds.height - drawHeight) / 2 + draft.offsetY,
    drawWidth,
    drawHeight,
  );
}

async function openTicketImageEditor(file, target, role) {
  const imageUrl = await fileAsDataUrl(file);
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.addEventListener("load", resolve, { once: true });
    image.addEventListener("error", () => reject(new Error("图片解码失败")), { once: true });
    image.src = imageUrl;
  });
  state.ticketImageDraft = {
    target: normalizeTicket(target),
    role,
    image,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    pointers: new Map(),
    lastCenter: null,
    lastDistance: 0,
  };
  const canvas = $("#ticket-image-editor-canvas");
  canvas.classList.toggle("is-avatar", role !== "back");
  $("#ticket-image-editor-title").textContent = role === "back" ? "调整票根背面" : "调整头像";
  const error = $("#ticket-image-editor-error");
  error.textContent = "";
  error.hidden = true;
  const dialog = $("#ticket-image-editor-dialog");
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(drawTicketImageEditor);
}

function closeTicketImageEditor() {
  const dialog = $("#ticket-image-editor-dialog");
  if (dialog.open) dialog.close();
  state.ticketImageDraft = null;
  state.ticketAssetRole = "";
  state.ticketImageTarget = null;
}

function confirmTicketImageEditor() {
  const draft = state.ticketImageDraft;
  const preview = $("#ticket-image-editor-canvas");
  if (!draft?.image || !preview) return;
  const previewBounds = preview.getBoundingClientRect();
  const outputWidth = draft.role === "back" ? 1200 : 512;
  const outputHeight = draft.role === "back" ? 600 : 512;
  const output = document.createElement("canvas");
  output.width = outputWidth;
  output.height = outputHeight;
  const context = output.getContext("2d");
  context.fillStyle = "#000";
  context.fillRect(0, 0, outputWidth, outputHeight);
  const previewScale = Math.max(
    previewBounds.width / draft.image.naturalWidth,
    previewBounds.height / draft.image.naturalHeight,
  ) * draft.zoom;
  const outputScaleX = outputWidth / previewBounds.width;
  const outputScaleY = outputHeight / previewBounds.height;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    draft.image,
    ((previewBounds.width - draft.image.naturalWidth * previewScale) / 2 + draft.offsetX) * outputScaleX,
    ((previewBounds.height - draft.image.naturalHeight * previewScale) / 2 + draft.offsetY) * outputScaleY,
    draft.image.naturalWidth * previewScale * outputScaleX,
    draft.image.naturalHeight * previewScale * outputScaleY,
  );
  const imageUrl = output.toDataURL("image/jpeg", 0.92);
  const updated = draft.role === "back"
    ? normalizeTicket({ ...draft.target, local_back_image_url: imageUrl })
    : updateTicketAvatar(draft.target, draft.role, imageUrl);
  const saved = ticketStore.save(updated);
  if (state.selectedTicket?.ticket_id === saved.ticket_id) state.selectedTicket = saved;
  if (state.currentEndTicket?.ticket_id === saved.ticket_id) state.currentEndTicket = saved;
  renderTicketFolder();
  if (activeTicketFrameDialog().open) renderTicketFrameDialog();
  closeTicketImageEditor();
}

function ticketEditorPointerCenter(pointers) {
  const values = [...pointers.values()];
  if (!values.length) return null;
  return {
    x: values.reduce((sum, point) => sum + point.x, 0) / values.length,
    y: values.reduce((sum, point) => sum + point.y, 0) / values.length,
  };
}

function ticketEditorPointerDistance(pointers) {
  const values = [...pointers.values()];
  if (values.length < 2) return 0;
  return Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
}

function resetTicketEditorGesture(draft) {
  draft.lastCenter = ticketEditorPointerCenter(draft.pointers);
  draft.lastDistance = ticketEditorPointerDistance(draft.pointers);
}

function renderTicketFrameDialog() {
  const dialog = activeTicketFrameDialog();
  const ticket = state.selectedTicket;
  if (!dialog || !ticket) return;
  dialog.querySelector(".clear-ticket-back-image").hidden = !(
    ticket.local_back_image_url || ticket.server_back_frame_url
  );
  renderTicketCapturePicker(dialog);
}

async function openTicketFrameGallery(value) {
  if (state.ticketCapturesLoading) return;
  const ticket = normalizeTicket(value);
  state.selectedTicket = ticket;
  state.ticketCaptures = [];
  state.ticketCapturesLoading = false;
  renderTicketFrameDialog();
  const loaded = await loadTicketCaptures(ticket.viewing_id);
  if (loaded && state.ticketCaptures.length === 0) {
    pickTicketImage(ticket, "back");
    return;
  }
  renderTicketFrameDialog();
  const dialog = activeTicketFrameDialog();
  if (!dialog.open) dialog.showModal();
}

function closeTicketFrameGallery() {
  const dialog = activeTicketFrameDialog();
  if (dialog.open) dialog.close();
}

function toggleTicket(value) {
  const ticket = normalizeTicket(value);
  if (state.ticketDeleteMode) {
    if (state.ticketDeleteSelection.has(ticket.ticket_id)) {
      state.ticketDeleteSelection.delete(ticket.ticket_id);
    } else {
      state.ticketDeleteSelection.add(ticket.ticket_id);
    }
    renderTicketFolder();
    return;
  }
  if (state.selectedTicket?.ticket_id === ticket.ticket_id) {
    state.selectedTicket = null;
    state.ticketCaptures = [];
    state.ticketCapturesLoading = false;
    renderTicketFolder();
    return;
  }
  state.selectedTicket = ticket;
  state.ticketCaptures = [];
  state.ticketCapturesLoading = false;
  renderTicketFolder();
}

function closeTicketEditPopover() {
  $("#tickets-edit-popover").hidden = true;
}

function enterTicketDeleteMode() {
  closeTicketEditPopover();
  state.ticketDeleteMode = true;
  state.ticketDeleteSelection.clear();
  state.selectedTicket = null;
  closeTicketFrameGallery();
  renderTicketFolder();
}

function leaveTicketDeleteMode() {
  state.ticketDeleteMode = false;
  state.ticketDeleteSelection.clear();
  renderTicketFolder();
}

function confirmTicketDelete() {
  const selectedIds = [...state.ticketDeleteSelection];
  if (!selectedIds.length) return;
  for (const ticketId of selectedIds) ticketStore.remove(ticketId);
  leaveTicketDeleteMode();
  toast(`已删除 ${selectedIds.length} 张票根`);
}

function renderTicketSortDialog() {
  const newest = state.ticketSortNewestFirst;
  $("#ticket-sort-newest").classList.toggle("is-selected", newest);
  $("#ticket-sort-newest").querySelector("b").textContent = newest ? "✓" : "";
  $("#ticket-sort-oldest").classList.toggle("is-selected", !newest);
  $("#ticket-sort-oldest").querySelector("b").textContent = newest ? "" : "✓";
}

function setTicketSort(newestFirst) {
  state.ticketSortNewestFirst = Boolean(newestFirst);
  renderTicketSortDialog();
  $("#ticket-sort-dialog").close();
  renderTicketFolder();
}

function renderTicketFolder() {
  const tickets = sortTicketsByEndedAt(
    ticketStore.list(),
    state.ticketSortNewestFirst,
  );
  $("#tickets-count").textContent = `${tickets.length} 张一起看的票根`;
  $("#tickets-empty").hidden = tickets.length > 0;
  $("#tickets-edit-button").hidden = tickets.length === 0;
  $("#tickets-edit-button").textContent = state.ticketDeleteMode ? "完成" : "编辑";
  const deleteBar = $("#ticket-delete-bar");
  deleteBar.hidden = !state.ticketDeleteMode || tickets.length === 0;
  const deleteCount = state.ticketDeleteSelection.size;
  $("#ticket-delete-selection").textContent = deleteCount
    ? `已选择 ${deleteCount} 张票根`
    : "选择要删除的票根";
  $("#ticket-delete-confirm").textContent = deleteCount
    ? `确认删除（${deleteCount}）`
    : "确认删除";
  $("#ticket-delete-confirm").disabled = deleteCount === 0;
  const list = $("#tickets-list");
  list.hidden = tickets.length === 0;
  list.replaceChildren();
  for (const ticket of tickets) {
    const flipped = state.selectedTicket?.ticket_id === ticket.ticket_id;
    const deleteSelected = state.ticketDeleteSelection.has(ticket.ticket_id);
    const entry = document.createElement("article");
    entry.className = "ticket-entry";
    entry.classList.toggle("is-delete-selected", deleteSelected);
    const flipCard = document.createElement("div");
    flipCard.className = "ticket-flip-card";
    flipCard.classList.toggle("is-flipped", flipped);
    flipCard.classList.toggle("is-delete-mode", state.ticketDeleteMode);
    flipCard.tabIndex = 0;
    flipCard.setAttribute("role", "button");
    flipCard.setAttribute(
      "aria-label",
      state.ticketDeleteMode
        ? `${deleteSelected ? "取消选择" : "选择"}${ticket.title}票根`
        : flipped
          ? `已翻到${ticket.title}票根背面`
          : `翻到${ticket.title}票根背面`,
    );
    const inner = document.createElement("span");
    inner.className = "ticket-flip-inner";
    const front = renderTicketCard(ticket, { interactive: !state.ticketDeleteMode });
    front.classList.add("ticket-face", "ticket-face-front");
    const back = renderTicketBack(ticket, { interactive: !state.ticketDeleteMode });
    back.classList.add("ticket-face", "ticket-face-back");
    inner.append(front, back);
    flipCard.append(inner);
    flipCard.addEventListener("click", () => toggleTicket(ticket));
    flipCard.addEventListener("keydown", (event) => {
      if (event.target !== flipCard || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      toggleTicket(ticket);
    });
    entry.append(flipCard);
    if (state.ticketDeleteMode) {
      const marker = document.createElement("span");
      marker.className = "ticket-delete-marker";
      marker.textContent = deleteSelected ? "✓" : "";
      entry.append(marker);
    }
    list.append(entry);
  }
}

async function openTicketFolder(selectedTicket = null) {
  state.selectedTicket = selectedTicket ? normalizeTicket(selectedTicket) : null;
  state.ticketDeleteMode = false;
  state.ticketDeleteSelection.clear();
  state.ticketCaptures = [];
  closeTicketEditPopover();
  renderTicketFolder();
  setPage("tickets", { historyMode: "push" });
  try {
    const payload = await bridge.listTickets();
    for (const ticket of payload.tickets || []) {
      ticketStore.sync(normalizeTicket(ticket, ticketIdentityFallback()));
    }
    renderTicketFolder();
  } catch {
    // The local shelf remains usable while an offline or older host is unavailable.
  }
}

function buildEndTicket(payload, sessionId) {
  const viewing = payload?.viewing_summary || {};
  const source = payload?.ticket || viewing.ticket || {};
  if (!source.ticket_id && !source.id) return null;
  const serverDuration = Number(
    source.played_duration_ms ?? viewing.played_duration_ms,
  );
  const playedDurationMs = Number.isFinite(serverDuration) && serverDuration > 0
    ? serverDuration
    : state.viewingDuration.totalMs;
  const endedAt = source.ended_at
    || source.completed_at
    || source.created_at
    || new Date().toISOString();
  return normalizeTicket(
    {
      ...source,
      played_duration_ms: playedDurationMs,
    },
    {
      viewing_id: viewing.viewing_id || state.viewingId,
      work_key: viewing.work_key || state.session?.media?.work_key || "",
      title: viewing.title || selectedTitle(),
      cover_url: viewing.cover_url || state.session?.media?.cover_url || "",
      ended_at: endedAt,
      played_duration_ms: playedDurationMs,
      part_count: state.parts.length || 1,
      part_label: [...state.viewedPartLabels].join(" / "),
      last_session_id: sessionId,
      ...ticketIdentityFallback(),
    },
  );
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
  if (
    state.resumeViewing?.media_revision
    && state.localRevision !== state.resumeViewing.media_revision
  ) {
    throw new Error("选择的本地视频与保存进度中的文件版本不一致");
  }
  if (state.resumeViewing?.local_asset_id) {
    state.localAssetId = state.resumeViewing.local_asset_id;
  }
  if (state.resumePlayheadMs > 0) {
    video.currentTime = Math.min(video.duration, state.resumePlayheadMs / 1000);
  }
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
    work_key: `local:${state.localRevision}`,
    part_key: `local:${state.localRevision}`,
    part_index: 1,
    part_count: 1,
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
    work_key: `bilibili:${reference.bvid}`,
    cover_url: description.cover_url || "",
    part_title: current.title,
    part_key: `${reference.bvid}:p${current.page}`,
    part_index: current.page,
    part_count: Math.max(1, state.parts.length),
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

function restoreModeControls(mode = {}) {
  if (mode.knowledge_mode) {
    state.knowledgeMode = mode.knowledge_mode;
    for (const radio of $$('input[name="knowledge-mode"]')) {
      radio.checked = radio.value === state.knowledgeMode;
    }
  }
  if (typeof mode.fear_mode === "boolean") {
    $("#fear-mode-input").checked = mode.fear_mode;
    $("#fear-action-row").hidden = !mode.fear_mode;
  }
  if (mode.fear_action) {
    state.fearAction = mode.fear_action;
    for (const button of $$('[data-fear-action]')) {
      button.classList.toggle("is-selected", button.dataset.fearAction === state.fearAction);
    }
  }
  if (typeof mode.danmaku_enabled === "boolean") {
    $("#danmaku-input").checked = mode.danmaku_enabled;
  }
  if (Number.isFinite(Number(mode.reply_lead_ms))) {
    state.replyLeadMs = Number(mode.reply_lead_ms);
    const matching = $$('[data-delay]').find(
      (button) => Number(button.dataset.delay) === state.replyLeadMs,
    );
    setSelected($$('[data-delay]'), matching || $('[data-delay="custom"]'));
    $("#custom-delay-field").hidden = Boolean(matching);
    if (!matching) {
      $("#custom-delay-input").value = String(Math.round(state.replyLeadMs / 1000));
    }
  }
  if (mode.visual_context_mode) {
    state.visualMode = mode.visual_context_mode;
    for (const button of $$('[data-visual-mode]')) {
      button.classList.toggle(
        "is-selected",
        button.dataset.visualMode === state.visualMode,
      );
    }
  }
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
  if (state.capturePreview?.url) URL.revokeObjectURL(state.capturePreview.url);
  state.capturePreview = null;
  state.captureWasPlaying = false;
  state.captureBusy = false;
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
  state.conversationMessages.clear();
  state.conversationFollow = createConversationFollowState();
  state.ignoreConversationScroll = false;
  state.fallbackStreamMessageId = "";
  state.viewingDuration = detachViewingDuration(state.viewingDuration);
  $("#capture-frame-button").hidden = true;
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
  $("#capture-frame-button").hidden = true;
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
      viewing_id: state.viewingId,
      window_id: config.windowId || "together-watch:web",
      companion: config.companion || { id: "companion", name: companionName },
      media,
      mode: modePayload(),
    });
    state.session = created.session;
    const resumeDirectly = shouldResumeDirectly(created.session);
    state.viewingId = created.viewing_summary?.viewing_id
      || created.session?.viewing_id
      || state.viewingId;
    const partLabel = media.part_title
      || (media.part_count > 1 ? `P${media.part_index}` : "");
    if (partLabel) state.viewedPartLabels.add(partLabel);
    state.timeline = new PlaybackTimeline(media.id);
    if (state.resumePlayheadMs > 0 && state.source !== "local") {
      await bridge.restorePlaybackPosition({
        session_id: state.session.session_id,
        media,
        playhead_ms: state.resumePlayheadMs,
      });
    }
    if (state.source === "local") await uploadSelectedSubtitle(media);
    startRuntimeLoops();
    if (resumeDirectly) unlockPlayback();
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

function handleStatusPollError() {
  state.statusPollFailures += 1;
  if (state.statusPollFailures < 2) return;
  const notice = $("#playback-notice");
  notice.textContent = "连接暂时不稳，正在重新同步";
  notice.hidden = false;
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
    state.viewingDuration = observeViewingDuration(state.viewingDuration, {
      sessionId: state.session.session_id,
      snapshot,
      observedAtMs: performance.now(),
    });
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
  const degradedReason = analysisDegradedReason(analysis, payload.analysis_runtime);
  $("#analysis-state-card").hidden = !analysis.error
    && analysis.status !== "degraded"
    && !preparation.knowledge_card_error;
  $("#analysis-state-title").textContent = analysis.status === "failed" ? "剧情分析不可用" : "当前为降级状态";
  $("#analysis-state-description").textContent = degradedReason
    || preparation.knowledge_card_error
    || "";
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
    let payload;
    try {
      payload = await bridge.getStatus(state.session.session_id);
    } catch {
      handleStatusPollError();
      return;
    }
    state.statusPollFailures = 0;
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
    payload.analysis_runtime?.latest_job?.status
      || payload.analysis_runtime?.latest_job_status,
  );
  const degradedReason = analysisDegradedReason(analysis, payload.analysis_runtime);
  $("#analysis-degraded-reason").hidden = analysis.status !== "degraded";
  $("#analysis-degraded-reason").textContent = analysis.status === "degraded"
    ? `降级原因：${degradedReason}`
    : "";
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
  updateCaptureButton();
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

function conversationMessageId(prefix = "message") {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function scrollConversationToBottom() {
  const list = $("#conversation-list");
  state.ignoreConversationScroll = true;
  list.scrollTop = list.scrollHeight;
  requestAnimationFrame(() => { state.ignoreConversationScroll = false; });
}

function upsertMessage({
  speaker,
  text,
  isUser = false,
  messageId = "",
  createdAt = "",
  append = false,
}) {
  if (!String(text || "").trim()) return;
  $("#conversation-empty").hidden = true;
  const resolvedId = String(messageId || conversationMessageId(isUser ? "viewer" : "assistant"));
  let message = state.conversationMessages.get(resolvedId);
  if (!message) {
    const fragment = $("#message-template").content.cloneNode(true);
    message = fragment.querySelector(".chat-message");
    message.dataset.messageId = resolvedId;
    if (isUser) message.classList.add("is-user");
    fragment.querySelector(".message-speaker").textContent = speaker;
    $("#conversation-list").append(fragment);
    state.conversationMessages.set(resolvedId, message);
  }
  const body = message.querySelector(".message-body");
  body.textContent = append ? `${body.textContent}${text}` : text;
  const timestamp = formatMessageTimestamp(createdAt);
  const time = message.querySelector(".message-time");
  time.hidden = !timestamp;
  if (timestamp) {
    time.dateTime = timestamp.dateTime;
    time.textContent = timestamp.label;
  }
  const follow = noteConversationMessage(state.conversationFollow, resolvedId);
  if (follow.shouldScroll) requestAnimationFrame(scrollConversationToBottom);
}

async function sendMessage(text) {
  if (!bridge.canSendMessage()) throw new Error("请先配置 TogetherWatchHost.sendMessage");
  const replyStartedAt = performance.now();
  let replyDisplayReported = false;
  const sentAt = new Date().toISOString();
  const snapshot = await captureSnapshot();
  if (!snapshot) throw new Error("当前读不到准确播放位置");
  await bridge.updatePlayback(state.session.session_id, snapshot);
  const result = await bridge.sendMessage({
    text,
    watch_session_id: state.session.session_id,
    watch_snapshot: snapshot,
  });
  const reportDisplayed = (message = null) => {
    if (replyDisplayReported) return;
    const jobId = String(
      message?.job_id
      || message?.run_id
      || result?.job_id
      || result?.run_id
      || result?.assistant_job_id
      || "",
    ).trim();
    if (!jobId) return;
    replyDisplayReported = true;
    void bridge.reportReplyDisplayed(
      state.session.session_id,
      jobId,
      performance.now() - replyStartedAt,
    ).catch(() => {});
  };
  upsertMessage({ speaker: "你", text, isUser: true, createdAt: sentAt });
  if (result?.assistant_text) {
    upsertMessage({
      speaker: companionName,
      text: result.assistant_text,
      messageId: result.assistant_message_id,
      createdAt: result.assistant_created_at,
    });
    reportDisplayed();
  }
  for (const message of result?.messages || []) {
    if (message?.role === "assistant") {
      upsertMessage({
        speaker: companionName,
        text: message.content,
        messageId: message.message_id || message.id,
        createdAt: message.created_at || message.timestamp,
      });
      reportDisplayed(message);
    }
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
  const ended = await leaveSession({ returnToConfirm: false });
  if (!ended) return;
  state.resumePlayheadMs = 0;
  state.resumeViewing = null;
  $("#bilibili-input").value = part.canonical_url;
  $("#part-list").hidden = true;
  await enterPlayer();
}

async function leaveSession({
  returnToConfirm = true,
  consumeHistory = true,
  viewingAction = "",
  showSummary = false,
} = {}) {
  if (state.ending) return false;
  state.ending = true;
  const sessionId = state.session?.session_id;
  clearRuntimeTimers();
  if (sessionId) await syncPlayback().catch(() => null);
  $("#local-video").pause();
  let endTicket = null;
  try {
    if (sessionId) {
      const ended = await bridge.endSession(sessionId, { viewingAction });
      recordEndedSessionCost(sessionId, ended);
      if (viewingAction === "complete") endTicket = buildEndTicket(ended, sessionId);
    }
  } catch (error) {
    state.ending = false;
    if (state.session) startRuntimeLoops();
    if (showSummary) showAnalysisCostUnavailable();
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
  if (showSummary) {
    finishAnalysisCostTracking(endTicket, null, {
      savedProgress: viewingAction === "save_progress",
    });
  }
  return true;
}

async function runViewingAction(action) {
  if (state.endAction || !state.session) return;
  setEndChoiceBusy(action);
  $("#watch-end-choice-dialog").close();
  const ended = await leaveSession({
    viewingAction: action,
    showSummary: true,
  });
  if (!ended) {
    setEndChoiceBusy();
    return;
  }
  setEndChoiceBusy();
  await loadRecentViewings();
}

async function openRecentViewing(value) {
  const recent = normalizeRecentViewing(value);
  if (recent.completed) {
    try {
      const payload = recent.ticket
        ? { ticket: recent.ticket }
        : await bridge.getViewing(recent.viewing_id);
      const ticket = ticketFromViewingPayload(payload) || recent.ticket;
      if (!ticket) throw new Error("这条已看完记录还没有返回票根");
      const saved = saveAndSelectTicket(ticket);
      await openTicketFolder(saved);
    } catch (error) {
      toast(error.message || "票根读取失败");
    }
    return;
  }

  state.viewingId = recent.viewing_id;
  state.resumeViewing = recent;
  state.resumePlayheadMs = recent.playhead_ms;
  restoreModeControls(recent.mode);
  if (!state.knowledgeMode) {
    toast("请先选择作品了解模式，再从最近观看继续");
    return;
  }
  $("#title-input").value = recent.title;
  if (recent.source === "local_file" || recent.media_revision) {
    selectSource("local");
    toast("请重新选择原本地视频，校验通过后继续");
    $("#local-file-input").click();
    return;
  }
  if (!recent.source_url) {
    toast("这条进度缺少可恢复的播放地址");
    return;
  }
  if (!bridge.canRestorePlaybackPosition()) {
    toast("宿主尚未实现跨域播放器进度恢复，当前不会假装从旧位置续播");
    return;
  }
  selectSource("bilibili");
  $("#bilibili-input").value = recent.source_url;
  updateSelection();
  await enterPlayer();
}

async function loadRecentViewings() {
  try {
    const payload = await bridge.listViewings({
      status: "recent",
      windowId: config.windowId || "together-watch:web",
    });
    const viewings = (payload.viewings || payload.items || payload.recent || [])
      .map(normalizeRecentViewing)
      .filter((viewing) => viewing.viewing_id);
    $("#recent-section").hidden = viewings.length === 0;
    const list = $("#recent-list");
    list.replaceChildren();
    for (const viewing of viewings) {
      const fragment = $("#recent-template").content.cloneNode(true);
      const button = fragment.querySelector(".recent-card");
      fragment.querySelector(".recent-title").textContent = viewing.title;
      fragment.querySelector(".recent-part").textContent = viewing.part_title || "Lean In";
      fragment.querySelector(".recent-status").textContent = viewing.status_text;
      const cover = fragment.querySelector(".recent-cover");
      if (viewing.cover_url) {
        cover.src = viewing.cover_url;
        cover.alt = viewing.title;
        cover.hidden = false;
      }
      button.addEventListener("click", () => openRecentViewing(viewing));
      list.append(fragment);
    }
  } catch {
    $("#recent-section").hidden = true;
  }
}

function updateCaptureButton() {
  const button = $("#capture-frame-button");
  const available = state.source === "local" || bridge.canCaptureVideoFrame();
  button.hidden = !state.unlocked || !available;
  button.disabled = state.captureBusy || !state.session;
  button.textContent = state.captureBusy
    ? "截取中"
    : state.ticketCaptures.length
      ? `截帧·${state.ticketCaptures.length}`
      : "截帧";
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("当前画面无法生成图片"))),
      "image/jpeg",
      0.92,
    );
  });
}

async function normalizeCapturedJpeg(blob, suppliedWidth = 0, suppliedHeight = 0) {
  const width = Number(suppliedWidth) || 0;
  const height = Number(suppliedHeight) || 0;
  if (blob.type === "image/jpeg" && width > 0 && height > 0) {
    return { blob, width, height, mimeType: "image/jpeg" };
  }
  if (typeof createImageBitmap !== "function") {
    throw new Error("宿主截图需要提供 JPEG 及真实宽高");
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d", { alpha: false }).drawImage(bitmap, 0, 0);
    return {
      blob: await canvasBlob(canvas),
      width: bitmap.width,
      height: bitmap.height,
      mimeType: "image/jpeg",
    };
  } finally {
    bitmap.close();
  }
}

async function assertCapturedFrameIsVisible(blob) {
  let source;
  let release = () => {};
  if (typeof createImageBitmap === "function") {
    source = await createImageBitmap(blob);
    release = () => source.close();
  } else {
    const url = URL.createObjectURL(blob);
    source = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("当前画面解析失败"));
      image.src = url;
    });
    release = () => URL.revokeObjectURL(url);
  }
  try {
    const sample = document.createElement("canvas");
    sample.width = 16;
    sample.height = 12;
    const context = sample.getContext("2d", { alpha: false });
    context.drawImage(source, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 3 || pixels[index + 1] > 3 || pixels[index + 2] > 3) return;
    }
    throw new Error("没有读取到视频画面，请重新截取");
  } finally {
    release();
  }
}

async function captureLocalVideoFrame() {
  const video = $("#local-video");
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    throw new Error("本地播放器画面还没有准备好");
  }
  const wasPlaying = !video.paused;
  video.pause();
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d", { alpha: false }).drawImage(video, 0, 0);
  const blob = await canvasBlob(canvas);
  await assertCapturedFrameIsVisible(blob);
  return {
    blob,
    atMs: Math.round(video.currentTime * 1000),
    capturedAt: new Date().toISOString(),
    wasPlaying,
    width: video.videoWidth,
    height: video.videoHeight,
    mimeType: "image/jpeg",
  };
}

async function blobFromHostCapture(value) {
  if (value instanceof Blob) return value;
  if (value?.blob instanceof Blob) return value.blob;
  const dataUrl = value?.data_url || value?.image_data_url;
  if (dataUrl) return (await fetch(dataUrl)).blob();
  throw new Error("宿主没有返回可预览的视频画面");
}

async function captureCurrentVideoFrame() {
  if (!state.session || !state.unlocked || state.captureBusy) return;
  state.captureBusy = true;
  updateCaptureButton();
  try {
    let captured;
    if (state.source === "local") {
      state.captureWasPlaying = state.captureWasPlaying || !$("#local-video").paused;
      captured = await captureLocalVideoFrame();
    } else {
      const snapshot = await captureSnapshot();
      state.captureWasPlaying = state.captureWasPlaying || Boolean(snapshot?.is_playing);
      const raw = await bridge.captureVideoFrame({
        session_id: state.session.session_id,
        media: state.session.media,
        playback: snapshot,
      });
      const normalized = await normalizeCapturedJpeg(
        await blobFromHostCapture(raw),
        raw?.width,
        raw?.height,
      );
      await assertCapturedFrameIsVisible(normalized.blob);
      captured = {
        ...normalized,
        atMs: Number(raw?.at_ms ?? snapshot?.playhead_ms ?? 0),
        capturedAt: raw?.captured_at || new Date().toISOString(),
        wasPlaying: Boolean(raw?.was_playing ?? snapshot?.is_playing),
      };
    }
    if (state.capturePreview?.url) URL.revokeObjectURL(state.capturePreview.url);
    state.capturePreview = {
      ...captured,
      wasPlaying: state.captureWasPlaying || captured.wasPlaying,
      url: URL.createObjectURL(captured.blob),
    };
    state.captureWasPlaying = state.capturePreview.wasPlaying;
    $("#capture-preview-image").src = state.capturePreview.url;
    $("#capture-preview-description").textContent = `截取于 ${formatMediaTime(captured.atMs)} · 确认后会保存到这次观看的自选画面`;
    $("#capture-preview-error").hidden = true;
    $("#save-frame-button").textContent = "保存这张";
    $("#capture-preview-dialog").showModal();
  } catch (error) {
    toast(error.message || "当前画面截取失败");
    await resumeAfterCapture();
  } finally {
    state.captureBusy = false;
    updateCaptureButton();
  }
}

async function resumeAfterCapture() {
  const preview = state.capturePreview;
  if (!(preview?.wasPlaying || state.captureWasPlaying) || !state.unlocked) return;
  if (state.source === "local") {
    await $("#local-video").play().catch(() => {});
  } else if (state.session) {
    await bridge.resumePlaybackAfterCapture({
      session_id: state.session.session_id,
      media: state.session.media,
    }).catch(() => {});
  }
}

async function closeCapturePreview({ resume = true } = {}) {
  const preview = state.capturePreview;
  if (resume) await resumeAfterCapture();
  if (preview?.url) URL.revokeObjectURL(preview.url);
  state.capturePreview = null;
  if (resume) state.captureWasPlaying = false;
  $("#capture-preview-image").removeAttribute("src");
  const dialog = $("#capture-preview-dialog");
  if (dialog.open) dialog.close();
}

async function saveCapturePreview() {
  const preview = state.capturePreview;
  if (!preview || !state.viewingId || state.captureBusy) return;
  state.captureBusy = true;
  $("#save-frame-button").disabled = true;
  $("#retake-frame-button").disabled = true;
  $("#save-frame-button").textContent = "保存中…";
  $("#capture-preview-error").hidden = true;
  try {
    const snapshot = await captureSnapshot().catch(() => null);
    const payload = await bridge.uploadTicketFrameCapture(
      state.viewingId,
      {
        session_id: state.session?.session_id || "",
        media_id: state.session?.media?.id || "",
        at_ms: preview.atMs,
        timeline_epoch: Number(snapshot?.timeline_epoch || 0),
        width: preview.width,
        height: preview.height,
        mime_type: preview.mimeType || "image/jpeg",
      },
      preview.blob,
    );
    const frame = normalizeTicketCapture(payload.capture || payload.frame);
    if (!frame.frame_id || !frame.image_url) throw new Error("网关没有返回已保存的画面");
    state.ticketCaptures = [
      ...state.ticketCaptures.filter((item) => item.frame_id !== frame.frame_id),
      frame,
    ];
    await closeCapturePreview();
    toast("这张画面已经保存，之后可以在票根里选择");
  } catch (error) {
    $("#capture-preview-error").textContent = error.message || "画面保存失败";
    $("#capture-preview-error").hidden = false;
  } finally {
    state.captureBusy = false;
    $("#save-frame-button").disabled = false;
    $("#retake-frame-button").disabled = false;
    $("#save-frame-button").textContent = "保存这张";
    updateCaptureButton();
  }
}

for (const button of $$('[data-source]')) {
  button.addEventListener("click", () => selectSource(button.dataset.source));
}

$("#local-file-input").addEventListener("change", async (event) => {
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
  if (state.localFile && state.resumeViewing) await enterPlayer();
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
  state.viewingId = "";
  state.viewingDuration = createViewingDurationAccumulator();
  state.viewedPartLabels.clear();
  state.resumeViewing = null;
  state.resumePlayheadMs = 0;
  state.ticketCaptures = [];
  enterPlayer();
});

$("#confirm-back").addEventListener("click", () => {
  window.dispatchEvent(new CustomEvent("togetherwatch:back"));
});
$("#ticket-folder-button").addEventListener("click", () => openTicketFolder());
$("#tickets-back").addEventListener("click", () => {
  state.selectedTicket = null;
  state.ticketDeleteMode = false;
  state.ticketDeleteSelection.clear();
  closeTicketEditPopover();
  closeTicketFrameGallery();
  if (history.state?.[WATCH_PAGE_STATE_KEY] === "tickets") history.back();
  else setPage("confirm");
});
$("#tickets-edit-button").addEventListener("click", () => {
  if (state.ticketDeleteMode) {
    leaveTicketDeleteMode();
    return;
  }
  const popover = $("#tickets-edit-popover");
  popover.hidden = !popover.hidden;
});
$("#tickets-delete-mode-button").addEventListener("click", enterTicketDeleteMode);
$("#tickets-sort-button").addEventListener("click", () => {
  closeTicketEditPopover();
  renderTicketSortDialog();
  $("#ticket-sort-dialog").showModal();
});
$("#ticket-delete-confirm").addEventListener("click", confirmTicketDelete);
$("#ticket-sort-newest").addEventListener("click", () => setTicketSort(true));
$("#ticket-sort-oldest").addEventListener("click", () => setTicketSort(false));
$("#ticket-frame-close").addEventListener("click", closeTicketFrameGallery);
$("#ticket-frame-dialog .pick-ticket-back-image").addEventListener("click", () => {
  pickTicketImage(state.selectedTicket, "back");
});
$("#ticket-frame-dialog .clear-ticket-back-image")
  .addEventListener("click", clearTicketBackImage);
$("#open-chat-button").addEventListener("click", () => bridge.openChat({ source: state.source }));
$("#player-back").addEventListener("click", showEndChoiceDialog);
$("#return-confirm-button").addEventListener("click", showEndChoiceDialog);
$("#end-session-button").addEventListener("click", showEndChoiceDialog);
$("#watch-end-choice-close").addEventListener("click", closeEndChoiceDialog);
$("#save-progress-button").addEventListener("click", () => runViewingAction("save_progress"));
$("#complete-viewing-button").addEventListener("click", () => runViewingAction("complete"));
$("#watch-end-choice-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeEndChoiceDialog();
});
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
$("#capture-frame-button").addEventListener("click", captureCurrentVideoFrame);
$("#save-frame-button").addEventListener("click", saveCapturePreview);
$("#retake-frame-button").addEventListener("click", async () => {
  await closeCapturePreview({ resume: false });
  await captureCurrentVideoFrame();
});
$("#capture-preview-dialog").addEventListener("cancel", async (event) => {
  event.preventDefault();
  if (!state.captureBusy) await closeCapturePreview();
});

$("#message-input").addEventListener("input", (event) => {
  $("#send-button").disabled = !event.target.value.trim();
});
$("#conversation-list").addEventListener("scroll", (event) => {
  if (state.ignoreConversationScroll) return;
  const list = event.currentTarget;
  const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
  if (distanceFromBottom > 8) pauseConversationFollow(state.conversationFollow);
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
$("#watch-end-dismiss").addEventListener("click", closeWatchEndDialog);
$("#watch-end-save").addEventListener("click", () => {
  if (!state.currentEndTicket) {
    closeWatchEndDialog();
    return;
  }
  if (state.endTicketSaved) {
    closeWatchEndDialog();
    return;
  }
  ticketStore.save(state.currentEndTicket);
  state.endTicketSaved = true;
  $("#watch-end-dismiss").hidden = true;
  $("#watch-end-save").textContent = "完成";
  renderTicketFolder();
  toast("已经放进票夹了");
});
$("#watch-end-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
});
$("#ticket-image-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  const target = state.ticketImageTarget;
  if (!file || !target || !state.ticketAssetRole) return;
  try {
    await openTicketImageEditor(file, target, state.ticketAssetRole);
  } catch (error) {
    toast(error.message || "票根图片保存失败");
    state.ticketAssetRole = "";
    state.ticketImageTarget = null;
  }
});
$("#ticket-image-editor-cancel").addEventListener("click", closeTicketImageEditor);
$("#ticket-image-editor-confirm").addEventListener("click", confirmTicketImageEditor);
$("#ticket-image-editor-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeTicketImageEditor();
});
$("#ticket-image-editor-canvas").addEventListener("pointerdown", (event) => {
  const draft = state.ticketImageDraft;
  if (!draft) return;
  event.currentTarget.setPointerCapture(event.pointerId);
  draft.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  resetTicketEditorGesture(draft);
});
$("#ticket-image-editor-canvas").addEventListener("pointermove", (event) => {
  const draft = state.ticketImageDraft;
  if (!draft?.pointers.has(event.pointerId)) return;
  draft.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const center = ticketEditorPointerCenter(draft.pointers);
  const distance = ticketEditorPointerDistance(draft.pointers);
  if (center && draft.lastCenter) {
    draft.offsetX += center.x - draft.lastCenter.x;
    draft.offsetY += center.y - draft.lastCenter.y;
  }
  if (distance > 0 && draft.lastDistance > 0) {
    draft.zoom = Math.max(1, Math.min(6, draft.zoom * (distance / draft.lastDistance)));
  }
  draft.lastCenter = center;
  draft.lastDistance = distance;
  drawTicketImageEditor();
});
for (const eventName of ["pointerup", "pointercancel"]) {
  $("#ticket-image-editor-canvas").addEventListener(eventName, (event) => {
    const draft = state.ticketImageDraft;
    if (!draft) return;
    draft.pointers.delete(event.pointerId);
    resetTicketEditorGesture(draft);
  });
}
window.addEventListener("resize", () => {
  if (state.ticketImageDraft) requestAnimationFrame(drawTicketImageEditor);
});

window.addEventListener("togetherwatch:danmaku", (event) => acceptDanmaku(event.detail));
window.addEventListener("togetherwatch:message", (event) => {
  const detail = event.detail || {};
  if (detail.session_id && detail.session_id !== state.session?.session_id) return;
  if (detail.streaming && (detail.stream_start || !state.fallbackStreamMessageId)) {
    state.fallbackStreamMessageId = conversationMessageId("assistant-stream");
  }
  const fallbackStreamId = detail.streaming ? state.fallbackStreamMessageId : "";
  upsertMessage({
    speaker: detail.speaker || companionName,
    text: detail.text,
    isUser: detail.role === "user",
    messageId: detail.message_id || fallbackStreamId,
    createdAt: detail.created_at || detail.timestamp,
    append: detail.append === true,
  });
  if (detail.stream_end) state.fallbackStreamMessageId = "";
});
window.addEventListener("popstate", () => {
  if (state.ignoreNextPopState) {
    state.ignoreNextPopState = false;
    return;
  }
  if (state.page === "player") {
    leaveSession({ consumeHistory: false });
  } else if (state.page === "tickets") {
    setPage("confirm");
  }
});
window.addEventListener("pagehide", () => {
  if (state.session?.session_id) {
    bridge.endSession(state.session.session_id).catch(() => {});
  }
});

setPage("confirm", { historyMode: "replace" });
selectSource("bilibili");
updateSelection();
updateConversationState(false);
renderTicketFolder();
loadRecentViewings();

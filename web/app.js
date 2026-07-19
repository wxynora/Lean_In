import {
  formatMediaTime,
  parseBilibiliReference,
  titleFromFileName,
} from "./lib/media.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const companionName = new URLSearchParams(location.search).get("companion")
  || document.documentElement.dataset.companionName
  || "陪伴者";

const state = {
  source: "bilibili",
  localFile: null,
  localUrl: "",
  knowledgeMode: "",
  replyLeadMs: 30_000,
  fearAction: "warn_only",
  visualMode: "text_plus_contact_sheet",
  unlocked: false,
};

for (const node of $$('[data-companion]')) node.textContent = companionName;

function setPage(name) {
  $("#confirm-page").hidden = name !== "confirm";
  $("#player-page").hidden = name !== "player";
  window.scrollTo({ top: 0, behavior: "instant" });
}

function setError(message = "") {
  const node = $("#setup-error");
  node.textContent = message;
  node.hidden = !message;
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
  const card = $("#selection-card");
  card.hidden = !title;
  $("#selection-title").textContent = title;
  $("#selection-meta").textContent = state.source === "local"
    ? "本地播放器  |  文件不会自动上传"
    : "等待读取真实分 P  |  Bilibili 官方播放器";
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

function loadPlayer() {
  const video = $("#local-video");
  const iframe = $("#bilibili-player");
  const placeholder = $("#player-placeholder");
  video.hidden = true;
  iframe.hidden = true;
  placeholder.hidden = true;

  if (state.source === "local") {
    if (state.localUrl) URL.revokeObjectURL(state.localUrl);
    state.localUrl = URL.createObjectURL(state.localFile);
    video.src = state.localUrl;
    video.hidden = false;
    video.pause();
    return;
  }

  const reference = parseBilibiliReference($("#bilibili-input").value);
  if (reference.requiresResolution) {
    placeholder.hidden = false;
    placeholder.querySelector("p").textContent = "短链接等待宿主解析";
    return;
  }
  iframe.src = reference.embedUrl;
  iframe.hidden = false;
}

function renderPreparation() {
  const known = state.knowledgeMode === "known";
  $("#preparation-title").textContent = known ? "准备好了，等你确认" : "等待宿主整理知识卡";
  $("#preparation-description").textContent = known
    ? "作品定位已经确认，看过准备状态后再开播。"
    : "播放器保持暂停；知识卡由接入方的资料服务生成。";
  $("#identified-card").hidden = !known;
  $("#confirm-start-button").disabled = !known;
  $("#skip-button").hidden = known;
  $("#regenerate-button").hidden = true;

  const activeIndex = known ? 4 : 1;
  $$("#preparation-progress li").forEach((item, index) => {
    item.classList.toggle("is-complete", index < activeIndex);
    item.classList.toggle("is-active", index === activeIndex);
  });

  $("#subtitle-title").textContent = "字幕服务未配置";
  $("#subtitle-description").textContent = "字幕检索是可选增强；当前参照页不连接字幕服务。";
  $("#subtitle-spinner").hidden = true;
}

function enterPlayer() {
  setError();
  try {
    loadPlayer();
  } catch (error) {
    setError(error.message || "视频来源无法识别");
    return;
  }
  $("#player-title").textContent = selectedTitle() || "一起看";
  $("#sync-badge").textContent = "准备中";
  state.unlocked = false;
  $("#player-lock").hidden = false;
  $("#preparation-panel").hidden = false;
  $("#conversation-panel").hidden = true;
  $("#playback-status").hidden = true;
  renderPreparation();
  setPage("player");
}

function unlockPlayback() {
  state.unlocked = true;
  $("#player-lock").hidden = true;
  $("#preparation-panel").hidden = true;
  $("#conversation-panel").hidden = false;
  $("#playback-status").hidden = false;
  $("#sync-badge").textContent = "播放已同步";
  $("#message-input").disabled = false;
  $("#send-button").disabled = !$("#message-input").value.trim();
}

function appendUserMessage(text) {
  $("#conversation-empty").hidden = true;
  const fragment = $("#message-template").content.cloneNode(true);
  const message = fragment.querySelector(".chat-message");
  message.classList.add("is-user");
  fragment.querySelector(".message-speaker").textContent = "你";
  fragment.querySelector(".message-body").textContent = text;
  $("#conversation-list").append(fragment);
  $("#conversation-list").scrollTop = $("#conversation-list").scrollHeight;
}

for (const button of $$('[data-source]')) {
  button.addEventListener("click", () => selectSource(button.dataset.source));
}

$("#local-file-input").addEventListener("change", (event) => {
  state.localFile = event.target.files?.[0] || null;
  $("#local-file-title").textContent = state.localFile?.name || "选择本地视频";
  $("#local-file-detail").textContent = state.localFile
    ? `${(state.localFile.size / 1024 / 1024).toFixed(1)} MB · 原片不会自动上传`
    : "原片留在浏览器内，不会自动上传";
  if (state.localFile && !$("#title-input").value.trim()) {
    $("#title-input").value = titleFromFileName(state.localFile.name);
  }
  updateSelection();
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

for (const button of [$("#player-back"), $("#return-confirm-button")]) {
  button.addEventListener("click", () => {
    $("#local-video").pause();
    setPage("confirm");
  });
}

$("#confirm-back").addEventListener("click", () => {
  window.dispatchEvent(new CustomEvent("togetherwatch:back"));
});
$("#open-chat-button").addEventListener("click", () => {
  window.dispatchEvent(new CustomEvent("togetherwatch:open-chat"));
});
$("#end-session-button").addEventListener("click", () => {
  $("#local-video").pause();
  setPage("confirm");
});
$("#confirm-start-button").addEventListener("click", unlockPlayback);
$("#skip-button").addEventListener("click", unlockPlayback);

$("#fullscreen-button").addEventListener("click", async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await $("#video-stage").requestFullscreen();
});

$("#message-input").addEventListener("input", (event) => {
  $("#send-button").disabled = !event.target.value.trim();
});
$("#message-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#message-input");
  const text = input.value.trim();
  if (!text) return;
  appendUserMessage(text);
  input.value = "";
  $("#send-button").disabled = true;
});

$("#local-video").addEventListener("play", (event) => {
  if (!state.unlocked) event.currentTarget.pause();
});
$("#local-video").addEventListener("timeupdate", (event) => {
  const video = event.currentTarget;
  $("#playback-clock").textContent = `${formatMediaTime(video.currentTime * 1000)} / ${formatMediaTime(video.duration * 1000)}`;
});

if (new URLSearchParams(location.search).get("screen") === "player") {
  $("#player-title").textContent = "一起看 · UI 参照";
  setPage("player");
} else {
  setPage("confirm");
}

updateSelection();

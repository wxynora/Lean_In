import { WatchApiClient } from "./api.js";


export class WatchHostBridge {
  constructor(config = globalThis.TogetherWatchConfig || {}, host = globalThis.TogetherWatchHost) {
    this.config = config;
    this.host = host || null;
    this.api = new WatchApiClient(config);
  }

  async callHost(name, payload) {
    const method = this.host?.[name];
    if (typeof method !== "function") throw new Error(`宿主尚未实现 ${name}`);
    return method.call(this.host, payload);
  }

  listSessions(windowId) {
    return this.api.listSessions(windowId);
  }

  describeBilibiliParts(bvid, page) {
    return this.api.describeBilibiliParts(bvid, page);
  }

  createSession(payload) {
    return this.api.createSession(payload);
  }

  getStatus(sessionId) {
    return this.api.getStatus(sessionId);
  }

  heartbeat(sessionId) {
    return this.api.heartbeat(sessionId);
  }

  startSession(sessionId, payload) {
    return this.api.startSession(sessionId, payload);
  }

  updatePlayback(sessionId, snapshot) {
    return this.api.updatePlayback(sessionId, snapshot);
  }

  reportReplyDisplayed(sessionId, jobId, visibleLatencyMs) {
    return this.api.reportReplyDisplayed(sessionId, jobId, visibleLatencyMs);
  }

  updateMode(sessionId, mode) {
    return this.api.updateMode(sessionId, mode);
  }

  regenerateKnowledge(sessionId) {
    return this.api.regenerateKnowledge(sessionId);
  }

  retrySubtitles(sessionId) {
    return this.api.retrySubtitles(sessionId);
  }

  uploadLocalSubtitle(sessionId, payload) {
    return this.api.uploadLocalSubtitle(sessionId, payload);
  }

  uploadSamples(sessionId, metadata, files) {
    return this.api.uploadSamples(sessionId, metadata, files);
  }

  endSession(sessionId, options) {
    return this.api.endSession(sessionId, options);
  }

  listViewings(options) {
    return this.api.listViewings(options);
  }

  getViewing(viewingId) {
    return this.api.getViewing(viewingId);
  }

  listTicketFrameCaptures(viewingId) {
    return this.api.listTicketFrameCaptures(viewingId);
  }

  uploadTicketFrameCapture(viewingId, metadata, image) {
    return this.api.uploadTicketFrameCapture(viewingId, metadata, image);
  }

  selectTicketFrameCapture(viewingId, captureId) {
    return this.api.selectTicketFrameCapture(viewingId, captureId);
  }

  clearTicketFrame(viewingId) {
    return this.api.clearTicketFrame(viewingId);
  }

  listTickets() {
    return this.api.listTickets();
  }

  updateTicketTitle(ticketId, title) {
    return this.api.updateTicketTitle(ticketId, title);
  }

  canTrackBilibiliPlayback() {
    return typeof this.host?.getPlaybackSnapshot === "function";
  }

  getPlaybackSnapshot(payload) {
    return this.callHost("getPlaybackSnapshot", payload);
  }

  canCaptureVideoFrame() {
    return typeof this.host?.captureVideoFrame === "function";
  }

  captureVideoFrame(payload) {
    return this.callHost("captureVideoFrame", payload);
  }

  resumePlaybackAfterCapture(payload) {
    if (typeof this.host?.resumePlaybackAfterCapture !== "function") return Promise.resolve();
    return this.callHost("resumePlaybackAfterCapture", payload);
  }

  canRestorePlaybackPosition() {
    return typeof this.host?.restorePlaybackPosition === "function";
  }

  restorePlaybackPosition(payload) {
    if (typeof this.host?.restorePlaybackPosition !== "function") return Promise.resolve(false);
    return this.callHost("restorePlaybackPosition", payload).then(() => true);
  }

  canSendMessage() {
    return typeof this.host?.sendMessage === "function";
  }

  sendMessage(payload) {
    return this.callHost("sendMessage", payload);
  }

  openChat(payload) {
    if (typeof this.host?.openChat === "function") return this.callHost("openChat", payload);
    globalThis.dispatchEvent(new CustomEvent("togetherwatch:open-chat", { detail: payload }));
    return Promise.resolve();
  }
}

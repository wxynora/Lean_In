export class WatchApiError extends Error {
  constructor(message, { status = 0, code = "", payload = null } = {}) {
    super(message);
    this.name = "WatchApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

function normalizeBase(value) {
  return String(value || "").replace(/\/+$/, "");
}

export class WatchApiClient {
  constructor(config = {}, fetchImpl = globalThis.fetch?.bind(globalThis)) {
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
    this.fetch = fetchImpl;
    this.gatewayBaseUrl = normalizeBase(config.gatewayBaseUrl);
    this.basePath = `/${String(config.watchApiBasePath || "/miniapp-api/watch")
      .replace(/^\/+|\/+$/g, "")}`;
    this.getAuthHeaders = typeof config.getAuthHeaders === "function"
      ? config.getAuthHeaders
      : async () => ({ ...(config.authHeaders || {}) });
  }

  url(path = "") {
    const suffix = String(path || "").replace(/^\/+/, "");
    return `${this.gatewayBaseUrl}${this.basePath}${suffix ? `/${suffix}` : ""}`;
  }

  async request(method, path, { body, form, query } = {}) {
    const url = new URL(this.url(path), globalThis.location?.href || "http://localhost/");
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    const headers = new Headers(await this.getAuthHeaders());
    const options = { method, headers };
    if (form) {
      options.body = form;
    } else if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      options.body = JSON.stringify(body);
    }
    const response = await this.fetch(url, options);
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) {
      throw new WatchApiError(
        payload?.error || `Lean In API HTTP ${response.status}`,
        { status: response.status, code: payload?.code || "", payload },
      );
    }
    return payload || {};
  }

  listSessions(windowId) {
    return this.request("GET", "sessions", { query: { window_id: windowId, limit: 20 } });
  }

  describeBilibiliParts(bvid, page) {
    return this.request("GET", "bilibili/parts", { query: { bvid, page } });
  }

  createSession(payload) {
    return this.request("POST", "sessions", { body: payload });
  }

  getStatus(sessionId) {
    return this.request("GET", `sessions/${encodeURIComponent(sessionId)}/status`);
  }

  heartbeat(sessionId) {
    return this.request("POST", `sessions/${encodeURIComponent(sessionId)}/heartbeat`, { body: {} });
  }

  startSession(sessionId, payload) {
    return this.request("POST", `sessions/${encodeURIComponent(sessionId)}/start`, { body: payload });
  }

  updatePlayback(sessionId, snapshot) {
    return this.request("PUT", `sessions/${encodeURIComponent(sessionId)}/playback`, { body: snapshot });
  }

  reportReplyDisplayed(sessionId, jobId, visibleLatencyMs) {
    return this.request(
      "POST",
      `sessions/${encodeURIComponent(sessionId)}/reply-displayed`,
      {
        body: {
          job_id: String(jobId || ""),
          visible_latency_ms: Math.max(0, Math.round(Number(visibleLatencyMs) || 0)),
        },
      },
    );
  }

  updateMode(sessionId, mode) {
    return this.request("PUT", `sessions/${encodeURIComponent(sessionId)}/mode`, { body: { mode } });
  }

  regenerateKnowledge(sessionId) {
    return this.request("POST", `sessions/${encodeURIComponent(sessionId)}/knowledge-card/regenerate`, { body: {} });
  }

  retrySubtitles(sessionId) {
    return this.request("POST", `sessions/${encodeURIComponent(sessionId)}/subtitles/retry`, { body: {} });
  }

  uploadLocalSubtitle(sessionId, payload) {
    return this.request("POST", `sessions/${encodeURIComponent(sessionId)}/local-subtitles`, { body: payload });
  }

  uploadSamples(sessionId, metadata, files) {
    const form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    for (const [field, blob, name] of files) form.set(field, blob, name);
    return this.request("POST", `sessions/${encodeURIComponent(sessionId)}/analysis/samples`, { form });
  }

  endSession(sessionId, { viewingAction = "" } = {}) {
    return this.request("DELETE", `sessions/${encodeURIComponent(sessionId)}`, {
      query: { viewing_action: viewingAction || undefined },
    });
  }

  listViewings({ status = "recent", windowId = "" } = {}) {
    return this.request("GET", "viewings", {
      query: { status, window_id: windowId || undefined },
    });
  }

  getViewing(viewingId) {
    return this.request("GET", `viewings/${encodeURIComponent(viewingId)}`);
  }

  listTicketFrameCaptures(viewingId) {
    return this.request(
      "GET",
      `viewings/${encodeURIComponent(viewingId)}/ticket-frame-captures`,
    );
  }

  uploadTicketFrameCapture(viewingId, metadata, image) {
    const form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    form.set("image", image, `ticket-frame-${Number(metadata?.at_ms) || 0}.jpg`);
    return this.request(
      "POST",
      `viewings/${encodeURIComponent(viewingId)}/ticket-frame-captures`,
      { form },
    );
  }

  selectTicketFrameCapture(viewingId, captureId) {
    return this.request("PUT", `viewings/${encodeURIComponent(viewingId)}/ticket-frame`, {
      body: { capture_id: captureId },
    });
  }

  clearTicketFrame(viewingId) {
    return this.request("DELETE", `viewings/${encodeURIComponent(viewingId)}/ticket-frame`);
  }

  listTickets() {
    return this.request("GET", "tickets");
  }

  updateTicketTitle(ticketId, title) {
    return this.request("PUT", `tickets/${encodeURIComponent(ticketId)}`, {
      body: { title },
    });
  }
}

function randomSessionId() {
  if (globalThis.crypto?.randomUUID) return `watch_${globalThis.crypto.randomUUID()}`;
  return `watch_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function localPreparation(payload) {
  const known = payload.mode.knowledge_mode === "known";
  const visualRequested = payload.mode.visual_context_mode === "text_plus_contact_sheet";
  return {
    session: {
      session_id: randomSessionId(),
      media: payload.media,
      mode: payload.mode,
    },
    preparation: {
      status: known ? "ready_to_confirm" : "knowledge_failed",
      knowledge_card_status: known ? "not_required" : "failed",
      knowledge_card_error: known ? "" : "当前没有连接作品资料服务",
      can_confirm: known,
      can_skip: !known,
      subtitle_lookup: {
        status: "not_configured",
        message: "当前环境没有配置字幕来源，可以继续观看。",
        can_retry: false,
      },
    },
    analysis: {
      status: known ? "pending" : "unavailable",
      error: known ? "" : "当前没有连接剧情分析服务",
    },
    visual_context: {
      degraded_reason: visualRequested ? "visual_context_disabled" : "",
    },
    knowledge_card: null,
    parts: payload.parts || [],
  };
}

export class WatchHostBridge {
  constructor(host = globalThis.TogetherWatchHost) {
    this.host = host || null;
  }

  get connected() {
    return Boolean(this.host);
  }

  async call(name, payload, fallback) {
    const method = this.host?.[name];
    if (typeof method === "function") return method.call(this.host, payload);
    if (fallback) return fallback();
    throw new Error(`宿主尚未实现 ${name}`);
  }

  resolveMedia(payload) {
    return this.call("resolveMedia", payload);
  }

  prepareSession(payload) {
    return this.call("prepareSession", payload, () => localPreparation(payload));
  }

  confirmSession(payload) {
    return this.call("confirmSession", payload, () => ({ started: true }));
  }

  skipPreparation(payload) {
    return this.call("skipPreparation", payload, () => ({ started: true }));
  }

  regenerateKnowledge(payload) {
    return this.call("regenerateKnowledge", payload);
  }

  retrySubtitles(payload) {
    return this.call("retrySubtitles", payload);
  }

  updatePlayback(payload) {
    return this.call("updatePlayback", payload, () => ({ applied: true }));
  }

  switchPart(payload) {
    return this.call("switchPart", payload, () => payload);
  }

  sendMessage(payload) {
    return this.call("sendMessage", payload);
  }

  endSession(payload) {
    return this.call("endSession", payload, () => ({ ended: true }));
  }
}

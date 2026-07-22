const DEFAULT_STORAGE_KEY = "lean-in:tickets:v1";

function cleanText(value) {
  return String(value || "").trim();
}

function nonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function fallbackTicketId(viewingId, endedAt) {
  const identity = cleanText(viewingId) || cleanText(endedAt) || `${Date.now()}`;
  return `watch_ticket_${identity.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function normalizeFrame(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    frame_id: cleanText(source.frame_id || source.capture_id || source.id),
    media_id: cleanText(source.media_id),
    at_ms: nonNegativeNumber(source.at_ms),
    image_url: cleanText(source.image_url || source.url),
    selected_at: cleanText(source.selected_at),
  };
}

export function createViewingDurationAccumulator() {
  return { totalMs: 0, activeSessionId: "", previous: null };
}

export function detachViewingDuration(accumulator) {
  return { ...accumulator, activeSessionId: "", previous: null };
}

export function observeViewingDuration(
  accumulator,
  { sessionId, snapshot, observedAtMs },
) {
  const activeSessionId = cleanText(sessionId);
  if (!activeSessionId || !snapshot) return detachViewingDuration(accumulator);

  const current = {
    playheadMs: nonNegativeNumber(snapshot.playhead_ms),
    isPlaying: Boolean(snapshot.is_playing),
    playbackRate: Math.min(4, Math.max(0.25, Number(snapshot.playback_rate) || 1)),
    timelineEpoch: nonNegativeNumber(snapshot.timeline_epoch),
    snapshotSeq: nonNegativeNumber(snapshot.snapshot_seq),
    observedAtMs: nonNegativeNumber(observedAtMs),
  };
  const previous = accumulator.activeSessionId === activeSessionId
    ? accumulator.previous
    : null;
  let watchedMs = 0;
  if (
    previous
    && previous.isPlaying
    && previous.timelineEpoch === current.timelineEpoch
    && current.snapshotSeq > previous.snapshotSeq
    && current.observedAtMs > previous.observedAtMs
    && current.playheadMs >= previous.playheadMs
  ) {
    const wallDeltaMs = current.observedAtMs - previous.observedAtMs;
    const mediaDeltaMs = current.playheadMs - previous.playheadMs;
    watchedMs = Math.max(0, Math.min(
      wallDeltaMs,
      Math.round(mediaDeltaMs / previous.playbackRate),
    ));
  }
  return {
    totalMs: nonNegativeNumber(accumulator.totalMs) + watchedMs,
    activeSessionId,
    previous: current,
  };
}

export function formatTicketDuration(durationMs) {
  const value = nonNegativeNumber(durationMs);
  const minutes = value <= 0 ? 0 : Math.max(1, Math.round(value / 60_000));
  return `一起看了 ${minutes} 分钟`;
}

export function normalizeTicket(value, fallback = {}) {
  const source = value && typeof value === "object" ? value : {};
  const endedAt = cleanText(
    source.ended_at
    || source.completed_at
    || source.created_at
    || fallback.ended_at
    || fallback.completed_at
    || fallback.created_at,
  ) || new Date().toISOString();
  const viewingId = cleanText(source.viewing_id || fallback.viewing_id);
  const completedParts = Array.isArray(source.completed_parts)
    ? source.completed_parts.filter((item) => item && typeof item === "object")
    : [];
  const partLabel = cleanText(source.part_label || fallback.part_label)
    || completedParts
      .map((item) => cleanText(item.part_title) || `P${Number(item.part_index) || 1}`)
      .filter(Boolean)
      .join(" / ");
  const playedDurationMs = nonNegativeNumber(
    source.played_duration_ms ?? fallback.played_duration_ms,
  );
  const backFrameSource = source.back_frame || fallback.back_frame;
  const backFrame = backFrameSource && typeof backFrameSource === "object"
    ? normalizeFrame(backFrameSource)
    : null;
  return {
    ticket_id: cleanText(source.ticket_id || source.id || fallback.ticket_id)
      || fallbackTicketId(viewingId, endedAt),
    viewing_id: viewingId,
    work_key: cleanText(source.work_key || fallback.work_key),
    title: cleanText(source.title || fallback.title) || "一起看",
    cover_url: cleanText(source.cover_url || fallback.cover_url),
    companion: {
      id: cleanText(source.companion?.id || fallback.companion?.id),
      name: cleanText(source.companion?.name || fallback.companion?.name) || "{assistant}",
      avatar_url: cleanText(
        source.companion?.avatar_url || fallback.companion?.avatar_url,
      ),
    },
    viewer: {
      name: cleanText(source.viewer?.name || fallback.viewer?.name) || "我",
      avatar_url: cleanText(source.viewer?.avatar_url || fallback.viewer?.avatar_url),
    },
    created_at: cleanText(source.created_at || fallback.created_at) || endedAt,
    ended_at: endedAt,
    completed_at: cleanText(source.completed_at || fallback.completed_at),
    played_duration_ms: playedDurationMs,
    part_count: Math.max(1, Number(source.part_count || fallback.part_count) || 1),
    part_label: partLabel,
    completed_parts: completedParts,
    last_session_id: cleanText(source.last_session_id || fallback.last_session_id),
    server_back_frame_id: cleanText(
      source.server_back_frame_id
      || backFrame?.frame_id
      || fallback.server_back_frame_id,
    ),
    server_back_frame_url: cleanText(
      source.server_back_frame_url
      || backFrame?.image_url
      || fallback.server_back_frame_url,
    ),
    local_back_image_url: cleanText(
      source.local_back_image_url || fallback.local_back_image_url,
    ),
  };
}

export function updateTicketAvatar(value, role, avatarUrl) {
  if (role !== "companion" && role !== "viewer") {
    throw new TypeError("ticket avatar role must be companion or viewer");
  }
  const ticket = normalizeTicket(value);
  return {
    ...ticket,
    [role]: {
      ...ticket[role],
      avatar_url: cleanText(avatarUrl),
    },
  };
}

export function mergeTickets(...collections) {
  const merged = new Map();
  for (const collection of collections) {
    for (const value of Array.isArray(collection) ? collection : []) {
      const ticket = normalizeTicket(value);
      const previous = merged.get(ticket.ticket_id);
      merged.set(ticket.ticket_id, previous ? normalizeTicket(ticket, previous) : ticket);
    }
  }
  return [...merged.values()].sort((left, right) => (
    Date.parse(right.ended_at || right.created_at) - Date.parse(left.ended_at || left.created_at)
  ));
}

export function sortTicketsByEndedAt(tickets, newestFirst = true) {
  const direction = newestFirst ? -1 : 1;
  return [...(Array.isArray(tickets) ? tickets : [])].sort((left, right) => {
    const leftTime = Date.parse(left?.ended_at || left?.created_at) || 0;
    const rightTime = Date.parse(right?.ended_at || right?.created_at) || 0;
    return (leftTime - rightTime) * direction;
  });
}

export function createTicketStore(
  storage = globalThis.localStorage,
  storageKey = DEFAULT_STORAGE_KEY,
) {
  const deletedStorageKey = `${storageKey}:deleted`;

  function deletedIds() {
    try {
      const parsed = JSON.parse(storage?.getItem(deletedStorageKey) || "[]");
      return new Set(Array.isArray(parsed) ? parsed.map(cleanText).filter(Boolean) : []);
    } catch {
      return new Set();
    }
  }

  function writeTickets(tickets) {
    storage?.setItem(storageKey, JSON.stringify(tickets));
  }

  function writeDeleted(ids) {
    storage?.setItem(deletedStorageKey, JSON.stringify([...ids]));
  }

  function list() {
    try {
      const parsed = JSON.parse(storage?.getItem(storageKey) || "[]");
      const deleted = deletedIds();
      return mergeTickets(parsed).filter((ticket) => !deleted.has(ticket.ticket_id));
    } catch {
      return [];
    }
  }

  function save(value) {
    const incoming = normalizeTicket(value);
    const deleted = deletedIds();
    if (deleted.delete(incoming.ticket_id)) writeDeleted(deleted);
    const previous = list().find((ticket) => ticket.ticket_id === incoming.ticket_id);
    const ticket = previous ? normalizeTicket(incoming, previous) : incoming;
    const tickets = mergeTickets(list(), [ticket]);
    writeTickets(tickets);
    return ticket;
  }

  function sync(value) {
    const incoming = normalizeTicket(value);
    if (deletedIds().has(incoming.ticket_id)) return null;
    return save(incoming);
  }

  function remove(ticketId) {
    const normalizedId = cleanText(ticketId);
    if (!normalizedId) return list();
    const deleted = deletedIds();
    deleted.add(normalizedId);
    writeDeleted(deleted);
    const tickets = list().filter((ticket) => ticket.ticket_id !== normalizedId);
    writeTickets(tickets);
    return tickets;
  }

  return { list, save, sync, remove };
}

export function normalizeTicketCapture(value) {
  return normalizeFrame(value);
}

export function normalizeRecentViewing(value) {
  const source = value && typeof value === "object" ? value : {};
  const progress = source.progress || source.viewing_progress || {};
  const playback = progress.playback || source.playback || {};
  const media = progress.media || source.media || {};
  const ticket = source.ticket ? normalizeTicket(source.ticket) : null;
  return {
    viewing_id: cleanText(source.viewing_id || progress.viewing_id),
    completed: Boolean(source.completed || ticket),
    status_text: cleanText(source.status_text)
      || (source.completed || ticket ? "已看完" : "继续观看"),
    title: cleanText(source.title || progress.title || media.title) || "Lean In",
    cover_url: cleanText(source.cover_url || progress.cover_url || media.cover_url),
    source: cleanText(media.source || progress.source),
    source_url: cleanText(media.source_url || progress.source_url),
    part_title: cleanText(media.part_title || progress.part_title),
    playhead_ms: nonNegativeNumber(playback.playhead_ms || progress.playhead_ms),
    local_asset_id: cleanText(media.local_media?.local_asset_id || progress.local_asset_id),
    media_revision: cleanText(media.local_media?.media_revision || progress.media_revision),
    media,
    progress,
    mode: source.mode || progress.mode || {},
    ticket,
  };
}

export class PlaybackTimeline {
  constructor(mediaId) {
    if (!String(mediaId || "").trim()) throw new Error("mediaId is required");
    this.mediaId = mediaId;
    this.timelineEpoch = 0;
    this.snapshotSequence = 0;
  }

  beginNewEpoch() {
    this.timelineEpoch += 1;
    this.snapshotSequence = 0;
  }

  next({ playheadMs, durationMs, isPlaying, playbackRate = 1, capturedAt }) {
    const boundedDuration = Math.max(1, Math.round(Number(durationMs || 0)));
    const boundedPlayhead = Math.min(
      boundedDuration,
      Math.max(0, Math.round(Number(playheadMs || 0))),
    );
    this.snapshotSequence += 1;
    return {
      media_id: this.mediaId,
      playhead_ms: boundedPlayhead,
      duration_ms: boundedDuration,
      is_playing: Boolean(isPlaying),
      playback_rate: Number(playbackRate || 1),
      timeline_epoch: this.timelineEpoch,
      snapshot_seq: this.snapshotSequence,
      captured_at: capturedAt || new Date().toISOString(),
    };
  }
}

export function snapshotFromVideo(video, timeline) {
  if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return null;
  return timeline.next({
    playheadMs: video.currentTime * 1000,
    durationMs: video.duration * 1000,
    isPlaying: !video.paused && !video.ended,
    playbackRate: video.playbackRate,
  });
}

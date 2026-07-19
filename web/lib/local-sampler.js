function once(target, eventName, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待 ${eventName} 超时`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener("error", onError);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("本地视频读取失败"));
    };
    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

async function canvasBlob(canvas, type = "image/jpeg", quality = 0.72) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("浏览器无法导出视频帧"));
    }, type, quality);
  });
}

export function validateClientSamplePlan(plan, expected, nowMs = Date.now()) {
  if (!plan?.plan_id) throw new Error("取材计划缺少 plan_id");
  if (plan.managed_by !== "client" || !plan.client_upload_required) {
    throw new Error("这不是客户端取材计划");
  }
  if (plan.media_id !== expected.mediaId) throw new Error("取材计划不属于当前视频");
  if (plan.media_revision !== expected.mediaRevision) throw new Error("本地视频版本已经变化");
  if (Number(plan.timeline_epoch) !== Number(expected.timelineEpoch)) {
    throw new Error("播放时间轴已经变化");
  }
  const expiresAtMs = Date.parse(plan.expires_at || "");
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    throw new Error("取材计划已经过期");
  }
  const startMs = Number(plan.allowed_start_ms);
  const endMs = Number(plan.allowed_end_ms);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs) {
    throw new Error("取材计划时间范围无效");
  }
  if (!Array.isArray(plan.target_timestamps_ms) || plan.target_timestamps_ms.length === 0) {
    throw new Error("取材计划没有目标时间点");
  }
  if (
    Number.isInteger(Number(plan.max_frames))
    && Number(plan.max_frames) >= 0
    && plan.target_timestamps_ms.length > Number(plan.max_frames)
  ) {
    throw new Error("取材计划目标帧数超过限制");
  }
  for (const value of plan.target_timestamps_ms) {
    const atMs = Number(value);
    if (!Number.isFinite(atMs) || atMs < startMs || atMs > endMs) {
      throw new Error("取材时间点超出允许范围");
    }
  }
  const acceptedImages = plan.accepted_image_mime_types || [];
  if (acceptedImages.length > 0 && !acceptedImages.includes("image/jpeg")) {
    throw new Error("取材计划不接受浏览器导出的 JPEG");
  }
  return plan;
}

export class LocalFrameSampler {
  constructor(objectUrl, { documentRef = globalThis.document } = {}) {
    this.document = documentRef;
    this.video = documentRef.createElement("video");
    this.video.preload = "auto";
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.src = objectUrl;
    this.readyPromise = this.video.readyState >= 1
      ? Promise.resolve()
      : once(this.video, "loadedmetadata");
  }

  async probe() {
    await this.readyPromise;
    if (!Number.isFinite(this.video.duration) || this.video.duration <= 0) {
      throw new Error("浏览器没有读到本地视频时长");
    }
    const atMs = Math.min(1_000, Math.max(0, this.video.duration * 500));
    await this.frameAt(atMs);
    return true;
  }

  async frameAt(atMs) {
    await this.readyPromise;
    const durationMs = this.video.duration * 1000;
    const boundedMs = Math.min(Math.max(0, Number(atMs || 0)), Math.max(0, durationMs - 50));
    if (Math.abs(this.video.currentTime * 1000 - boundedMs) > 40) {
      this.video.currentTime = boundedMs / 1000;
      await once(this.video, "seeked");
    }
    if (this.video.readyState < 2) await once(this.video, "loadeddata");
    const sourceWidth = this.video.videoWidth;
    const sourceHeight = this.video.videoHeight;
    if (!sourceWidth || !sourceHeight) throw new Error("本地视频帧尺寸不可用");
    const scale = Math.min(1, 960 / Math.max(sourceWidth, sourceHeight));
    const canvas = this.document.createElement("canvas");
    canvas.width = Math.max(2, Math.round(sourceWidth * scale));
    canvas.height = Math.max(2, Math.round(sourceHeight * scale));
    canvas.getContext("2d", { alpha: false }).drawImage(
      this.video,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return canvasBlob(canvas);
  }

  async exportPlan(plan) {
    if (!plan?.plan_id) throw new Error("取材计划缺少 plan_id");
    if (plan.expires_at && Date.parse(plan.expires_at) <= Date.now()) {
      throw new Error("取材计划已经过期");
    }
    const samples = [];
    const files = [];
    const timestamps = [...new Set((plan.target_timestamps_ms || []).map(Number))];
    for (const [index, atMs] of timestamps.entries()) {
      const field = `frame_${index}`;
      const blob = await this.frameAt(atMs);
      samples.push({
        kind: "image",
        at_ms: Math.round(atMs),
        mime_type: blob.type || "image/jpeg",
        file_field: field,
        captured_at: new Date().toISOString(),
      });
      files.push([field, blob, `${Math.round(atMs)}.jpg`]);
    }
    return { samples, files };
  }

  destroy() {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }
}

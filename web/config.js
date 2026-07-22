globalThis.TogetherWatchConfig = {
  gatewayBaseUrl: "",
  watchApiBasePath: "/miniapp-api/watch",
  windowId: "together-watch:web",
  companion: { id: "companion", name: "{assistant}", avatarUrl: "" },
  viewer: { name: "我", avatarUrl: "" },
  heartbeatIntervalMs: 30_000,
  playbackSyncIntervalMs: 2_000,
  statusPollIntervalMs: 2_000,
  getAuthHeaders: async () => ({}),
};

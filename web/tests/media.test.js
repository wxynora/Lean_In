import assert from "node:assert/strict";
import test from "node:test";

import {
  formatMediaTime,
  localMediaId,
  parseBilibiliReference,
  parseBoundaryInput,
  titleFromFileName,
} from "../lib/media.js";

test("parses a Bilibili link and selected part", () => {
  const result = parseBilibiliReference("https://www.bilibili.com/video/BV1Er2HYEE4x?p=3");
  assert.equal(result.bvid, "BV1Er2HYEE4x");
  assert.equal(result.page, 3);
  assert.equal(result.mediaId, "bili:BV1Er2HYEE4x:p3");
});

test("keeps short links for a host resolver", () => {
  const result = parseBilibiliReference("https://b23.tv/example");
  assert.equal(result.requiresResolution, true);
});

test("parses media boundaries and formats time", () => {
  assert.equal(parseBoundaryInput("1:02:03"), 3_723_000);
  assert.equal(parseBoundaryInput("42:10"), 2_530_000);
  assert.equal(parseBoundaryInput(""), null);
  assert.equal(formatMediaTime(3_723_000), "1:02:03");
});

test("local file identity changes with file metadata", () => {
  const first = { name: "movie.mp4", size: 100, lastModified: 1 };
  const replacement = { name: "movie.mp4", size: 101, lastModified: 2 };
  assert.notEqual(localMediaId(first), localMediaId(replacement));
  assert.equal(titleFromFileName(first.name), "movie");
});

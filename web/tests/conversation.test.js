import assert from "node:assert/strict";
import test from "node:test";

import {
  createConversationFollowState,
  formatMessageTimestamp,
  noteConversationMessage,
  pauseConversationFollow,
} from "../lib/conversation.js";


test("a manual scroll pauses one streaming message and the next message restores follow", () => {
  const state = createConversationFollowState();

  assert.equal(noteConversationMessage(state, "reply-1").shouldScroll, true);
  pauseConversationFollow(state);
  assert.equal(noteConversationMessage(state, "reply-1").shouldScroll, false);
  assert.equal(noteConversationMessage(state, "reply-2").shouldScroll, true);
});

test("message timestamps use real values and fixed 24-hour labels", () => {
  const timestamp = formatMessageTimestamp(new Date(2026, 6, 20, 9, 7, 0));

  assert.equal(timestamp.label, "09:07");
  assert.equal(formatMessageTimestamp(""), null);
  assert.equal(formatMessageTimestamp("not-a-date"), null);
});

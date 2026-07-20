export function createConversationFollowState() {
  return { activeMessageId: "", follow: true };
}

export function noteConversationMessage(followState, messageId) {
  const id = String(messageId || "");
  const isNewMessage = id !== followState.activeMessageId;
  if (isNewMessage) {
    followState.activeMessageId = id;
    followState.follow = true;
  }
  return { isNewMessage, shouldScroll: followState.follow };
}

export function pauseConversationFollow(followState) {
  followState.follow = false;
}

export function formatMessageTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return { dateTime: date.toISOString(), label: `${hours}:${minutes}` };
}

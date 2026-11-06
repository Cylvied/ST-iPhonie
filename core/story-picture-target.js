// Message identity for asynchronous story pictures, including metadata-only JSON copies.
const messageStamp = value => {
  if (Object.prototype.toString.call(value) === '[object Date]') return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === 'string' && value.trim()) return value;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};
// An unset swipe_id and zero both identify the first reply variant.
const swipeOf = message => typeof message?.swipe_id === 'number' ? message.swipe_id : 0;

export function storyChatOwner(ctx) {
  const chatId = ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? '';
  return JSON.stringify(ctx?.groupId != null
    ? ['group', ctx.groupId, chatId]
    : ['character', ctx?.characters?.[ctx.characterId]?.avatar || (ctx?.characterId ?? null), chatId]);
}

export function captureStoryPictureTarget(ctx, id) {
  const message = ctx?.chat?.[id];
  return {id, owner: storyChatOwner(ctx), message, sentAt: messageStamp(message?.send_date),
    startedAt: messageStamp(message?.gen_started), swipe: swipeOf(message)};
}

export function resolveStoryPictureTarget(ctx, target) {
  const current = ctx?.chat?.[target.id];
  let reason = '';
  if (target.owner !== storyChatOwner(ctx)) reason = 'chat_changed';
  else if (!current) reason = 'message_missing';
  // A dated reply can survive a metadata writer replacing every message with a JSON copy.
  else if (
    current !== target.message && target.sentAt === null
    || target.sentAt !== null && messageStamp(current.send_date) !== target.sentAt
    || target.startedAt !== null && messageStamp(current.gen_started) !== target.startedAt
  ) reason = 'message_identity_changed';
  else if (swipeOf(current) !== target.swipe) reason = 'swipe_changed';
  return {message: reason ? null : current, reason};
}

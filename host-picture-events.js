import {captureStoryPictureTarget, resolveStoryPictureTarget} from './core/story-picture-target.js';

/** MESSAGE_RECEIVED owns completed reply content even when a renderer replaces its objects before it finishes. */
export function createPictureEvents({context, autoPictures, notice = () => {}}) {
  const attempted = new Map();
  let epoch = 0, closed = false;
  function reset() { epoch++; attempted.clear(); }
  function received(value, type) {
    if (closed || type === 'quiet' || type === 'impersonate' || value == null) return;
    const id = Number(value), ctx = context(), message = ctx?.chat?.[id];
    if (!Number.isInteger(id) || id < 0 || !message || message.is_user || message.is_system || message.role === 'tool') return;
    const target = captureStoryPictureTarget(ctx, id), key = target.owner + ':' + id;
    const previous = attempted.get(key);
    if (previous && resolveStoryPictureTarget(ctx, previous).message) return;
    // Dated replies need only their identity fields, without retaining chat variables or table data.
    if (target.sentAt !== null) target.message = null;
    const version = epoch;
    // A later duplicate event must not retry a failed, cancelled or manually removed picture.
    attempted.set(key, target);
    return Promise.resolve().then(() => {
      if (!closed && epoch === version && resolveStoryPictureTarget(context(), target).message) return autoPictures(id);
    }).catch(error => { if (!error?.cancelled) notice(error?.message || String(error)); });
  }
  return {received, reset, dispose() { closed = true; reset(); }};
}

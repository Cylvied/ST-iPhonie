// The serial lane keeps the original NovelAI rules. One account allows one image at a time; when friends share an account, requests that
// collide get 429 and too many of them can get the account flagged. So:
//   - requests from this browser run one at a time, also across tavern tabs (Web Locks when available);
//   - two requests are at least `gap` apart (the last request time is shared through localStorage);
//   - a 429 ("account busy") waits and retries with growing pauses, up to `retries` times, instead of failing.
//   - with a shared cloud queue (remote), each request also waits for its turn among everyone using the account;
//     when the cloud cannot be reached the job goes ahead with the local rules and remoteError says why.
// GPT and RunningHub each have their own bounded lane. Each image keeps its own request and abort signal.
// Job states: waiting (in line) · spacing (keeping the gap) · remote (waiting in the cloud queue) · busy (429, waiting to retry) · running.

const LAST_KEY = 'sttts.nai.lastRequest';
const cancelled = () => Object.assign(Error('已取消'), {cancelled: true});

function memoryStorage() {
  let value = 0;
  try {
    const s = globalThis.localStorage;
    if (s) return {get: () => Number(s.getItem(LAST_KEY)) || 0, set: v => { try { s.setItem(LAST_KEY, String(v)); } catch { value = v; } }};
  } catch { /* storage blocked */ }
  return {get: () => value, set: v => { value = v; }};
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener('abort', abort, {once: true});
  });
}

export class DrawQueue {
  /**
   * gap(): milliseconds between two requests. retries(): how often a 429 is retried.
   * onChange(list, {remoteError}): called whenever the line changes. backoff(attempt): pause before retry `attempt` (1-based).
   * remote(): the shared cloud queue to wait in, or null. concurrency(channel): local GPT or RunningHub slots, 1–4.
   */
  constructor({gap = () => 3000, retries = () => 4, onChange = () => {}, remote = () => null, concurrency = () => 2, locks = globalThis.navigator?.locks, storage = memoryStorage(), now = Date.now, wait = pause,
    backoff = attempt => Math.min(120000, 15000 * 2 ** (attempt - 1)) + Math.random() * 3000} = {}) {
    Object.assign(this, {gap, retries, onChange, remote, concurrency, locks, storage, now, wait, backoff});
    this.jobs = [];
    this.remoteError = '';
    this.active = {serial: 0, gpt: 0, runninghub: 0};
  }
  /** Adds a job; the same key joins the job already in line. task(signal) makes the request. */
  add({key = crypto.randomUUID(), label = '', channel = 'serial', task}) {
    const existing = this.jobs.find(j => j.key === key);
    if (existing) return existing.promise;
    if (channel !== 'gpt' && channel !== 'runninghub') channel = 'serial';
    const job = {key, label, task, channel, active: false, state: 'waiting', attempt: 0, until: 0, controller: new AbortController()};
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    this.jobs.push(job);
    this.changed();
    this.pump();
    return job.promise;
  }
  list() {
    const positions = {serial: 0, gpt: 0, runninghub: 0};
    return this.jobs.map(({key, label, channel, state, attempt, until, cloud}) =>
      ({key, label, channel, state, attempt, until, position: positions[channel]++, cloud: cloud || null}));
  }
  get(key) { return this.list().find(j => j.key === key) || null; }
  get pending() { return this.jobs.length > 0; }
  cancel(key) {
    const index = this.jobs.findIndex(j => j.key === key);
    if (index < 0) return false;
    const job = this.jobs[index];
    job.controller.abort();
    // Keep an active slot until its task, including any cloud cancellation, finishes.
    if (!job.active) { this.jobs.splice(index, 1); job.reject(cancelled()); this.changed(); }
    return true;
  }
  cancelAll() { for (const job of [...this.jobs].reverse()) this.cancel(job.key); }
  changed() { try { this.onChange(this.list(), {remoteError: this.remoteError}); } catch { /* a listener cannot stop the queue */ } }
  /** Takes a turn in the shared cloud queue; null when there is none or it cannot be reached. */
  async turn(job, signal) {
    const remote = this.remote();
    if (!remote) { this.remoteError = ''; return null; }
    try {
      const lease = await remote.acquire({label: job.label, signal, onWait: info => {
        job.state = 'remote'; job.cloud = {position: info.position, holder: info.holder || '', cooldown: info.cooldown || 0}; this.changed();
      }});
      this.remoteError = '';
      return lease;
    } catch (error) {
      if (signal.aborted || error.cancelled) throw cancelled();
      this.remoteError = error.message;
      return null;
    }
  }

  /** Also called when a limit changes. Lowering a limit lets active jobs finish. */
  pump() {
    for (const job of this.jobs) {
      if (job.active) continue;
      const configured = job.channel === 'serial' ? 1 : Number(this.concurrency(job.channel));
      const limit = Number.isFinite(configured) ? Math.max(1, Math.min(4, Math.trunc(configured))) : 2;
      if (this.active[job.channel] >= limit) continue;
      job.active = true;
      this.active[job.channel]++;
      void this.execute(job);
    }
  }
  async execute(job) {
    try {
      const run = () => this.run(job);
      const result = job.channel === 'serial' && this.locks?.request
        ? await this.locks.request('st-iphonie-novelai', {signal: job.controller.signal}, run)
        : await run();
      job.resolve(result);
    } catch (error) {
      job.reject(job.controller.signal.aborted ? cancelled() : error);
    } finally {
      this.jobs.splice(this.jobs.indexOf(job), 1);
      this.active[job.channel]--;
      this.changed();
      this.pump();
    }
  }
  async run(job) {
    const signal = job.controller.signal, serial = job.channel === 'serial';
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      if (serial) {
        const readyAt = this.storage.get() + this.gap();
        if (readyAt > this.now()) {
          job.state = 'spacing'; job.until = readyAt; this.changed();
          await this.wait(readyAt - this.now(), signal);
        }
      }
      const lease = serial ? await this.turn(job, signal) : null;
      job.state = 'running'; job.attempt = attempt; job.until = 0; job.cloud = null; this.changed();
      try {
        signal.throwIfAborted();
        const result = await job.task(signal);
        // The task may already have saved its picture if cancellation arrived during the write.
        if (serial) this.storage.set(this.now());
        lease?.release('done');
        return result;
      } catch (error) {
        if (serial) this.storage.set(this.now());
        // RunningHub may already have created a billable task. Never repeat its submission.
        const rateLimited = job.channel !== 'runninghub' && error?.status === 429;
        const delay = rateLimited ? this.backoff(attempt + 1) : 0;
        lease?.release(rateLimited ? 'busy' : 'done', delay);
        if (signal.aborted || !rateLimited || attempt >= this.retries()) throw error;
        job.state = 'busy'; job.attempt = attempt + 1; job.until = this.now() + delay; this.changed();
        await this.wait(delay, signal);
      }
    }
  }
}

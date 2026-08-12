// Drives src/provider.js in Node against canned SSE, exercising the parser,
// the Messages-API event mapping and the result shape. Stubs only what a
// plugin page would really have: window, Store, and pluginApi.net.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const ROOT = new URL('..', import.meta.url).pathname;

// --- fake host -------------------------------------------------------------
const config = new Map();
let lastRequest = null;
let scriptedChunks = [];
let scriptedEnd = { ok: true };

function makeWindow() {
  const win = {};
  win.window = win;
  win.Store = {
    getConfig: async (k, fallback = null) => (config.has(k) ? config.get(k) : fallback),
    setConfig: async (k, v) => { config.set(k, v == null ? null : String(v)); },
  };
  win.pluginApi = {
    net: {
      fetch: async (url, init) => { lastRequest = { url, init }; return { ok: true, status: 200, body: '{}' }; },
      stream: async (url, init, { onChunk, onEnd }) => {
        lastRequest = { url, init };
        // Deliver asynchronously, like the real IPC path does.
        setImmediate(() => {
          for (const c of scriptedChunks) onChunk(c);
          onEnd(scriptedEnd);
        });
        return () => {};
      },
    },
  };
  return win;
}

// provider.js is a classic browser script: it reads bare `window` / `Store` and
// assigns window.Provider. Running it with those as function parameters is the
// whole shim — no bundler, no module wrapper, same file the app downloads.
function loadProvider(customise) {
  const win = makeWindow();
  customise?.(win);
  const src = readFileSync(`${ROOT}src/provider.js`, 'utf8');
  new Function('window', 'Store', 'fetch', src)(win, win.Store, () => {
    throw new Error('the host net path should have been used');
  });
  return win.Provider;
}

// Turns a list of Messages-API events into the SSE bytes the server would
// send, split on an awkward boundary so the parser's partial-line handling is
// exercised.
function sse(events) {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const cut = Math.floor(text.length / 3);
  return [text.slice(0, cut), text.slice(cut, cut * 2), text.slice(cut * 2)];
}

function reset() {
  config.clear();
  lastRequest = null;
  scriptedChunks = [];
  scriptedEnd = { ok: true };
}

// --- tests -----------------------------------------------------------------
test('defaults: api mode, no key means not connected', async () => {
  reset();
  const P = loadProvider();
  const s = await P.readSettings();
  assert.equal(s.mode, 'api');
  assert.equal(s.model, P.DEFAULT_MODEL);
  assert.deepEqual(P.connectionState(s), { ok: false, reason: 'no_api_key' });
});

test('oauth mode accepts a pasted token alone — no client id, no sign-in', async () => {
  reset();
  const P = loadProvider();
  config.set('mode', 'oauth');
  let s = await P.readSettings();
  assert.deepEqual(P.connectionState(s), { ok: false, reason: 'oauth_signed_out' });

  // This is the Local CLI path: `claude setup-token` (or an existing
  // `claude login` session) produces a token, and pasting just that — with no
  // client id, authorize URL or token URL — is enough to be connected.
  config.set('oauth_access_token', 'tok_123');
  s = await P.readSettings();
  assert.equal(s.oauth.clientId, '');
  assert.deepEqual(P.connectionState(s), { ok: true });
});

test('a pasted token is sent as a Bearer + oauth-beta request, same as sign-in would send', async () => {
  reset();
  const P = loadProvider();
  config.set('mode', 'oauth');
  config.set('oauth_access_token', 'tok_from_cli');
  const s = await P.readSettings();
  scriptedChunks = sse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }]);
  await P.sendMessage({ settings: s, messages: [] });
  assert.equal(lastRequest.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(lastRequest.init.headers.authorization, 'Bearer tok_from_cli');
  assert.equal(lastRequest.init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal('x-api-key' in lastRequest.init.headers, false);
});

test('a pasted token clears any stale expiry so it is used as-is, never auto-refreshed without a refresh token', async () => {
  reset();
  const P = loadProvider();
  config.set('mode', 'oauth');
  config.set('oauth_access_token', 'tok_123');
  config.set('oauth_expires_at', ''); // what the Local CLI "Save token" button writes
  const s = await P.readSettings();
  assert.equal(s.oauth.expiresAt, 0);
  scriptedChunks = sse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }]);
  await P.sendMessage({ settings: s, messages: [] });
  // No refresh attempted: the only network call made was the message itself.
  assert.equal(lastRequest.url, 'https://api.anthropic.com/v1/messages');
});

test('api mode sends x-api-key, not a bearer token', async () => {
  reset();
  const P = loadProvider();
  config.set('api_key', 'sk-ant-test');
  const s = await P.readSettings();
  scriptedChunks = sse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }]);
  await P.sendMessage({ settings: s, messages: [] });
  assert.equal(lastRequest.init.headers['x-api-key'], 'sk-ant-test');
  assert.equal('authorization' in lastRequest.init.headers, false);
});

test('streams text, thinking and usage out of a Messages stream', async () => {
  reset();
  const P = loadProvider();
  config.set('api_key', 'sk-ant-test');
  config.set('effort', 'high');
  config.set('thinking', '1');
  config.set('system_prompt', 'be brief');
  const s = await P.readSettings();

  scriptedChunks = sse([
    { type: 'message_start', message: { usage: { input_tokens: 11 } } },
    { type: 'content_block_start', content_block: { type: 'thinking' } },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'weigh' } },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: ' options' } },
    { type: 'content_block_stop' },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: ', world' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
  ]);

  const seen = { text: '', thinking: '' };
  const out = await P.sendMessage({
    settings: s,
    messages: [{ role: 'user', content: 'hi' }],
    onDelta: (d) => { if (d.text) seen.text += d.text; if (d.thinking) seen.thinking += d.thinking; },
  });

  assert.equal(out.ok, true);
  assert.equal(out.text, 'Hello, world');
  assert.equal(out.thinking, 'weigh options');
  assert.equal(out.inTokens, 11);
  assert.equal(out.outTokens, 4);
  assert.equal(seen.text, 'Hello, world');
  assert.equal(seen.thinking, 'weigh options');

  // Request shape
  assert.equal(lastRequest.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(lastRequest.init.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(lastRequest.init.body);
  assert.equal(body.stream, true);
  assert.equal(body.system, 'be brief');
  assert.equal(body.max_tokens, P.DEFAULT_MAX_TOKENS);
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(body.output_config, { effort: 'high' });
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal('temperature' in body, false);
});

test('omits thinking and output_config when neither is set', async () => {
  reset();
  const P = loadProvider();
  config.set('api_key', 'sk-ant-test');
  const s = await P.readSettings();
  scriptedChunks = sse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }]);
  await P.sendMessage({ settings: s, messages: [] });
  const body = JSON.parse(lastRequest.init.body);
  assert.equal('thinking' in body, false);
  assert.equal('output_config' in body, false);
  assert.equal('system' in body, false);
});

test('a refusal is reported as a failure, not as an answer', async () => {
  reset();
  const P = loadProvider();
  config.set('api_key', 'sk-ant-test');
  const s = await P.readSettings();
  scriptedChunks = sse([
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'never mind' } },
    { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { category: 'policy' } }, usage: {} },
  ]);
  const out = await P.sendMessage({ settings: s, messages: [] });
  assert.equal(out.ok, false);
  assert.equal(out.refusal, true);
  assert.match(out.error, /declined/);
  assert.match(out.error, /policy/);
});

test('a bare stream error event surfaces its message', async () => {
  reset();
  const P = loadProvider();
  config.set('api_key', 'sk-ant-test');
  const s = await P.readSettings();
  scriptedChunks = sse([{ type: 'error', error: { message: 'overloaded' } }]);
  const out = await P.sendMessage({ settings: s, messages: [] });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'overloaded');
});

test('an HTTP error from the host stream is decoded into the API message', async () => {
  reset();
  const P = loadProvider();
  config.set('api_key', 'sk-ant-bad');
  const s = await P.readSettings();
  scriptedChunks = [];
  scriptedEnd = { ok: false, code: 'http', status: 401, error: JSON.stringify({ error: { message: 'invalid x-api-key' } }) };
  const out = await P.sendMessage({ settings: s, messages: [] });
  assert.equal(out.ok, false);
  assert.match(out.error, /401/);
  assert.match(out.error, /invalid x-api-key/);
});

test('abort is reported as Stopped, not as a crash', async () => {
  reset();
  const P = loadProvider();
  config.set('api_key', 'sk-ant-test');
  const s = await P.readSettings();
  scriptedEnd = { ok: false, code: 'aborted' };
  const out = await P.sendMessage({ settings: s, messages: [] });
  assert.equal(out.error, 'Stopped.');
});

test('sendMessage never makes a request when the connection gate is closed', async () => {
  reset();
  const P = loadProvider();
  config.set('mode', 'oauth'); // no token pasted, never signed in
  const s = await P.readSettings();
  const out = await P.sendMessage({ settings: s, messages: [] });
  assert.equal(out.ok, false);
  assert.match(out.error, /Signed out/);
  assert.equal(lastRequest, null, 'no request was attempted');
});

'use strict';
// The connection layer: one interface, two ways of authenticating.
//
// This talks to the Messages API over raw HTTP rather than through the
// official SDK, because a plugin page has no bundler and no node_modules —
// there is nowhere for a dependency to come from. Everything below follows the
// documented wire format for POST /v1/messages.
//
//   mode 'api'    x-api-key: <key>
//   mode 'oauth'  Authorization: Bearer <token> + anthropic-beta: oauth-2025-04-20
//
// BE HONEST ABOUT THE SECOND MODE. Anthropic publishes no API for driving a
// Claude Pro/Max subscription from a third-party app, and this does not invent
// one. What it implements is standard OAuth 2.0 + PKCE against endpoints and a
// client_id the user supplies — useful when you have an OAuth client you are
// entitled to use, and inert otherwise. The API-key mode works out of the box.
//
// A pasted token gets into oauth mode without any of that: run `claude
// setup-token` (or reuse an existing `claude login` session) with the Claude
// Code CLI on this machine, and paste the token it prints into Settings'
// Local CLI section. It is the exact same accessToken field the sign-in flow
// fills in, sent the exact same way — this file never shells out to the CLI
// itself (a plugin page cannot; see docs/PLUGINS.md in App-DraconDex), it only
// accepts whatever token that CLI already produced.

const ANTHROPIC_BASE = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
// Sent only in OAuth mode: an OAuth access token goes on Authorization: Bearer
// and additionally requires this beta flag on /v1/messages.
const OAUTH_BETA = 'oauth-2025-04-20';

// Refresh this far ahead of expiry so a long streaming response doesn't have
// the token die out from under it mid-flight.
const REFRESH_SKEW_MS = 120000;

const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
];
const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_MAX_TOKENS = 16000;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// ---------------------------------------------------------------------------
// Transport. The host's pluginApi.net.* runs the request in the main process,
// which is the only way to read a cross-origin response — the manifest's
// permissions.net allowlist is what makes that legal. Falling back to the
// page's own fetch() keeps this plugin working as a plain window on a host
// that predates the panel API, where the request is subject to CORS and needs
// the direct-browser-access opt-in instead.
// ---------------------------------------------------------------------------
const hostNet = () => (window.pluginApi || window.extApi || {}).net || null;
const hasHostNet = () => !!hostNet();

function browserHeaders(headers) {
  // Only needed on the fallback path: without the host proxying the request,
  // the browser applies CORS and Anthropic requires this opt-in.
  return { ...headers, 'anthropic-dangerous-direct-browser-access': 'true' };
}

async function httpFetch(url, init) {
  const net = hostNet();
  if (net) return net.fetch(url, init);
  let res;
  try {
    res = await fetch(url, { ...init, headers: browserHeaders(init.headers) });
  } catch (e) {
    return { ok: false, code: 'network', error: String(e?.message || e) };
  }
  return { ok: true, status: res.status, statusText: res.statusText, body: await res.text() };
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
async function readSettings() {
  const [mode, apiKey, model, maxTokens, effort, thinking, systemPrompt,
    clientId, authorizeUrl, tokenUrl, scope, accessToken, refreshToken, expiresAt] = await Promise.all([
    Store.getConfig('mode', 'api'),
    Store.getConfig('api_key', ''),
    Store.getConfig('model', DEFAULT_MODEL),
    Store.getConfig('max_tokens', String(DEFAULT_MAX_TOKENS)),
    Store.getConfig('effort', ''),
    Store.getConfig('thinking', '0'),
    Store.getConfig('system_prompt', ''),
    Store.getConfig('oauth_client_id', ''),
    Store.getConfig('oauth_authorize_url', ''),
    Store.getConfig('oauth_token_url', ''),
    Store.getConfig('oauth_scope', ''),
    Store.getConfig('oauth_access_token', ''),
    Store.getConfig('oauth_refresh_token', ''),
    Store.getConfig('oauth_expires_at', ''),
  ]);
  return {
    mode: mode === 'oauth' ? 'oauth' : 'api',
    apiKey: apiKey || '',
    model: MODELS.some((m) => m.id === model) ? model : DEFAULT_MODEL,
    maxTokens: Number(maxTokens) > 0 ? Number(maxTokens) : DEFAULT_MAX_TOKENS,
    effort: EFFORTS.includes(effort) ? effort : '',
    thinking: thinking === '1',
    systemPrompt: systemPrompt || '',
    oauth: {
      clientId: clientId || '', authorizeUrl: authorizeUrl || '', tokenUrl: tokenUrl || '',
      scope: scope || '', accessToken: accessToken || '', refreshToken: refreshToken || '',
      expiresAt: Number(expiresAt) || 0,
    },
  };
}

function connectionState(s) {
  if (s.mode === 'api') return s.apiKey ? { ok: true } : { ok: false, reason: 'no_api_key' };
  // Either half of OAuth mode is enough to have a usable token: the PKCE
  // sign-in below, or a token pasted in from the local CLI (`claude
  // setup-token` / an existing `claude login` session) — see Local CLI in
  // Settings. clientId/authorizeUrl/tokenUrl are only needed for sign-in.
  return s.oauth.accessToken ? { ok: true } : { ok: false, reason: 'oauth_signed_out' };
}

// --- OAuth 2.0 + PKCE ------------------------------------------------------
// The host owns the redirect capture: a plugin page cannot listen on a port,
// so pluginApi.oauth.authorize opens the system browser and hands back the
// code plus the PKCE verifier it generated. The token exchange stays here, so
// a client secret (if the provider needs one) never leaves this page.
async function oauthSignIn() {
  const s = await readSettings();
  const o = s.oauth;
  if (!o.clientId || !o.authorizeUrl || !o.tokenUrl) throw new Error('Fill in client ID, authorize URL and token URL first.');
  const oauth = (window.pluginApi || window.extApi || {}).oauth;
  if (!oauth) throw new Error('This DraconDex version cannot capture the OAuth redirect. Update the app, or use API key mode.');

  const { code, redirectUri, verifier } = await oauth.authorize({
    authorizeUrl: o.authorizeUrl, clientId: o.clientId, scope: o.scope || undefined,
  });

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code, redirect_uri: redirectUri, client_id: o.clientId, code_verifier: verifier,
  });
  const res = await httpFetch(o.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return storeToken(res, 'sign-in');
}

async function oauthRefresh(o) {
  if (!o.refreshToken) throw new Error('Signed out — sign in again.');
  const body = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: o.clientId,
  });
  const res = await httpFetch(o.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return storeToken(res, 'refresh');
}

async function storeToken(res, what) {
  if (!res.ok) throw new Error(`Token ${what} failed: ${res.error || 'network error'}`);
  if (res.status < 200 || res.status >= 300) throw new Error(`Token ${what} failed (HTTP ${res.status}): ${res.body || ''}`);
  let json;
  try { json = JSON.parse(res.body); } catch (_) { throw new Error(`Token ${what} returned a non-JSON body.`); }
  if (!json.access_token) throw new Error(`Token ${what} returned no access_token.`);
  const expiresAt = json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : 0;
  await Store.setConfig('oauth_access_token', json.access_token);
  // Providers that rotate refresh tokens send a new one on every exchange;
  // ones that don't omit it, and the existing token must be kept.
  if (json.refresh_token) await Store.setConfig('oauth_refresh_token', json.refresh_token);
  await Store.setConfig('oauth_expires_at', String(expiresAt));
  return { ok: true };
}

async function oauthSignOut() {
  await Store.setConfig('oauth_access_token', '');
  await Store.setConfig('oauth_refresh_token', '');
  await Store.setConfig('oauth_expires_at', '');
}

// Returns the headers for one request, refreshing an about-to-expire token
// first so the refresh never lands mid-stream.
async function authHeaders(s) {
  if (s.mode === 'api') return { 'x-api-key': s.apiKey };
  let o = s.oauth;
  if (o.expiresAt && Date.now() > o.expiresAt - REFRESH_SKEW_MS && o.refreshToken) {
    await oauthRefresh(o);
    o = (await readSettings()).oauth;
  }
  return { authorization: `Bearer ${o.accessToken}`, 'anthropic-beta': OAUTH_BETA };
}

// ---------------------------------------------------------------------------
// Messages API
// ---------------------------------------------------------------------------
function buildRequestBody(s, messages) {
  const body = {
    model: s.model,
    max_tokens: s.maxTokens,
    messages,
    stream: true,
  };
  if (s.systemPrompt) body.system = s.systemPrompt;
  // Adaptive is the only thinking mode current models take, and the summary is
  // opt-in — the default returns thinking blocks with empty text, which would
  // look like a long stall with nothing to show.
  if (s.thinking) body.thinking = { type: 'adaptive', display: 'summarized' };
  if (s.effort) body.output_config = { effort: s.effort };
  // Deliberately absent: temperature/top_p/top_k (rejected with a 400 on
  // current models) and any trailing assistant turn (prefill is unsupported).
  return body;
}

// One SSE `data:` payload. Returns what the caller should do with it.
function applyStreamEvent(evt, acc) {
  if (evt.type === 'content_block_start' && evt.content_block?.type === 'thinking') acc.inThinking = true;
  if (evt.type === 'content_block_stop' && acc.inThinking) acc.inThinking = false;
  if (evt.type === 'content_block_delta') {
    if (evt.delta?.type === 'text_delta') return { text: evt.delta.text };
    if (evt.delta?.type === 'thinking_delta') return { thinking: evt.delta.thinking };
  }
  if (evt.type === 'message_delta') {
    if (evt.delta?.stop_reason) acc.stopReason = evt.delta.stop_reason;
    if (evt.delta?.stop_details) acc.stopDetails = evt.delta.stop_details;
    if (evt.usage?.output_tokens != null) acc.outTokens = evt.usage.output_tokens;
  }
  if (evt.type === 'message_start' && evt.message?.usage?.input_tokens != null) acc.inTokens = evt.message.usage.input_tokens;
  if (evt.type === 'error') acc.error = evt.error?.message || 'stream error';
  return null;
}

// Feeds raw SSE bytes in and calls back with deltas. Chunks arrive on
// arbitrary boundaries, so a partial line is held over to the next chunk.
function makeSseParser(onEvent) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();          // last element is the incomplete tail
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { onEvent(JSON.parse(payload)); } catch (_) { /* a non-JSON keepalive */ }
    }
  };
}

// Streams one assistant turn. `onDelta` is called with { text } / { thinking }
// as they arrive; resolves with the finished turn. Never throws for an API
// error — those come back on the result so the caller can persist them next to
// the message they belong to.
async function sendMessage({ settings, messages, onDelta, onAbortReady }) {
  const s = settings;
  const gate = connectionState(s);
  if (!gate.ok) return { ok: false, error: describeGate(gate.reason) };

  let headers;
  try {
    headers = { ...(await authHeaders(s)), 'content-type': 'application/json', 'anthropic-version': API_VERSION };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }

  const url = `${ANTHROPIC_BASE}/v1/messages`;
  const init = { method: 'POST', headers, body: JSON.stringify(buildRequestBody(s, messages)) };
  const acc = { inThinking: false, stopReason: null, stopDetails: null, inTokens: null, outTokens: null, error: null };
  let text = '';
  let thinking = '';

  const feed = makeSseParser((evt) => {
    const delta = applyStreamEvent(evt, acc);
    if (!delta) return;
    if (delta.text != null) { text += delta.text; onDelta?.({ text: delta.text, full: text }); }
    if (delta.thinking != null) { thinking += delta.thinking; onDelta?.({ thinking: delta.thinking }); }
  });

  const net = hostNet();
  const end = net
    ? await streamViaHost(net, url, init, feed, onAbortReady)
    : await streamViaFetch(url, init, feed, onAbortReady);

  if (!end.ok) return { ok: false, error: end.error, text, thinking };
  if (acc.error) return { ok: false, error: acc.error, text, thinking };
  // A refusal is a successful HTTP 200 with an empty or partial body — check
  // it before treating the accumulated text as a real answer.
  if (acc.stopReason === 'refusal') {
    const category = acc.stopDetails?.category ? ` (${acc.stopDetails.category})` : '';
    return { ok: false, refusal: true, error: `Claude declined this request${category}.`, text, thinking };
  }
  return { ok: true, text, thinking, stopReason: acc.stopReason, inTokens: acc.inTokens, outTokens: acc.outTokens };
}

function streamViaHost(net, url, init, feed, onAbortReady) {
  return new Promise((resolve) => {
    net.stream(url, init, {
      onChunk: feed,
      onEnd: (res) => resolve(res.ok ? { ok: true } : { ok: false, ...toEndError(res) }),
    })
      .then((abort) => onAbortReady?.(abort))
      .catch((e) => resolve({ ok: false, error: String(e?.message || e) }));
  });
}

function toEndError(res) {
  if (res.code === 'aborted') return { error: 'Stopped.' };
  if (res.code === 'http') return { error: describeHttp(res.status, res.error) };
  return { error: res.error || 'Request failed.' };
}

// Fallback for a host without pluginApi.net — subject to CORS.
async function streamViaFetch(url, init, feed, onAbortReady) {
  const ctrl = new AbortController();
  onAbortReady?.(() => ctrl.abort());
  let res;
  try {
    res = await fetch(url, { ...init, headers: browserHeaders(init.headers), signal: ctrl.signal });
  } catch (e) {
    return { ok: false, error: ctrl.signal.aborted ? 'Stopped.' : String(e?.message || e) };
  }
  if (!res.ok) return { ok: false, error: describeHttp(res.status, await res.text()) };
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, error: 'No response body.' };
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    return { ok: false, error: ctrl.signal.aborted ? 'Stopped.' : String(e?.message || e) };
  }
  return { ok: true };
}

// The API's own message is the useful part; the status code alone tells the
// user nothing they can act on.
function describeHttp(status, body) {
  let detail = '';
  try { detail = JSON.parse(body)?.error?.message || ''; } catch (_) { detail = String(body || '').slice(0, 300); }
  if (status === 401) return `Not authorized (401). ${detail || 'Check your API key or sign in again.'}`;
  if (status === 429) return `Rate limited (429). ${detail || 'Wait a moment and retry.'}`;
  if (status >= 500) return `Anthropic API error (${status}). ${detail || 'Retry shortly.'}`;
  return `HTTP ${status}. ${detail}`;
}

function describeGate(reason) {
  if (reason === 'no_api_key') return 'No API key set — open Settings and paste one.';
  if (reason === 'oauth_signed_out') return 'Signed out — sign in from Settings, or paste a token from the local CLI.';
  return 'Not connected.';
}

window.Provider = {
  MODELS, DEFAULT_MODEL, DEFAULT_MAX_TOKENS, EFFORTS,
  readSettings, connectionState, describeGate,
  oauthSignIn, oauthRefresh, oauthSignOut,
  sendMessage, hasHostNet,
};

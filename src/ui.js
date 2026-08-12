'use strict';
// Rendering. The whole page is one of three views (chat / sessions / settings)
// drawn into #root, plus renderStream() which patches only the streaming
// bubble — redrawing everything on every token would reset the scroll position
// and lose the composer's focus.
//
// Nothing stored is ever interpolated into an HTML string. Message bodies come
// from the model and from the user, so they are built with textContent and the
// tiny inline-markdown pass below works on DOM nodes, not markup.

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const root = () => document.getElementById('root');

// --- message body ----------------------------------------------------------
// A deliberately small subset: fenced code blocks and `inline code`. Both are
// created as elements with textContent, so a reply containing markup renders
// as the characters the model actually wrote.
function renderBody(container, text) {
  const parts = String(text).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // Odd chunks are inside a fence. Drop an opening language tag line.
      const body = part.replace(/^[a-zA-Z0-9_+-]*\n/, '');
      const pre = el('pre', 'code-block');
      pre.appendChild(el('code', null, body));
      container.appendChild(pre);
      return;
    }
    for (const line of part.split('\n')) {
      const p = el('p', 'md-line');
      renderInline(p, line);
      container.appendChild(p);
    }
  });
}

function renderInline(parent, line) {
  const segments = String(line).split(/(`[^`]+`)/);
  for (const seg of segments) {
    if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 2) {
      parent.appendChild(el('code', 'inline-code', seg.slice(1, -1)));
    } else if (seg) {
      parent.appendChild(document.createTextNode(seg));
    }
  }
}

// --- chat view -------------------------------------------------------------
function buildChat() {
  const wrap = el('div', 'chat');
  const stream = el('div', 'stream');
  stream.id = 'stream';

  if (!Chat.messages.length && !Chat.sending) {
    const empty = el('div', 'empty');
    empty.appendChild(el('h3', null, 'Claude'));
    const ctx = Chat.moduleContext?.moduleName;
    empty.appendChild(el('p', null, ctx ? `Ask about ${ctx}, or anything else.` : 'Ask anything.'));
    stream.appendChild(empty);
  }

  for (const m of Chat.messages) stream.appendChild(buildBubble(m));

  if (Chat.sending) {
    const live = buildBubble({ role: 'assistant', content: Chat.streamText }, true);
    live.id = 'live-bubble';
    stream.appendChild(live);
  }
  wrap.appendChild(stream);

  if (Chat.error) {
    const bar = el('div', 'errbar');
    bar.appendChild(el('span', null, Chat.error));
    const retry = el('button', 'btn btn-s', 'Retry');
    retry.onclick = () => ChatActions.retryLast();
    bar.appendChild(retry);
    wrap.appendChild(bar);
  }

  wrap.appendChild(buildComposer());
  return wrap;
}

function buildBubble(m, live = false) {
  const row = el('div', `row ${m.role === 'assistant' ? 'assistant' : 'user'}`);
  const bubble = el('div', 'bubble');

  if (live && Chat.streamThinking) {
    const think = el('details', 'thinking');
    think.appendChild(el('summary', null, 'Thinking…'));
    think.appendChild(el('div', 'thinking-body', Chat.streamThinking));
    bubble.appendChild(think);
  }

  const body = el('div', 'body');
  if (m.content) renderBody(body, m.content);
  else if (live) body.appendChild(el('p', 'md-line dim', '…'));
  bubble.appendChild(body);

  if (m.error) bubble.appendChild(el('div', 'bubble-err', m.error));
  if (m.out_tokens != null) bubble.appendChild(el('div', 'meta', `${m.in_tokens ?? '?'} in · ${m.out_tokens} out`));

  row.appendChild(bubble);
  return row;
}

function buildComposer() {
  const form = el('form', 'composer');
  const input = el('textarea', 'input');
  input.id = 'composer-input';
  input.rows = 1;
  input.placeholder = Chat.sending ? 'Waiting for Claude…' : 'Message Claude…';
  input.disabled = Chat.sending;
  // Enter sends, Shift+Enter is a newline — the convention every chat UI uses,
  // and the reason this is a textarea rather than an input.
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  };
  input.oninput = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  };
  form.appendChild(input);

  const send = el('button', 'btn btn-p', Chat.sending ? 'Stop' : 'Send');
  send.type = Chat.sending ? 'button' : 'submit';
  if (Chat.sending) send.onclick = () => ChatActions.stop();
  form.appendChild(send);

  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value;
    input.value = '';
    input.style.height = 'auto';
    ChatActions.send(text);
  };
  return form;
}

// --- sessions view ---------------------------------------------------------
function buildSessions() {
  const wrap = el('div', 'pane');
  wrap.appendChild(el('div', 'pane-label', 'Conversations'));
  if (!Chat.sessions.length) wrap.appendChild(el('p', 'dim', 'No conversations yet.'));

  for (const s of Chat.sessions) {
    const row = el('div', `li ${s.id === Chat.sessionId ? 'sel' : ''}`);
    const name = el('span', 'li-name', s.title || 'Untitled');
    name.onclick = () => ChatActions.selectSession(s.id);
    row.appendChild(name);
    if (s.module_key) row.appendChild(el('span', 'tag', 'module'));
    const del = el('button', 'btn btn-g btn-i', '×');
    del.title = 'Delete';
    del.onclick = () => ChatActions.removeSession(s.id);
    row.appendChild(del);
    wrap.appendChild(row);
  }
  return wrap;
}

// --- settings view ---------------------------------------------------------
function field(label, node, hint) {
  const fg = el('div', 'fg');
  fg.appendChild(el('label', null, label));
  fg.appendChild(node);
  if (hint) fg.appendChild(el('div', 'hint', hint));
  return fg;
}

function input(id, value, { type = 'text', placeholder = '' } = {}) {
  const node = el('input');
  node.id = id;
  node.type = type;
  node.value = value ?? '';
  node.placeholder = placeholder;
  return node;
}

// Reports the outcome of a settings action in the notice slot without a full
// re-boot — used by the buttons that talk to the network.
async function withNotice(fn) {
  try {
    await fn();
  } catch (e) {
    Chat.notice = String(e?.message || e);
  }
  Chat.settings = await Provider.readSettings();
  render();
}

function buildApiSection(s) {
  const wrap = el('div');
  const key = input('cfg-api-key', s.apiKey, { type: 'password', placeholder: 'sk-ant-…' });
  wrap.appendChild(field('Anthropic API key', key,
    'Stored in this plugin\'s own table, in plain text — same as the app stores its other credentials.'));
  const save = el('button', 'btn btn-p', 'Save key');
  save.onclick = () => ChatActions.saveSettings({ api_key: key.value.trim() });
  wrap.appendChild(save);
  return wrap;
}

function buildOauthSection(s) {
  const wrap = el('div');
  const signedIn = !!s.oauth.accessToken;

  wrap.appendChild(el('div', 'notice',
    'Anthropic publishes no API for driving a Claude Pro/Max subscription from a third-party app, and this '
    + 'plugin does not invent one. "Sign in" below is a standard OAuth 2.0 + PKCE client that only does '
    + 'anything useful if you already have an OAuth client you are entitled to use. Most people want '
    + '"Local CLI" instead.'));

  // --- sign in ---
  wrap.appendChild(el('div', 'pane-label', 'Sign in'));
  wrap.appendChild(el('div', 'hint',
    'Needs an OAuth client\'s details — client ID, authorize URL, token URL. If you do not have one of '
    + 'those, this will not work; use Local CLI below or API key mode instead.'));

  const clientId = input('cfg-client-id', s.oauth.clientId);
  const authorizeUrl = input('cfg-authorize-url', s.oauth.authorizeUrl, { placeholder: 'https://…/oauth/authorize' });
  const tokenUrl = input('cfg-token-url', s.oauth.tokenUrl, { placeholder: 'https://…/oauth/token' });
  const scope = input('cfg-scope', s.oauth.scope, { placeholder: 'optional' });
  wrap.appendChild(field('Client ID', clientId));
  wrap.appendChild(field('Authorize URL', authorizeUrl));
  wrap.appendChild(field('Token URL', tokenUrl));
  wrap.appendChild(field('Scope', scope));

  const row = el('div', 'row-actions');
  const save = el('button', 'btn btn-s', 'Save');
  save.onclick = () => ChatActions.saveSettings({
    oauth_client_id: clientId.value.trim(),
    oauth_authorize_url: authorizeUrl.value.trim(),
    oauth_token_url: tokenUrl.value.trim(),
    oauth_scope: scope.value.trim(),
  });
  row.appendChild(save);

  const auth = el('button', 'btn btn-p', signedIn ? 'Sign out' : 'Sign in');
  auth.onclick = () => withNotice(async () => {
    if (signedIn) { await Provider.oauthSignOut(); Chat.notice = 'Signed out.'; }
    else { await Provider.oauthSignIn(); Chat.notice = 'Signed in.'; }
  });
  row.appendChild(auth);
  wrap.appendChild(row);
  wrap.appendChild(el('div', 'hint', signedIn
    ? `Signed in.${s.oauth.expiresAt ? ` Token expires ${new Date(s.oauth.expiresAt).toLocaleString()}.` : ''}`
    : 'Not signed in.'));

  // --- Local CLI ---
  wrap.appendChild(el('div', 'pane-label', 'Local CLI'));
  wrap.appendChild(el('div', 'hint',
    'Run `claude setup-token` with the Claude Code CLI on this machine — it prints a token tied to your '
    + 'Claude subscription, no OAuth client of your own required. (Already signed in there? That session\'s '
    + 'token works the same way.) Paste it below; it is stored and sent exactly like a token obtained by '
    + 'signing in above. This plugin never runs the CLI itself — a plugin page cannot — it only accepts '
    + 'whatever token the CLI already produced.'));

  const access = input('cfg-access-token', s.oauth.accessToken, { type: 'password', placeholder: 'access token' });
  const refresh = input('cfg-refresh-token', s.oauth.refreshToken, { type: 'password', placeholder: 'refresh token (optional)' });
  wrap.appendChild(field('Access token', access));
  wrap.appendChild(field('Refresh token', refresh,
    'Without one, the token cannot be renewed when it expires — rerun `claude setup-token` for a new one.'));

  const saveToken = el('button', 'btn btn-p', 'Save token');
  saveToken.onclick = () => ChatActions.saveSettings({
    oauth_access_token: access.value.trim(),
    oauth_refresh_token: refresh.value.trim(),
    // A pasted token carries no expiry, so clear any stale one rather than
    // letting it trigger a refresh the moment the next request goes out.
    oauth_expires_at: '',
  });
  wrap.appendChild(saveToken);
  return wrap;
}

function buildSettings() {
  const s = Chat.settings;
  const wrap = el('div', 'pane');

  if (Chat.notice) wrap.appendChild(el('div', 'notice', Chat.notice));

  wrap.appendChild(el('div', 'pane-label', 'Connection'));

  const modeRow = el('div', 'seg');
  for (const [value, label] of [['api', 'API key'], ['oauth', 'Subscription (OAuth)']]) {
    const b = el('button', `btn btn-s ${s.mode === value ? 'active' : ''}`, label);
    b.onclick = () => ChatActions.saveSettings({ mode: value });
    modeRow.appendChild(b);
  }
  wrap.appendChild(field('Mode', modeRow));

  wrap.appendChild(s.mode === 'api' ? buildApiSection(s) : buildOauthSection(s));

  wrap.appendChild(el('div', 'pane-label', 'Model'));

  const model = el('select');
  model.id = 'cfg-model';
  for (const m of Provider.MODELS) {
    const opt = el('option', null, m.label);
    opt.value = m.id;
    if (m.id === s.model) opt.selected = true;
    model.appendChild(opt);
  }
  model.onchange = () => ChatActions.saveSettings({ model: model.value });
  wrap.appendChild(field('Model', model));

  const effort = el('select');
  effort.id = 'cfg-effort';
  for (const value of ['', ...Provider.EFFORTS]) {
    const opt = el('option', null, value || 'default');
    opt.value = value;
    if (value === s.effort) opt.selected = true;
    effort.appendChild(opt);
  }
  effort.onchange = () => ChatActions.saveSettings({ effort: effort.value });
  wrap.appendChild(field('Effort', effort, 'Higher effort thinks longer and costs more.'));

  const thinking = el('input');
  thinking.type = 'checkbox';
  thinking.id = 'cfg-thinking';
  thinking.checked = s.thinking;
  thinking.onchange = () => ChatActions.saveSettings({ thinking: thinking.checked ? '1' : '0' });
  const thinkWrap = el('div', 'check');
  thinkWrap.appendChild(thinking);
  thinkWrap.appendChild(el('span', null, 'Show a summary of Claude\'s reasoning'));
  wrap.appendChild(field('Thinking', thinkWrap));

  const maxTokens = input('cfg-max-tokens', String(s.maxTokens), { type: 'number' });
  maxTokens.onchange = () => ChatActions.saveSettings({ max_tokens: maxTokens.value });
  wrap.appendChild(field('Max tokens', maxTokens));

  const system = el('textarea');
  system.id = 'cfg-system';
  system.rows = 3;
  system.value = s.systemPrompt;
  system.placeholder = 'Optional system prompt';
  system.onchange = () => ChatActions.saveSettings({ system_prompt: system.value });
  wrap.appendChild(field('System prompt', system));

  if (!Provider.hasHostNet()) {
    wrap.appendChild(el('div', 'notice',
      'This DraconDex version has no plugin network API, so requests go straight from this page '
      + 'and are subject to the browser\'s cross-origin rules. Update the app if requests fail.'));
  }
  return wrap;
}

// --- shell -----------------------------------------------------------------
function buildTabs() {
  const bar = el('div', 'tabs');
  for (const [view, label] of [['chat', 'Chat'], ['sessions', 'History'], ['settings', 'Settings']]) {
    const b = el('button', `tab ${Chat.view === view ? 'active' : ''}`, label);
    b.onclick = () => { Chat.view = view; render(); };
    bar.appendChild(b);
  }
  const add = el('button', 'btn btn-g btn-i', '+');
  add.title = 'New conversation';
  add.onclick = () => ChatActions.newSession();
  bar.appendChild(add);
  return bar;
}

function render() {
  const host = root();
  if (!host) return;
  host.replaceChildren();
  host.appendChild(buildTabs());
  if (Chat.view === 'settings') host.appendChild(buildSettings());
  else if (Chat.view === 'sessions') host.appendChild(buildSessions());
  else host.appendChild(buildChat());
  scrollToEnd();
  if (Chat.view === 'chat' && !Chat.sending) document.getElementById('composer-input')?.focus();
}

// Token-by-token patch of just the live bubble. A full render() here would
// reset the scroll position and blur the composer on every delta.
function renderStream() {
  const bubble = document.getElementById('live-bubble');
  if (!bubble) return;
  const body = bubble.querySelector('.body');
  if (body) { body.replaceChildren(); renderBody(body, Chat.streamText || '…'); }
  if (Chat.streamThinking) {
    let think = bubble.querySelector('.thinking-body');
    if (!think) {
      const details = el('details', 'thinking');
      details.appendChild(el('summary', null, 'Thinking…'));
      think = el('div', 'thinking-body');
      details.appendChild(think);
      bubble.prepend(details);
    }
    think.textContent = Chat.streamThinking;
  }
  scrollToEnd();
}

// Only auto-scroll when the user is already at the bottom — yanking the view
// down while they are reading back through the transcript is worse than
// letting new content arrive off-screen.
function scrollToEnd() {
  const stream = document.getElementById('stream');
  if (!stream) return;
  const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
  if (atBottom) stream.scrollTop = stream.scrollHeight;
}

window.UI = { render, renderStream };

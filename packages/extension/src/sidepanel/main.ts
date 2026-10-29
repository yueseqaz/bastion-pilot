/**
 * Side panel: thin chat client. All state lives in the daemon; this file only
 * renders the transcript and forwards user actions over the 'panel' port.
 */

interface StateMessage {
  kind: 'state';
  connected: boolean;
  agentConnected: boolean;
  agentNames: string[];
  agents: Array<{
    agentId: string;
    name: string;
    label: string;
    conversationId?: string;
    connectedAt: number;
    lastSeenAt: number;
  }>;
  sessions: Array<{ sessionId: string; title: string; state: string; profileId: string }>;
  approvals: Array<{ requestId: string; tool: string; summary: string; sessionId?: string }>;
}

interface ChatEventMessage {
  kind: 'chat-event';
  message: {
    type: string;
    payload: Record<string, unknown>;
  };
}

type PortMessage = StateMessage | ChatEventMessage;

const port = chrome.runtime.connect({ name: 'panel' });

const transcript = document.getElementById('transcript')!;
const input = document.getElementById('input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const abortBtn = document.getElementById('abort-btn') as HTMLButtonElement;
const statusDot = document.getElementById('status-dot')!;
const sessionSelect = document.getElementById('session-select') as HTMLSelectElement;
const modeSelect = document.getElementById('chat-mode') as HTMLSelectElement;
const modeStatus = document.getElementById('mode-status')!;
const agentSelect = document.getElementById('agent-select') as HTMLSelectElement;
const newChatBtn = document.getElementById('new-chat') as HTMLButtonElement;
const approvalsEl = document.getElementById('approvals')!;
const emptyHint = document.querySelector('.empty-hint');
const activityEl = document.getElementById('activity')!;
const activityText = document.getElementById('activity-text')!;
const queueCount = document.getElementById('queue-count')!;

let chatId: string | null = null;
const outbox: string[] = [];
let chatCreateRequested = false;
let busy = false;
let stopping = false;
let chatMode: 'provider' | 'agent' = 'provider';
let agentConnected = false;
let selectedAgentId = '';
let selectedSessionId = '';
let sharedReplayRendered = false;
let pendingAgentRequestId: string | null = null;
let agentRequestTimer: number | null = null;
let currentAssistant: HTMLDivElement | null = null;
const toolCards = new Map<string, HTMLElement>();

function postToBackground(message: unknown) {
  try {
    port.postMessage(message);
  } catch {
    // The panel can outlive an MV3 service-worker restart; reopening it will
    // create a fresh port and the current daemon state is restored.
  }
}

function scrollBottom() {
  transcript.scrollTop = transcript.scrollHeight;
}

function setBusy(value: boolean) {
  busy = value;
  abortBtn.classList.toggle('hidden', !value);
  activityEl.classList.toggle('active', value);
  if (!value && outbox.length === 0) setActivity('就绪 · 等待你的指令', false);
  renderQueueCount();
}

function setActivity(text: string, active = busy) {
  activityText.textContent = text;
  activityEl.classList.toggle('active', active);
}

function renderQueueCount() {
  queueCount.classList.toggle('hidden', outbox.length === 0);
  queueCount.textContent = outbox.length > 0 ? `队列 ${outbox.length}` : '';
}

function removeEmptyHint() {
  emptyHint?.remove();
}

function addUserMessage(text: string) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.textContent = text;
  transcript.appendChild(div);
  scrollBottom();
}

function ensureAssistantBubble(): HTMLDivElement {
  if (!currentAssistant) {
    currentAssistant = document.createElement('div');
    currentAssistant.className = 'msg assistant';
    transcript.appendChild(currentAssistant);
  }
  return currentAssistant;
}

function finalizeAssistant() {
  if (currentAssistant && !currentAssistant.textContent?.trim()) currentAssistant.remove();
  currentAssistant = null;
  scrollBottom();
}

function addErrorMessage(text: string) {
  const div = document.createElement('div');
  div.className = 'msg error';
  div.textContent = text;
  transcript.appendChild(div);
  scrollBottom();
}

function addReplayLine(text: string) {
  const div = document.createElement('div');
  div.className = 'msg replay';
  div.textContent = text;
  transcript.appendChild(div);
}

function addSharedAgentMessage(role: string, text: string) {
  const div = document.createElement('div');
  div.className = role === 'user' ? 'msg user shared-agent' : 'msg assistant shared-agent';
  div.textContent = role === 'user' ? text : `本地 Agent · ${text}`;
  transcript.appendChild(div);
  scrollBottom();
}

function paramsSummary(params: Record<string, unknown>): string {
  const json = JSON.stringify(params, null, 1);
  return json.length > 240 ? json.slice(0, 240) + '…' : json;
}

function addToolCard(callId: string, tool: string, params: Record<string, unknown>) {
  const card = document.createElement('div');
  card.className = 'tool-card running';
  card.innerHTML = `
    <div class="tool-head">
      <span class="tool-name"></span>
      <span class="tool-state">…</span>
    </div>
    <div class="tool-body"></div>`;
  (card.querySelector('.tool-name') as HTMLElement).textContent = toolLabel(tool);
  (card.querySelector('.tool-body') as HTMLElement).textContent = paramsSummary(params);
  (card.querySelector('.tool-head') as HTMLElement).addEventListener('click', () => {
    card.classList.toggle('open');
  });
  transcript.appendChild(card);
  toolCards.set(callId, card);
  scrollBottom();
}

function toolLabel(tool: string): string {
  const labels: Record<string, string> = {
    list_sessions: '查找终端会话',
    send_command: '执行终端命令',
    read_output: '读取命令输出',
    wait_output: '等待终端输出',
    send_key: '发送终端按键',
    screen_snapshot: '读取终端画面',
    upload_file: '上传文件',
    download_file: '下载文件',
    get_shared_context: '读取共享会话',
    append_shared_context: '写入共享会话',
  };
  return labels[tool] ?? tool;
}

function finishToolCard(callId: string, ok: boolean, summary: string) {
  const card = toolCards.get(callId);
  if (!card) return;
  card.classList.remove('running');
  card.classList.add(ok ? 'ok' : 'fail');
  (card.querySelector('.tool-state') as HTMLElement).textContent = ok ? '✓' : '✗';
  const body = card.querySelector('.tool-body') as HTMLElement;
  body.textContent = `${body.textContent ?? ''}\n→ ${summary}`;
  toolCards.delete(callId);
  scrollBottom();
}

function renderApprovals(approvals: StateMessage['approvals']) {
  approvalsEl.textContent = '';
  for (const approval of approvals) {
    const div = document.createElement('div');
    div.className = 'approval';
    div.innerHTML = `
      <div class="title"></div>
      <div class="summary"></div>
      <div class="actions">
        <button class="approve">批准执行</button>
        <button class="deny">拒绝</button>
      </div>`;
    (div.querySelector('.title') as HTMLElement).textContent = `需要批准：${toolLabel(
      approval.tool
    )}${approval.sessionId ? ` · 终端 ${approval.sessionId.slice(0, 14)}` : ''}`;
    (div.querySelector('.summary') as HTMLElement).textContent = approval.summary;
    (div.querySelector('.approve') as HTMLButtonElement).addEventListener('click', () => {
      postToBackground({
        kind: 'approval-response',
        requestId: approval.requestId,
        approved: true,
      });
    });
    (div.querySelector('.deny') as HTMLButtonElement).addEventListener('click', () => {
      postToBackground({
        kind: 'approval-response',
        requestId: approval.requestId,
        approved: false,
      });
    });
    approvalsEl.appendChild(div);
  }
}

function renderState(state: StateMessage) {
  agentConnected = state.agentConnected;
  statusDot.className = `dot ${state.connected ? 'dot-on' : 'dot-off'}`;
  statusDot.title = state.connected ? '本地服务已连接' : '本地服务未连接';
  modeStatus.textContent =
    chatMode === 'agent'
      ? agentConnected
        ? `Agent 已连接${state.agentNames.length ? ` · ${state.agentNames.join('、')}` : ''}`
        : '等待本地 Agent（MCP）'
      : '使用 API Key';
  modeStatus.className = `mode-status ${chatMode === 'agent' && agentConnected ? 'ok' : ''}`;
  agentSelect.textContent = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = state.agents.length
    ? '选择本地 Agent 对话（选择后读取上下文）'
    : '等待本地 Agent';
  agentSelect.appendChild(placeholder);
  for (const agent of state.agents) {
    const option = document.createElement('option');
    option.value = agent.agentId;
    option.textContent = agent.conversationId
      ? `${agent.label} · ${agent.conversationId.slice(0, 12)}`
      : agent.label;
    agentSelect.appendChild(option);
  }
  if (!state.agents.some((agent) => agent.agentId === selectedAgentId)) {
    selectedAgentId = '';
  }
  if (state.agents.some((agent) => agent.agentId === selectedAgentId)) {
    agentSelect.value = selectedAgentId;
  }
  agentSelect.classList.toggle('hidden', chatMode !== 'agent');
  agentSelect.disabled = state.agents.length === 0;

  sessionSelect.textContent = '';
  if (state.sessions.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '未连接终端';
    sessionSelect.appendChild(option);
    sessionSelect.disabled = true;
  } else {
    sessionSelect.disabled = false;
    for (const session of state.sessions) {
      const option = document.createElement('option');
      option.value = session.sessionId;
      option.textContent = `${session.title} (${session.profileId})`;
      sessionSelect.appendChild(option);
    }
    if (!state.sessions.some((session) => session.sessionId === selectedSessionId)) {
      selectedSessionId = state.sessions[0]!.sessionId;
    }
    sessionSelect.value = selectedSessionId;
  }
  renderApprovals(state.approvals);
  if (!busy)
    setActivity(state.connected ? '已连接 · 等待你的指令' : '未连接本地服务 · 请打开设置', false);
  if (state.connected) removeEmptyHint();
  const hookHint = document.getElementById('hook-hint');
  if (hookHint) {
    hookHint.classList.toggle(
      'hidden',
      !(state.connected && state.sessions.length === 0 && !chatId)
    );
  }
}

function handleChatEvent(message: ChatEventMessage['message']) {
  const payload = message.payload;
  if (payload.chatId && chatId && payload.chatId !== chatId) return;
  if (stopping && ['chat_delta', 'chat_tool_call', 'chat_tool_result'].includes(message.type))
    return;
  switch (message.type) {
    case 'chat_created':
      chatId = String(payload.chatId);
      chatCreateRequested = false;
      if (outbox.length > 0) dispatchNext();
      break;
    case 'chat_replay': {
      // Restored history from a previous session — render compactly.
      const messages = (payload.messages ?? []) as Array<{ role: string; content: string }>;
      for (const m of messages) {
        if (m.role === 'user') {
          addUserMessage(m.content);
        } else if (m.role === 'assistant') {
          if (m.content) {
            const bubble = ensureAssistantBubble();
            bubble.textContent += m.content;
            finalizeAssistant();
          }
        } else if (m.role === 'tool' && m.content.trim()) {
          addReplayLine(m.content);
        }
      }
      finalizeAssistant();
      scrollBottom();
      break;
    }
    case 'shared_context_event': {
      const entry = payload.entry as
        { source?: string; role?: string; content?: string; targetAgentId?: string; requestId?: string } | undefined;
      if (
        entry?.source === 'mcp' &&
        entry.content &&
        (!entry.targetAgentId || entry.targetAgentId === selectedAgentId)
      ) {
        addSharedAgentMessage(entry.role ?? 'note', entry.content);
        if (
          chatMode === 'agent' &&
          entry.role === 'assistant' &&
          pendingAgentRequestId &&
          entry.requestId === pendingAgentRequestId
        ) {
          pendingAgentRequestId = null;
          if (agentRequestTimer !== null) window.clearTimeout(agentRequestTimer);
          agentRequestTimer = null;
          setBusy(false);
          setActivity('本地 Agent 已回写 · 可以继续', false);
        }
      }
      break;
    }
    case 'shared_context_replay': {
      if (sharedReplayRendered) break;
      sharedReplayRendered = true;
      const entries = (payload.entries ?? []) as Array<{
        source?: string;
        role?: string;
        content?: string;
        chatId?: string;
        targetAgentId?: string;
        requestId?: string;
      }>;
      for (const entry of entries) {
        if (!entry.content || entry.source === 'agent') continue;
        if (entry.targetAgentId && entry.targetAgentId !== selectedAgentId) continue;
        if (entry.source === 'panel' && entry.role === 'user' && !entry.chatId)
          addSharedAgentMessage('user', entry.content);
        else if (entry.source === 'mcp') addSharedAgentMessage(entry.role ?? 'note', entry.content);
      }
      break;
    }
    case 'chat_delta':
      setActivity('正在生成回答…', true);
      if (typeof payload.text === 'string' && payload.text.length > 0) {
        const bubble = ensureAssistantBubble();
        bubble.textContent += payload.text;
        scrollBottom();
      }
      break;
    case 'chat_tool_call':
      finalizeAssistant();
      setActivity(`正在执行：${toolLabel(String(payload.tool))}`, true);
      addToolCard(
        String(payload.callId),
        String(payload.tool),
        (payload.params ?? {}) as Record<string, unknown>
      );
      break;
    case 'chat_tool_result':
      setActivity(
        payload.ok === true ? '工具执行完成，继续思考…' : '工具执行失败，正在处理…',
        true
      );
      finishToolCard(String(payload.callId), payload.ok === true, String(payload.summary ?? ''));
      break;
    case 'chat_done':
      stopping = false;
      abortBtn.disabled = false;
      if (payload.error) addErrorMessage(String(payload.error));
      finalizeAssistant();
      if (outbox.length > 0) {
        dispatchNext();
      } else {
        setBusy(false);
        if (payload.stopReason === 'aborted') setActivity('已停止 · 可继续发送消息', false);
      }
      break;
    case 'error':
      stopping = false;
      abortBtn.disabled = false;
      addErrorMessage(String((payload as { message?: string }).message ?? '未知错误'));
      finalizeAssistant();
      if (outbox.length > 0) dispatchNext();
      else setBusy(false);
      break;
    default:
      break;
  }
}

port.onMessage.addListener((msg: PortMessage) => {
  if (msg.kind === 'state') {
    renderState(msg);
  } else if (msg.kind === 'chat-event') {
    removeEmptyHint();
    handleChatEvent(msg.message);
  }
});

postToBackground({ kind: 'get-state' });

function dispatchNext() {
  if (!chatId || outbox.length === 0) return;
  const text = outbox.shift()!;
  renderQueueCount();
  setBusy(true);
  setActivity('正在连接 AI…', true);
  ensureAssistantBubble();
  postToBackground({ kind: 'chat-message', chatId, text });
}

function sendToAgent(text: string) {
  if (!agentConnected) {
    addErrorMessage('本地 Agent 尚未连接。请启动 Claude Code 或 Codex，并配置 bastion-pilot MCP。');
    setBusy(false);
    return;
  }
  if (!selectedAgentId) {
    addErrorMessage('请先选择一个本地 Agent 对话。');
    setBusy(false);
    return;
  }
  const requestId = crypto.randomUUID();
  pendingAgentRequestId = requestId;
  if (agentRequestTimer !== null) window.clearTimeout(agentRequestTimer);
  agentRequestTimer = window.setTimeout(() => {
    if (pendingAgentRequestId !== requestId) return;
    pendingAgentRequestId = null;
    setBusy(false);
    setActivity('本地 Agent 响应超时 · 请确认 Agent 已读取共享上下文', false);
    addErrorMessage('本地 Agent 暂未回写响应。请在 Agent 对话中调用 get_shared_context 后，使用 append_shared_context 回答。');
  }, 120_000);
  setBusy(true);
  setActivity('已发送至选中的 Agent 对话 · 等待回写…', true);
  postToBackground({ kind: 'agent-message', text, targetAgentId: selectedAgentId, requestId });
}

function send() {
  const text = input.value.trim();
  if (!text) return;
  removeEmptyHint();
  addUserMessage(text);
  input.value = '';
  if (chatMode === 'agent') {
    sendToAgent(text);
    return;
  }
  outbox.push(text);
  renderQueueCount();
  if (chatId) {
    if (!busy) dispatchNext();
    else setActivity('正在处理上一条消息 · 已加入队列', true);
  } else {
    setActivity('正在建立会话…', true);
    if (!chatCreateRequested) {
      chatCreateRequested = true;
      postToBackground({
        kind: 'chat-new',
        sessionId: selectedSessionId || undefined,
      });
    }
  }
}

function resetConversation() {
  if (busy) {
    addErrorMessage('当前任务仍在执行，请先停止后再新建对话。');
    return;
  }
  chatId = null;
  chatCreateRequested = false;
  sharedReplayRendered = false;
  currentAssistant = null;
  toolCards.clear();
  transcript.textContent = '';
  const hint = document.createElement('div');
  hint.className = 'empty-hint';
  hint.innerHTML = '<p class="welcome-title">新对话已准备好</p><p>描述你的目标，执行前会显示审批卡片。</p>';
  transcript.appendChild(hint);
  postToBackground({
    kind: 'chat-new',
    sessionId: selectedSessionId || undefined,
    fresh: true,
  });
  setActivity('正在建立新会话…', true);
}

sendBtn.addEventListener('click', send);
newChatBtn.addEventListener('click', resetConversation);
abortBtn.addEventListener('click', () => {
  if (stopping) return;
  stopping = true;
  abortBtn.disabled = true;
  outbox.splice(0, outbox.length);
  renderQueueCount();
  finalizeAssistant();
  if (chatMode === 'provider' && chatId) postToBackground({ kind: 'chat-abort', chatId });
  setBusy(false);
  setActivity(
    chatMode === 'agent'
      ? '已停止等待 · 本地 Agent 仍可能继续执行'
      : '正在停止生成… 已发送的终端命令不会自动撤销',
    false
  );
});
input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    send();
  }
});

document.getElementById('open-options')!.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById('empty-options-link')?.addEventListener('click', (ev) => {
  ev.preventDefault();
  chrome.runtime.openOptionsPage();
});

modeSelect.addEventListener('change', () => {
  chatMode = modeSelect.value === 'agent' ? 'agent' : 'provider';
  void chrome.storage.sync.set({ chatMode });
  stopping = false;
  if (busy) setBusy(false);
  setActivity(
    chatMode === 'agent'
      ? agentConnected
        ? '本地 Agent 已连接 · 可以发送'
        : '等待本地 Agent · 请启动 Claude Code / Codex'
      : 'API Key 对话 · 等待你的指令',
    false
  );
  modeStatus.textContent = chatMode === 'agent' ? '等待本地 Agent（MCP）' : '使用 API Key';
  agentSelect.classList.toggle('hidden', chatMode !== 'agent');
});

agentSelect.addEventListener('change', () => {
  if (agentRequestTimer !== null) window.clearTimeout(agentRequestTimer);
  agentRequestTimer = null;
  pendingAgentRequestId = null;
  if (busy && chatMode === 'agent') setBusy(false);
  selectedAgentId = agentSelect.value;
  sharedReplayRendered = false;
  if (selectedAgentId) {
    postToBackground({ kind: 'get-shared-context', targetAgentId: selectedAgentId, limit: 50 });
  }
});

sessionSelect.addEventListener('change', () => {
  selectedSessionId = sessionSelect.value;
  if (chatId && !busy) {
    addReplayLine('已切换目标终端。新建对话后生效。');
  }
});

void chrome.storage.sync.get('chatMode').then((stored) => {
  const mode = (stored as { chatMode?: string }).chatMode;
  chatMode = mode === 'agent' ? 'agent' : 'provider';
  modeSelect.value = chatMode;
  modeStatus.textContent = chatMode === 'agent' ? '等待本地 Agent（MCP）' : '使用 API Key';
  agentSelect.classList.toggle('hidden', chatMode !== 'agent');
});

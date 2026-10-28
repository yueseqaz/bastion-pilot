/**
 * Side panel: thin chat client. All state lives in the daemon; this file only
 * renders the transcript and forwards user actions over the 'panel' port.
 */

interface StateMessage {
  kind: 'state';
  connected: boolean;
  sessions: Array<{ sessionId: string; title: string; state: string; profileId: string }>;
  approvals: Array<{ requestId: string; tool: string; summary: string }>;
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
const approvalsEl = document.getElementById('approvals')!;
const emptyHint = document.querySelector('.empty-hint');

let chatId: string | null = null;
let pendingText: string | null = null;
let busy = false;
let currentAssistant: HTMLDivElement | null = null;
const toolCards = new Map<string, HTMLElement>();

function scrollBottom() {
  transcript.scrollTop = transcript.scrollHeight;
}

function setBusy(value: boolean) {
  busy = value;
  sendBtn.disabled = value;
  abortBtn.classList.toggle('hidden', !value);
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
  (card.querySelector('.tool-name') as HTMLElement).textContent = tool;
  (card.querySelector('.tool-body') as HTMLElement).textContent = paramsSummary(params);
  (card.querySelector('.tool-head') as HTMLElement).addEventListener('click', () => {
    card.classList.toggle('open');
  });
  transcript.appendChild(card);
  toolCards.set(callId, card);
  scrollBottom();
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
        <button class="approve">Approve</button>
        <button class="deny">Deny</button>
      </div>`;
    (div.querySelector('.title') as HTMLElement).textContent =
      `Approval required: ${approval.tool}`;
    (div.querySelector('.summary') as HTMLElement).textContent = approval.summary;
    (div.querySelector('.approve') as HTMLButtonElement).addEventListener('click', () => {
      port.postMessage({
        kind: 'approval-response',
        requestId: approval.requestId,
        approved: true,
      });
    });
    (div.querySelector('.deny') as HTMLButtonElement).addEventListener('click', () => {
      port.postMessage({
        kind: 'approval-response',
        requestId: approval.requestId,
        approved: false,
      });
    });
    approvalsEl.appendChild(div);
  }
}

function renderState(state: StateMessage) {
  statusDot.className = `dot ${state.connected ? 'dot-on' : 'dot-off'}`;
  statusDot.title = state.connected ? 'daemon connected' : 'daemon not connected';

  sessionSelect.textContent = '';
  if (state.sessions.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'no terminal hooked';
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
  }
  renderApprovals(state.approvals);
  if (state.connected) removeEmptyHint();
}

function handleChatEvent(message: ChatEventMessage['message']) {
  const payload = message.payload;
  switch (message.type) {
    case 'chat_created':
      chatId = String(payload.chatId);
      if (pendingText !== null) {
        port.postMessage({ kind: 'chat-message', chatId, text: pendingText });
        pendingText = null;
      }
      break;
    case 'chat_delta':
      if (typeof payload.text === 'string' && payload.text.length > 0) {
        const bubble = ensureAssistantBubble();
        bubble.textContent += payload.text;
        scrollBottom();
      }
      break;
    case 'chat_tool_call':
      addToolCard(
        String(payload.callId),
        String(payload.tool),
        (payload.params ?? {}) as Record<string, unknown>
      );
      break;
    case 'chat_tool_result':
      finishToolCard(String(payload.callId), payload.ok === true, String(payload.summary ?? ''));
      break;
    case 'chat_done':
      if (payload.error) addErrorMessage(String(payload.error));
      finalizeAssistant();
      setBusy(false);
      break;
    case 'error':
      addErrorMessage(String((payload as { message?: string }).message ?? 'unknown error'));
      finalizeAssistant();
      setBusy(false);
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

port.postMessage({ kind: 'get-state' });

function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  removeEmptyHint();
  addUserMessage(text);
  input.value = '';
  setBusy(true);
  if (chatId) {
    port.postMessage({ kind: 'chat-message', chatId, text });
  } else {
    pendingText = text;
    port.postMessage({ kind: 'chat-new' });
  }
}

sendBtn.addEventListener('click', send);
abortBtn.addEventListener('click', () => {
  if (chatId) port.postMessage({ kind: 'chat-abort', chatId });
});
input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
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

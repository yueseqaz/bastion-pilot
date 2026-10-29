/**
 * Options page: daemon pairing, AI providers and per-site grants. Access is
 * strictly opt-in — the extension only runs on origins listed here.
 */

const SETTINGS_KEY = 'settings';

interface SiteEntry {
  origin: string;
  profileId?: string;
}

interface Settings {
  daemonUrl: string;
  token: string;
  sites: SiteEntry[];
  defaultWaitMs?: number;
}

interface ProviderConfig {
  id: string;
  label?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
}

const DEFAULTS: Settings = { daemonUrl: 'ws://127.0.0.1:8765', token: '', sites: [] };

const urlInput = document.getElementById('daemon-url') as HTMLInputElement;
const tokenInput = document.getElementById('token') as HTMLInputElement;
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
const testBtn = document.getElementById('test-btn') as HTMLButtonElement;
const testResult = document.getElementById('test-result') as HTMLElement;
const siteInput = document.getElementById('site-input') as HTMLInputElement;
const addSiteBtn = document.getElementById('add-site-btn') as HTMLButtonElement;
const siteList = document.getElementById('site-list') as HTMLUListElement;
const permissionHint = document.getElementById('permission-hint') as HTMLElement;
const providerList = document.getElementById('provider-list') as HTMLElement;
const addProviderBtn = document.getElementById('add-provider-btn') as HTMLButtonElement;
const addKimiBtn = document.getElementById('add-kimi-btn') as HTMLButtonElement;
const activeProviderSelect = document.getElementById('active-provider') as HTMLSelectElement;
const saveProvidersBtn = document.getElementById('save-providers-btn') as HTMLButtonElement;
const providerResult = document.getElementById('provider-result') as HTMLElement;

document.querySelector('.ver')!.textContent = `v${chrome.runtime.getManifest().version}`;

let settings: Settings = { ...DEFAULTS };
let providers: ProviderConfig[] = [];
let activeProviderId: string | null = null;

async function load() {
  try {
    const stored = (await chrome.storage.sync.get(SETTINGS_KEY)) as Record<string, unknown>;
    settings = { ...DEFAULTS, ...((stored[SETTINGS_KEY] as Partial<Settings>) ?? {}) };
  } catch {
    settings = { ...DEFAULTS };
  }
  urlInput.value = settings.daemonUrl;
  tokenInput.value = settings.token;
  renderSites();
  await loadProviderConfig();
}

async function save() {
  settings.daemonUrl = urlInput.value.trim() || DEFAULTS.daemonUrl;
  settings.token = tokenInput.value.trim();
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
  setTestResult('已保存，插件将很快重新连接。', 'ok');
}

function setTestResult(text: string, cls: 'ok' | 'err' | '') {
  testResult.textContent = text;
  testResult.className = `result ${cls}`;
}

saveBtn.addEventListener('click', () => void save());

testBtn.addEventListener('click', () => {
  const url = urlInput.value.trim() || DEFAULTS.daemonUrl;
  const token = tokenInput.value.trim();
  if (!token) {
    setTestResult('请先填写配对令牌。', 'err');
    return;
  }
  testBtn.disabled = true;
  setTestResult('正在连接…', '');
  testConnection(url, token)
    .then((result) => setTestResult(result, result.startsWith('连接成功') ? 'ok' : 'err'))
    .catch((err) => setTestResult(`失败：${(err as Error).message}`, 'err'))
    .finally(() => {
      testBtn.disabled = false;
    });
});

function testConnection(url: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (result: string) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error('连接超时——本地服务是否已启动？'));
    }, 5_000);
    const ws = new WebSocket(url);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          v: 1,
          id: `test-${Date.now()}`,
          ts: Date.now(),
          type: 'hello',
          payload: { token, role: 'brain', name: 'options-test', version: '0' },
        })
      );
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        clearTimeout(timer);
        if (msg.type === 'welcome')
          done(`连接成功（服务版本 ${msg.payload?.daemonVersion ?? '?'}）`);
        else if (msg.type === 'error')
          done(`本地服务拒绝连接：${msg.payload?.message ?? '未知错误'}`);
        ws.close();
      } catch {
        /* ignore */
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done('无法连接本地服务（地址错误或服务未启动）');
    };
  });
}

/* ----------------------- AI providers ----------------------- */

function envelope(type: string, payload: unknown): string {
  return JSON.stringify({
    v: 1,
    id: crypto.randomUUID(),
    ts: Date.now(),
    type,
    payload,
  });
}

/** Use the authenticated daemon connection so provider API 密钥s never pass through sync storage. */
async function providerRequest(
  type: 'provider_configs_get' | 'provider_configs_update' | 'provider_models_get',
  payload: unknown
) {
  // Read storage as a fallback when the options page was opened before the
  // daemon settings were hydrated into the form (or after a browser restore).
  const stored = (await chrome.storage.sync.get(SETTINGS_KEY)) as Record<string, unknown>;
  const saved = (stored[SETTINGS_KEY] as Partial<Settings> | undefined) ?? {};
  const url = urlInput.value.trim() || saved.daemonUrl || DEFAULTS.daemonUrl;
  const token = tokenInput.value.trim() || saved.token?.trim() || '';
  if (!token) {
    throw new Error(
      '缺少配对令牌——运行 `bastion-pilot init`，将令牌粘贴到“本地服务”并保存'
    );
  }

  return await new Promise<unknown>((resolve, reject) => {

    let ws: WebSocket | null = null;
    let settled = false;
    const timer = setTimeout(() => finishError(new Error('连接超时——本地服务是否已启动？')), 5_000);
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    const finishError = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      reject(err);
    };

    try {
      ws = new WebSocket(url);
    } catch (err) {
      finishError(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    ws.onopen = () => {
      ws?.send(
        envelope('hello', {
          token,
          role: 'brain',
          name: 'options-page',
          version: chrome.runtime.getManifest().version,
        })
      );
    };
    ws.onmessage = (event) => {
      let message: { type?: string; payload?: unknown };
      try {
        message = JSON.parse(String(event.data)) as { type?: string; payload?: unknown };
      } catch {
        return;
      }
      if (message.type === 'welcome') {
        ws?.send(envelope(type, payload));
      } else if (message.type === 'provider_configs' && type === 'provider_configs_get') {
        finish(message.payload);
      } else if (message.type === 'provider_configs_saved' && type === 'provider_configs_update') {
        finish(message.payload);
      } else if (message.type === 'provider_models' && type === 'provider_models_get') {
        finish(message.payload);
      } else if (message.type === 'error') {
        const detail = (message.payload as { message?: string } | undefined)?.message;
        finishError(new Error(detail || '本地服务拒绝了请求'));
      }
    };
    ws.onerror = () => finishError(new Error('无法连接本地服务'));
    ws.onclose = () => {
      if (!settled) finishError(new Error('本地服务连接已关闭'));
    };
  });
}

function setProviderResult(text: string, cls: 'ok' | 'err' | '') {
  providerResult.textContent = text;
  providerResult.className = `result ${cls}`;
}

function textField(
  parent: HTMLElement,
  labelText: string,
  className: string,
  value: string,
  type = 'text',
  wide = false
) {
  const label = document.createElement('label');
  if (wide) label.className = 'wide';
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.className = className;
  input.value = value;
  input.autocomplete = 'off';
  label.appendChild(input);
  parent.appendChild(label);
}

function renderProviderSelect() {
  activeProviderSelect.textContent = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = providers.length > 0 ? '无（停用对话）' : '暂无服务商';
  activeProviderSelect.appendChild(none);
  for (const provider of providers) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.label || 'API Key 服务';
    activeProviderSelect.appendChild(option);
  }
  activeProviderSelect.value = activeProviderId ?? '';
  activeProviderSelect.disabled = providers.length === 0;
}

function renderProviders() {
  providerList.textContent = '';
  if (providers.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = '暂无服务商 configured. Add one to enable the side-panel chat.';
    providerList.appendChild(empty);
  }

  providers.forEach((provider, index) => {
    const card = document.createElement('div');
    card.className = 'provider-card';
    card.dataset.index = String(index);
    card.dataset.providerId = provider.id;
    card.dataset.providerLabel = provider.label ?? '';

    const head = document.createElement('div');
    head.className = 'provider-card-head';
    const title = document.createElement('strong');
    title.textContent = provider.label || 'API Key 服务';
    head.appendChild(title);
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.type = 'button';
    remove.textContent = '移除';
    remove.addEventListener('click', () => {
      providers.splice(index, 1);
      if (activeProviderId === provider.id) activeProviderId = null;
      renderProviders();
    });
    head.appendChild(remove);
    card.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'provider-card-grid';
    textField(grid, '接口地址', 'provider-base-url', provider.baseUrl, 'text', true);
    textField(grid, 'API 密钥', 'provider-api-key', provider.apiKey, 'password', true);
    const modelLabel = document.createElement('label');
    modelLabel.className = 'model-row';
    modelLabel.textContent = '模型';
    const modelRow = document.createElement('span');
    modelRow.className = 'model-control';
    const model = document.createElement('select');
    model.className = 'provider-model';
    model.title = '先填写 URL 和 API Key，再点击获取模型';
    const currentOption = document.createElement('option');
    currentOption.value = provider.model;
    currentOption.textContent = provider.model || '点击获取模型';
    model.appendChild(currentOption);
    model.value = provider.model;
    modelRow.appendChild(model);
    const refreshModels = document.createElement('button');
    refreshModels.type = 'button';
    refreshModels.className = 'fetch-models';
    refreshModels.textContent = '获取模型';
    refreshModels.addEventListener('click', () => {
      const baseUrl = (grid.querySelector('.provider-base-url') as HTMLInputElement | null)?.value.trim() ?? '';
      const apiKey = (grid.querySelector('.provider-api-key') as HTMLInputElement | null)?.value ?? '';
      if (!baseUrl || !apiKey) {
        setProviderResult('请先填写接口地址和 API 密钥。', 'err');
        return;
      }
      try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported scheme');
      } catch {
        setProviderResult('接口地址无效，请输入 http(s) 地址。', 'err');
        return;
      }
      refreshModels.disabled = true;
      setProviderResult('正在获取模型列表…', '');
      providerRequest('provider_models_get', { baseUrl, apiKey })
        .then((payload) => {
          const models = (payload as { models?: unknown }).models;
          if (!Array.isArray(models) || models.length === 0) throw new Error('接口未返回可用模型');
          const selected = model.value;
          model.textContent = '';
          for (const id of models) {
            if (typeof id !== 'string') continue;
            const option = document.createElement('option');
            option.value = id;
            option.textContent = id;
            model.appendChild(option);
          }
          if (selected && models.includes(selected)) model.value = selected;
          else model.selectedIndex = 0;
          setProviderResult(`已获取 ${model.options.length} 个模型，请选择后保存。`, 'ok');
        })
        .catch((err) => setProviderResult(`获取模型失败：${(err as Error).message}`, 'err'))
        .finally(() => {
          refreshModels.disabled = false;
        });
    });
    modelRow.appendChild(refreshModels);
    modelLabel.appendChild(modelRow);
    grid.appendChild(modelLabel);
    textField(
      grid,
      '温度（可选）',
      'provider-temperature',
      provider.temperature === undefined ? '' : String(provider.temperature),
      'number'
    );
    textField(
      grid,
      '最大 token 数（可选）',
      'provider-max-tokens',
      provider.maxTokens === undefined ? '' : String(provider.maxTokens),
      'number'
    );
    const stream显示名称 = document.createElement('label');
    stream显示名称.className = 'stream-row';
    const stream = document.createElement('input');
    stream.type = 'checkbox';
    stream.className = 'provider-stream';
    stream.checked = provider.stream !== false;
    stream显示名称.appendChild(stream);
    stream显示名称.append('启用流式响应');
    grid.appendChild(stream显示名称);
    card.appendChild(grid);
    providerList.appendChild(card);
  });
  renderProviderSelect();
}

function collectProviders(): ProviderConfig[] {
  return [...providerList.querySelectorAll<HTMLElement>('.provider-card')].map((card) => {
    const value = (className: string) =>
      (card.querySelector(`.${className}`) as HTMLInputElement | null)?.value.trim() ?? '';
    const optionalNumber = (className: string) => {
      const raw = value(className);
      return raw === '' ? undefined : Number(raw);
    };
    const provider: ProviderConfig = {
      id: card.dataset.providerId ?? `provider-${Date.now().toString(36)}`,
      label: card.dataset.providerLabel || undefined,
      baseUrl: value('provider-base-url'),
      apiKey: value('provider-api-key'),
      model: value('provider-model'),
      stream: (card.querySelector('.provider-stream') as HTMLInputElement).checked,
      temperature: optionalNumber('provider-temperature'),
      maxTokens: optionalNumber('provider-max-tokens'),
    };
    return provider;
  });
}

async function loadProviderConfig() {
  if (!tokenInput.value.trim()) {
    providers = [];
    activeProviderId = null;
    renderProviders();
    setProviderResult('请先保存本地服务令牌，再加载 AI 配置。', '');
    return;
  }
  try {
    const payload = (await providerRequest('provider_configs_get', {})) as {
      providers?: ProviderConfig[];
      activeProviderId?: string | null;
    };
    providers = Array.isArray(payload.providers) ? payload.providers : [];
    activeProviderId = payload.activeProviderId ?? null;
    renderProviders();
    setProviderResult('', '');
  } catch (err) {
    renderProviders();
    setProviderResult(`加载 AI 配置失败：${(err as Error).message}`, 'err');
  }
}

addProviderBtn.addEventListener('click', () => {
  const id = `provider-${Date.now().toString(36)}`;
  providers.push({
    id,
    label: '新服务商',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: '',
    stream: true,
  });
  if (!activeProviderId) activeProviderId = id;
  renderProviders();
});

addKimiBtn.addEventListener('click', () => {
  const id = `kimi-${Date.now().toString(36)}`;
  providers.push({
    id,
    label: 'API Key 服务',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: '',
    model: '',
    stream: true,
  });
  activeProviderId = id;
  renderProviders();
  setProviderResult('已添加 API Key 配置模板，请填写 URL 和 API Key，然后获取模型。', '');
});

activeProviderSelect.addEventListener('change', () => {
  activeProviderId = activeProviderSelect.value || null;
});

saveProvidersBtn.addEventListener('click', () => {
  const next = collectProviders();
  const ids = new Set<string>();
  for (const provider of next) {
    if (!provider.id || !provider.baseUrl || !provider.apiKey || !provider.model) {
      setProviderResult('每个服务商都需要填写接口地址、API Key，并先获取模型。', 'err');
      return;
    }
    if (ids.has(provider.id)) {
      setProviderResult(`服务商 ID 重复：${provider.id}`, 'err');
      return;
    }
    ids.add(provider.id);
    try {
      const url = new URL(provider.baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported scheme');
    } catch {
      setProviderResult(`接口地址无效：${provider.id}。请输入 http(s) 地址。`, 'err');
      return;
    }
    if (provider.temperature !== undefined && (!Number.isFinite(provider.temperature) || provider.temperature < 0 || provider.temperature > 2)) {
      setProviderResult(`温度范围错误：${provider.id}必须在 0 到 2 之间。`, 'err');
      return;
    }
    if (provider.maxTokens !== undefined && (!Number.isInteger(provider.maxTokens) || provider.maxTokens <= 0)) {
      setProviderResult(`最大 token 数错误：${provider.id}必须是正整数。`, 'err');
      return;
    }
  }
  if (activeProviderId !== null && !ids.has(activeProviderId)) activeProviderId = null;

  saveProvidersBtn.disabled = true;
  setProviderResult('正在保存…', '');
  providerRequest('provider_configs_update', {
    providers: next,
    activeProviderId,
  })
    .then(() => {
      providers = next;
      settings.daemonUrl = urlInput.value.trim() || DEFAULTS.daemonUrl;
      settings.token = tokenInput.value.trim();
      void chrome.storage.sync.set({
        [SETTINGS_KEY]: settings,
      });
      renderProviders();
      setProviderResult('AI 配置已保存，下一条侧边栏消息将使用新配置。', 'ok');
    })
    .catch((err) => setProviderResult(`保存失败：${(err as Error).message}`, 'err'))
    .finally(() => {
      saveProvidersBtn.disabled = false;
    });
});

/* ----------------------- sites ----------------------- */

function normalizeOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function matchPattern(origin: string): string | null {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return null;
  }
}

addSiteBtn.addEventListener('click', () => {
  const origin = normalizeOrigin(siteInput.value);
  if (!origin) {
    permissionHint.textContent = '请输入有效的 http(s) 站点，例如 https://bastion.example.com';
    return;
  }
  if (settings.sites.some((s) => s.origin === origin)) {
    permissionHint.textContent = '这个站点已经授予权限。';
    return;
  }
  const pattern = matchPattern(origin)!;
  chrome.permissions
    .request({ origins: [pattern] })
    .then((granted) => {
      if (!granted) {
        permissionHint.textContent = '未授予权限。';
        return;
      }
      settings.sites = [...settings.sites, { origin, profileId: 'generic-xterm' }];
      siteInput.value = '';
      permissionHint.textContent = '';
      return chrome.storage.sync.set({ [SETTINGS_KEY]: settings }).then(renderSites);
    })
    .catch((err) => {
      permissionHint.textContent = `操作失败：${(err as Error).message}`;
    });
});

function renderSites() {
  siteList.textContent = '';
  if (settings.sites.length === 0) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = '尚未添加站点，请在上方输入堡垒机地址。';
    siteList.appendChild(li);
    return;
  }
  for (const site of settings.sites) {
    const li = document.createElement('li');

    const origin = document.createElement('span');
    origin.className = 'origin';
    origin.textContent = site.origin;
    li.appendChild(origin);

    const select = document.createElement('select');
    select.title = '站点类型';
    for (const profile of [
      { id: 'generic-xterm', name: '通用 xterm.js' },
      { id: 'jumpserver', name: 'JumpServer' },
      { id: 'teleport', name: 'Teleport（实验性）' },
      { id: 'qizhi', name: '齐治（实验性）' },
      { id: 'aliyun-bastionhost', name: '阿里云堡垒机（实验性）' },
    ]) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.name;
      select.appendChild(option);
    }
    select.value = site.profileId ?? 'generic-xterm';
    select.addEventListener('change', () => {
      site.profileId = select.value;
      void chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
    });
    li.appendChild(select);

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '移除';
    remove.addEventListener('click', () => {
      const pattern = matchPattern(site.origin);
      const forget = () => {
        settings.sites = settings.sites.filter((s) => s.origin !== site.origin);
        void chrome.storage.sync.set({ [SETTINGS_KEY]: settings }).then(renderSites);
      };
      if (pattern) {
        chrome.permissions
          .remove({ origins: [pattern] })
          .then(forget)
          .catch(forget);
      } else {
        forget();
      }
    });
    li.appendChild(remove);

    siteList.appendChild(li);
  }
}

void load();

/**
 * Options page: daemon pairing and per-site grants. Access is strictly
 * opt-in — the extension only runs on origins listed here.
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

document.querySelector('.ver')!.textContent = `v${chrome.runtime.getManifest().version}`;

let settings: Settings = { ...DEFAULTS };

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
}

async function save() {
  settings.daemonUrl = urlInput.value.trim() || DEFAULTS.daemonUrl;
  settings.token = tokenInput.value.trim();
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
  setTestResult('Saved. The extension will (re)connect shortly.', 'ok');
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
    setTestResult('Enter the pairing token first.', 'err');
    return;
  }
  testBtn.disabled = true;
  setTestResult('Connecting…', '');
  testConnection(url, token)
    .then((result) => setTestResult(result, result.includes('ok') ? 'ok' : 'err'))
    .catch((err) => setTestResult(`failed: ${(err as Error).message}`, 'err'))
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
      reject(new Error('timeout — is the daemon running?'));
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
          done(`connected ok (daemon v${msg.payload?.daemonVersion ?? '?'})`);
        else if (msg.type === 'error')
          done(`daemon rejected: ${msg.payload?.message ?? 'unknown'}`);
        ws.close();
      } catch {
        /* ignore */
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done('could not reach the daemon (wrong URL or not running)');
    };
  });
}

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
    permissionHint.textContent = 'Enter a valid http(s) origin, e.g. https://bastion.example.com';
    return;
  }
  if (settings.sites.some((s) => s.origin === origin)) {
    permissionHint.textContent = 'This origin is already granted.';
    return;
  }
  const pattern = matchPattern(origin)!;
  chrome.permissions
    .request({ origins: [pattern] })
    .then((granted) => {
      if (!granted) {
        permissionHint.textContent = 'Permission was not granted.';
        return;
      }
      settings.sites = [...settings.sites, { origin, profileId: 'generic-xterm' }];
      siteInput.value = '';
      permissionHint.textContent = '';
      return chrome.storage.sync.set({ [SETTINGS_KEY]: settings }).then(renderSites);
    })
    .catch((err) => {
      permissionHint.textContent = `Failed: ${(err as Error).message}`;
    });
});

function renderSites() {
  siteList.textContent = '';
  if (settings.sites.length === 0) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'No sites granted yet — add the origin of your bastion host above.';
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
    select.title = 'site profile';
    for (const profile of [
      { id: 'generic-xterm', name: 'Generic xterm.js' },
      { id: 'jumpserver', name: 'JumpServer' },
      { id: 'teleport', name: 'Teleport (experimental)' },
      { id: 'qizhi', name: 'Qizhi 齐治 (experimental)' },
      { id: 'aliyun-bastionhost', name: 'Aliyun Bastionhost (experimental)' },
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
    remove.textContent = 'Remove';
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

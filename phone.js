// Hot News iPhone app: unlocks the encrypted days once, then lists the days and shows article cards with full text.
// Copied from local-ai-news/phone/phone.js.
// Encrypted files are kept in IndexedDB (not Cache Storage: other apps on this address clear
// each other's caches), so days already opened can be read offline.
(function () {
  const app = document.getElementById('app');
  const back = document.getElementById('back');
  const barTitle = document.getElementById('bar-title');
  const DB_NAME = 'hot-news';
  let key = null;
  let reports = [];
  let offline = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------- IndexedDB ----------

  function database() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('keys');   // the CryptoKey itself; it cannot be read back out
        request.result.createObjectStore('files');  // encrypted library and reports for offline reading
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function stored(name, mode, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const request = action(db.transaction(name, mode).objectStore(name));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  const loadSavedKey = () => stored('keys', 'readonly', (s) => s.get('main')).catch(() => null);
  const saveKey = (record) => stored('keys', 'readwrite', (s) => s.put(record, 'main'));
  const forgetKey = () => stored('keys', 'readwrite', (s) => s.delete('main'));
  const loadFile = (name) => stored('files', 'readonly', (s) => s.get(name)).catch(() => undefined);
  const saveFile = (name, buffer) => stored('files', 'readwrite', (s) => s.put(buffer, name)).catch(() => {});
  const fileNames = () => stored('files', 'readonly', (s) => s.getAllKeys()).catch(() => []);
  const dropFile = (name) => stored('files', 'readwrite', (s) => s.delete(name)).catch(() => {});

  // ---------- Crypto ----------

  function bytes(base64) {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  }

  async function deriveKey(passphrase, info) {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: bytes(info.salt), iterations: info.iterations },
      material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
  }

  async function openJson(buffer) {
    const data = new Uint8Array(buffer);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, key, data.slice(12));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  // ---------- Loading ----------

  async function fetchBuffer(url) {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(String(response.status));
    return response.arrayBuffer();
  }

  async function start() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    back.addEventListener('click', () => { location.hash = ''; });
    window.addEventListener('hashchange', () => { if (key) route(); });

    const saved = await loadSavedKey();
    let info = null;
    try {
      const response = await fetch('data/key.json', { cache: 'no-cache' });
      if (response.status === 404) {
        showMessage('아직 게시된 뉴스가 없습니다', '맥의 Hot News 창에서 [Publish to Phone]을 누르면 1~2분 후 여기에 나옵니다.');
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      info = await response.json();
    } catch (error) {
      if (saved) {  // offline: open what this iPhone already has
        offline = true;
        key = saved.key;
        await loadLibrary();
        return;
      }
      showMessage('불러오지 못했습니다', '인터넷에 연결한 뒤 다시 열어 주세요.');
      return;
    }
    if (saved && saved.salt === info.salt) {
      key = saved.key;
      await loadLibrary();
    } else {
      showLock(info, Boolean(saved));
    }
  }

  async function loadLibrary() {
    let buffer;
    try {
      buffer = await fetchBuffer('data/library.bin');
      saveFile('library', buffer);
    } catch (error) {
      offline = true;
      buffer = await loadFile('library');
    }
    try {
      if (!buffer) throw new Error('none');
      reports = (await openJson(buffer)).reports;
    } catch (error) {
      showMessage('목록을 열지 못했습니다', '인터넷에 연결한 뒤 다시 열어 주세요. 계속 안 되면 아래 [잠그기]로 비밀번호를 다시 입력하세요.', true);
      return;
    }
    if (!offline) cleanOldFiles();
    route();
  }

  async function cleanOldFiles() {
    const wanted = new Set(['library', ...reports.map((r) => r.file)]);
    for (const name of await fileNames()) if (!wanted.has(name)) dropFile(name);
  }

  async function reportBody(report) {
    let buffer = await loadFile(report.file);  // file names change with the content, so a saved copy is never stale
    if (!buffer) {
      buffer = await fetchBuffer(report.file);
      saveFile(report.file, buffer);
    }
    return openJson(buffer);
  }

  // ---------- Screens ----------

  function setBar(title, showBack) {
    barTitle.textContent = title;
    back.hidden = !showBack;
  }

  function showMessage(title, text, withLock = false) {
    setBar('Hot News', false);
    const box = el('section', 'message');
    box.append(el('h1', '', title), el('p', 'muted', text));
    if (withLock) box.append(lockButton());
    app.replaceChildren(box);
  }

  function showLock(info, changed) {
    setBar('Hot News', false);
    const box = el('form', 'lock');
    const icon = el('img', 'lock-icon');
    icon.src = 'icons/icon-192.png';
    icon.alt = '';
    box.append(icon, el('h1', '', 'Hot News'));
    box.append(el('p', 'muted', changed
      ? '맥에서 게시 비밀번호를 새로 정했습니다. 새 비밀번호를 입력하세요.'
      : '맥에서 게시할 때 정한 비밀번호를 한 번 입력하세요. 이 아이폰에서는 다시 묻지 않습니다.'));
    const input = el('input');
    input.type = 'password';
    input.autocomplete = 'current-password';
    input.placeholder = '게시 비밀번호';
    const error = el('p', 'error');
    error.hidden = true;
    const go = el('button', 'button primary', '열기');
    go.type = 'submit';
    box.append(input, error, go);
    box.addEventListener('submit', async (event) => {
      event.preventDefault();
      go.disabled = true;
      go.textContent = '확인 중…';
      error.hidden = true;
      try {
        const candidate = await deriveKey(input.value, info);
        const check = bytes(info.check);
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: check.slice(0, 12) }, candidate, check.slice(12));
        key = candidate;
        input.value = '';
        await saveKey({ key: candidate, salt: info.salt });
        await loadLibrary();
      } catch (problem) {
        error.textContent = '비밀번호가 맞지 않습니다.';
        error.hidden = false;
        go.disabled = false;
        go.textContent = '열기';
      }
    });
    app.replaceChildren(box);
    input.focus();
  }

  function lockButton() {
    const lock = el('button', 'link', '잠그기');
    lock.type = 'button';
    lock.addEventListener('click', async () => {
      if (!confirm('이 아이폰에서 비밀번호를 지우고 잠글까요? 다음에 열 때 다시 입력합니다.')) return;
      await forgetKey();
      location.hash = '';
      location.reload();
    });
    return lock;
  }

  function route() {
    const id = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    const report = reports.find((r) => r.id === id);
    if (report) showReport(report);
    else showList();
  }

  function showList() {
    setBar('Hot News', false);
    const page = el('section', 'list');
    if (offline) page.append(el('p', 'offline', '오프라인: 이 아이폰에 저장된 내용만 보입니다.'));
    if (!reports.length) page.append(el('p', 'muted empty', '아직 게시된 뉴스가 없습니다.'));
    reports.forEach((report, index) => {
      const card = el('a', 'day-card');
      card.href = `#/${encodeURIComponent(report.id)}`;
      const top = el('div', 'day-card-top');
      top.append(el('span', 'day-card-date', report.date), el('span', 'muted', `기사 ${report.count}개`));
      if (index === 0) top.append(el('span', 'badge', '최신'));
      if (report.ai) top.append(el('span', 'badge ai-badge', 'Qwen'));
      card.append(top);
      if (report.top) card.append(el('div', 'day-card-top-title muted', report.top));
      page.append(card);
    });
    const foot = el('div', 'foot');
    foot.append(lockButton());
    page.append(foot);
    app.replaceChildren(page);
    window.scrollTo(0, 0);
  }

  function webLink(url, text) {
    const link = el('a', '', text);
    if (/^https?:\/\//.test(url || '')) {
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    return link;
  }

  function stars(n) {
    return '★'.repeat(n) + '☆'.repeat(Math.max(0, 5 - n));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      const area = el('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      document.body.append(area);
      area.select();
      const done = document.execCommand('copy');
      area.remove();
      return done;
    }
  }

  function renderCard(article) {
    const card = el('article', 'card');
    const meta = el('div', 'card-meta');
    meta.append(el('span', 'stars', stars(article.stars)),
      el('span', `score s${article.stars}`, `${article.rank}위 · ${article.score}점`),
      el('span', 'group', article.source));
    if (article.published) meta.append(el('span', '', article.published));
    card.append(meta, el('h3', '', article.title));
    if (article.summary) card.append(el('p', 'summary', article.summary));
    if (article.reason) card.append(el('p', 'reason', article.reason));

    const details = el('div', 'details');
    details.hidden = true;
    details.append(el('h4', '', article.words ? `본문 · ${article.words}` : '본문'));
    const text = el('div', 'body-text');
    article.body.split(/\n{2,}/).forEach((para) => { if (para.trim()) text.append(el('p', '', para.trim())); });
    details.append(text);
    if (article.others.length) {
      details.append(el('h4', '', '같은 사건을 다룬 다른 기사'));
      const list = el('ul', 'others');
      article.others.forEach((other) => {
        const li = el('li');
        li.append(el('span', 'muted', `${other.source} — `), webLink(other.url, other.title));
        list.append(li);
      });
      details.append(list);
    }

    const actions = el('div', 'card-actions');
    const more = el('button', '', '본문 보기 ▾');
    more.type = 'button';
    more.addEventListener('click', () => {
      details.hidden = !details.hidden;
      more.textContent = details.hidden ? '본문 보기 ▾' : '접기 ▴';
    });
    const copy = el('button', '', '본문 복사');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      const done = await copyText(article.body);
      copy.textContent = done ? '✓ 복사했습니다' : '복사하지 못했습니다';
      copy.classList.toggle('copy-done', done);
      setTimeout(() => { copy.textContent = '본문 복사'; copy.classList.remove('copy-done'); }, 2000);
    });
    actions.append(more, copy);
    if (article.url) actions.append(webLink(article.url, '원문 열기 ↗'));
    card.append(actions, details);
    return card;
  }

  async function showReport(report) {
    setBar(report.date, true);
    app.replaceChildren(el('p', 'muted loading', '여는 중…'));
    let data;
    try {
      data = await reportBody(report);
    } catch (error) {
      app.replaceChildren(el('p', 'error loading', '이날 뉴스를 열지 못했습니다. 인터넷에 연결한 뒤 다시 열어 주세요.'));
      return;
    }
    const page = el('section', 'day');
    page.append(el('p', 'note', `기사 ${data.count}개 · 중요도 높은 순${data.method ? ` · ${data.method}` : ''}`));
    if (data.articles.some((a) => a.summary)) {
      page.append(el('p', 'note', '한 줄 요약은 로컬 AI(Qwen)가 만든 것이라 틀릴 수 있습니다. 본문은 기사 원문 그대로입니다.'));
    }
    const list = el('div', 'cards');
    data.articles.forEach((article) => list.append(renderCard(article)));
    if (!data.articles.length) list.append(el('p', 'muted empty', '이날 저장된 기사가 없습니다.'));
    page.append(list);
    if (data.skipped.length) {
      const box = el('div', 'skipped');
      box.append(el('strong', 'error', `원문을 가져오지 못해 뺀 사건 ${data.skipped.length}개`));
      const skipped = el('ul');
      data.skipped.forEach((line) => skipped.append(el('li', '', line)));
      box.append(skipped);
      page.append(box);
    }
    const top = el('button', 'to-top', '↑');
    top.type = 'button';
    top.setAttribute('aria-label', '맨 위로');
    top.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    app.replaceChildren(page, top);
    window.scrollTo(0, 0);
  }

  start();
})();

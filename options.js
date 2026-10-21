// Gmail Auto BCC - 設定画面
const MAX_BCC = 5;
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

const listEl = document.getElementById('list');
const detectedEl = document.getElementById('detected');
const statusEl = document.getElementById('status');
const tpl = document.getElementById('card-tpl');

function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
  if (!isError && msg) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 3000);
}

function addCard(key, conf) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  conf = conf || {};
  node.querySelector('.acct').value = key || '';
  node.querySelector('.enabled').checked = conf.enabled !== false;
  node.querySelector('.apply-new').checked = conf.applyNew !== false;
  node.querySelector('.apply-reply').checked = conf.applyReply !== false;
  node.querySelector('.apply-forward').checked = conf.applyForward === true;
  const bccInputs = node.querySelectorAll('.bcc');
  (conf.bcc || []).slice(0, MAX_BCC).forEach((a, i) => { bccInputs[i].value = a; });
  node.querySelector('.del').addEventListener('click', () => node.remove());
  listEl.appendChild(node);
  return node;
}

async function load() {
  const { accounts = {} } = await chrome.storage.sync.get('accounts');
  listEl.innerHTML = '';
  Object.keys(accounts).forEach((key) => addCard(key, accounts[key]));
  if (Object.keys(accounts).length === 0) addCard('', {});

  const { detectedAccounts = [] } = await chrome.storage.local.get('detectedAccounts');
  if (detectedAccounts.length > 0) {
    detectedEl.innerHTML = '';
    detectedAccounts.forEach((email) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'small';
      btn.textContent = email;
      btn.title = 'この送信元を一覧に追加';
      btn.addEventListener('click', () => {
        const existing = [...listEl.querySelectorAll('.acct')].find((i) => i.value.trim().toLowerCase() === email.toLowerCase());
        if (existing) { existing.focus(); return; }
        const empty = [...listEl.querySelectorAll('.card')].find((c) => !c.querySelector('.acct').value.trim());
        const card = empty || addCard('', {});
        card.querySelector('.acct').value = email;
        card.querySelector('.bcc').focus();
      });
      detectedEl.appendChild(btn);
    });
  }
}

function collect() {
  const accounts = {};
  let ok = true;
  listEl.querySelectorAll('.card').forEach((card) => {
    const acctInput = card.querySelector('.acct');
    const raw = acctInput.value.trim();
    acctInput.classList.remove('invalid');
    const bccInputs = [...card.querySelectorAll('.bcc')];
    const bcc = [];
    bccInputs.forEach((i) => {
      i.classList.remove('invalid');
      const v = i.value.trim();
      if (!v) return;
      if (!EMAIL_RE.test(v)) { i.classList.add('invalid'); ok = false; return; }
      if (!bcc.map((x) => x.toLowerCase()).includes(v.toLowerCase())) bcc.push(v);
    });

    // アカウント欄も BCC も空のカードは無視する
    if (!raw && bcc.length === 0) return;

    if (raw !== '*' && !EMAIL_RE.test(raw)) { acctInput.classList.add('invalid'); ok = false; return; }
    const key = raw.toLowerCase();
    if (accounts[key]) { acctInput.classList.add('invalid'); ok = false; return; }
    if (bcc.length === 0) { bccInputs[0].classList.add('invalid'); ok = false; return; }

    accounts[key] = {
      enabled: card.querySelector('.enabled').checked,
      applyNew: card.querySelector('.apply-new').checked,
      applyReply: card.querySelector('.apply-reply').checked,
      applyForward: card.querySelector('.apply-forward').checked,
      bcc,
    };
  });
  return ok ? accounts : null;
}

document.getElementById('add').addEventListener('click', () => {
  addCard('', {}).querySelector('.acct').focus();
});

document.getElementById('save').addEventListener('click', async () => {
  const accounts = collect();
  if (!accounts) {
    setStatus('赤枠の項目を確認してください（メールアドレスの形式、重複、BCC 未入力）', true);
    return;
  }
  try {
    await chrome.storage.sync.set({ accounts });
    setStatus('保存しました');
  } catch (e) {
    setStatus('保存に失敗しました: ' + e.message, true);
  }
});

load();

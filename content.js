// Gmail Auto BCC - コンテンツスクリプト
// 作成ウィンドウ（新規・返信・転送）を検出し、送信元アドレスごとに設定した BCC を自動入力する。
//
// 「送信元アドレス」= 作成ウィンドウの「送信元(From)」に入っているアドレス。
//   Gmail アカウント本体のアドレスでも、「送信元」で選ぶエイリアス（別ドメインのアドレス）でも同じ扱い。
//   送信元に設定がなければ何もしない（ログイン中アカウントの設定にはフォールバックしない）。
//   "*" を設定しておくと、個別設定のない送信元すべてに適用される。
//
// 二重追加を防ぐ仕組み（3段構え）
//   1. 同じ作成ウィンドウ（DOM要素）は1回しか処理しない
//   2. BCC 欄にすでに入っているアドレスは追加しない（下書きを開き直した場合はここで止まる）
//   3. 一度処理した下書き ID を記録し、再度開いても処理しない
//
// 送信元の切り替えに追従
//   作成ウィンドウを開いた後に「送信元」を変えると、この拡張機能が入れた BCC を外し、
//   新しい送信元の BCC を入れ直す。
//
// 実機で確認した Gmail の構造（2026年10月時点）
//   作成フォーム        : form.bAs（件名 input[name="subjectbox"] を含む）
//   送信元              : input[name="from"]（"名前 <addr>" または addr）
//   宛先/Cc/Bcc の行    : div[name="to"] / div[name="cc"] / div[name="bcc"]
//   入力欄              : その中の input[role="combobox"]（Bcc リンクを押すまで生成されないことがある）
//   入力済みのチップ    : その中の div[role="option"][data-hovercard-id="メールアドレス"]
//   チップの削除        : チップ内の div.afX をクリック
//   Bcc を表示するリンク: span.aB.gQ.pB（aria-label="Bcc の宛先を追加"）
//   下書き ID           : input[name="draft"]（例 "#msg-a:r-123..."）
//   本文エディタ        : [contenteditable="true"]（インライン返信では form の外、td.I5 の中）

(() => {
  'use strict';

  const LOG = '[Gmail Auto BCC]';
  const MAX_BCC = 5;
  const SUBJECT_SEL = 'input[name="subjectbox"]';
  const CONTAINER_SEL = '[role="dialog"], td.I5, div.ip, div.AD';
  const FIELD_SEL = 'input[role="combobox"], input:not([type="hidden"]), textarea';
  const CHIP_SEL = '[data-hovercard-id], [email], [data-email]';
  // Bcc を表示するリンクの候補。優先順に 1 つずつ試す
  // （まとめて querySelector すると「Bcc - 連絡先を選択します」のリンクが先にヒットすることがある）
  const BCC_TOGGLE_SELS = [
    'span.aB.pB',
    'span.pB[role="link"]',
    '[role="link"][aria-label*="Bcc" i]:not(.gO)',
    '[data-tooltip*="Bcc" i]:not(.gO)',
  ];
  const EMAIL_IN_TEXT = /[^\s<>(),;"]+@[^\s<>(),;"]+\.[^\s<>(),;"]+/;
  const FORWARD_MARKERS = ['Forwarded message', '転送メッセージ'];
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const FROM_WATCH_INTERVAL = 1000;

  const composeStates = new WeakMap(); // root -> { from, added:Set, timer }
  let accounts = {};
  let scanTimer = null;
  const reportedSenders = new Set();

  // ---------------------------------------------------------------- 設定
  async function loadSettings() {
    const data = await chrome.storage.sync.get({ accounts: {} });
    accounts = data.accounts || {};
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.accounts) {
      accounts = changes.accounts.newValue || {};
    }
  });

  // ---------------------------------------------------------------- 汎用
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').trim().toLowerCase();
  const isVisible = (el) => !!el && el.offsetParent !== null;

  async function waitFor(fn, timeout = 2000, interval = 100) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return fn() || null;
  }

  function extractEmail(s) {
    const m = (s || '').match(EMAIL_IN_TEXT);
    return m ? m[0] : null;
  }

  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  function fireKey(el, key, extra) {
    const code = key.length === 1 ? 'Key' + key.toUpperCase() : key;
    const keyCode = key === 'Enter' ? 13 : key.toUpperCase().charCodeAt(0);
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(
        new KeyboardEvent(type, Object.assign({
          key, code, keyCode, which: keyCode, bubbles: true, cancelable: true,
        }, extra || {}))
      );
    }
  }

  // ---------------------------------------------------------------- 送信元の判定
  // ログイン中アカウントのメールアドレス
  function detectAccountEmail() {
    // 例: "受信トレイ (3) - user@example.com - Gmail"
    const m = document.title.match(/([^\s<>()]+@[^\s<>()]+)\s*-\s*Gmail\s*$/);
    if (m) return m[1];
    // 右上のアカウントボタン: aria-label="Google アカウント: 名前 (user@example.com)"
    const a = document.querySelector('a[aria-label][href*="SignOutOptions"]');
    if (a) {
      const mm = a.getAttribute('aria-label').match(/\(([^()\s]+@[^()\s]+)\)/);
      if (mm) return mm[1];
    }
    return null;
  }

  // 作成ウィンドウの送信元アドレス（From 欄）。取れなければログイン中アカウント
  function currentSender(root) {
    const fromInput = root.querySelector('input[name="from"]');
    return (fromInput && extractEmail(fromInput.value)) || detectAccountEmail();
  }

  // 設定画面で選べるように、見つけた送信元アドレスを記録しておく
  async function reportSender(email) {
    if (!email || reportedSenders.has(norm(email))) return;
    reportedSenders.add(norm(email));
    try {
      const { detectedAccounts = [] } = await chrome.storage.local.get('detectedAccounts');
      if (!detectedAccounts.map(norm).includes(norm(email))) {
        detectedAccounts.push(email);
        await chrome.storage.local.set({ detectedAccounts: detectedAccounts.slice(-30) });
      }
    } catch (e) {
      /* 拡張機能の再読み込み直後などは失敗することがある */
    }
  }

  // 送信元アドレスに対応する設定（なければ "*"、それもなければ null）
  function resolveConfig(sender) {
    for (const c of [sender, '*']) {
      const key = norm(c);
      if (key && accounts[key]) return { key, conf: accounts[key] };
    }
    return null;
  }

  function configAddresses(conf) {
    return [...new Set((conf.bcc || []).map((a) => (a || '').trim()).filter((a) => EMAIL_IN_TEXT.test(a)))].slice(0, MAX_BCC);
  }

  // ---------------------------------------------------------------- 種別判定
  function detectKind(root, subjectBox) {
    const subj = norm(subjectBox.value);
    if (/^(fwd?|fw|転送)\s*[:：]/.test(subj)) return 'forward';
    const container = root.closest(CONTAINER_SEL) || root;
    const body = container.querySelector('[contenteditable="true"]');
    const bodyText = body ? body.innerText || '' : '';
    if (FORWARD_MARKERS.some((m) => bodyText.includes(m))) return 'forward';
    if (/^(re|返信)\s*[:：]/.test(subj)) return 'reply';
    if (container.querySelector('.gmail_quote')) return 'reply';
    return 'new';
  }

  // ---------------------------------------------------------------- 下書き ID
  function getDraftId(root) {
    const el = root.querySelector('input[name="draft"]');
    const v = el && el.value ? el.value.trim() : '';
    return v && v !== 'undefined' && v.length >= 6 ? v : null;
  }

  async function isDraftProcessed(id) {
    const { processedDrafts = [] } = await chrome.storage.local.get('processedDrafts');
    return processedDrafts.includes(id);
  }

  async function markDraftProcessed(id) {
    const { processedDrafts = [] } = await chrome.storage.local.get('processedDrafts');
    if (!processedDrafts.includes(id)) {
      processedDrafts.push(id);
      await chrome.storage.local.set({ processedDrafts: processedDrafts.slice(-300) });
    }
  }

  // ---------------------------------------------------------------- BCC 欄操作
  // BCC の行と入力欄を探す（新 UI → 旧 UI の順）
  function findBcc(root) {
    const row = root.querySelector('div[name="bcc"]');
    if (row) {
      const field = row.querySelector(FIELD_SEL);
      if (field) return { row, field };
    }
    const legacy = root.querySelector('input[name="bcc"], textarea[name="bcc"]');
    if (legacy) {
      // 宛先欄を含まない範囲まで親をたどって「行」とみなす
      const toField = root.querySelector('input[name="to"], textarea[name="to"]');
      let r = legacy;
      let p = legacy.parentElement;
      while (p && p !== root && !(toField && p.contains(toField))) {
        r = p;
        p = p.parentElement;
      }
      return { row: r, field: legacy };
    }
    return null;
  }

  function chipEmail(el) {
    return extractEmail(el.getAttribute('data-hovercard-id') || el.getAttribute('email') || el.getAttribute('data-email'));
  }

  function findChip(row, addr) {
    return [...row.querySelectorAll(CHIP_SEL)].find((el) => norm(chipEmail(el)) === norm(addr)) || null;
  }

  // BCC 欄にすでに入っているアドレス（チップ＋入力途中のテキスト）
  function existingAddresses(row, field) {
    const set = new Set();
    row.querySelectorAll(CHIP_SEL).forEach((el) => {
      const e = chipEmail(el);
      if (e) set.add(norm(e));
    });
    (field.value || '').split(/[,;]/).forEach((s) => {
      const e = extractEmail(s);
      if (e) set.add(norm(e));
    });
    return set;
  }

  function findBccToggle(root) {
    for (const sel of BCC_TOGGLE_SELS) {
      const el = root.querySelector(sel);
      if (el && !/連絡先|contacts/i.test(el.getAttribute('aria-label') || '')) return el;
    }
    return null;
  }

  // 隠れている BCC 行を表示する（インライン返信で宛先が折りたたまれている場合は表示されないが、追加自体はできる）
  function revealBcc(root) {
    const toggle = findBccToggle(root);
    if (toggle) {
      toggle.click();
      return true;
    }
    // 最終手段: ショートカット (Ctrl/Cmd + Shift + B)
    const toRow = root.querySelector('div[name="to"] input, input[name="to"], textarea[name="to"]');
    fireKey(toRow || root, 'b', { shiftKey: true, ctrlKey: !IS_MAC, metaKey: IS_MAC });
    return false;
  }

  // 1件のアドレスを入力欄に入れてチップ化する
  async function enterAddress(row, addr) {
    // Gmail が入力欄を作り直すことがあるので、毎回探し直す
    const getField = () => row.querySelector(FIELD_SEL);
    let field = getField();
    if (!field) return false;

    field.focus();
    field.value = addr;
    fire(field, 'input');
    await sleep(40);
    fireKey(field, 'Enter');
    await sleep(120);

    if (!findChip(row, addr)) {
      // もう一度 Enter（候補リストの表示待ちで無視されることがある）
      field = getField() || field;
      fireKey(field, 'Enter');
      await sleep(150);
    }
    if (!findChip(row, addr)) {
      // カンマで区切ってみる
      field = getField() || field;
      field.value = addr + ',';
      fire(field, 'input');
      await sleep(120);
    }
    if (!findChip(row, addr)) {
      // それでもだめならフォーカスを外して確定させる
      field = getField() || field;
      field.blur();
      fire(field, 'focusout');
      await sleep(120);
    }

    // チップになったのに入力欄にテキストが残っていると、Gmail が 2 件と数えるので消す
    field = getField() || field;
    if (findChip(row, addr) && norm(field.value)) {
      field.value = '';
      fire(field, 'input');
    }
    return !!findChip(row, addr);
  }

  // この拡張機能が入れたチップを外す
  async function removeAddress(row, addr) {
    const chip = findChip(row, addr);
    if (!chip) return false;
    const x = chip.querySelector('.afX') || chip.querySelector('[aria-label*="削除"], [aria-label*="remove" i], [role="button"]');
    if (!x) return false;
    x.click();
    await sleep(100);
    return !findChip(row, addr);
  }

  async function ensureBccField(root) {
    // 入力欄は Gmail が遅れて作ることがあるので、Bcc リンクを押しながら最大 3 秒ほど待つ
    let found = findBcc(root);
    for (let attempt = 0; attempt < 6 && !(found && isVisible(found.field)); attempt++) {
      revealBcc(root);
      await waitFor(() => { const f = findBcc(root); return f && isVisible(f.field) ? f : null; }, 500);
      found = findBcc(root);
      // インライン返信で宛先が折りたたまれていると入力欄は非表示のままだが、追加はできる
      if (found && !isVisible(found.field) && attempt >= 1) break;
    }
    if (!found) console.warn(LOG, 'BCC 欄が見つかりませんでした。Gmail の画面構成が変わった可能性があります。');
    return found;
  }

  // 返り値: 実際に追加したアドレスの配列
  async function insertBcc(root, addresses) {
    const prevActive = document.activeElement;
    const found = await ensureBccField(root);
    if (!found) return [];
    const { row, field } = found;

    const existing = existingAddresses(row, field);
    const missing = addresses.filter((a) => !existing.has(norm(a)));
    if (missing.length === 0) {
      console.log(LOG, 'BCC は入力済みのため追加しません');
      return [];
    }

    const added = [];
    if (field.tagName === 'TEXTAREA') {
      // 旧 UI: カンマ区切りのテキストを追記するだけでよい
      const cur = field.value.trim();
      field.value = (cur ? cur.replace(/[,;]?\s*$/, ', ') : '') + missing.join(', ');
      fire(field, 'input');
      fire(field, 'change');
      added.push(...missing);
    } else {
      for (const addr of missing) {
        if (await enterAddress(row, addr)) added.push(addr);
        else console.warn(LOG, 'チップ化できませんでした:', addr);
      }
    }

    if (prevActive && prevActive !== field && document.contains(prevActive)) {
      try { prevActive.focus(); } catch (e) { /* ignore */ }
    }
    if (added.length) console.log(LOG, 'BCC を追加しました:', added.join(', '));
    return added;
  }

  // ---------------------------------------------------------------- 作成ウィンドウ処理
  // 現在の送信元に合わせて BCC を入れる。state.added に入れたものを記録する
  async function applyForSender(root, state) {
    const sender = currentSender(root);
    state.from = norm(sender);
    reportSender(sender);
    const resolved = resolveConfig(sender);
    if (!resolved) {
      console.log(LOG, `送信元 ${sender} の設定がないため何もしません（設定画面で追加してください）`);
      return;
    }
    if (resolved.conf.enabled === false) {
      console.log(LOG, `送信元 ${sender} の設定は無効になっています`);
      return;
    }
    console.log(LOG, `送信元 ${sender} → 設定「${resolved.key}」を使います`);
    const addresses = configAddresses(resolved.conf);
    if (addresses.length === 0) return;
    const added = await insertBcc(root, addresses);
    added.forEach((a) => state.added.add(norm(a)));
  }

  // 送信元が切り替わったら、入れた BCC を外して入れ直す
  function watchSender(root, state) {
    state.timer = setInterval(async () => {
      if (!document.contains(root)) {
        clearInterval(state.timer);
        return;
      }
      if (state.busy) return;
      const now = norm(currentSender(root));
      if (!now || now === state.from) return;
      state.busy = true;
      try {
        console.log(LOG, `送信元が ${state.from} から ${now} に変わりました。BCC を入れ替えます`);
        const found = findBcc(root);
        if (found) {
          for (const addr of [...state.added]) await removeAddress(found.row, addr);
        }
        state.added.clear();
        await applyForSender(root, state);
      } catch (e) {
        console.warn(LOG, e);
      } finally {
        state.from = now;
        state.busy = false;
      }
    }, FROM_WATCH_INTERVAL);
  }

  async function handleCompose(root, subjectBox) {
    if (!document.contains(root)) return;
    const state = { from: null, added: new Set(), timer: null, busy: false };
    composeStates.set(root, state);

    const kind = detectKind(root, subjectBox);
    const sender = currentSender(root);
    reportSender(detectAccountEmail());
    reportSender(sender);

    const resolved = resolveConfig(sender);
    const conf = resolved ? resolved.conf : null;
    const apply = conf
      ? { new: conf.applyNew !== false, reply: conf.applyReply !== false, forward: conf.applyForward === true }
      : { new: true, reply: true, forward: false };
    if (!apply[kind]) {
      console.log(LOG, `種別「${kind}」は対象外のため何もしません`);
      return;
    }

    const draftId = getDraftId(root);
    if (draftId && (await isDraftProcessed(draftId))) {
      console.log(LOG, '処理済みの下書きのため何もしません:', draftId);
      state.from = norm(sender);
      watchSender(root, state);
      return;
    }

    await applyForSender(root, state);
    watchSender(root, state);

    // 下書き ID は作成直後から入っているが、念のため少し待ってから記録する
    const id = draftId || (await waitFor(() => (document.contains(root) ? getDraftId(root) : null), 15000, 1000));
    if (id) await markDraftProcessed(id);
  }

  function scan() {
    scanTimer = null;
    document.querySelectorAll(SUBJECT_SEL).forEach((sb) => {
      const root = sb.closest('form') || sb.closest('[role="dialog"]') || sb.closest('div.ip') || sb.closest('div.AD');
      if (!root || composeStates.has(root)) return;
      composeStates.set(root, { from: null, added: new Set(), timer: null, busy: false });
      // Gmail の描画が落ち着くのを少し待つ
      setTimeout(() => {
        handleCompose(root, sb).catch((e) => console.warn(LOG, e));
      }, 500);
    });
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, 200);
  }

  // ---------------------------------------------------------------- 起動
  loadSettings().then(() => {
    reportSender(detectAccountEmail());
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleScan();
    console.log(LOG, '起動しました');
  });
})();

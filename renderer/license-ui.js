// Lock screen (activation key, shared with Spine Preview / Mondiro Toolbox), Admin panel (manage
// keys), the update button + in-app update modal, and the green "latest" badge.
// The checking itself happens in the main process — see license.js and updater.js.
// Only runs inside Electron; the plain-browser UI test page skips it.
(() => {
  if (typeof require !== 'function') return;
  const { ipcRenderer, clipboard } = require('electron');

  const call = async (channel, ...args) => {
    const res = await ipcRenderer.invoke(channel, ...args);
    if (res.error) throw new Error(res.error);
    return res.result;
  };
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const toast = msg => (window.toast ? window.toast(msg) : console.log(msg));

  // ---- "latest" badge + update button (m-skill 2b): icon only, state shown by colour + tooltip ----
  const latestTag = document.getElementById('latestTag');
  const updBtn = document.getElementById('checkUpdateBtn');
  let version = '';
  call('app-version').then(v => { version = v; setUpdBtn(null, `đang dùng v${v}`); }).catch(() => {});
  const setLatest = on => { latestTag.hidden = !on; };
  const setUpdBtn = (cls, tip) => {
    updBtn.classList.remove('checking', 'ok', 'news', 'fail');
    if (cls) updBtn.classList.add(cls);
    const t = 'Kiểm tra cập nhật' + (tip ? ' · ' + tip : '');
    updBtn.title = t;
    updBtn.setAttribute('aria-label', t);
  };

  // ---- update modal (release notes + download progress), never an OS dialog ----
  const upd = { state: 'idle', version: null, notes: [], percent: 0 };
  let modal = null;

  function renderModal() {
    if (!modal) return;
    modal.querySelector('.upd-title-text').textContent = `Có bản mới ${upd.version ? 'v' + upd.version : ''}`;
    const notesEl = modal.querySelector('.upd-notes');
    notesEl.innerHTML = upd.notes.length
      ? '<ul>' + upd.notes.map(n => `<li>${esc(n)}</li>`).join('') + '</ul>'
      : '<div class="upd-notes-empty">Bản cập nhật này không có ghi chú.</div>';
    const go = modal.querySelector('.upd-go');
    const label = go.querySelector('span');
    go.classList.toggle('ready', upd.state === 'ready');
    go.classList.toggle('failed', upd.state === 'error');
    go.querySelector('.bar').style.width = (upd.state === 'downloading' ? upd.percent : upd.state === 'ready' ? 100 : 0) + '%';
    if (upd.state === 'ready') label.textContent = 'Cập nhật ngay · khởi động lại';
    else if (upd.state === 'error') label.textContent = 'Tải lỗi · thử lại';
    else label.textContent = `Đang tải ${upd.percent || 0}%`;
  }

  function openModal() {
    if (modal) { renderModal(); return; }
    modal = document.createElement('div');
    modal.className = 'upd-back';
    modal.innerHTML = `<div class="drag-strip"></div><div class="upd-card" role="dialog" aria-modal="true" aria-labelledby="upd-title">
      <div class="upd-title" id="upd-title"><svg class="i"><use href="#ic-sparkles"/></svg><span class="upd-title-text"></span></div>
      <div class="upd-sub">Bạn đang dùng bản v${esc(version)}. Cài đặt của bạn được giữ nguyên khi cập nhật.</div>
      <div class="upd-notes"></div>
      <div class="upd-actions"><button class="upd-later">Để sau</button><button class="upd-go"><i class="bar"></i><span></span></button></div>
    </div>`;
    modal.querySelector('.upd-later').onclick = closeModal;
    modal.querySelector('.upd-go').onclick = () => {
      if (upd.state === 'ready') ipcRenderer.send('update-install');
      else if (upd.state === 'error') { upd.state = 'downloading'; upd.percent = 0; renderModal(); ipcRenderer.send('update-retry'); }
    };
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); e.stopPropagation(); });
    document.body.append(modal);
    renderModal();
    modal.querySelector('.upd-later').focus();
  }
  function closeModal() {
    if (!modal) return;
    const m = modal;
    modal = null;
    m.classList.add('closing');
    setTimeout(() => m.remove(), 160);
  }

  ipcRenderer.on('update-status', (_e, s) => {
    if (s.version) upd.version = s.version;
    if (Array.isArray(s.notes)) upd.notes = s.notes;
    if (s.state === 'available') {
      upd.state = 'downloading'; upd.percent = 0;
      setLatest(false);
      setUpdBtn('news', `có bản v${upd.version}, đang tải`);
      openModal();
    } else if (s.state === 'downloading') {
      upd.state = 'downloading'; upd.percent = s.percent || 0;
      setLatest(false);
      setUpdBtn('news', `đang tải bản v${upd.version || ''} ${upd.percent}%`);
    } else if (s.state === 'ready') {
      upd.state = 'ready';
      setLatest(false);
      setUpdBtn('news', `bản v${upd.version} đã tải xong, bấm để cập nhật`);
      openModal();
    } else if (s.state === 'error') {
      if (upd.state === 'downloading') { upd.state = 'error'; setUpdBtn('fail', 'tải bản mới bị lỗi, bấm để thử lại'); }
    }
    renderModal();
  });

  updBtn.addEventListener('click', async () => {
    if (upd.state === 'downloading' || upd.state === 'ready' || upd.state === 'error') { openModal(); return; }
    if (updBtn.classList.contains('checking')) return;
    setUpdBtn('checking', 'đang kiểm tra…');
    let r;
    try { r = await call('update-check-now'); } catch (e) { r = { state: 'error' }; }
    if (!r || r.state === 'error') {
      setUpdBtn('fail', 'không kiểm tra được, thử lại sau');
      toast('Không kiểm tra được cập nhật, hãy kiểm tra mạng rồi thử lại');
    } else if (r.state === 'latest') {
      setLatest(true);
      setUpdBtn('ok', 'đã là bản mới nhất');
      toast(`Đã là bản mới nhất (v${version})`);
    } else {
      setLatest(false);
      setUpdBtn('news', `có bản v${r.version}`);
      if (!r.canDownload) toast(`Có bản v${r.version} trên GitHub (bản chạy thử không tự cập nhật)`);
    }
  });

  const refreshLatest = async () => {
    if (upd.state !== 'idle') return;
    try {
      const latest = await call('check-latest');
      if (latest === true) { setLatest(true); setUpdBtn('ok', 'đã là bản mới nhất'); }
      else if (latest === false) setLatest(false);
    } catch (e) { /* keep the previous state */ }
  };
  refreshLatest();
  setInterval(refreshLatest, 60 * 60 * 1000);

  // ---- lock screen ----
  const REASONS = {
    nokey: 'Nhập key kích hoạt mà Mondiro gửi cho bạn để bắt đầu dùng app (dùng chung key với Spine Preview).',
    invalid: 'Key không đúng. Kiểm tra lại hoặc liên hệ Mondiro.',
    revoked: 'Key của máy này đã bị thu hồi. Liên hệ Mondiro nếu cần dùng tiếp.',
    offline: 'Không kết nối được để kiểm tra key. Hãy kiểm tra mạng rồi thử lại.'
  };

  const lockMsg = el('div', { class: 'lock-msg', text: 'Đang kiểm tra quyền sử dụng...' });
  const keyInput = el('input', { type: 'text', class: 'lock-input', placeholder: 'SPV-XXXX-XXXX-XXXX-XXXX', spellcheck: 'false' });
  const activateBtn = el('button', { class: 'primary-btn', text: 'Kích hoạt' });
  const retryBtn = el('button', { class: 'secondary-btn', text: 'Thử lại' });
  const keyForm = el('div', { class: 'lock-form', hidden: '' }, [keyInput, activateBtn, retryBtn]);
  const lockOverlay = el('div', { id: 'lock-overlay' }, [
    el('div', { class: 'lock-card' }, [
      el('div', { class: 'lock-brand' }, [
        el('img', { class: 'lock-logo', src: '../build/icon-small.svg', alt: '' }),
        el('div', {}, [el('span', { class: 'brand-red', text: 'Mondiro' }), el('span', { class: 'brand-white', text: ' FormaLab' })])
      ]),
      lockMsg,
      keyForm
    ]),
    el('div', { class: 'lock-credit', text: 'Created by Mondiro' }),
    el('div', { class: 'drag-strip' })
  ]);
  document.body.append(lockOverlay);

  function applyStatus(status) {
    if (status && status.ok) {
      lockOverlay.hidden = true;
      return;
    }
    lockOverlay.hidden = false;
    keyForm.hidden = false;
    lockMsg.textContent = REASONS[(status && status.reason) || 'nokey'] || REASONS.nokey;
    lockMsg.classList.toggle('error', !!status && status.reason !== 'nokey');
    setTimeout(() => keyInput.focus(), 0);
  }

  async function check() {
    try { applyStatus(await call('license-check')); } catch (e) { applyStatus({ ok: false, reason: 'offline' }); }
  }

  async function doActivate() {
    activateBtn.disabled = true;
    lockMsg.textContent = 'Đang kiểm tra key...';
    lockMsg.classList.remove('error');
    try { applyStatus(await call('license-activate', keyInput.value)); } catch (e) { applyStatus({ ok: false, reason: 'offline' }); }
    activateBtn.disabled = false;
  }
  activateBtn.addEventListener('click', doActivate);
  keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') doActivate(); e.stopPropagation(); });
  retryBtn.addEventListener('click', check);
  ipcRenderer.on('license-status', (_e, status) => applyStatus(status));

  // ---- Admin panel ----
  const adminBody = el('div', { class: 'admin-body' });
  const adminMsg = el('div', { class: 'admin-msg' });
  const adminModal = el('div', { id: 'admin-modal', hidden: '' }, [
    el('div', { class: 'drag-strip' }),
    el('div', { class: 'admin-card' }, [
      el('div', { class: 'admin-head' }, [
        el('div', { class: 'admin-title', text: 'Quản lý key' }),
        el('button', { class: 'icon-btn', text: '✕', title: 'Đóng', onclick: () => { adminModal.hidden = true; } })
      ]),
      adminMsg,
      adminBody
    ])
  ]);
  document.body.append(adminModal);
  adminModal.addEventListener('keydown', e => e.stopPropagation());

  const setMsg = (text, isError) => {
    adminMsg.textContent = text || '';
    adminMsg.classList.toggle('error', !!isError);
  };
  const busy = async (fn, doneText) => {
    setMsg('Đang lưu lên GitHub...');
    adminModal.classList.add('busy');
    try {
      await fn();
      setMsg(doneText || '');
    } catch (e) {
      setMsg(e.message, true);
    }
    adminModal.classList.remove('busy');
  };

  async function openAdmin() {
    adminModal.hidden = false;
    setMsg('');
    if (await call('admin-status').catch(() => false)) renderList();
    else renderLogin();
  }

  function renderLogin() {
    const tokenInput = el('input', { type: 'password', class: 'lock-input', placeholder: 'github_pat_...' });
    const loginBtn = el('button', { class: 'primary-btn', text: 'Đăng nhập Admin' });
    const login = () => busy(async () => {
      await call('admin-login', tokenInput.value);
      await check();
      renderList();
    });
    loginBtn.addEventListener('click', login);
    tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
    adminBody.replaceChildren(
      el('p', { class: 'admin-hint', text: 'Dán GitHub token có quyền ghi (Contents: Read and write) vào repo Spine_Preview (danh sách key dùng chung với Spine Preview). Token được mã hóa và chỉ lưu trên máy này. Cách tạo token: xem README.' }),
      tokenInput,
      loginBtn
    );
    setTimeout(() => tokenInput.focus(), 0);
  }

  const maskKey = key => key.replace(/[A-Z0-9]{4}(?=-|$)/g, '••••');

  function keyRow(k) {
    const active = k.active !== false;
    let keyLine;
    if (k.key) {
      let shown = false;
      const keyText = el('code', { class: 'admin-key-text', text: maskKey(k.key) });
      const eyeBtn = el('button', { class: 'text-btn', text: 'Hiện', title: 'Ẩn/hiện key' });
      eyeBtn.addEventListener('click', () => {
        shown = !shown;
        keyText.textContent = shown ? k.key : maskKey(k.key);
        eyeBtn.textContent = shown ? 'Ẩn' : 'Hiện';
      });
      keyLine = el('div', { class: 'admin-key-line' }, [
        keyText,
        eyeBtn,
        el('button', { class: 'text-btn', text: 'Copy', onclick: () => { clipboard.writeText(k.key); setMsg(`Đã copy key của ${k.name}.`); } })
      ]);
    } else {
      keyLine = el('div', { class: 'admin-key-line' }, [
        el('span', { class: 'admin-key-missing', text: 'Key không lưu trên máy này' }),
        el('button', {
          class: 'text-btn', text: 'Đổi key', title: 'Tạo key mới cho người này, key cũ sẽ hết dùng được',
          onclick: () => {
            if (!confirm(`Tạo key mới cho "${k.name}"? Key cũ sẽ không dùng được nữa, bạn cần gửi key mới cho họ.`)) return;
            busy(async () => {
              const { key, keys } = await call('admin-regenerate', k.id);
              clipboard.writeText(key);
              showList(keys);
            }, `Đã tạo key mới cho ${k.name} và copy sẵn, gửi cho họ nhé.`);
          }
        })
      ]);
    }
    return el('div', { class: 'admin-row' + (active ? '' : ' revoked') }, [
      el('div', { class: 'admin-row-info' }, [
        el('div', { class: 'admin-row-name' }, [
          el('span', { text: k.name }),
          el('span', { class: 'admin-badge' + (active ? '' : ' off'), text: active ? 'Đang dùng' : 'Đã thu hồi' })
        ]),
        el('div', { class: 'admin-row-meta', text: [k.created, k.note].filter(Boolean).join(' · ') }),
        keyLine
      ]),
      el('button', {
        class: 'text-btn', text: active ? 'Thu hồi' : 'Mở lại',
        onclick: () => busy(async () => showList(await call('admin-set-active', k.id, !active)),
          active ? `Đã thu hồi key của ${k.name}. Máy đó sẽ bị khóa trong khoảng 15–20 phút.` : `Đã mở lại key của ${k.name}.`)
      }),
      el('button', {
        class: 'text-btn danger', text: 'Xóa',
        onclick: () => {
          if (!confirm(`Xóa hẳn key của "${k.name}"? Máy đó sẽ bị khóa và key không dùng lại được.`)) return;
          busy(async () => showList(await call('admin-remove', k.id)), `Đã xóa key của ${k.name}.`);
        }
      })
    ]);
  }

  let listEl = null;
  function showList(keys) {
    if (!listEl) return;
    listEl.replaceChildren(...(keys.length ? keys.map(keyRow) : [el('div', { class: 'admin-hint', text: 'Chưa có key nào.' })]));
  }

  async function renderList() {
    const nameInput = el('input', { type: 'text', class: 'lock-input', placeholder: 'Tên đồng nghiệp' });
    const noteInput = el('input', { type: 'text', class: 'lock-input', placeholder: 'Ghi chú (không bắt buộc)' });
    const addBtn = el('button', { class: 'primary-btn', text: '+ Tạo key mới' });
    addBtn.addEventListener('click', () => {
      const name = nameInput.value.trim();
      busy(async () => {
        const { keys } = await call('admin-add', name, noteInput.value);
        nameInput.value = '';
        noteInput.value = '';
        showList(keys);
      }, `Đã tạo key cho ${name}. Bấm "Hiện" hoặc "Copy" ở dòng của họ để lấy key.`);
    });
    listEl = el('div', { class: 'admin-list' }, [el('div', { class: 'admin-hint', text: 'Đang tải danh sách...' })]);
    adminBody.replaceChildren(
      el('div', { class: 'admin-add' }, [nameInput, noteInput, addBtn]),
      listEl,
      el('div', { class: 'admin-foot' }, [
        el('span', { class: 'admin-hint', text: 'Lưu ý: tên và ghi chú hiển thị công khai trên GitHub, key thì không.' }),
        el('button', {
          class: 'text-btn', text: 'Đăng xuất Admin',
          onclick: async () => { await call('admin-logout').catch(() => {}); adminModal.hidden = true; check(); }
        })
      ])
    );
    try {
      showList(await call('admin-list'));
    } catch (e) {
      listEl.replaceChildren(el('div', { class: 'admin-msg error', text: e.message }));
    }
  }

  // Ctrl+Shift+M opens the Admin panel from anywhere.
  window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); openAdmin(); }
  }, true);

  check();
})();

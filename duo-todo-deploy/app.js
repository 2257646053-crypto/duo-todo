/* 我们的待办 · 双人专属清单
 * Local-first PWA. Optional free Supabase sync. No build step, no dependencies.
 */
(function () {
  'use strict';

  const STATE_KEY = 'duotodo_state_v1';
  const CFG_KEY = 'duotodo_cloud_v1';

  const SQL = `-- 我们的待办 · 双人同步初始化（Supabase SQL Editor 里整段执行一次）
create table if not exists public.duo_rooms (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.duo_rooms enable row level security;
drop policy if exists duo_rooms_rw on public.duo_rooms;
create policy duo_rooms_rw on public.duo_rooms
  for all to anon, authenticated using (true) with check (true);

-- 服务端逐条合并，两个人同时编辑也不会互相覆盖
drop function if exists public.merge_room(text, jsonb);
create or replace function public.merge_room(p_id text, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cur jsonb; map jsonb := '{}'::jsonb; item jsonb;
  cur_items jsonb; inc_items jsonb; merged jsonb;
  cur_names_ts bigint; inc_names_ts bigint;
begin
  select data into cur from public.duo_rooms where id = p_id;
  if cur is null then
    insert into public.duo_rooms(id, data) values (p_id, p_data);
    return p_data;
  end if;
  cur_items := coalesce(cur->'items', '[]'::jsonb);
  inc_items := coalesce(p_data->'items', '[]'::jsonb);
  for item in select value from jsonb_array_elements(cur_items || inc_items) loop
    if jsonb_typeof(map->(item->>'id')) is null
       or coalesce((item->>'updatedAt'),'0')::bigint >= coalesce((map->(item->>'id'))->>'updatedAt','0')::bigint then
      map := jsonb_set(map, array[item->>'id'], item, true);
    end if;
  end loop;
  cur_names_ts := coalesce((cur->>'namesUpdatedAt'),'0')::bigint;
  inc_names_ts := coalesce((p_data->>'namesUpdatedAt'),'0')::bigint;
  merged := jsonb_build_object(
    'items', coalesce((select jsonb_agg(value) from jsonb_each(map)), '[]'::jsonb),
    'names', case when inc_names_ts >= cur_names_ts
                  then coalesce(p_data->'names', cur->'names')
                  else coalesce(cur->'names', p_data->'names') end,
    'namesUpdatedAt', greatest(cur_names_ts, inc_names_ts),
    'updatedAt', (extract(epoch from now())*1000)::bigint
  );
  update public.duo_rooms set data = merged, updated_at = now() where id = p_id;
  return merged;
end $$;
grant execute on function public.merge_room(text, jsonb) to anon, authenticated;`;

  // ---------------------------------------------------------------- helpers
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.prototype.slice.call(r.querySelectorAll(s));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const other = (x) => (x === 'A' ? 'B' : 'A');
  const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dtStr = (d) => `${dateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const svg = (id) => `<svg class="ic"><use href="#${id}"></use></svg>`;

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  function b64(s) {
    return btoa(unescape(encodeURIComponent(s)));
  }
  function unb64(s) {
    return decodeURIComponent(escape(atob(s)));
  }

  // ---------------------------------------------------------------- state
  function fresh() {
    return { v: 1, me: null, names: { A: '我', B: 'TA' }, namesUpdatedAt: 0, items: [] };
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return fresh();
      const s = JSON.parse(raw);
      return Object.assign(fresh(), s, {
        names: Object.assign({ A: '我', B: 'TA' }, s.names || {}),
        items: Array.isArray(s.items) ? s.items : []
      });
    } catch (e) { return fresh(); }
  }
  function loadCfg() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch (e) { return null; }
  }
  function saveState() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); }
    catch (e) { toast('本机存储写入失败，可能空间已满'); }
  }
  function saveCfg(c) {
    cloudCfg = c;
    try {
      if (c) localStorage.setItem(CFG_KEY, JSON.stringify(c));
      else localStorage.removeItem(CFG_KEY);
    } catch (e) { /* ignore */ }
  }

  let state = loadState();
  let cloudCfg = loadCfg();
  let tab = 'A';
  let editingId = null;
  let formOwner = 'A';
  let formPrio = 0;
  let setMeChoice = state.me || 'A';
  let showDone = false;
  let deferredPrompt = null;
  let syncing = false;
  let pushTimer = null;
  let pollTimer = null;

  const activeItems = () => state.items.filter((i) => !i.deleted);

  function sortItems(arr) {
    return arr.slice().sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.done) return (Number(b.doneAt) || 0) - (Number(a.doneAt) || 0);
      if ((Number(a.priority) || 0) !== (Number(b.priority) || 0)) {
        return (Number(b.priority) || 0) - (Number(a.priority) || 0);
      }
      const ad = a.due || '9999-12-31T23:59';
      const bd = b.due || '9999-12-31T23:59';
      if (ad !== bd) return ad < bd ? -1 : 1;
      return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
    });
  }

  // ---------------------------------------------------------------- rendering
  function render() {
    renderHeader();
    renderOverview();
    renderTabs();
    renderList();
    updateBadge();
  }

  function renderHeader() {
    const d = new Date();
    const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    const who = state.me ? `我是 ${state.names[state.me]}` : '还没选身份';
    $('#todayLine').textContent = `${d.getMonth() + 1}月${d.getDate()}日 周${week} · ${who}`;
  }

  function renderOverview() {
    const a = activeItems().filter((i) => !i.done);
    $('#ovMine').textContent = state.me ? a.filter((i) => i.owner === state.me).length : 0;
    $('#ovUs').textContent = a.filter((i) => i.owner === 'US').length;
    $('#ovTa').textContent = state.me ? a.filter((i) => i.owner === other(state.me)).length : 0;
    const today = dateStr(new Date());
    $('#ovToday').textContent = a.filter((i) => i.due && i.due.slice(0, 10) <= today).length;
  }

  function renderTabs() {
    $$('.tab').forEach((btn) => {
      const t = btn.dataset.tab;
      btn.classList.toggle('active', t === tab);
      const name = t === 'US' ? '我们' : state.names[t];
      $('.tab-name', btn).textContent = name;
      $(`[data-count="${t}"]`).textContent = activeItems().filter((i) => i.owner === t && !i.done).length;
    });
  }

  function dueChip(it) {
    if (!it.due) return '';
    const d = it.due;
    const day = d.slice(0, 10);
    const time = d.slice(11, 16) || '';
    const today = dateStr(new Date());
    const tmr = dateStr(new Date(Date.now() + 86400000));
    let label;
    if (day === today) label = `今天 ${time}`;
    else if (day === tmr) label = `明天 ${time}`;
    else label = `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日 ${time}`;
    const overdue = !it.done && d < dtStr(new Date());
    return `<span class="chip ${overdue ? 'overdue' : ''}">${overdue ? '已逾期 · ' : ''}${esc(label)}</span>`;
  }

  function duePlain(due) {
    if (!due) return '';
    const day = due.slice(0, 10);
    const time = due.slice(11, 16) || '';
    const today = dateStr(new Date());
    const tmr = dateStr(new Date(Date.now() + 86400000));
    if (day === today) return `今天 ${time}`;
    if (day === tmr) return `明天 ${time}`;
    return `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日 ${time}`;
  }

  function itemHtml(it) {
    const canCheck = it.owner === state.me || it.owner === 'US';
    const prio = Number(it.priority) || 0;
    const chips = (prio ? `<span class="chip p${prio}">${prio === 2 ? '紧急' : '重要'}</span>` : '') + dueChip(it);
    return `<article class="todo ${it.done ? 'is-done' : ''} p${prio}" data-owner="${it.owner}" data-id="${it.id}">
      <button class="check ${canCheck ? '' : 'locked'}" data-act="${canCheck ? 'toggle' : 'locked'}" aria-label="${canCheck ? '标记完成' : '只有本人能勾选'}">${canCheck ? svg('i-check') : svg('i-lock')}</button>
      <div class="todo-body" data-act="edit">
        <div class="todo-title">${esc(it.title)}</div>
        ${chips ? `<div class="todo-meta">${chips}</div>` : ''}
        ${it.note ? `<div class="todo-note">${esc(it.note)}</div>` : ''}
      </div>
      <div class="todo-actions">
        <button class="act-btn send" data-act="remind" aria-label="转发到微信提醒">${svg('i-send')}</button>
      </div>
    </article>`;
  }

  function emptyHtml() {
    const hint = tab === 'US' ? '一起要做的事记在这里' :
      (tab === state.me ? '点下面的按钮，记下第一件事' : '这里可以帮 TA 记一条，或者等 TA 同步过来');
    return `<div class="empty"><div class="empty-art">${svg('i-plus')}</div><b>这里还空着</b><p>${hint}</p></div>`;
  }

  function renderList() {
    const all = activeItems().filter((i) => i.owner === tab);
    const undone = sortItems(all.filter((i) => !i.done));
    const done = sortItems(all.filter((i) => i.done));
    let html = '';
    if (!undone.length && !done.length) {
      html = emptyHtml();
    } else {
      if (!undone.length) html += '<div class="empty" style="padding:24px 20px"><b>未完成的事都搞定啦</b></div>';
      html += undone.map(itemHtml).join('');
      if (done.length) {
        html += `<button class="done-head ${showDone ? 'open' : ''}" id="doneHead">${svg('i-chevron')}已完成 ${done.length} 条</button>`;
        if (showDone) html += done.map(itemHtml).join('');
      }
    }
    $('#list').innerHTML = html;
  }

  function updateBadge() {
    if (!('setAppBadge' in navigator)) return;
    const n = state.me
      ? activeItems().filter((i) => !i.done && (i.owner === state.me || i.owner === 'US')).length
      : 0;
    try {
      if (n > 0) navigator.setAppBadge(n).catch(() => {});
      else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- sheets
  function openSheet(id) {
    closeAllSheets(false);
    const el = $('#' + id);
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    $('#scrim').classList.add('open');
  }
  function closeAllSheets(keepWelcome) {
    $$('.sheet').forEach((s) => {
      if (keepWelcome && s.id === 'welcomeSheet' && s.classList.contains('open')) return;
      s.classList.remove('open');
      s.setAttribute('aria-hidden', 'true');
    });
    $('#scrim').classList.remove('open');
  }

  // ---------------------------------------------------------------- editor
  function openEditor(item) {
    editingId = item ? item.id : null;
    formOwner = item ? item.owner : tab;
    formPrio = item ? (Number(item.priority) || 0) : 0;
    const helpTa = !!state.me && formOwner !== state.me && formOwner !== 'US';
    $('#editTitle').textContent = item ? '编辑待办' : (helpTa ? '帮 TA 记一条' : '添加待办');
    $('#fTitle').value = item ? item.title : '';
    $('#fDue').value = item && item.due ? item.due : '';
    $('#fNote').value = item ? (item.note || '') : '';
    $('#btnDeleteItem').hidden = !item;
    syncSeg('#fOwner', 'owner', formOwner);
    syncSeg('#fPriority', 'prio', String(formPrio));
    openSheet('editSheet');
  }
  function syncSeg(sel, attr, val) {
    $$('button', $(sel)).forEach((b) => b.classList.toggle('on', b.dataset[attr] === val));
  }

  function quickDate(kind) {
    if (kind === 'clear') return '';
    const now = new Date();
    const d = new Date(now);
    if (kind === 'today') {
      d.setHours(20, 0, 0, 0);
      if (d <= now) d.setTime(now.getTime() + 60 * 60 * 1000);
    } else if (kind === 'tomorrow') {
      d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
    } else if (kind === 'sunday') {
      d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); d.setHours(18, 0, 0, 0);
      if (d <= now) d.setDate(d.getDate() + 7);
    }
    return dtStr(d);
  }

  function saveItem() {
    const title = $('#fTitle').value.trim();
    if (!title) { toast('先写一下要做什么'); $('#fTitle').focus(); return; }
    const note = $('#fNote').value.trim();
    const due = $('#fDue').value || '';
    const ts = Date.now();
    if (editingId) {
      const it = state.items.find((x) => x.id === editingId);
      if (!it) return;
      Object.assign(it, { title, note, due, owner: formOwner, priority: formPrio, updatedAt: ts });
    } else {
      state.items.push({
        id: uid(), owner: formOwner, title, note, due,
        priority: formPrio, done: false, doneAt: 0,
        createdAt: ts, updatedAt: ts, deleted: false
      });
    }
    tab = formOwner;
    saveState();
    closeAllSheets(false);
    render();
    scheduleSync();
    toast(editingId ? '已更新' : '记下了');
  }

  function deleteItem() {
    const it = state.items.find((x) => x.id === editingId);
    if (!it) return;
    if (!confirm(`删除「${it.title}」？`)) return;
    it.deleted = true;
    it.updatedAt = Date.now();
    saveState();
    closeAllSheets(false);
    render();
    scheduleSync();
    toast('已删除');
  }

  // ---------------------------------------------------------------- reminder
  function buildReminder(it) {
    const meName = state.me ? state.names[state.me] : '我';
    const taName = state.me ? state.names[other(state.me)] : 'TA';
    const lines = [];
    if (it.owner === 'US') lines.push(`一起记着：${it.title}`);
    else if (it.owner === state.me) lines.push(`我记了一件事：${it.title}`);
    else lines.push(`${taName}，记得「${it.title}」哦`);
    const due = duePlain(it.due);
    if (due) lines.push(`时间：${due}`);
    if (it.note) lines.push(`备注：${it.note}`);
    lines.push(`—— ${meName} · 我们的待办`);
    return lines.join('\n');
  }

  async function shareReminder(it) {
    const text = buildReminder(it);
    if (navigator.share) {
      try {
        await navigator.share({ title: '我们的待办', text });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // 用户取消分享面板
      }
    }
    const ok = await copyText(text);
    toast(ok ? '已复制，打开微信粘贴发给 TA' : '复制失败，请换个浏览器试试');
  }

  // ---------------------------------------------------------------- cloud sync
  function setSync(kind, text) {
    $('#syncBar').className = 'syncbar ' + (kind || '');
    $('#syncText').textContent = text;
  }
  function cloudStatus(text) { $('#cloudStatus').textContent = text; }

  function cfetch(path, opt) {
    opt = opt || {};
    const base = cloudCfg.url.replace(/\/+$/, '');
    return fetch(`${base}/rest/v1/${path}`, Object.assign({}, opt, {
      headers: Object.assign({
        apikey: cloudCfg.key,
        Authorization: 'Bearer ' + cloudCfg.key,
        'Content-Type': 'application/json'
      }, opt.headers || {})
    })).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r;
    });
  }

  function mergeRemote(remote) {
    if (!remote || !Array.isArray(remote.items)) return false;
    const map = new Map(state.items.map((i) => [i.id, i]));
    let changed = false;
    remote.items.forEach((it) => {
      if (!it || !it.id) return;
      const cur = map.get(it.id);
      if (!cur || (Number(it.updatedAt) || 0) > (Number(cur.updatedAt) || 0)) {
        map.set(it.id, it);
        changed = true;
      }
    });
    const rts = Number(remote.namesUpdatedAt) || 0;
    if (rts > (Number(state.namesUpdatedAt) || 0) && remote.names) {
      state.names = Object.assign({ A: '我', B: 'TA' }, state.names, remote.names);
      state.namesUpdatedAt = rts;
      changed = true;
    }
    if (changed) {
      state.items = Array.from(map.values());
      saveState();
      render();
    }
    return changed;
  }

  async function cloudPull() {
    const room = encodeURIComponent(cloudCfg.room);
    const res = await cfetch(`duo_rooms?id=eq.${room}&select=data`);
    const rows = await res.json();
    if (rows && rows.length && rows[0].data) mergeRemote(rows[0].data);
  }

  async function cloudPush() {
    const payload = {
      items: state.items,
      names: state.names,
      namesUpdatedAt: state.namesUpdatedAt || 0,
      updatedAt: Date.now()
    };
    try {
      const res = await cfetch('rpc/merge_room', {
        method: 'POST',
        body: JSON.stringify({ p_id: cloudCfg.room, p_data: payload })
      });
      const merged = await res.json();
      if (merged && Array.isArray(merged.items)) mergeRemote(merged);
    } catch (e) {
      // 没建合并函数时降级为整包 upsert，同步依然可用
      await cfetch('duo_rooms', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ id: cloudCfg.room, data: payload, updated_at: new Date().toISOString() })
      });
    }
  }

  async function syncNow() {
    if (!cloudCfg || syncing) return;
    syncing = true;
    setSync('syncing', '同步中…');
    try {
      await cloudPull();
      await cloudPush();
      const t = new Date();
      setSync('ok', `已同步 · ${pad(t.getHours())}:${pad(t.getMinutes())}`);
      cloudStatus('连接正常 · 两台手机房间码一致就会自动同步');
    } catch (e) {
      setSync('error', '云端连不上，已存本机');
      cloudStatus('连接失败：' + e.message + '（检查 URL / key / 是否已执行建表 SQL）');
    } finally {
      syncing = false;
    }
  }

  function scheduleSync() {
    if (!cloudCfg) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(syncNow, 700);
  }

  function startSync() {
    stopSync();
    if (!cloudCfg) { setSync('', '仅存本机'); return; }
    syncNow();
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') syncNow();
    }, 20000);
  }
  function stopSync() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function readCloudInputs() {
    const u = $('#cloudUrl').value.trim().replace(/\/+$/, '');
    const k = $('#cloudKey').value.trim();
    const r = $('#cloudRoom').value.trim();
    if (!u || !k || !r) return false;
    saveCfg({ url: u, key: k, room: r });
    return true;
  }

  function fillCloudInputs() {
    const c = cloudCfg || {};
    $('#cloudUrl').value = c.url || '';
    $('#cloudKey').value = c.key || '';
    $('#cloudRoom').value = c.room || '';
    cloudStatus(cloudCfg ? '已开启 · 房间码 ' + cloudCfg.room : '未开启（数据只存本机）');
  }

  function randomRoom() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    const arr = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(arr);
    for (let i = 0; i < arr.length; i++) s += chars[arr[i] % chars.length];
    return s;
  }

  async function copyConfig() {
    if (!readCloudInputs()) { toast('先把 URL、key、房间码填完整'); return; }
    const token = 'DUOTODO1|' + b64(JSON.stringify(cloudCfg));
    if (await copyText(token)) toast('已复制，发到微信给 TA 粘贴导入');
    else toast('复制失败，请手动长按复制输入框内容');
  }

  async function importConfig(text) {
    const raw = (text || $('#cfgInput').value || '').trim();
    if (!raw) {
      try { $('#cfgInput').value = await navigator.clipboard.readText(); }
      catch (e) { toast('把 TA 发来的配置粘贴到输入框'); }
      if (!$('#cfgInput').value.trim()) return;
      return importConfig($('#cfgInput').value);
    }
    try {
      if (!raw.startsWith('DUOTODO1|')) throw new Error('bad prefix');
      const c = JSON.parse(unb64(raw.slice(raw.indexOf('|') + 1)));
      if (!c.url || !c.key || !c.room) throw new Error('bad payload');
      saveCfg({ url: c.url, key: c.key, room: c.room });
      fillCloudInputs();
      startSync();
      toast('已连上同一个房间');
    } catch (e) { toast('配置格式不对，请复制完整的一串'); }
  }

  // ---------------------------------------------------------------- backup
  function exportData() {
    const data = Object.assign({ app: 'duo-todo', v: 1, exportedAt: new Date().toISOString() }, state);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `我们的待办-备份-${dateStr(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast('备份文件已下载');
  }

  function importData(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const d = JSON.parse(fr.result);
        if (!Array.isArray(d.items)) throw new Error('bad file');
        mergeRemote(d);
        saveState(); render(); scheduleSync();
        toast('已合并导入，原有内容不会丢');
      } catch (e) { toast('文件格式不对'); }
    };
    fr.readAsText(file);
  }

  function clearData() {
    if (!confirm('确定清空全部待办？此操作不可撤销，建议先导出备份。')) return;
    state.items = [];
    showDone = false;
    saveState(); render(); scheduleSync();
    toast('已清空');
  }

  function openSettings() {
    $('#setNameA').value = state.names.A;
    $('#setNameB').value = state.names.B;
    setMeChoice = state.me || 'A';
    syncSeg('#setMe', 'me', setMeChoice);
    fillCloudInputs();
    openSheet('settingsSheet');
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    const safe = location.protocol === 'https:' ||
      ['localhost', '127.0.0.1'].indexOf(location.hostname) >= 0;
    if (!safe) return;
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // ---------------------------------------------------------------- events
  function bindEvents() {
    $('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('.tab');
      if (!b) return;
      tab = b.dataset.tab;
      showDone = false;
      renderTabs(); renderList();
    });

    $('#list').addEventListener('click', (e) => {
      const head = e.target.closest('#doneHead');
      if (head) { showDone = !showDone; renderList(); return; }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const el = btn.closest('.todo');
      if (!el) return;
      const it = state.items.find((x) => x.id === el.dataset.id);
      if (!it) return;
      const act = btn.dataset.act;
      if (act === 'locked') { toast('只有 TA 本人能勾选完成'); return; }
      if (act === 'toggle') {
        it.done = !it.done;
        it.doneAt = it.done ? Date.now() : 0;
        it.updatedAt = Date.now();
        saveState(); render(); scheduleSync();
      } else if (act === 'edit') openEditor(it);
      else if (act === 'remind') shareReminder(it);
    });

    $('#btnAdd').addEventListener('click', () => openEditor(null));
    $('#btnSettings').addEventListener('click', openSettings);
    $('#btnSaveItem').addEventListener('click', saveItem);
    $('#btnDeleteItem').addEventListener('click', deleteItem);
    $('#scrim').addEventListener('click', () => closeAllSheets(true));
    $$('[data-close]').forEach((b) => b.addEventListener('click', () => closeAllSheets(false)));

    $('#fOwner').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-owner]'); if (!b) return;
      formOwner = b.dataset.owner;
      syncSeg('#fOwner', 'owner', formOwner);
    });
    $('#fPriority').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-prio]'); if (!b) return;
      formPrio = Number(b.dataset.prio);
      syncSeg('#fPriority', 'prio', b.dataset.prio);
    });
    $('#fQuick').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-quick]'); if (!b) return;
      $('#fDue').value = quickDate(b.dataset.quick);
    });
    $('#fTitle').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveItem(); }
    });

    ['#nickA', '#nickB'].forEach((sel) => $(sel).addEventListener('input', () => {
      $('#pickNameA').textContent = $('#nickA').value.trim() || '我';
      $('#pickNameB').textContent = $('#nickB').value.trim() || 'TA';
    }));
    function pick(who) {
      state.me = who;
      state.names = { A: $('#nickA').value.trim() || '我', B: $('#nickB').value.trim() || 'TA' };
      state.namesUpdatedAt = Date.now();
      tab = who;
      setMeChoice = who;
      saveState();
      closeAllSheets(false);
      render();
      scheduleSync();
      toast('搞定，开始记第一件事吧');
    }
    $('#btnPickA').addEventListener('click', () => pick('A'));
    $('#btnPickB').addEventListener('click', () => pick('B'));

    $('#setMe').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-me]'); if (!b) return;
      setMeChoice = b.dataset.me;
      syncSeg('#setMe', 'me', setMeChoice);
    });
    $('#btnSaveSettings').addEventListener('click', () => {
      const a = $('#setNameA').value.trim() || '我';
      const b = $('#setNameB').value.trim() || 'TA';
      if (a !== state.names.A || b !== state.names.B) {
        state.names = { A: a, B: b };
        state.namesUpdatedAt = Date.now();
      }
      state.me = setMeChoice;
      readCloudInputs();
      saveState();
      closeAllSheets(false);
      startSync();
      render();
      toast('已保存');
    });

    $('#btnGenRoom').addEventListener('click', () => {
      $('#cloudRoom').value = randomRoom();
      toast('房间码已生成，记得发给 TA');
    });
    $('#btnTestCloud').addEventListener('click', async () => {
      if (!readCloudInputs()) { toast('先把三项填完整'); return; }
      fillCloudInputs();
      await syncNow();
      if ($('#syncBar').classList.contains('ok')) toast('连接成功，两台手机填一样的房间码就行');
    });
    $('#btnCopyConfig').addEventListener('click', copyConfig);
    $('#btnPasteConfig').addEventListener('click', () => importConfig());
    $('#btnCloudOff').addEventListener('click', () => {
      saveCfg(null);
      stopSync();
      setSync('', '仅存本机');
      $('#cloudUrl').value = ''; $('#cloudKey').value = ''; $('#cloudRoom').value = '';
      cloudStatus('已关闭同步，数据仍完整保存在本机');
      toast('已关闭同步');
    });
    $('#btnCopySQL').addEventListener('click', async () => {
      toast(await copyText(SQL) ? '建表 SQL 已复制' : '复制失败，请手动选择');
    });
    $('#btnExport').addEventListener('click', exportData);
    $('#btnImport').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) importData(e.target.files[0]);
      e.target.value = '';
    });
    $('#btnClear').addEventListener('click', clearData);
    $('#btnHelp').addEventListener('click', () => openSheet('helpSheet'));

    $('#btnInstall').addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (e) { /* ignore */ }
      deferredPrompt = null;
      $('#installBar').hidden = true;
    });
    $('#btnInstallClose').addEventListener('click', () => {
      $('#installBar').hidden = true;
      try { localStorage.setItem('duo_install_dismissed', '1'); } catch (e) { /* ignore */ }
    });
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      if (localStorage.getItem('duo_install_dismissed')) return;
      if (window.matchMedia('(display-mode: standalone)').matches) return;
      $('#installBar').hidden = false;
    });
    window.addEventListener('appinstalled', () => {
      $('#installBar').hidden = true;
      deferredPrompt = null;
      toast('已添加到桌面');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && cloudCfg) syncNow();
    });
    window.addEventListener('online', () => { if (cloudCfg) syncNow(); });
  }

  function init() {
    bindEvents();
    tab = state.me || 'A';
    render();
    if (!state.me) {
      openSheet('welcomeSheet');
      setSync('', '仅存本机');
    } else if (cloudCfg) {
      startSync();
    } else {
      setSync('', '仅存本机');
    }
    registerSW();
  }

  init();
})();

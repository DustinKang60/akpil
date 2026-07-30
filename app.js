'use strict';

/* ─────────── 짧은 도우미 ─────────── */
const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const clock = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};

let toastTimer;
function toast(msg, ms = 2000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), ms);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('is-active', s.id === id));
}

/* ─────────── 저장소 (IndexedDB) ─────────── */
const DB = {
  _p: null,
  open() {
    if (this._p) return this._p;
    this._p = new Promise((res, rej) => {
      const r = indexedDB.open('akpil', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('meetings', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this._p;
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('meetings', mode);
      const req = fn(t.objectStore('meetings'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  },
  put(rec) { return this.tx('readwrite', (s) => s.put(rec)); },
  get(id) { return this.tx('readonly', (s) => s.get(id)); },
  del(id) { return this.tx('readwrite', (s) => s.delete(id)); },
  all() { return this.tx('readonly', (s) => s.getAll()); },
};

/* ─────────── 설정 ─────────── */
const DEFAULTS = { record: true, gap: 8, chips: true, size: 15, dict: [] };

function loadSet() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('akpil.set') || '{}') || {}; } catch { /* 깨졌으면 기본값 */ }
  const s = Object.assign({}, DEFAULTS, saved);
  // dict 는 배열이라 그냥 두면 DEFAULTS 의 것을 함께 쓰게 된다 → 기본값이 오염된다
  s.dict = Array.isArray(s.dict) ? s.dict.map((r) => ({ from: String(r.from || ''), to: String(r.to || '') })) : [];
  return s;
}
let SET = loadSet();
function saveSet() { localStorage.setItem('akpil.set', JSON.stringify(SET)); }

// 늘 틀리게 들리는 말을 바로잡는다. 긴 것부터 바꿔야 짧은 규칙이 먼저 먹지 않는다.
function fixTerms(text) {
  const rules = (SET.dict || []).filter((r) => r.from).sort((a, b) => b.from.length - a.from.length);
  return rules.reduce((s, r) => s.split(r.from).join(r.to), text);
}

function applySet() {
  document.documentElement.style.setProperty('--seg-size', SET.size + 'px');
  $('#speakers').hidden = !SET.chips;
}

/* ─────────── 앱 상태 ─────────── */
const app = {
  state: 'idle',          // idle | rec | paused
  segments: [],           // {id, t, speaker, text, mark}
  speaker: '',
  startedAt: 0,
  accrued: 0,             // 일시정지 구간을 뺀 누적 ms
  stream: null,
  recorder: null,
  chunks: [],
  audioBlob: null,
  mime: '',
  recog: null,
  recogWanted: false,     // 인식이 계속 돌아야 하는 상태인가
  recogLast: null,        // 마지막 인식 문단 (자라는 발화를 교체로 잇기 위함)
  restartAt: 0,
  restartFails: 0,
  wakeLock: null,
  tick: null,
  editing: false,
  current: null,          // 정리 화면에 열려 있는 회의 레코드
};

const elapsedMs = () =>
  app.accrued + (app.state === 'rec' ? Date.now() - app.startedAt : 0);

/* ─────────── 화자 칩 ─────────── */
function loadSpeakers() {
  try { return JSON.parse(localStorage.getItem('akpil.speakers') || '[]'); }
  catch { return []; }
}
function saveSpeakers(list) {
  localStorage.setItem('akpil.speakers', JSON.stringify(list));
}
function renderSpeakers() {
  const box = $('#speakers');
  const names = loadSpeakers();
  box.querySelectorAll('.chip:not(.chip-add)').forEach((c) => c.remove());
  const add = $('#btn-add-speaker');

  const mk = (name, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (app.speaker === name ? ' is-on' : '');
    b.dataset.speaker = name;
    b.textContent = label;
    box.insertBefore(b, add);
  };
  mk('', '화자 없음');
  names.forEach((n) => mk(n, n));
}

/* ─────────── 문단 렌더링 ─────────── */
function segEl(seg) {
  const div = document.createElement('div');
  div.className = 'seg' + (seg.mark === 'mark' ? ' is-marked' : seg.mark === 'todo' ? ' is-todo' : '');
  div.dataset.id = seg.id;
  div.dataset.t = seg.t;

  const head = document.createElement('div');
  head.className = 'seg-head';
  const tags = [];
  if (seg.speaker) tags.push(['tag-speaker', seg.speaker]);
  if (seg.mark === 'mark') tags.push(['tag-mark', '중요']);
  if (seg.mark === 'todo') tags.push(['tag-todo', '할일']);
  tags.push(['tag-time', clock(seg.t)]);
  tags.forEach(([cls, txt]) => {
    const s = document.createElement('span');
    s.className = 'tag ' + cls;
    s.textContent = txt;
    head.appendChild(s);
  });

  const body = document.createElement('p');
  body.className = 'seg-body';
  body.textContent = seg.text;
  if (app.editing) body.contentEditable = 'true';

  div.append(head, body);
  return div;
}

function renderTranscript(target = $('#transcript'), segs = app.segments, withInterim = true) {
  target.innerHTML = '';
  if (!segs.length && !withInterim) {
    const p = document.createElement('p');
    p.className = 'seg-body';
    p.style.color = 'var(--text-3)';
    p.textContent = '변환된 내용이 없습니다.';
    target.appendChild(p);
    return;
  }
  if (!segs.length && target.id === 'transcript') {
    target.innerHTML =
      '<div class="empty" id="empty-hint"><p>듣고 있습니다…<br>말소리가 들리면 여기에 나타납니다.</p></div>';
  }
  segs.forEach((s) => target.appendChild(segEl(s)));

  if (withInterim && target.id === 'transcript') {
    const i = document.createElement('p');
    i.className = 'seg-body';
    i.id = 'interim';
    target.appendChild(i);
  }
  target.scrollTop = target.scrollHeight;
}

// 새 문단을 화면 끝에 붙인다. 한 시간짜리 회의면 문단이 수백 개가 되므로
// 매번 전체를 다시 그리지 않고 이 문단 하나만 DOM 에 넣는다.
function appendSeg(seg) {
  const box = $('#transcript');
  const hint = $('#empty-hint');
  if (hint) hint.remove();
  const interim = $('#interim');
  if (interim) box.insertBefore(segEl(seg), interim);
  else box.appendChild(segEl(seg));
  box.scrollTop = box.scrollHeight;
}

// 공백을 하나로 정규화 (접두사 비교용)
const norm = (s) => s.replace(/\s+/g, ' ').trim();

// b 가 a 가 자란 것인가? (한쪽이 다른 쪽으로 시작하면 같은 발화가 커지는 중)
function isGrowth(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return y.startsWith(x) || x.startsWith(y);
}

// 인식 결과 하나를 문단에 반영한다.
//
// 이 기기(안드로이드 크롬)는 하나의 발화를 "자라는 채로"
// (음 서울에 한 → 음 서울에 한 사립대학교 → …) 확정 결과로 여러 번 보내고,
// 인식을 자주 끊었다 재시작하며 그때마다 결과 인덱스를 0 으로 되돌린다.
// 그래서 인덱스로는 같은 발화를 못 묶는다.
//
// 대신 내용을 본다: 방금 온 문장이 마지막 문단이 "자란 것"이면(접두사 관계)
// 새로 붙이지 말고 그 문단을 최신 값으로 교체한다. 화자가 바뀌었거나,
// 사용자가 중요·할일로 표시한 문단이면 건드리지 않고 새 문단으로 시작한다.
function ingestFinal(raw) {
  const text = fixTerms(raw);
  const box = $('#transcript');
  const last = app.recogLast;
  const canGrow = last && last.speaker === app.speaker && !last.mark
    && isGrowth(last.rawText, raw);

  if (canGrow) {
    // 더 긴 쪽을 남긴다 (드물게 짧아진 결과가 와도 내용이 사라지지 않게)
    if (norm(raw).length >= norm(last.rawText).length) {
      last.rawText = raw;
      last.text = text;
      last.lastAt = elapsedMs();
      const body = box.querySelector(`.seg[data-id="${last.id}"] .seg-body`);
      if (body) body.textContent = text;
      else renderTranscript();
      box.scrollTop = box.scrollHeight;
    }
  } else {
    const s = {
      id: 's' + Date.now() + Math.random().toString(36).slice(2, 6),
      t: elapsedMs(), lastAt: elapsedMs(), speaker: app.speaker, text, rawText: raw, mark: null,
    };
    app.segments.push(s);
    app.recogLast = s;
    appendSeg(s);
  }
  saveDraft();
}

// 테스트·초안 복구처럼 인식 밖에서 문단을 직접 넣을 때 쓴다.
function pushText(raw) {
  const s = {
    id: 's' + Date.now() + Math.random().toString(36).slice(2, 6),
    t: elapsedMs(), lastAt: elapsedMs(), speaker: app.speaker, text: fixTerms(raw), mark: null,
  };
  app.segments.push(s);
  appendSeg(s);
  saveDraft();
}

/* ─────────── 초안 보관 (앱이 죽어도 글은 남게) ─────────── */
let draftTimer;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      localStorage.setItem('akpil.draft', JSON.stringify({
        at: Date.now(), dur: elapsedMs(), segments: app.segments,
      }));
    } catch { /* 용량 초과는 무시 */ }
  }, 1500);
}
const clearDraft = () => localStorage.removeItem('akpil.draft');

/* ─────────── 음성 인식 ─────────── */
function makeRecognizer() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;

  const r = new SR();
  r.lang = 'ko-KR';
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;

  // 세션마다 결과 목록은 0 부터 다시 쌓인다. 같은 세션 안에서 같은 확정
  // 결과를 중복 처리하지 않도록, 인덱스별로 마지막에 본 확정 텍스트를 기억한다.
  // 재시작해도 app.recogLast 는 살아 있어, 이어지는 발화는 내용으로 묶인다.
  let seenFinal = [];
  r.onstart = () => { seenFinal = []; };

  r.onresult = (e) => {
    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const res = e.results[i];
      const txt = (res[0] && res[0].transcript || '').trim();
      if (!txt) continue;
      if (res.isFinal) {
        if (seenFinal[i] !== txt) {           // 이 자리 확정이 처음이거나 자랐을 때만
          seenFinal[i] = txt;
          ingestFinal(txt);
        }
      } else {
        interim += txt + ' ';                 // 아직 확정 전 → 미리보기 줄에만
      }
    }
    const el = $('#interim');
    if (el) {
      el.textContent = interim;
      if (interim) $('#transcript').scrollTop = $('#transcript').scrollHeight;
    }
  };

  r.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      app.recogWanted = false;
      toast('마이크 권한이 없습니다. 브라우저 설정에서 허용해 주세요.', 4000);
    } else if (e.error === 'network') {
      toast('네트워크가 끊겼습니다. 인터넷 연결을 확인해 주세요.', 3000);
    }
    // no-speech, aborted 는 흔한 일이라 조용히 넘어간다 (onend 가 재시작)
  };

  r.onend = () => {
    if (!app.recogWanted) return;
    // 아이폰은 수십 초마다 스스로 끊긴다 → 곧바로 되살린다.
    const gap = Date.now() - app.restartAt;
    app.restartFails = gap < 500 ? app.restartFails + 1 : 0;
    if (app.restartFails > 8) {
      app.recogWanted = false;
      toast('음성 인식이 계속 끊깁니다. 종료 후 다시 시작해 주세요.', 4000);
      return;
    }
    app.restartAt = Date.now();
    setTimeout(() => {
      if (!app.recogWanted) return;
      try { r.start(); } catch { /* 이미 돌고 있으면 무시 */ }
    }, Math.min(120 * (app.restartFails + 1), 800));
  };

  return r;
}

/* ─────────── 녹음 ─────────── */
function pickMime() {
  const list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  if (!window.MediaRecorder) return '';
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

async function startRecorder() {
  try {
    app.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    app.mime = pickMime();
    app.recorder = new MediaRecorder(app.stream, app.mime ? { mimeType: app.mime } : undefined);
    app.chunks = [];
    app.recorder.ondataavailable = (e) => { if (e.data && e.data.size) app.chunks.push(e.data); };
    app.recorder.start(4000);
    return true;
  } catch (err) {
    app.recorder = null;
    toast('녹음은 못 하지만 받아쓰기는 계속됩니다.', 3500);
    console.warn('recorder off:', err);
    return false;
  }
}

function stopRecorder() {
  return new Promise((res) => {
    if (!app.recorder || app.recorder.state === 'inactive') return res(null);
    app.recorder.onstop = () => {
      const blob = app.chunks.length
        ? new Blob(app.chunks, { type: app.mime || 'audio/webm' })
        : null;
      res(blob);
    };
    try { app.recorder.stop(); } catch { res(null); }
  });
}

/* ─────────── 화면 꺼짐 방지 ─────────── */
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    app.wakeLock = await navigator.wakeLock.request('screen');
    $('#wake-badge').hidden = false;
    app.wakeLock.addEventListener('release', () => { $('#wake-badge').hidden = true; });
  } catch { /* 배터리 절약 모드 등에서 거부될 수 있다 */ }
}
function releaseWakeLock() {
  if (app.wakeLock) { app.wakeLock.release().catch(() => {}); app.wakeLock = null; }
  $('#wake-badge').hidden = true;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && app.state === 'rec' && !app.wakeLock) acquireWakeLock();
});

/* ─────────── 시작 / 일시정지 / 종료 ─────────── */
function setState(s) {
  app.state = s;
  document.body.classList.toggle('is-rec', s === 'rec');
  document.body.classList.toggle('is-paused', s === 'paused');
  $('#status-text').textContent = s === 'rec' ? '녹음 중' : s === 'paused' ? '일시정지' : '대기 중';
  $('#btn-main').setAttribute('aria-label', s === 'rec' ? '일시정지' : '녹음 시작');
  $('#ic-main').innerHTML = s === 'rec'
    ? '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>'
    : '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>';
  ['#btn-mark', '#btn-todo', '#btn-edit', '#btn-stop'].forEach((sel) => {
    $(sel).disabled = s === 'idle';
  });
}

function startTick() {
  clearInterval(app.tick);
  app.tick = setInterval(() => { $('#elapsed').textContent = clock(elapsedMs()); }, 500);
}

async function begin() {
  if (!app.recog) {
    app.recog = makeRecognizer();
    if (!app.recog) {
      toast('이 브라우저는 음성 인식을 지원하지 않습니다. 크롬이나 사파리로 열어 주세요.', 5000);
      return;
    }
  }
  // 아이폰은 사용자가 손가락을 뗀 직후에만 인식을 켤 수 있다 → 제일 먼저 켠다.
  app.recogWanted = true;
  app.restartFails = 0;
  app.recogLast = null;
  try { app.recog.start(); } catch { /* 이미 켜져 있으면 무시 */ }

  app.startedAt = Date.now();
  setState('rec');
  startTick();
  renderTranscript();
  acquireWakeLock();
  if (SET.record) await startRecorder();   // 설정에서 끄면 받아쓰기만 한다
}

function pause() {
  app.accrued = elapsedMs();
  app.recogWanted = false;
  try { app.recog.stop(); } catch {}
  if (app.recorder && app.recorder.state === 'recording') app.recorder.pause();
  releaseWakeLock();
  setState('paused');
}

function resume() {
  if (!app.recog) app.recog = makeRecognizer();   // 초안을 되살린 직후엔 아직 없다
  if (!app.recog) return toast('이 브라우저는 음성 인식을 지원하지 않습니다.', 4000);

  app.startedAt = Date.now();
  app.recogWanted = true;
  app.restartFails = 0;
  app.recogLast = null;
  try { app.recog.start(); } catch {}
  if (app.recorder && app.recorder.state === 'paused') app.recorder.resume();
  else if (!app.recorder && SET.record) startRecorder();
  setState('rec');
  acquireWakeLock();
}

async function finish() {
  app.accrued = elapsedMs();
  app.recogWanted = false;
  try { app.recog && app.recog.stop(); } catch {}
  clearInterval(app.tick);
  releaseWakeLock();

  const blob = await stopRecorder();
  if (app.stream) { app.stream.getTracks().forEach((t) => t.stop()); app.stream = null; }
  app.audioBlob = blob;

  if (!app.segments.length && !blob) {
    setState('idle');
    toast('저장할 내용이 없습니다.');
    return;
  }

  const now = new Date();
  const rec = {
    id: 'm' + now.getTime(),
    title: '',
    people: '',
    date: now.toISOString(),
    dur: app.accrued,
    segments: app.segments.map(({ lastAt, ...s }) => s),
    audio: blob,
    mime: app.mime,
  };
  await DB.put(rec);          // 제목을 안 적어도 일단 저장된다
  clearDraft();
  setState('idle');
  openSave(rec);
}

/* ─────────── 정리 화면 ─────────── */
let playerUrl = null;

function openSave(rec, from = 'screen-rec') {
  app.current = rec;
  app.saveFrom = from;
  $('#in-title').value = rec.title || '';
  $('#in-people').value = rec.people || '';

  const d = new Date(rec.date);
  const wd = '일월화수목금토'[d.getDay()];
  const mins = Math.max(1, Math.round(rec.dur / 60000));
  $('#save-meta').textContent =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} (${wd}) ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())} · ${mins}분 · ${rec.segments.length}문단`;

  const player = $('#player');
  if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }
  if (rec.audio) {
    playerUrl = URL.createObjectURL(rec.audio);
    player.src = playerUrl;
    player.hidden = false;
  } else {
    player.removeAttribute('src');
    player.hidden = true;
  }

  renderTranscript($('#review'), rec.segments, false);
  showScreen('screen-save');
}

async function patchCurrent() {
  if (!app.current) return;
  app.current.title = $('#in-title').value.trim();
  app.current.people = $('#in-people').value.trim();
  await DB.put(app.current);
}

/* ─────────── 텍스트로 뽑기 ─────────── */
function asText(rec) {
  const d = new Date(rec.date);
  const wd = '일월화수목금토'[d.getDay()];
  const head = [
    rec.title || '제목 없는 회의',
    `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. (${wd}) ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())} · ${Math.max(1, Math.round(rec.dur / 60000))}분`,
  ];
  if (rec.people) head.push(`참석자: ${rec.people}`);

  const marks = rec.segments.filter((s) => s.mark);
  const body = rec.segments.map((s) => {
    const badge = s.mark === 'mark' ? '★ ' : s.mark === 'todo' ? '☑ ' : '';
    const who = s.speaker ? ` ${s.speaker}` : '';
    return `${badge}[${clock(s.t)}]${who}\n${s.text}`;
  });

  const out = [head.join('\n'), '─'.repeat(20), body.join('\n\n')];
  if (marks.length) {
    out.push('─'.repeat(20), '■ 중요 · 할일',
      marks.map((s) => `${s.mark === 'todo' ? '☑' : '★'} [${clock(s.t)}] ${s.text}`).join('\n'));
  }
  out.push('— 악필 · 작은앱공방');
  return out.join('\n\n');
}

/* ─────────── 목록 ─────────── */
async function openList() {
  const rows = (await DB.all()).sort((a, b) => b.date.localeCompare(a.date));
  const box = $('#list');
  box.innerHTML = '';

  if (!rows.length) {
    box.innerHTML =
      '<div class="empty"><p>저장된 회의가 없습니다.</p></div>';
  }

  rows.forEach((r) => {
    const d = new Date(r.date);
    const card = document.createElement('div');
    card.className = 'card';

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'card-main';
    const h = document.createElement('h3');
    h.textContent = r.title || '제목 없는 회의';
    const p = document.createElement('p');
    p.textContent =
      `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())} · ${Math.max(1, Math.round(r.dur / 60000))}분` +
      (r.audio ? ' · 녹음 있음' : '');
    main.append(h, p);
    main.addEventListener('click', () => openSave(r, 'screen-list'));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'card-del';
    del.setAttribute('aria-label', '삭제');
    del.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
    del.addEventListener('click', async () => {
      if (!confirm(`"${r.title || '제목 없는 회의'}"를 지울까요?\n되돌릴 수 없습니다.`)) return;
      await DB.del(r.id);
      openList();
      toast('삭제했습니다.');
    });

    card.append(main, del);
    box.appendChild(card);
  });

  showScreen('screen-list');
}

/* ─────────── 이벤트 연결 ─────────── */
$('#btn-main').addEventListener('click', () => {
  if (app.state === 'idle') begin();
  else if (app.state === 'rec') pause();
  else resume();
});

$('#btn-stop').addEventListener('click', () => {
  if (app.state !== 'idle' && !confirm('회의를 종료하고 저장할까요?')) return;
  finish();
});

const applyMark = (kind) => {
  const seg = app.segments[app.segments.length - 1];
  if (!seg) return toast('아직 표시할 내용이 없습니다.');
  seg.mark = seg.mark === kind ? null : kind;
  renderTranscript();
  toast(seg.mark ? (kind === 'mark' ? '중요로 표시했습니다.' : '할일로 표시했습니다.') : '표시를 지웠습니다.');
};
$('#btn-mark').addEventListener('click', () => applyMark('mark'));
$('#btn-todo').addEventListener('click', () => applyMark('todo'));

$('#btn-edit').addEventListener('click', () => {
  app.editing = !app.editing;
  $('#btn-edit').style.color = app.editing ? 'var(--neon)' : '';
  renderTranscript();
  toast(app.editing ? '문장을 눌러 고칠 수 있습니다.' : '수정을 마쳤습니다.');
});

// 고친 내용을 상태에 되돌려 넣는다
$('#transcript').addEventListener('input', (e) => {
  const body = e.target.closest('.seg-body');
  if (!body) return;
  const id = body.parentElement.dataset.id;
  const seg = app.segments.find((s) => s.id === id);
  if (seg) { seg.text = body.textContent; saveDraft(); }
});

$('#speakers').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  if (chip.id === 'btn-add-speaker') {
    const name = (prompt('참석자 이름') || '').trim();
    if (!name) return;
    const list = loadSpeakers();
    if (!list.includes(name)) { list.push(name); saveSpeakers(list); }
    app.speaker = name;
    renderSpeakers();
    return;
  }
  app.speaker = chip.dataset.speaker;
  renderSpeakers();
});

$('#btn-list').addEventListener('click', () => {
  if (app.state !== 'idle') return toast('회의를 종료한 뒤에 볼 수 있습니다.');
  openList();
});
$('#btn-list-back').addEventListener('click', () => showScreen('screen-rec'));

$('#btn-save-back').addEventListener('click', async () => {
  await patchCurrent();
  const back = app.saveFrom || 'screen-rec';
  $('#player').pause();
  if (back === 'screen-list') return openList();   // 목록에서 왔으면 목록으로
  app.segments = [];
  app.accrued = 0;
  app.audioBlob = null;
  renderTranscript();
  $('#elapsed').textContent = '00:00';
  showScreen('screen-rec');
});

$('#in-title').addEventListener('change', patchCurrent);
$('#in-people').addEventListener('change', patchCurrent);

// 문장을 누르면 녹음의 그 지점으로 건너뛴다
$('#review').addEventListener('click', (e) => {
  const seg = e.target.closest('.seg');
  const player = $('#player');
  if (!seg || player.hidden) return;
  player.currentTime = Number(seg.dataset.t) / 1000;
  player.play().catch(() => {});
});

$('#btn-copy').addEventListener('click', async () => {
  await patchCurrent();
  const text = asText(app.current);
  try {
    await navigator.clipboard.writeText(text);
    toast('회의록을 복사했습니다.');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('회의록을 복사했습니다.');
  }
});

$('#btn-share').addEventListener('click', async () => {
  await patchCurrent();
  const rec = app.current;
  const text = asText(rec);
  const title = rec.title || '회의록';

  if (!navigator.share) {
    await navigator.clipboard.writeText(text).catch(() => {});
    return toast('공유를 지원하지 않는 브라우저입니다. 대신 복사했습니다.', 3000);
  }
  try {
    await navigator.share({ title, text });
  } catch (err) {
    if (err && err.name !== 'AbortError') toast('공유하지 못했습니다.');
  }
});

/* ─────────── 설정 화면 ─────────── */
function renderDict() {
  const box = $('#dict');
  box.innerHTML = '';
  (SET.dict || []).forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'dict-item';
    const from = document.createElement('span');
    from.className = 'from'; from.textContent = r.from;
    const arw = document.createElement('span');
    arw.className = 'arrow'; arw.textContent = '→';
    const to = document.createElement('span');
    to.className = 'to'; to.textContent = r.to;
    const del = document.createElement('button');
    del.type = 'button';
    del.setAttribute('aria-label', `"${r.from}" 규칙 삭제`);
    del.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    del.addEventListener('click', () => {
      SET.dict.splice(i, 1); saveSet(); renderDict();
    });
    row.append(from, arw, to, del);
    box.appendChild(row);
  });
}

function openSet() {
  const sw = (el, on) => el.setAttribute('aria-checked', on ? 'true' : 'false');
  sw($('#set-record'), SET.record);
  sw($('#set-chips'), SET.chips);
  $('#set-gap').value = String(SET.gap);
  $('#set-size').value = String(SET.size);
  $('#size-out').textContent = SET.size + 'px';
  renderDict();
  showScreen('screen-set');
}

$('#btn-set').addEventListener('click', () => {
  if (app.state !== 'idle') return toast('회의를 종료한 뒤에 바꿀 수 있습니다.');
  openSet();
});
$('#btn-set-back').addEventListener('click', () => showScreen('screen-rec'));

const toggle = (sel, key, after) => {
  $(sel).addEventListener('click', () => {
    SET[key] = !SET[key];
    $(sel).setAttribute('aria-checked', SET[key] ? 'true' : 'false');
    saveSet();
    if (after) after();
  });
};
toggle('#set-record', 'record', () => {
  toast(SET.record ? '녹음도 함께 합니다.' : '받아쓰기만 합니다. 녹음 파일은 남지 않습니다.', 3000);
});
toggle('#set-chips', 'chips', applySet);

$('#set-gap').addEventListener('change', (e) => {
  SET.gap = Number(e.target.value) || 8; saveSet();
});
$('#set-size').addEventListener('input', (e) => {
  SET.size = Number(e.target.value);
  $('#size-out').textContent = SET.size + 'px';
  applySet(); saveSet();
});

$('#dict-add').addEventListener('click', () => {
  const from = $('#dict-from').value.trim();
  const to = $('#dict-to').value.trim();
  if (!from || !to) return toast('양쪽을 다 채워 주세요.');
  if (from === to) return toast('같은 말입니다.');
  SET.dict = SET.dict || [];
  const dup = SET.dict.findIndex((r) => r.from === from);
  if (dup >= 0) SET.dict[dup].to = to;
  else SET.dict.push({ from, to });
  saveSet(); renderDict();
  $('#dict-from').value = ''; $('#dict-to').value = '';
  $('#dict-from').focus();
  toast(`"${from}" → "${to}" 로 고칩니다.`);
});
$('#dict-to').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#dict-add').click();
});

/* ─────────── 시작할 때 ─────────── */
applySet();
renderSpeakers();
setState('idle');

if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
  toast('이 브라우저는 음성 인식을 지원하지 않습니다. 크롬이나 사파리로 열어 주세요.', 6000);
}

// 앱이 갑자기 죽었을 때 남은 초안 되살리기
(function restoreDraft() {
  let d;
  try { d = JSON.parse(localStorage.getItem('akpil.draft') || 'null'); } catch { return; }
  if (!d || !d.segments || !d.segments.length) return;
  if (!confirm('저장되지 않은 회의 기록이 남아 있습니다.\n이어서 볼까요?')) return clearDraft();
  app.segments = d.segments;
  app.accrued = d.dur || 0;
  renderTranscript();
  $('#elapsed').textContent = clock(app.accrued);
  clearDraft();
  toast('기록을 되살렸습니다. 종료를 누르면 저장됩니다.', 3500);
  setState('paused');
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

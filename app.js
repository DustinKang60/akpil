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

// 문단의 표시 텍스트를 다시 만든다.
//   committed = 이 문단에서 이미 끝난 발화들을 이어붙인 것
//   active    = 지금 자라고 있는 마지막 발화
// 화면·저장에는 (committed + active) 에 용어 교정을 입힌 것을 쓴다.
function refreshSeg(seg) {
  const raw = norm(`${seg.committed} ${seg.active}`);
  seg.text = fixTerms(raw);
  const body = $('#transcript').querySelector(`.seg[data-id="${seg.id}"] .seg-body`);
  if (body) body.textContent = seg.text;
  else renderTranscript();
}

// 인식 결과 하나를 문단에 반영한다.
//
// 이 기기(안드로이드 크롬)는 하나의 발화를 "자라는 채로"
// (음 서울에 한 → 음 서울에 한 사립대학교 → …) 확정 결과로 여러 번 보내고,
// 인식을 자주 끊었다 재시작하며 그때마다 결과 인덱스를 0 으로 되돌린다.
// 그래서 인덱스로는 같은 발화를 못 묶는다. 대신 내용으로 판정한다.
//
// 회의록은 매 구절마다 새 줄로 쪼개면 읽기 어렵다. 그래서 같은 화자가
// 말하는 동안은 한 문단에 계속 이어 붙이고, 다음 셋 중 하나면 새 문단으로 끊는다.
//   - 화자가 바뀜 (화자 칩 탭)
//   - 앞 문단을 중요·할일로 표시함
//   - 같은 화자라도 SET.gap 초 넘게 말이 끊김 (한 문단이 끝없이 길어지는 것 방지)
// 이어 붙일 때, 방금 온 문장이 진행 중 발화가 자란 것(접두사)이면 active 를
// 교체하고, 새로운 발화면 이전 active 를 committed 로 넘긴 뒤 이어 붙인다.
function ingestFinal(raw) {
  const last = app.recogLast;
  const sameSpeaker = last && last.speaker === app.speaker && !last.mark;
  const grew = sameSpeaker && isGrowth(last.active, raw);
  // 자라는 발화는 거의 즉시 연속이므로 시간과 무관하게 이어간다.
  // 침묵 판정은 "새 발화"에만 적용한다.
  const within = sameSpeaker && (elapsedMs() - last.lastAt) < SET.gap * 1000;

  if (grew) {
    if (norm(raw).length >= norm(last.active).length) last.active = raw;   // 더 긴 쪽으로 교체
    last.lastAt = elapsedMs();
    refreshSeg(last);
    $('#transcript').scrollTop = $('#transcript').scrollHeight;
  } else if (sameSpeaker && within) {
    last.committed = norm(`${last.committed} ${last.active}`);             // 진행 발화 확정분으로 편입
    last.active = raw;
    last.lastAt = elapsedMs();
    refreshSeg(last);
    $('#transcript').scrollTop = $('#transcript').scrollHeight;
  } else {
    const s = {
      id: 's' + Date.now() + Math.random().toString(36).slice(2, 6),
      t: elapsedMs(), lastAt: elapsedMs(), speaker: app.speaker,
      committed: '', active: raw, text: fixTerms(raw), mark: null,
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

// 통화용 보정을 모두 끈다. 이 셋은 "코앞의 한 사람 목소리"에 맞춘 것이라,
// 회의실에서 2~3m 떨어진 말소리를 잡음으로 보고 깎아낸다. 원본을 그대로 받는다.
const MIC_BASE = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

// 이 값보다 작으면 마이크가 소리를 안 보내는 것으로 본다.
// 살아 있는 마이크는 조용한 방에서도 이보다 큰 잡음 바닥을 가진다.
// 실측: 블루투스 시계가 마이크를 가로챘을 때 최대 진폭이 0.0001 이었다.
const MIC_SILENT = 0.0005;

// 스트림에 실제로 소리가 들어오는지 잠깐 재본다. 최대 진폭을 돌려준다.
async function micPeak(stream, ms = 600) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return 1;                       // 잴 수 없으면 통과시킨다
  const ac = new AC();
  try {
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let peak = 0;
    const until = Date.now() + ms;
    while (Date.now() < until) {
      an.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]);
        if (v > peak) peak = v;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    return peak;
  } catch { return 1; } finally { try { ac.close(); } catch {} }
}

// 소리가 들어오는 마이크를 골라 연다.
//
// 블루투스 이어폰이나 스마트워치가 붙어 있으면 안드로이드는 "기본 마이크"로
// 그쪽을 내준다. 손목의 시계 마이크는 회의실 소리를 거의 담지 못해서, 앱은
// 정상으로 보이는데 녹음만 통째로 무음이 된다. 실제로 그것 때문에 하루를 날렸다.
//
// 라벨 이름으로 짐작하지 않는다. 기기마다 이름이 제각각이라 믿을 수 없다.
// 열어서 소리를 재보고, 무음이면 다음 입력 장치로 옮긴다.
async function openMic() {
  let stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_BASE });
  app.micLabel = (stream.getAudioTracks()[0] || {}).label || '기본 마이크';
  if (await micPeak(stream) >= MIC_SILENT) return stream;

  let devs = [];
  try {
    devs = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'audioinput' && d.deviceId
                     && d.deviceId !== 'default' && d.deviceId !== 'communications');
  } catch { /* 목록을 못 얻으면 그냥 기본 마이크로 간다 */ }

  for (const d of devs) {
    stream.getTracks().forEach((t) => t.stop());
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...MIC_BASE, deviceId: { exact: d.deviceId } },
      });
    } catch { continue; }
    if (await micPeak(stream) >= MIC_SILENT) {
      app.micLabel = d.label || '다른 마이크';
      toast(`마이크를 "${app.micLabel}" 로 바꿨습니다.`, 3500);
      return stream;
    }
  }

  toast('마이크에서 소리가 들어오지 않습니다. 블루투스 이어폰·시계의 통화 오디오를 꺼 주세요.', 6000);
  return stream;                            // 그래도 녹음은 시도한다
}

async function startRecorder() {
  try {
    app.stream = await openMic();
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
function startRecognition() {
  app.recogWanted = true;
  app.restartFails = 0;
  app.recogLast = null;
  try { app.recog.start(); } catch { /* 이미 켜져 있으면 무시 */ }
}

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
  // 실험 B(녹음 먼저 → 인식 나중)를 되돌린다.
  // 그 순서에서는 인식이 마이크를 가져가 녹음이 통째로 무음이 됐다. 측정으로 확인했다.
  // 원래 순서에서는 녹음에 소리가 담겼고, 받아쓰기만 쓰고 싶으면 설정에서 녹음을 끄면 된다.
  // 즉 이 순서라야 "녹음이냐 받아쓰기냐"를 사용자가 고를 수 있다.
  // 아이폰은 사용자가 손가락을 뗀 직후에만 인식을 켤 수 있다 → 어차피 인식이 먼저다.
  startRecognition();

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
  // 일시정지 중에도 마이크 스트림은 살아 있으므로 재개는 순서를 따질 필요가 없다.
  startRecognition();
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

  // 가로 구분선(─)은 카톡·메일에서 폭을 못 채워 줄이 깨져 지저분하다.
  // 빈 줄과 소제목(■)만으로 구분한다.
  const out = [head.join('\n'), body.join('\n\n')];
  if (marks.length) {
    out.push('■ 중요 · 할일',
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

// 회의록 텍스트 공유
async function shareText() {
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
}

// 녹음 원본(음성 파일) 공유
async function shareAudio() {
  const rec = app.current;
  if (!rec.audio) return toast('녹음 파일이 없습니다.');

  const ext = /mp4/.test(rec.mime) ? 'm4a' : /ogg/.test(rec.mime) ? 'ogg' : 'webm';
  const base = (rec.title || '회의 녹음').replace(/[\\/:*?"<>|]/g, ' ').trim();
  const d = new Date(rec.date);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const file = new File([rec.audio], `${base} ${stamp}.${ext}`, { type: rec.audio.type || rec.mime || 'audio/webm' });

  if (!navigator.canShare || !navigator.canShare({ files: [file] })) {
    return toast('이 브라우저는 음성 파일 공유를 지원하지 않습니다.', 3500);
  }
  try {
    await navigator.share({ files: [file], title: rec.title || '회의 녹음' });
  } catch (err) {
    if (err && err.name !== 'AbortError') toast('음성을 보내지 못했습니다.');
  }
}

// ── 녹음을 wav 파일로 저장(다운로드) ──
// 안드로이드 크롬은 webm 으로 녹음한다. 이걸 16kHz mono wav 로 바꿔서
// 폰 다운로드 폴더에 파일로 떨어뜨린다. wav 는 어디서든 열리고 음성 AI 에도
// 그대로 넣을 수 있다. 16kHz mono 는 음성 인식 표준이라 파일도 작아진다.
function encodeWav(audioBuffer) {
  const ch = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;
  const n = ch.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const wr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); wr(8, 'WAVE');
  wr(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);      // PCM
  view.setUint16(22, 1, true);      // mono
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true); // byte rate
  view.setUint16(32, 2, true);      // block align
  view.setUint16(34, 16, true);     // bits per sample
  wr(36, 'data'); view.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function audioToWav(blob) {
  const arr = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const tmp = new AC();
  const decoded = await tmp.decodeAudioData(arr);
  tmp.close();
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return encodeWav(rendered);
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function saveAudioAsWav() {
  const rec = app.current;
  if (!rec.audio) return toast('녹음 파일이 없습니다.');
  const base = (rec.title || '회의 녹음').replace(/[\\/:*?"<>|]/g, ' ').trim();
  const d = new Date(rec.date);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  toast('음성을 변환하는 중…', 8000);
  try {
    const wav = await audioToWav(rec.audio);
    downloadBlob(wav, `${base} ${stamp}.wav`);
    toast('wav 파일을 저장했습니다. 파일 앱의 "다운로드"에서 찾으세요.', 4500);
  } catch (err) {
    console.error('wav 변환 실패:', err);
    toast('변환에 실패했습니다. 대신 원본 보내기를 써 주세요.', 4000);
  }
}

const closeShareSheet = () => { $('#share-sheet').hidden = true; };

$('#btn-share').addEventListener('click', async () => {
  await patchCurrent();
  // 녹음이 있으면 무엇을 할지 고르게 하고, 없으면 바로 텍스트를 공유한다.
  if (app.current && app.current.audio) $('#share-sheet').hidden = false;
  else shareText();
});
$('#share-text').addEventListener('click', () => { closeShareSheet(); shareText(); });
$('#save-audio').addEventListener('click', () => { closeShareSheet(); saveAudioAsWav(); });
$('#share-audio').addEventListener('click', () => { closeShareSheet(); shareAudio(); });
$('#share-cancel').addEventListener('click', closeShareSheet);
$('#share-sheet').addEventListener('click', (e) => { if (e.target.id === 'share-sheet') closeShareSheet(); });

/* ─────────── 설정 화면 ─────────── */
// 참석자 목록. 화자 칩과 같은 저장소(akpil.speakers)를 공유한다.
function renderPeople() {
  const box = $('#people-list');
  box.innerHTML = '';
  loadSpeakers().forEach((name) => {
    const row = document.createElement('div');
    row.className = 'dict-item';
    const label = document.createElement('span');
    label.className = 'from'; label.textContent = name;
    const del = document.createElement('button');
    del.type = 'button';
    del.setAttribute('aria-label', `"${name}" 삭제`);
    del.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    del.addEventListener('click', () => {
      saveSpeakers(loadSpeakers().filter((n) => n !== name));
      if (app.speaker === name) app.speaker = '';   // 지운 사람이 지금 화자면 화자 없음으로
      renderPeople();
      renderSpeakers();
      toast(`"${name}"을(를) 지웠습니다.`);
    });
    row.append(label, del);
    box.appendChild(row);
  });
}

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
  renderPeople();
  renderDict();
  showScreen('screen-set');
}

function addPerson() {
  const input = $('#person-name');
  const name = input.value.trim();
  if (!name) return toast('이름을 입력해 주세요.');
  const list = loadSpeakers();
  if (list.includes(name)) { input.value = ''; return toast('이미 있는 이름입니다.'); }
  list.push(name);
  saveSpeakers(list);
  renderPeople();
  renderSpeakers();
  input.value = '';
  input.focus();
  toast(`"${name}"을(를) 추가했습니다.`);
}
$('#person-add').addEventListener('click', addPerson);
$('#person-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addPerson(); });

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

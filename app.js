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
const DEFAULTS = { record: true, gap: 8, chips: true, size: 15, dict: [], lang: 'ko' };

function loadSet() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('akpil.set') || '{}') || {}; } catch { /* 깨졌으면 기본값 */ }
  const s = Object.assign({}, DEFAULTS, saved);
  // dict 는 배열이라 그냥 두면 DEFAULTS 의 것을 함께 쓰게 된다 → 기본값이 오염된다.
  // 예전에는 {from, to} 였다. 옛 값이 남아 있으면 바른 말(to) 만 가져온다.
  s.dict = Array.isArray(s.dict)
    ? s.dict.map((r) => String(r && typeof r === 'object' ? (r.to || r.from || '') : r).trim()).filter(Boolean)
    : [];
  return s;
}
let SET = loadSet();
function saveSet() { localStorage.setItem('akpil.set', JSON.stringify(SET)); }

// 용어 사전 — 회사 약어나 사람 이름을 딥그램에 미리 알려주는 목록.
//
// 예전에는 "들리는 대로 → 바른 말" 로 받아쓴 뒤에 고쳤다. 그 방식은 늦고 약하다.
// 틀린 결과를 본 다음에야 규칙을 넣을 수 있고, 같은 말도 사람마다 다르게 들려서
// 단어 하나에 규칙이 여러 개 필요했다 ("딥그램"이 뒷그램·댓글에·미끄럼으로 들렸다).
// 바른 말을 미리 알려주면 딥그램이 그 말을 후보로 놓고 듣는다. 예방이 교정보다 낫다.
// 나중에 딥그램에 보내게 되면 상한이 있다 — 한 요청당 500 토큰.
// 실측: 한국어 3~6글자 낱말 80개는 통과, 100개는 HTTP 400 으로 거절.
// 낱말이 길면 80개보다 적어도 넘으므로 개수와 글자 수를 함께 막는다.
const MAX_TERMS = 60;
const MAX_TERM_CHARS = 300;

function allTerms() {
  const list = [...(SET.dict || []), ...loadSpeakers()]
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  const uniq = [...new Set(list)];
  const out = [];
  let chars = 0;
  for (const t of uniq) {
    if (out.length >= MAX_TERMS || chars + t.length > MAX_TERM_CHARS) break;
    out.push(t);
    chars += t.length;
  }
  return out;
}

function applySet() {
  document.documentElement.style.setProperty('--seg-size', SET.size + 'px');
  $('#speakers').hidden = !SET.chips;
  renderLang();
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
  seg.text = raw;
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
      committed: '', active: raw, text: raw, mark: null,
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
    t: elapsedMs(), lastAt: elapsedMs(), speaker: app.speaker, text: raw, mark: null,
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
  r.lang = SET.lang === 'en' ? 'en-US' : 'ko-KR';
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

// 음량 칸을 칠할 때 쓰는 "소리가 들어온다" 기준.
const MIC_SILENT = 0.0005;

// 마이크는 열자마자 소리를 주지 않는다. 갤럭시 A32 실측:
//   열리는 데 127ms, 그런데 처음 400ms 는 샘플이 정확히 0,
//   500ms 부터 값이 나오기 시작하고 810ms 에야 잡음 바닥을 넘었다.
// 데우기 전에 재면 멀쩡한 마이크도 무음으로 오판한다. 실제로 그랬다.
const MIC_WARMUP = 700;

// 죽은 마이크를 가리는 기준은 진폭이 아니라 "값이 정확히 0 인 샘플의 비율"이다.
//   살아 있는 마이크 (조용한 방)  5~8%
//   블루투스에 뺏긴 마이크        98.9%
// 진폭으로 가르려 했더니 조용한 방 실측(0.0005~0.002)이 임계값과 겹쳐 오탐이 났다.
const MIC_DEAD_ZERO = 60;

// 스트림에 소리가 들어오는지 데운 뒤에 재본다.
async function micProbe(stream, ms = 1200) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return { peak: 1, zeroPct: 0 };          // 잴 수 없으면 통과시킨다
  const ac = new AC();
  try {
    const an = ac.createAnalyser();
    an.fftSize = 2048;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    await new Promise((r) => setTimeout(r, MIC_WARMUP));
    let peak = 0, zero = 0, n = 0;
    const until = Date.now() + ms;
    while (Date.now() < until) {
      an.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]);
        if (v > peak) peak = v;
        if (buf[i] === 0) zero++;
        n++;
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    return { peak, zeroPct: n ? (zero / n) * 100 : 100 };
  } catch { return { peak: 1, zeroPct: 0 }; } finally { try { ac.close(); } catch {} }
}

const micIsDead = (p) => p.zeroPct > MIC_DEAD_ZERO;

// getUserMedia 는 응답을 아예 안 주고 멎을 수 있다.
//
// 브라우저 음성 인식이 마이크를 쥐고 있을 때 안드로이드에서 실제로 그랬다.
// 거부(reject)도 아니라 catch 가 안 걸리고, 그 뒤 줄이 통째로 실행되지 않아
// 녹음도 음량 막대도 조용히 사라졌다. 오류 한 줄 안 남아서 한참을 헤맸다.
// 그래서 시간을 재고, 넘으면 실패로 만들어 눈에 보이게 한다.
function gumWithTimeout(constraints, ms = 5000) {
  return Promise.race([
    navigator.mediaDevices.getUserMedia(constraints),
    new Promise((_, rej) => setTimeout(
      () => rej(new Error('마이크가 응답하지 않습니다 (' + ms + 'ms 초과)')), ms)),
  ]);
}

// 소리가 들어오는 마이크를 골라 연다.
//
// 블루투스 이어폰이나 스마트워치가 붙어 있으면 안드로이드는 "기본 마이크"로
// 그쪽을 내준다. 손목의 시계 마이크는 회의실 소리를 거의 담지 못해서, 앱은
// 정상으로 보이는데 녹음만 통째로 무음이 된다. 실제로 그것 때문에 하루를 날렸다.
//
// 다만 성급히 갈아타면 안 된다. 회의 시작 순간은 원래 조용하다. 조용하다는
// 이유만으로 옮기면 엉뚱한 입력(스피커폰 등)을 잡는다. 그래서 다른 장치가
// 기본보다 세 배 넘게 크게 들릴 때만 바꾸고, 아니면 기본으로 돌아온다.
// 그래도 조용하면 바꾸지 않고, 녹음 중 음량 막대가 계속 알려준다.
// 마이크가 도중에 멈추거나 끊기는 것을 지켜본다.
// 블루투스 기기가 마이크를 가져가면 여기가 3초 무음 판정보다 먼저 울린다.
function watchTrack(stream) {
  const t = (stream.getAudioTracks() || [])[0];
  if (!t) return;
  let timer = null;
  t.addEventListener('mute', () => {
    clearTimeout(timer);
    // 짧은 끊김은 흔하다. 2초 넘게 이어질 때만 알린다.
    timer = setTimeout(() => {
      if (t.muted && app.state === 'rec') {
        toast('마이크가 멈췄습니다. 블루투스 이어폰·시계가 마이크를 가져갔을 수 있습니다.', 7000);
      }
    }, 2000);
  });
  t.addEventListener('unmute', () => clearTimeout(timer));
  t.addEventListener('ended', () => {
    if (app.state === 'rec') {
      toast('마이크 연결이 끊겼습니다. 회의를 종료하고 다시 시작해 주세요.', 8000);
    }
  });
}

async function openMic() {
  const first = await gumWithTimeout({ audio: MIC_BASE });
  const firstP = await micProbe(first, 900);
  let best = first, bestP = firstP;
  app.micLabel = (first.getAudioTracks()[0] || {}).label || '기본 마이크';
  app.micDead = micIsDead(firstP);
  if (!app.micDead) { watchTrack(first); return first; }

  // 기본 마이크가 죽어 있다 — 다른 입력 장치를 찾아본다
  let devs = [];
  try {
    devs = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'audioinput' && d.deviceId
                     && d.deviceId !== 'default' && d.deviceId !== 'communications');
  } catch { /* 목록을 못 얻으면 그냥 기본 마이크로 간다 */ }

  for (const d of devs) {
    let s;
    try {
      s = await gumWithTimeout({ audio: { ...MIC_BASE, deviceId: { exact: d.deviceId } } }, 3000);
    } catch { continue; }
    const p = await micProbe(s, 900);
    if (!micIsDead(p)) {
      if (best !== first) best.getTracks().forEach((t) => t.stop());
      best = s; bestP = p;
      app.micLabel = d.label || '다른 마이크';
      break;                                  // 살아 있는 것을 찾았으면 그만 본다
    }
    s.getTracks().forEach((t) => t.stop());
  }

  app.micDead = micIsDead(bestP);
  if (best !== first) {
    first.getTracks().forEach((t) => t.stop());
    toast(`마이크를 "${app.micLabel}" 로 바꿨습니다.`, 3500);
    watchTrack(best);
    return best;
  }

  watchTrack(first);
  return first;
}

/* ── 마이크가 살아 있는지 미리 보기 ── */
// 회의가 끝나고서야 무음인 것을 알면 되돌릴 방법이 없다. 그래서 두 번 본다.
// ① 앱을 켤 때 (권한이 이미 있을 때만 — 첫 실행에서 권한 창을 띄우지 않는다)
// ② 시작 버튼을 눌렀을 때
let micOverride = false;          // "그냥 시작"을 누른 경우 한 번만 통과시킨다

function showMicSheet() { $('#mic-sheet').hidden = false; }
function hideMicSheet() { $('#mic-sheet').hidden = true; }

function dropStream() {
  if (!app.stream) return;
  app.stream.getTracks().forEach((t) => t.stop());
  app.stream = null;
}

// 상태 줄의 "대기 중" 자리를 잠깐 빌려 쓴다. 대기 중일 때만 바꾸고,
// 회의가 시작되면 setState 가 알아서 제 글자로 되돌린다.
function sayStatus(text, kind) {
  if (app.state && app.state !== 'idle') return;
  const el = $('#status-text');
  if (!el) return;
  el.textContent = text;
  el.className = 'status-text' + (kind ? ' st-' + kind : '');
}

async function micPreflight() {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    if (p.state !== 'granted') return;          // 권한이 없으면 조용히 넘어간다
  } catch { return; }                           // 사파리처럼 못 물어보는 곳도 넘어간다

  let s;
  try { s = await gumWithTimeout({ audio: MIC_BASE }, 4000); } catch { return; }

  // 재는 동안 음량 칸을 실제로 움직여 준다. 말 없이 기다리게 하지 않는다.
  sayStatus('마이크 확인 중…');
  startMeter(s);
  const p = await micProbe(s, 1500);            // 급할 것 없으니 넉넉히 잰다
  stopMeter();
  s.getTracks().forEach((t) => t.stop());

  if (micIsDead(p)) {
    $('#level').classList.add('is-silent');
    sayStatus('마이크 무음', 'bad');
    toast('마이크에 소리가 안 들어옵니다. 블루투스 이어폰·시계의 통화 오디오를 꺼 주세요.', 7000);
    return;
  }
  sayStatus('녹음 가능', 'ok');
  setTimeout(() => sayStatus('대기 중'), 2500);
}

// 소리 기기가 바뀌면(이어폰 연결 등) 회의 중에 곧바로 알린다.
function watchDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.addEventListener) return;
  const snap = async () => {
    try {
      return (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === 'audioinput').map((d) => d.deviceId).join('|');
    } catch { return null; }
  };
  let known = null, toldAt = 0;
  snap().then((v) => { known = v; });
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    const now = await snap();
    if (now === null || now === known) return;   // 안드로이드는 헛울림이 잦다
    known = now;
    if (app.state !== 'rec') return;
    if (Date.now() - toldAt < 60000) return;     // 잔소리는 1분에 한 번
    toldAt = Date.now();
    toast('소리 기기가 바뀌었습니다. 상단 음량 칸이 움직이는지 확인해 주세요.', 7000);
  });
}

async function startRecorder() {
  try {
    if (!app.stream) app.stream = await openMic();   // begin() 에서 이미 열어 두었다
    app.mime = pickMime();
    app.recorder = new MediaRecorder(app.stream, app.mime ? { mimeType: app.mime } : undefined);
    app.chunks = [];
    app.recorder.ondataavailable = (e) => { if (e.data && e.data.size) app.chunks.push(e.data); };
    app.recorder.start(4000);
    startMeter(app.stream);
    return true;
  } catch (err) {
    app.recorder = null;
    toast('녹음을 켜지 못했습니다 — ' + (err && err.message || err) + ' 받아쓰기는 계속됩니다.', 6000);
    console.warn('recorder off:', err);
    return false;
  }
}

/* ─────────── 입력 음량 표시 ─────────── */
// 녹음이 무음인 것을 회의가 끝난 뒤에야 아는 일이 없도록, 그 자리에서 보여준다.
// 실제로 블루투스 시계가 마이크를 가로챈 것을 몇 시간 뒤에야 알아챘다.
let meterCtx = null, meterTimer = null, quietSince = 0, quietToldAt = 0;

// 사각형 다섯 개 중 n 칸을 켠다. 대기 중에는 0 칸이지만 자리는 늘 지킨다.
function paintLevel(n) {
  const boxes = $('#level').children;
  for (let i = 0; i < boxes.length; i++) boxes[i].classList.toggle('on', i < n);
}

function startMeter(stream) {
  stopMeter();
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !stream) return;
  try {
    meterCtx = new AC();
    const an = meterCtx.createAnalyser();
    an.fftSize = 1024;
    meterCtx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const bar = $('#level');
    quietSince = Date.now();
    quietToldAt = 0;
    meterTimer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]);
        if (v > peak) peak = v;
      }
      // 진폭을 dB 로 바꿔 -60dB~0dB 를 사각형 다섯 칸에 나눈다. 사람 귀에 맞는 눈금이다.
      const db = peak > 0 ? 20 * Math.log10(peak) : -99;
      paintLevel(db <= -60 ? 0 : Math.min(5, Math.ceil((db + 60) / 60 * 5)));

      if (peak >= MIC_SILENT) quietSince = Date.now();
      const quiet = Date.now() - quietSince > 3000;   // 3초 넘게 무음이면 경고
      bar.classList.toggle('is-silent', quiet);
      if (quiet && Date.now() - quietToldAt > 60000) {   // 잔소리는 1분에 한 번만
        quietToldAt = Date.now();
        toast('마이크에 소리가 안 들어옵니다. 블루투스 이어폰·시계의 통화 오디오를 꺼 주세요.', 5000);
      }
    }, 100);
  } catch { stopMeter(); }
}

function stopMeter() {
  clearInterval(meterTimer);
  meterTimer = null;
  if (meterCtx) { try { meterCtx.close(); } catch {} meterCtx = null; }
  const bar = $('#level');
  if (!bar) return;
  bar.classList.remove('is-silent');
  paintLevel(0);
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

/* ─────────── 딥그램 받아쓰기 (주 엔진) ─────────── */
// 브라우저 음성 인식(Web Speech)은 마이크를 통째로 가져간다. 그래서 녹음과
// 동시에 쓸 수 없다. 안드로이드에서는 인식이 켜져 있으면 getUserMedia 가
// 거부되거나 아예 응답을 안 준다. 측정으로 확인했다.
//
// 딥그램은 다르다. 우리가 연 마이크의 소리를 보내주면 글로 돌려준다.
// 마이크를 여는 쪽이 하나뿐이라 다툴 상대가 없고, 그래서 녹음과 받아쓰기가
// 같이 된다. 같은 MediaRecorder 조각을 저장용과 전송용으로 함께 쓴다.
//
// 키는 이 기기에만 둔다. 저장소에도 서버에도 올라가지 않는다.
const DG_URL = 'wss://api.deepgram.com/v1/listen';
const dgKey = () => (localStorage.getItem('akpil.dgkey') || '').trim();

function dgQuery() {
  return new URLSearchParams({
    model: 'nova-3', language: SET.lang === 'en' ? 'en' : 'ko',
    smart_format: 'true', punctuate: 'true', interim_results: 'true',
  }).toString();
  // 용어 사전(allTerms)은 아직 보내지 않는다. 켜려면 아래 한 줄을 되살린다.
  //   allTerms().forEach((t) => q.append('keyterm', t));
  //
  // 왜 안 보내는가 — 이득은 확인되지 않았고 위험은 확인됐다.
  //   딥그램 문서 어디에도 "한국어에서 keyterm 이 동작한다"는 말이 없다.
  //   keyterm 문서는 "Nova-3 에서 동작"까지만 적고 언어를 밝히지 않고,
  //   모델·언어 표에는 keyterm 칸 자체가 없다. 근거는 "던져도 거절하지
  //   않더라"뿐인데, 딥그램은 지원 안 하는 옵션을 조용히 무시하기도 한다.
  //   반면 상한(한 요청 500 토큰)은 실측으로 확인됐다 — 한국어 낱말 100개를
  //   보내니 HTTP 400 "Keyterm limit exceeded" 로 연결 자체가 거절됐다.
  //   (80개는 통과. 낱말이 길면 80개보다 적어도 넘는다.)
  //
  // 확인하는 법 — 앱을 고칠 필요 없다. 회의 녹음 파일 하나를 keyterm 있이/없이
  // 두 번 돌려 받아쓴 결과를 비교하면 된다. 정말 나아지면 그때 켠다.
}

async function startDeepgram() {
  try {
    if (!app.stream) app.stream = await openMic();   // begin() 에서 이미 열어 두었다
  } catch (err) {
    toast('마이크를 열지 못했습니다 — ' + (err && err.message || err), 6000);
    console.warn('mic:', err);
    return false;
  }

  return new Promise((res) => {
    let done = false;
    const settle = (v) => { if (!done) { done = true; res(v); } };

    let ws;
    try { ws = new WebSocket(DG_URL + '?' + dgQuery(), ['token', dgKey()]); }
    catch (err) { console.warn('dg:', err); return settle(false); }
    app.dg = ws;
    app.dgWanted = true;

    const giveUp = setTimeout(() => settle(false), 7000);   // 7초 안에 안 열리면 포기

    ws.onopen = () => {
      clearTimeout(giveUp);
      app.mime = pickMime();
      app.recorder = new MediaRecorder(app.stream, app.mime ? { mimeType: app.mime } : undefined);
      app.chunks = [];
      app.recorder.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        if (SET.record) app.chunks.push(e.data);                 // 저장은 설정에 따라
        if (ws.readyState === WebSocket.OPEN) ws.send(e.data);   // 받아쓰기는 늘 보낸다
      };
      app.recorder.start(250);        // 자주 흘려야 글이 빨리 올라온다
      // 말이 없어도 연결이 끊기지 않게 붙잡아 둔다 (일시정지 중에도).
      app.dgAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }, 5000);
      startMeter(app.stream);
      settle(true);
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type !== 'Results') return;
      const alt = m.channel && m.channel.alternatives && m.channel.alternatives[0];
      const txt = ((alt && alt.transcript) || '').trim();
      const el = $('#interim');
      if (!txt) { if (el) el.textContent = ''; return; }
      if (m.is_final) {
        if (el) el.textContent = '';
        ingestFinal(txt);
      } else if (el) {
        el.textContent = txt;
        $('#transcript').scrollTop = $('#transcript').scrollHeight;
      }
    };

    ws.onerror = () => settle(false);
    ws.onclose = (e) => {
      settle(false);
      if (app.dgWanted && e.code !== 1000) {
        toast('받아쓰기 연결이 끊겼습니다. 인터넷을 확인해 주세요.', 5000);
      }
    };
  });
}

function stopDeepgram() {
  app.dgWanted = false;
  clearInterval(app.dgAlive);
  app.dgAlive = null;
  if (!app.dg) return;
  try {
    if (app.dg.readyState === WebSocket.OPEN) app.dg.send(JSON.stringify({ type: 'CloseStream' }));
  } catch { /* 이미 닫혔으면 그만 */ }
  try { app.dg.close(1000); } catch {}
  app.dg = null;
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

// 받아쓰기 언어. 딥그램은 연결할 때 언어가 정해지므로 회의 중에는 못 바꾼다.
// 도중에 바꾸려면 연결과 녹음기를 새로 시작해야 하고, 그러면 녹음 파일이
// 두 조각으로 갈라져 재생이 깨진다. 그래서 대기 중에만 열어 둔다.
function renderLang() {
  const b = $('#btn-lang');
  if (!b) return;
  b.textContent = SET.lang === 'en' ? 'English' : '한국어';
  b.disabled = app.state === 'rec' || app.state === 'paused';
}

function setState(s) {
  app.state = s;
  document.body.classList.toggle('is-rec', s === 'rec');
  document.body.classList.toggle('is-paused', s === 'paused');
  const st = $('#status-text');
  st.className = 'status-text';        // 미리 확인하며 물들인 색을 되돌린다
  st.textContent = s === 'rec' ? '녹음 중' : s === 'paused' ? '일시정지' : '대기 중';
  $('#btn-main').setAttribute('aria-label', s === 'rec' ? '일시정지' : '녹음 시작');
  $('#ic-main').innerHTML = s === 'rec'
    ? '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>'
    : '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>';
  ['#btn-mark', '#btn-todo', '#btn-edit', '#btn-stop'].forEach((sel) => {
    $(sel).disabled = s === 'idle';
  });
  renderLang();
}

$('#mic-retry').addEventListener('click', async () => {
  hideMicSheet();
  dropStream();                       // 새로 열어야 바뀐 경로가 반영된다
  toast('다시 확인하는 중…', 2000);
  begin();
});
$('#mic-anyway').addEventListener('click', () => {
  hideMicSheet();
  micOverride = true;
  begin();
});
$('#mic-cancel').addEventListener('click', () => {
  hideMicSheet();
  dropStream();                       // 회의를 안 하니 마이크를 놓아준다
});

$('#btn-lang').addEventListener('click', () => {
  if (app.state === 'rec' || app.state === 'paused') {
    return toast('회의 중에는 언어를 바꿀 수 없습니다. 종료 후 바꿔 주세요.', 3500);
  }
  SET.lang = SET.lang === 'en' ? 'ko' : 'en';
  saveSet();
  renderLang();
  toast(SET.lang === 'en' ? '영어로 받아씁니다.' : '한국어로 받아씁니다.', 2500);
});

function startTick() {
  clearInterval(app.tick);
  app.tick = setInterval(() => { $('#elapsed').textContent = clock(elapsedMs()); }, 500);
}

async function begin() {
  // 마이크부터 확보하고 소리가 들어오는지 본다. 무음이면 회의를 시작하지 않는다.
  // 회의가 끝나고서야 무음인 걸 알면 그 회의는 되돌릴 수 없다.
  if (SET.record || dgKey()) {
    try {
      if (!app.stream) app.stream = await openMic();
    } catch (err) {
      return toast('마이크를 열지 못했습니다 — ' + (err && err.message || err), 7000);
    }
    if (app.micDead && !micOverride) return showMicSheet();
  }
  micOverride = false;
  $('#level').classList.remove('is-silent');

  // 지난 회의의 마지막 문단을 가리킨 채로 두면, 새 회의의 첫 확정 문장이
  // 그 문단에 이어붙는다. 그 문단은 이미 저장이 끝난 지난 회의 것이라
  // 화면에도 안 나오고 저장도 안 된다 — 받아쓴 글이 통째로 사라진다.
  // 웹 음성인식 경로는 startRecognition() 이 비워줬지만 딥그램 경로는 안 부른다.
  app.recogLast = null;

  app.startedAt = Date.now();
  setState('rec');
  startTick();
  renderTranscript();
  acquireWakeLock();

  // 딥그램 키가 있으면 그쪽이 주 엔진이다. 마이크를 한 번만 열어 녹음과
  // 받아쓰기를 함께 한다. 키가 없거나 연결이 안 되면 기존 방식으로 내려간다.
  if (dgKey()) {
    if (await startDeepgram()) { app.engine = 'dg'; return; }
    stopDeepgram();
    if (app.stream) { app.stream.getTracks().forEach((t) => t.stop()); app.stream = null; }
    toast('딥그램에 연결하지 못했습니다. 기존 받아쓰기로 진행합니다.', 5000);
  }

  app.engine = 'web';
  if (!app.recog) {
    app.recog = makeRecognizer();
    if (!app.recog) {
      toast('이 브라우저는 음성 인식을 지원하지 않습니다. 크롬이나 사파리로 열어 주세요.', 5000);
      clearInterval(app.tick);
      releaseWakeLock();
      setState('idle');
      return;
    }
  }
  // 실험 B(녹음 먼저 → 인식 나중)를 되돌린다.
  // 그 순서에서는 인식이 마이크를 가져가 녹음이 통째로 무음이 됐다. 측정으로 확인했다.
  // 원래 순서에서는 녹음에 소리가 담겼고, 받아쓰기만 쓰고 싶으면 설정에서 녹음을 끄면 된다.
  // 즉 이 순서라야 "녹음이냐 받아쓰기냐"를 사용자가 고를 수 있다.
  // 아이폰은 사용자가 손가락을 뗀 직후에만 인식을 켤 수 있다 → 어차피 인식이 먼저다.
  startRecognition();
  if (SET.record) await startRecorder();   // 설정에서 끄면 받아쓰기만 한다
}

function pause() {
  app.accrued = elapsedMs();
  app.recogWanted = false;
  try { app.recog.stop(); } catch {}
  if (app.recorder && app.recorder.state === 'recording') app.recorder.pause();
  stopMeter();
  releaseWakeLock();
  setState('paused');
}

function resume() {
  app.startedAt = Date.now();

  if (app.engine === 'dg') {
    // 딥그램은 연결을 KeepAlive 로 붙잡아 뒀다. 조각만 다시 흘려보내면 된다.
    if (app.recorder && app.recorder.state === 'paused') { app.recorder.resume(); startMeter(app.stream); }
  } else {
    if (!app.recog) app.recog = makeRecognizer();   // 초안을 되살린 직후엔 아직 없다
    if (!app.recog) return toast('이 브라우저는 음성 인식을 지원하지 않습니다.', 4000);
    // 일시정지 중에도 마이크 스트림은 살아 있으므로 재개는 순서를 따질 필요가 없다.
    startRecognition();
    if (app.recorder && app.recorder.state === 'paused') { app.recorder.resume(); startMeter(app.stream); }
    else if (!app.recorder && SET.record) startRecorder();
  }
  setState('rec');
  acquireWakeLock();
}

async function finish() {
  app.accrued = elapsedMs();
  app.recogWanted = false;
  try { app.recog && app.recog.stop(); } catch {}
  stopDeepgram();
  clearInterval(app.tick);
  releaseWakeLock();
  stopMeter();

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

// MediaRecorder 로 만든 webm 에는 전체 길이가 안 적혀 있다. 녹음이 끝나는
// 시점을 미리 알 수 없어서 헤더에 쓸 수가 없기 때문이다. 그래서 재생기의
// 총 시간이 비어 있고, 막대를 끌어 옮기지도 못한다.
//
// 아주 먼 지점으로 한 번 건너뛰면 브라우저가 파일 끝까지 읽어 길이를
// 알아낸다. 그 뒤 처음으로 되돌려 놓는다. 화면에는 순간적으로만 보인다.
function fixDuration(el) {
  const settle = () => {
    if (el.duration && Number.isFinite(el.duration)) return;   // 이미 안다면 그만
    try { el.currentTime = 1e101; } catch { return; }
    const back = () => {
      el.removeEventListener('timeupdate', back);
      el.removeEventListener('durationchange', back);
      try { el.currentTime = 0; } catch {}
    };
    el.addEventListener('timeupdate', back);
    el.addEventListener('durationchange', back);
  };
  if (el.readyState > 0) settle();
  else el.addEventListener('loadedmetadata', settle, { once: true });
}

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
    fixDuration(player);
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
    // 글과 녹음이 각각 남아 있는지 한눈에 보이게 한다. 없는 것도 적는다 —
    // 아무 표시가 없으면 "없는 것"인지 "안 적은 것"인지 알 수 없다.
    const segs = (r.segments || []).length;
    const p = document.createElement('p');
    p.textContent =
      `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())} · ${Math.max(1, Math.round(r.dur / 60000))}분 · ` +
      (segs ? `글 ${segs}문단` : '글 없음') + ' · ' +
      (r.audio ? '녹음 있음' : '녹음 없음');
    main.append(h, p);

    // 참석자도 보여준다. 목록에서 "누가 있던 회의였나"로 찾는 일이 많다.
    if (r.people) {
      const who = document.createElement('p');
      who.className = 'who';
      who.textContent = r.people;
      who.title = r.people;              // 잘려도 길게 누르면 전체가 보인다
      main.append(who);
    }
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
  app.recogLast = null;      // 지난 회의 문단에 새 글이 붙지 않도록 함께 비운다
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
// 칩 하나를 만든다. onDel 이 없으면 지우기 단추 없이 흐리게 보여준다.
function makeTag(text, onDel) {
  const tag = document.createElement('span');
  tag.className = 'tag' + (onDel ? '' : ' is-auto');
  const label = document.createElement('span');
  label.textContent = text;
  tag.appendChild(label);
  if (onDel) {
    const del = document.createElement('button');
    del.type = 'button';
    del.setAttribute('aria-label', `"${text}" 삭제`);
    del.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    del.addEventListener('click', onDel);
    tag.appendChild(del);
  }
  return tag;
}

function renderPeople() {
  const box = $('#people-list');
  box.innerHTML = '';
  loadSpeakers().forEach((name) => {
    box.appendChild(makeTag(name, () => {
      saveSpeakers(loadSpeakers().filter((n) => n !== name));
      if (app.speaker === name) app.speaker = '';   // 지운 사람이 지금 화자면 화자 없음으로
      renderPeople();
      renderSpeakers();
      renderDict();                                 // 용어 사전 개수도 함께 줄어든다
      toast(`"${name}"을(를) 지웠습니다.`);
    }));
  });
}

function renderDict() {
  const box = $('#dict');
  box.innerHTML = '';

  (SET.dict || []).forEach((w, i) => {
    box.appendChild(makeTag(w, () => { SET.dict.splice(i, 1); saveSet(); renderDict(); }));
  });

  // 참석자 이름도 함께 보내진다. 여기서는 보여만 주고, 지우는 것은 참석자 쪽에서 한다.
  loadSpeakers().forEach((name) => box.appendChild(makeTag(name)));

  const btn = $('#dict-open');
  if (btn) btn.textContent = `등록된 말 ${allTerms().length}개`;
}

function openSet() {
  const sw = (el, on) => el.setAttribute('aria-checked', on ? 'true' : 'false');
  $('#set-dgkey').value = dgKey();
  renderDgState();
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

// ── 딥그램 키 ──
// SET(akpil.set) 과 따로 둔다. 설정은 나중에 내보내거나 옮길 수 있는 값이고,
// 키는 이 기기 밖으로 나가면 안 되는 값이라 섞지 않는다.
function dgSay(msg, kind) {
  const el = $('#dgkey-state');
  if (!el) return;
  el.textContent = msg;
  el.className = kind ? 'dg-' + kind : '';
}

function renderDgState() {
  const k = dgKey();
  if (!k) return dgSay('넣지 않음 — 브라우저 받아쓰기로 동작합니다 (녹음과 동시 사용 불가)');
  dgSay(`넣었습니다 (${k.length}자) — 녹음과 받아쓰기가 함께 됩니다`, 'ok');
}

// 키가 진짜 되는 것인지 딥그램에 한 번 붙어서 확인한다.
// 붙여넣기만 하고 아무 반응이 없으면 제대로 한 것인지 알 수가 없다.
function verifyDgKey(k) {
  return new Promise((res) => {
    let ws;
    try { ws = new WebSocket(DG_URL + '?' + dgQuery(), ['token', k]); }
    catch { return res('fail'); }
    let done = false;
    const settle = (v) => { if (!done) { done = true; res(v); } };
    const giveUp = setTimeout(() => { try { ws.close(); } catch {} settle('timeout'); }, 8000);
    ws.onopen = () => {
      clearTimeout(giveUp);
      try { ws.send(JSON.stringify({ type: 'CloseStream' })); ws.close(1000); } catch {}
      settle('ok');
    };
    ws.onerror = () => { clearTimeout(giveUp); settle('fail'); };
    ws.onclose = () => { clearTimeout(giveUp); settle('fail'); };
  });
}

let dgTimer = null;
async function onDgKeyTyped(raw) {
  const k = raw.trim();
  clearTimeout(dgTimer);

  if (!k) {
    localStorage.removeItem('akpil.dgkey');
    renderDgState();
    return;
  }

  localStorage.setItem('akpil.dgkey', k);          // 우선 저장부터 한다
  dgSay(`${k.length}자 저장했습니다 · 확인하는 중…`);

  // 붙여넣는 도중에 매번 접속하지 않도록 잠깐 기다린다
  dgTimer = setTimeout(async () => {
    if (!navigator.onLine) {
      return dgSay(`${k.length}자 저장했습니다 · 인터넷이 없어 확인은 못 했습니다`, 'warn');
    }
    const r = await verifyDgKey(k);
    if (dgKey() !== k) return;                     // 그새 또 바뀌었으면 버린다
    if (r === 'ok') dgSay(`✓ 키가 확인됐습니다 — 녹음과 받아쓰기가 함께 됩니다`, 'ok');
    else if (r === 'timeout') dgSay('딥그램이 응답하지 않습니다. 인터넷을 확인해 주세요', 'warn');
    else dgSay('✗ 딥그램이 이 키를 받아주지 않습니다. 다시 확인해 주세요', 'bad');
  }, 700);
}

$('#set-dgkey').addEventListener('input', (e) => onDgKeyTyped(e.target.value));
$('#set-dgkey').addEventListener('change', (e) => onDgKeyTyped(e.target.value));

$('#dgkey-clear').addEventListener('click', () => {
  clearTimeout(dgTimer);
  localStorage.removeItem('akpil.dgkey');
  $('#set-dgkey').value = '';
  renderDgState();
  toast('딥그램 키를 지웠습니다.', 3000);
});

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
  const w = $('#dict-word').value.trim();
  if (!w) return toast('등록할 말을 적어 주세요.');
  SET.dict = SET.dict || [];
  if (allTerms().some((t) => t === w)) {
    $('#dict-word').value = '';
    return toast(`"${w}" 는 이미 있습니다.`);
  }
  if (allTerms().length >= MAX_TERMS) {
    return toast(`한 번에 ${MAX_TERMS}개까지만 보낼 수 있습니다. 안 쓰는 말을 지워 주세요.`, 4500);
  }
  SET.dict.push(w);
  saveSet(); renderDict();
  $('#dict-word').value = '';
  $('#dict-word').focus();
  toast(`"${w}" 를 등록했습니다.`);
});
$('#dict-word').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#dict-add').click();
});
$('#dict-open').addEventListener('click', () => { renderDict(); $('#dict-sheet').hidden = false; });
$('#dict-close').addEventListener('click', () => { $('#dict-sheet').hidden = true; });

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

// 앱을 켤 때 마이크가 살아 있는지 미리 본다. 회의 시작 전에 알아야 고칠 수 있다.
watchDevices();
micPreflight();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

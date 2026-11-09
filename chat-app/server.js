const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// ── 닉네임 풀 (테마별 앞말 50 × 뒷말 40 = 2,000개) ──
// 단어 목록은 관객 화면(chat.html)과 같은 파일(public/nickname-themes.js)을 함께 쓴다.
// 닉네임은 클라이언트가 로컬에서 즉시 고르지만, 동시 접속자와 겹치면 서버가 같은 테마에서 교체해준다.
const NICKNAME_THEMES = require('./public/nickname-themes.js');
const DEFAULT_THEME = 'office';
// 테마 이름 검증 — 'constructor'·'__proto__' 같은 객체 기본 속성 이름이 테마로 통과하지 않게 자기 키만 인정
const isThemeKey = (t) => typeof t === 'string' && Object.prototype.hasOwnProperty.call(NICKNAME_THEMES, t);

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 테마별로 모든 조합 생성 후 셔플
const nicknamePools = {};
for (const [key, t] of Object.entries(NICKNAME_THEMES)) {
  nicknamePools[key] = { list: shuffle(t.prefixes.flatMap(p => t.suffixes.map(s => `${p} ${s}`))), index: 0 };
}

// 띄어쓰기 교정(fix/nickname) 전 옛 표기 닉네임 판별 — 공백을 뺀 글자는 지금 풀의 닉네임과 같은데 표기가 다른 것.
// (예: '퇴근못한 3년차' ↔ '퇴근 못 한 3년 차') 옛 페이지·옛 저장값이 다시 등록하려 하면 새 닉네임으로 바꿔 준다.
const nicknameCanon = {};
for (const [key, pool] of Object.entries(nicknamePools)) nicknameCanon[key] = new Set(pool.list.map(n => n.replace(/\s+/g, '')));
function isOldSpacingNickname(name, theme) {
  const canon = nicknameCanon[theme] || nicknameCanon[DEFAULT_THEME];
  return canon.has(name.replace(/\s+/g, '')) && !(nicknamePools[theme] || nicknamePools[DEFAULT_THEME]).list.includes(name);
}

function assignNickname(theme) {
  const pool = nicknamePools[theme] || nicknamePools[DEFAULT_THEME];
  if (pool.index >= pool.list.length) {
    // 모두 소진되면 재셔플 (테마당 2,000개라 1000명 규모에선 발생 안 함)
    pool.list = shuffle(pool.list);
    pool.index = 0;
  }
  return pool.list[pool.index++];
}

function poolSize(theme) {
  return (nicknamePools[theme] || nicknamePools[DEFAULT_THEME]).list.length;
}

// ── 닉네임 중복 방지 ──
// 닉네임 자체는 클라이언트가 즉시 로컬에서 고르지만(빠른 UX),
// 서버는 현재 접속 중인 소켓들의 닉네임을 추적해 동시 중복만 감지/교체한다.
const activeNicknames = new Map(); // socket.id -> nickname (이 소켓이 채팅에 쓰는 닉네임)

// 닉네임 주인은 소켓이 아니라 기기(clientId) — 폰이 다른 앱을 쓰다 돌아와 재접속해도 같은 닉네임을 쓴다.
//  - 서버가 옛 소켓 끊김을 아직 모르는 동안(핑 타임아웃 최대 수십 초) 들어온 새 소켓도 같은 주인으로 본다.
//  - 기기의 소켓이 모두 끊겨도 NICKNAME_HOLD_MS 동안은 그 기기 몫으로 남겨 다른 관객이 가져가지 못한다.
// 주인 키는 기기+테마('clientId|theme') — 같은 폰이 / 와 /concert 를 함께 열어도 서로의 닉네임을 풀어 버리지 않는다.
// clientId가 없는 소켓은 'sid:소켓id'를 주인 키로 쓰고, 끊기면 바로 풀린다.
const NICKNAME_HOLD_MS = 30 * 60 * 1000;
const nicknameOwners = new Map(); // nickname -> 주인 키
const ownerNicknames = new Map(); // 주인 키 -> { name, sockets: 접속 중 소켓 수, releasedAt: 모두 끊긴 시각 }

function ownerKeyOf(socket, theme) { return socket.clientId ? socket.clientId + '|' + theme : 'sid:' + socket.id; }

function releaseOwner(key) {
  const rec = ownerNicknames.get(key);
  if (!rec) return;
  if (nicknameOwners.get(rec.name) === key) nicknameOwners.delete(rec.name);
  ownerNicknames.delete(key);
}

function holdExpired(rec, now = Date.now()) {
  return rec.sockets <= 0 && now - rec.releasedAt >= NICKNAME_HOLD_MS;
}

// 보존 시간이 지난 닉네임 정리(메모리 누수 방지)
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of ownerNicknames) if (holdExpired(rec, now)) releaseOwner(key);
}, 60 * 1000).unref();

// ── 관객 접속자 통계 ──
// 관객만 claimNickname을 호출한다(LED는 identify만, 관리자는 둘 다 안 함)
// → 이걸 관객 식별 기준으로 삼아 LED·관리자 화면이 접속자 수에 섞이지 않게 한다.
// clientId(localStorage 영구 ID) 기준으로 세므로 한 사람이 탭을 여러 개 열어도 1명이다.
const audienceSockets = new Map(); // clientId -> 현재 열려 있는 소켓 수
let audiencePeak = 0;              // 최고 동시 접속자 수

function audienceStats() {
  return { current: audienceSockets.size, peak: audiencePeak };
}

// 접속/해제가 몰릴 때 브로드캐스트가 폭주하지 않도록 살짝 묶어서 보낸다
let audienceBroadcastTimer = null;
function broadcastAudience() {
  if (audienceBroadcastTimer) return;
  audienceBroadcastTimer = setTimeout(() => {
    audienceBroadcastTimer = null;
    io.to(ADMINS).emit('audienceStats', audienceStats());
  }, 250);
}

// 다른 주인(다른 기기)이 쓰고 있거나 보존 중인 닉네임인지
function isNicknameTaken(name, ownerKey) {
  const owner = nicknameOwners.get(name);
  if (!owner || owner === ownerKey) return false;
  const rec = ownerNicknames.get(owner);
  if (!rec || holdExpired(rec)) { releaseOwner(owner); return false; }
  return true;
}

// ── 제작진 인증 ──
// 관리자(/admin)·운영진(/host) 이벤트는 키가 있어야 동작한다. 키는 환경변수로만 설정(저장소에 두지 않음).
//  - ADMIN_KEY: 관리자 권한(모든 admin:* 이벤트 + 운영진 권한 포함)
//  - HOST_KEY : 운영진 권한(운영자 채팅 표시 + 채팅 삭제). 비우면 ADMIN_KEY로만 운영진 화면 사용 가능
// 키가 설정되지 않으면 해당 권한은 아무도 쓸 수 없다(관객이 콘솔로 관리자 기능을 쓰는 것 방지).
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const HOST_KEY = process.env.HOST_KEY || '';
if (!ADMIN_KEY) console.warn('⚠️ ADMIN_KEY 환경변수가 없어 관리자 기능이 잠겨 있습니다. (예: ADMIN_KEY=비밀키 node server.js)');

function keyMatches(given, expected) {
  if (!expected || typeof given !== 'string' || !given) return false;
  // 길이가 달라도 비교 시간이 같도록 해시끼리 비교
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function roleForKey(key) {
  if (keyMatches(key, ADMIN_KEY)) return 'admin';
  if (keyMatches(key, HOST_KEY)) return 'host';
  return 'audience';
}

// ── 입력값 정리 ── 클라이언트가 보낸 값은 형식을 믿지 않는다(잘못된 값 하나로 서버가 죽지 않도록).
// 문자열이 아니면 '', 앞뒤 공백 제거 후 max 글자(코드포인트 개수 기준)로 자른다.
// 자를 때는 글자(grapheme) 단위로 — 👨‍👩‍👧·국기·피부색 이모지처럼 여러 코드포인트로 된 글자가 상한에 걸리면
// 반쪽만 남기지 않고 그 글자 전체를 버린다(결과 길이는 코드포인트 기준 max 이하). Segmenter가 없으면 코드포인트로 자름
const graphemeSeg = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('ko', { granularity: 'grapheme' }) : null;
function cleanStr(v, max) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (t.length <= max) return t;
  if (!graphemeSeg) return [...t].slice(0, max).join('');
  let out = '', n = 0;
  for (const { segment } of graphemeSeg.segment(t)) {
    const len = [...segment].length;
    if (n + len > max) break;
    out += segment; n += len;
  }
  return out;
}
function asObj(v) { return v && typeof v === 'object' ? v : {}; }

const MAX_QUESTION_LENGTH = 200; // 질문 문구 상한
const MAX_OPTION_LENGTH = 40;    // 객관식 보기 라벨 상한
const MAX_EMOJI_LENGTH = 16;     // 이모지(ZWJ 조합 포함) 상한
const MAX_EMOJI_LABEL_LENGTH = 30;
const MAX_VOTING_SECONDS = 600;  // setTimeout 한계 초과로 즉시 종료되는 것 방지
const MIN_VOTING_SECONDS = 5;
const DEFAULT_VOTING_SECONDS = 30;
// 투표 시간(초) 정리 — 숫자가 아니면 null(호출부가 기본값 결정), 범위 밖이면 5~600으로 맞춤
function cleanVotingSeconds(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(MAX_VOTING_SECONDS, Math.max(MIN_VOTING_SECONDS, n)) : null;
}

function cleanOptions(list) {
  return (Array.isArray(list) ? list : [])
    .map(o => cleanStr(typeof o === 'number' ? String(o) : o, MAX_OPTION_LENGTH))
    .filter(Boolean).slice(0, 6);
}
function cleanEmojis(list) {
  return (Array.isArray(list) ? list : [])
    .map(o => ({ emoji: cleanStr(asObj(o).emoji, MAX_EMOJI_LENGTH), label: cleanStr(asObj(o).label, MAX_EMOJI_LABEL_LENGTH) }))
    .filter(o => o.emoji).slice(0, 6);
}
// 주관식 답변 글자 수 상한 (LED 가독성 보호). cleanPreset이 쓰므로 loadPresets() 호출보다 먼저 선언해야 한다
// (아래에 두면 주관식 프리셋이 있을 때 서버 시작 시 TDZ 오류로 목록이 비어 버림)
const MAX_ANSWER_LENGTH = 20;
const PRESET_TYPES = ['yesno', 'choice', 'subjective', 'emoji'];
// 프리셋은 파일에 저장되고 모든 관리자 화면에 그려지므로 형식을 엄격히 맞춘다
function cleanPreset(p) {
  const o = asObj(p);
  const text = cleanStr(o.text, MAX_QUESTION_LENGTH);
  if (!text) return null;
  const type = PRESET_TYPES.includes(o.type) ? o.type : 'yesno';
  const out = { text, type };
  if (type === 'choice') out.options = cleanOptions(o.options);
  // 선택형(YES/NO·객관식) 투표 시간 — 없으면(예전 프리셋) 실행 시 관리자 화면의 기본 시간을 쓴다
  if (type === 'yesno' || type === 'choice') {
    const sec = cleanVotingSeconds(o.duration);
    if (sec != null) out.duration = sec;
  }
  if (type === 'emoji') out.emojis = cleanEmojis(o.emojis);
  if (type === 'subjective') {
    const n = parseInt(o.maxLen, 10);
    out.maxLen = Number.isFinite(n) ? Math.min(MAX_ANSWER_LENGTH, Math.max(1, n)) : MAX_ANSWER_LENGTH;
  }
  return out;
}

// ── 옛 주소 정리 ── 예전 Render 계정의 서비스(chat-app-6kl5)도 같은 저장소를 보고 자동 배포된다.
// 현장에서 화면마다 다른 서버를 쓰는 사고를 막기 위해 옛 주소 접속은 모두 새 주소로 보낸다.
const CANONICAL_ORIGIN = 'https://chat-app-s6y2.onrender.com';
const LEGACY_HOSTS = ['chat-app-6kl5.onrender.com'];
const isLegacyHost = (host) => LEGACY_HOSTS.includes(String(host || '').split(':')[0].toLowerCase());

// ── 서버 상태 확인 (/health) ── Render health check·행사 전 점검용. 가볍게: 키·개인정보·채팅 내용 없이 숫자만.
// 옛 주소 리다이렉트보다 먼저 둔다(상태 확인은 어느 주소로 와도 그 서버 자신의 상태를 답함)
const SERVER_STARTED_AT = Date.now(); // 서버(프로세스) 시작 시각 — 재시작 알림·가동 시간 표시에도 쓴다
// 이번 실행의 고유 값 — 관리자 화면이 다시 연결됐을 때 이 값이 바뀌었으면 '서버가 다시 시작됨(기록 초기화)'을 알린다
const BOOT_ID = crypto.randomBytes(6).toString('hex');
app.get('/health', (req, res) => {
  const screens = io.sockets.adapter.rooms.get(SCREENS);
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    uptime: Math.round((Date.now() - SERVER_STARTED_AT) / 1000), // 초
    mode: appState.mode,
    audience: audienceSockets.size,
    screens: screens ? screens.size : 0, // LED + 관리자 + 운영진 화면 소켓 수
    startedAt: new Date(SERVER_STARTED_AT).toISOString(),
  });
});

app.use((req, res, next) => {
  if (isLegacyHost(req.headers.host)) return res.redirect(301, CANONICAL_ORIGIN + req.originalUrl);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// 라우트
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});
app.get('/led', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'led.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
// 행사별 관객 입장 주소 — 같은 chat.html이 경로를 보고 닉네임 풀·문구를 바꾼다.
// 관리자/LED는 공유하므로 기존 '/' 와 동일한 채팅·투표에 그대로 참여한다.
app.get('/concert', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});
// 콘서트 현장 LED (4:3 가로형, 2496×1872) — 관리자/관객은 기존 것 그대로 공유
app.get('/led/concert', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'led-concert.html'));
});
// 운영자(진행자/제작진) 채팅 화면 — 닉네임 직접 입력, LED에 구분 표시
app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

// 채팅이 허용되는 모드 / 리액션이 막히는 모드
// (운영진·관리자의 운영자 채팅은 모드와 무관하게 항상 허용 — 질문 중에도 채팅창 관리를 계속하므로)
const CHAT_MODES = ['chat', 'idle', 'ending'];
const REACTION_BLOCKED_MODES = ['voting', 'subjective', 'emoji', 'applause'];

// 최근 메시지 저장 (새 연결 시 보여줄 용도)
const recentMessages = [];
let msgSeq = 0; // 메시지 고유 id 시퀀스 (Date.now() 단독은 동시 전송 시 충돌 → 삭제 오작동)

// 관리자 질문 사전 등록 목록 — 여러 관리자 PC가 공유. 파일에 저장해 서버 재시작에도 유지한다.
// (단 Render는 재배포 시 파일시스템이 초기화되므로 재배포 때는 사라질 수 있음 — 완전 영속은 외부 DB 필요)
const PRESETS_FILE = path.join(__dirname, 'presets.json');
function loadPresets() {
  try { const v = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')); return Array.isArray(v) ? v.map(cleanPreset).filter(Boolean) : []; }
  catch { return []; }
}
function persistPresets() {
  try { fs.writeFileSync(PRESETS_FILE, JSON.stringify(questionPresets)); }
  catch (e) { console.error('프리셋 저장 실패:', e.message); }
}
let questionPresets = loadPresets();
const MAX_MESSAGES = 50;
const MAX_CHAT_LENGTH = 200; // 채팅 글자 수 제한 (클라이언트 제한 우회 대비 서버에서도 자름)
const MAX_OPERATOR_CHAT_LENGTH = 100; // 운영진(/host) 채팅 상한 — 화면 입력칸과 같게

const MAX_NICKNAME_LENGTH = 20; // 닉네임 길이 상한 — 실제 풀은 17자 이하지만
                                // 클라이언트가 보낸 값을 그대로 쓰므로 LED 레이아웃 보호용으로 자름

// ── 비속어 필터 ── 매칭 부분을 글자 수만큼 * 로 마스킹(차단이 아니라 가림).
// 방송 노출 화면 보호가 목적이라 오탐(정상 단어 차단)이 큰 단어는 넣지 않음.
// 완벽한 차단은 불가능(자모 분리·띄어쓰기 우회 등) — 명백한 욕설 + 흔한 초성체/영타 위주.
const PROFANITY = [
  // 대표 욕설(변형 포함)
  '씨발','씨발놈','씨발년','시발','시발놈','시발년','씨바','시바','씨빨','시빨','씨발새끼','시발새끼',
  '개새끼','개색기','개세끼','개새기','개쌔끼','새끼','쌔끼','새키',
  '병신','븅신','빙신','병맛',
  '지랄','지럴','염병','엿먹어','닥쳐','닥치','꺼져',
  '좆','좆같','좆나','존나','존니','존만','조까',
  '씹','씹새','씹창','씹할','씨부럴','씨부랄','개씹',
  '보지','자지','걸레','창녀','창놈','호로','후장',
  '미친놈','미친년','또라이','돌아이','썅','쌍놈','쌍년',
  // 초성체
  'ㅅㅂ','ㅆㅂ','ㅄ','ㅂㅅ','ㅈㄹ','ㄲㅈ','ㅅㅃ','ㅆㅃ','ㅗ',
  // 영문/영타
  'fuck','fxxk','shit','bitch','asshole','tlqkf','tprtl','qudtls','wlfkf',
].sort((a, b) => b.length - a.length); // 긴 단어 우선 매칭(개새끼 → 새끼보다 먼저)

function escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const PROFANITY_RE = PROFANITY.map(w => new RegExp(escapeRegex(w), 'gi'));

function maskProfanity(text) {
  if (!text) return text;
  let out = text;
  for (const re of PROFANITY_RE) {
    out = out.replace(re, (m) => '*'.repeat([...m].length));
  }
  return out;
}

// ── 투표(질문) 상태 관리 ──
// mode: 'chat' | 'voting' | 'result' | 'subjective' | 'subjectiveResult' | 'emoji'
//       | 'idle' | 'applause' | 'applauseResult' | 'ending'
//  - voting/result: 선택형 투표. voteType='yesno'(YES/NO 2지) 또는 'choice'(N지선다 2~6지)
//  - subjective/subjectiveResult: 주관식(자유 텍스트, 제작진 수동 마감 → 워드클라우드)
//  - emoji: 이모지 반응 질문(관객이 이모지 선택 → LED에 대량으로 떠오름, 비율 X, 분위기 고조용)
//  - idle: 대기 화면(입장 QR) — 채팅은 허용
//  - applause/applauseResult: 함성 측정(LED 마이크 레벨을 서버가 모아 화면에 중계) → 최고치 표시
//  - ending: 엔딩 슬라이드(그동안의 결과 모음) — 관리자가 직접 넘김(자동 진행 없음)
const appState = {
  mode: 'chat',
  question: null,
  votingDuration: null,   // 초 (선택형 전용)
  votingEndTime: null,    // epoch ms (선택형 전용)
  voteType: 'yesno',      // 'yesno' | 'choice' — 클라이언트 색/레이아웃 분기용
  voteOptions: ['YES', 'NO'], // 보기 라벨 배열 (yesno는 ['YES','NO'])
  votes: {},              // clientId -> 보기 인덱스(0-based)
  answers: {},            // clientId -> text (주관식, 1인 1회)
  answerList: [],         // [{id, text}] 도착 순서 (관리자 목록/픽용)
  pickedAnswers: [],      // 픽된 답변 id 목록 (픽 순서)
  starredAnswers: [],     // 별표(후보) 답변 id 목록 — 작가 1차 선별용, 관리자끼리 공유
  answerMaxLen: MAX_ANSWER_LENGTH, // 주관식 최대 글자수 (질문별 설정 가능, 1~20)
  emojiOptions: [],       // 이모지 반응 질문 보기: [{emoji, label}] (라벨=뜻, 관객 폰에 표시)
  pinnedChat: null,       // 채팅 모드에서 LED 중앙에 핀 고정된 채팅 {id, nickname, text}
  pinnedNotice: null,     // 운영자 채팅을 핀하면 공지처럼 LED·관객 폰 맨 위 띠로 고정 {id, nickname, text} (일반 핀과 따로)
  starredChats: [],       // 관리자가 체크(즐겨찾기)한 채팅 [{id, nickname, text, isOperator}] — 관리자끼리 공유, 메모리 보관
  timerHandle: null,
  chatPaused: false,      // LED 화면 채팅 표시 일시정지 여부 (관리자 화면에서 제어, 관객 채팅 송수신엔 영향 없음)
  effects: { heartBurst: true }, // LED 연출 on/off (리허설·현장 상황에 따라 관리자가 끔)
  applause: { endTime: null, peak: 0 }, // 함성 측정: 종료 시각(epoch ms) + 최고 레벨(0~1)
  endingIndex: 0,         // 엔딩 슬라이드 현재 위치
};

// ── 결과 기록 ── 투표·주관식 마감 결과를 쌓아 두었다가 엔딩 슬라이드로 다시 보여준다.
// 메모리에만 보관(재시작 시 초기화). 리허설 뒤에는 관리자가 비운다.
const MAX_RESULTS = 20;
const resultsHistory = [];
let resultSeq = 0; // 결과마다 서버가 붙이는 고정 id — 삭제를 위치(index)가 아닌 id로 해서 엇갈림 방지
function recordResult(entry) {
  resultsHistory.push({ ...entry, id: ++resultSeq });
  if (resultsHistory.length > MAX_RESULTS) resultsHistory.shift(); // 오래된 것부터 버림
}

// 엔딩 슬라이드 = 타이틀 + 결과(오래된 순) + 감사 인사. 결과를 비우면 바로 반영되도록 매번 만든다.
function endingSlides() {
  // id는 관리자 목록용 — 슬라이드 모양(프로토콜)은 그대로 둔다
  return [{ kind: 'title' }, ...resultsHistory.map(({ id, ...e }) => e), { kind: 'thanks' }];
}

// 결과 한 건을 관리자 목록에 보여줄 한 줄 요약으로 줄인다 (질문 전체 텍스트는 그대로 둠)
function resultSummary(entry) {
  if (entry.kind === 'vote') {
    const total = entry.total;
    const parts = entry.options.map((label, i) => {
      const pct = total > 0 ? Math.round((entry.perOption[i] / total) * 100) : 0;
      return `${label} ${pct}%`;
    });
    return `${parts.join(' · ')} (총 ${total}표)`;
  }
  if (entry.kind === 'subjective') {
    const top = entry.top[0];
    if (!top) return `답변 없음 (답변 ${entry.answerCount})`;
    const tied = entry.top.filter((t) => t.count === top.count); // 동률 1위는 모두 "공동 1위"로
    if (tied.length > 1) return `공동 1위 ${tied.map((t) => `‘${t.word}’`).join('·')} 각 ${top.count}명 (답변 ${entry.answerCount})`;
    return `1위 ‘${top.word}’ ${top.count}명 (답변 ${entry.answerCount})`;
  }
  return '';
}

// 관리자 화면의 "오늘의 결과" 목록용 — 질문 사전등록 목록과 같은 모양({kind,question,summary})
function resultsSummaryList() {
  return resultsHistory.map(e => ({ id: e.id, kind: e.kind, question: e.question, summary: resultSummary(e) }));
}

// 결과 기록이 바뀔 때마다(마감·비우기·개별 삭제) 관리자 화면에만 목록을 다시 보낸다 (관객 폰엔 안 보냄)
function emitResults() {
  io.to(ADMINS).emit('results', resultsSummaryList());
}

// 주관식 답변 묶음 키 — 같은 답으로 칠 표기 차이만 지운다: 유니코드 호환 정규화(NFKC), 공백 전부, 문장부호·기호·이모지
// (ZWJ·이모지 변형 선택자·키캡 포함), 영문 대소문자, 같은 글자 3번 이상 반복은 2번으로('ㅋㅋㅋㅋ'='ㅋㅋ').
// 오탈자 추정('일직'→'일찍') 같은 유사도 묶기는 하지 않는다(엉뚱한 답이 합쳐질 위험).
// 지우고 나면 빈 문자열(이모지·기호만)인 답은 원문(공백만 정리) 그대로 따로 센다.
const ANSWER_STRIP_RE = /[\s\p{P}\p{S}\p{Extended_Pictographic}\u200d\ufe0e\ufe0f\u20e3]/gu;
function answerKey(text) {
  const raw = String(text == null ? '' : text);
  const key = raw.normalize('NFKC').replace(ANSWER_STRIP_RE, '').toLowerCase().replace(/(.)\1{2,}/gu, '$1$1');
  return key || '\u0000' + raw.replace(/\s+/g, ' ').trim();
}

// 주관식 답변 → 워드클라우드용 빈도 집계 (상위 40개)
// 단어로 쪼개지 않고 답변 전체를 한 덩어리로 집계 — "나 빼고 다" 같은 문구형 답변의
// 어순/의미가 보존되고, 같은 답변을 쓴 사람이 많을수록 그 문구가 커진다.
// 묶음(answerKey)마다 화면에 보이는 대표 문구 = 그 묶음에서 가장 많이 나온 원문 표기(공백만 정리, 동률이면 먼저 들어온 것).
// key는 LED가 흘러가던 답변을 자기 단어로 모을 때 같은 묶음을 찾는 데 쓴다 (subjectiveAnswer에도 같은 key)
function computeCloud() {
  const groups = new Map(); // 묶음 키 -> { key, count, forms: Map(표기 -> 개수), first: 처음 들어온 순서 }
  appState.answerList.forEach((a, order) => {
    const form = String(a.text).replace(/\s+/g, ' ').trim();
    if (!form) return;
    const key = answerKey(form);
    let g = groups.get(key);
    if (!g) groups.set(key, g = { key, count: 0, forms: new Map(), first: order });
    g.count += 1;
    g.forms.set(form, (g.forms.get(form) || 0) + 1); // Map은 넣은 순서를 지킴 → 동률이면 먼저 들어온 표기
  });
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || a.first - b.first)
    .slice(0, 40)
    .map((g) => {
      let word = null, best = 0;
      g.forms.forEach((n, form) => { if (n > best) { best = n; word = form; } });
      return { word, count: g.count, key: g.key };
    });
}

// 보기별 득표 집계 → { perOption: [n0, n1, ...], total }
function computeCounts() {
  const perOption = new Array(appState.voteOptions.length).fill(0);
  let total = 0;
  for (const v of Object.values(appState.votes)) {
    if (typeof v === 'number' && v >= 0 && v < perOption.length) {
      perOption[v]++;
      total++;
    }
  }
  return { perOption, total };
}

// withSlides: 엔딩 슬라이드 전체는 화면(LED·관리자·운영진)에만 — 관객 폰엔 빈 목록(전송량 절약). 투표 중 집계 포함 여부도 겸함
function publicState(forClientId, withSlides = false) {
  const myVote = forClientId != null && appState.votes[forClientId] != null
    ? appState.votes[forClientId] : null;
  return {
    mode: appState.mode,
    question: appState.question,
    votingDuration: appState.votingDuration,
    votingEndTime: appState.votingEndTime,
    // 남은 시간(ms)을 서버 시계로 계산해 보낸다 — 화면마다 기기 시계가 달라(LED PC·관리자 PC·폰)
    // votingEndTime - 각자의 Date.now()로 계산하면 같은 질문인데 남은 초가 제각각이 되던 문제 해결.
    // 클라이언트는 받은 순간의 performance.now() + votingRemainMs 를 마감 시각으로 쓴다.
    votingRemainMs: appState.mode === 'voting' && appState.votingEndTime
      ? Math.max(0, appState.votingEndTime - Date.now()) : null,
    voteType: appState.voteType,
    voteOptions: appState.voteOptions,
    // 투표 중 집계는 화면(LED·관리자·운영진)에만 — 관객 폰이 재접속 때 받는 state로 표 수를 알 수 없게
    counts: appState.mode === 'voting' && !withSlides
      ? { perOption: new Array(appState.voteOptions.length).fill(0), total: 0 } : computeCounts(),
    myVote, // 내가 고른 보기 인덱스(0-based) 또는 null
    answerCount: Object.keys(appState.answers).length,
    answerMaxLen: appState.answerMaxLen,
    emojiOptions: appState.emojiOptions,
    myAnswered: forClientId ? !!appState.answers[forClientId] : null,
    cloud: appState.mode === 'subjectiveResult' ? computeCloud() : null,
    pinnedChat: appState.pinnedChat,
    pinnedNotice: appState.pinnedNotice,
    chatPaused: appState.chatPaused,
    audience: audienceStats(),
    // 아래는 모든 모드에서 같은 모양으로 보낸다(해당 모드가 아니면 기본값) — 클라이언트가 분기 없이 읽도록
    effects: { ...appState.effects },
    applause: isApplauseMode()
      ? { endTime: appState.applause.endTime, peak: appState.applause.peak }
      : { endTime: null, peak: 0 },
    ending: appState.mode === 'ending'
      ? { index: appState.endingIndex, slides: withSlides ? endingSlides() : [] }
      : { index: 0, slides: [] },
    resultsCount: resultsHistory.length,
    server: { bootId: BOOT_ID, startedAt: SERVER_STARTED_AT }, // 재시작 알림·가동 시간 (관리자 화면)
  };
}

// 모드 변경 알림 — 엔딩일 때만 화면/관객 페이로드를 나눈다(다른 모드는 모두에게 같은 내용)
function emitModeChange() {
  if (appState.mode !== 'ending') { io.emit('modeChange', publicState(null, true)); return; }
  io.to(SCREENS).emit('modeChange', publicState(null, true));
  io.except(SCREENS).emit('modeChange', publicState(null, false));
}

function isApplauseMode() {
  return appState.mode === 'applause' || appState.mode === 'applauseResult';
}

// ── 전송 대상 분리 ── 관객 폰이 쓰지 않는 이벤트(리액션·투표 중간 집계·주관식 답변 등)는
// 화면(LED·관리자·운영진)에만 보낸다. 관객 수만큼 곱해지는 전송량(N²)을 줄이는 핵심.
const SCREENS = 'screens'; // LED + 관리자 + 운영진
const ADMINS = 'admins';   // 관리자 화면 전용 (프리셋·별표·접속 통계)

// 채팅 묶음 전송 — 한가할 땐 즉시 'chat'으로 보내고, 그 뒤 CHAT_BATCH_MS 안에 몰려 온 메시지는
// 'chatBatch' 한 번으로 묶어 보낸다. 평소 지연은 0, 폭주 시 소켓당 전송 횟수가 크게 준다.
const CHAT_BATCH_MS = 100;
let chatQueue = [];
let chatWindowTimer = null;
function broadcastChat(message) {
  if (chatWindowTimer) { chatQueue.push(message); return; }
  io.emit('chat', message);
  chatWindowTimer = setTimeout(flushChatQueue, CHAT_BATCH_MS);
}
function flushChatQueue() {
  if (!chatQueue.length) { chatWindowTimer = null; return; }
  const batch = chatQueue;
  chatQueue = [];
  if (batch.length === 1) io.emit('chat', batch[0]);
  else io.emit('chatBatch', batch);
  chatWindowTimer = setTimeout(flushChatQueue, CHAT_BATCH_MS);
}

// 투표 집계는 표마다 보내지 않고 VOTE_UPDATE_MS마다 최신 집계만 화면에 보낸다
const VOTE_UPDATE_MS = 200;
let voteUpdateTimer = null;
function scheduleVoteUpdate() {
  if (voteUpdateTimer) return;
  voteUpdateTimer = setTimeout(() => {
    voteUpdateTimer = null;
    if (appState.mode === 'voting') io.to(SCREENS).emit('voteUpdate', { counts: computeCounts() });
  }, VOTE_UPDATE_MS);
}

// 질문 모드 진입/복귀 시 채팅 핀·운영자 공지 핀 해제 (오래된 핀이 남는 것 방지)
function clearPinnedChat() {
  clearPinnedNotice();
  if (!appState.pinnedChat) return;
  appState.pinnedChat = null;
  io.to(SCREENS).emit('chatPinned', { message: null });
}

// 운영자 공지 핀 해제 — 관객 폰에도 보이므로 모두에게 알린다 (드물게 일어나는 이벤트라 전송량 부담 없음)
function clearPinnedNotice() {
  if (!appState.pinnedNotice) return;
  appState.pinnedNotice = null;
  io.emit('noticePinned', { message: null });
}

// 체크(즐겨찾기)한 채팅 목록 — 관리자 화면 전용
function emitChatStars(target) {
  (target || io.to(ADMINS)).emit('chatStars', appState.starredChats);
}

// options: 보기 라벨 배열, type: 'yesno' | 'choice'
function startVoting(question, options, duration, type) {
  clearPinnedChat();
  resetSpecialState(); // 대기·함성·엔딩 중에 시작해도 남은 상태 정리
  if (appState.timerHandle) clearTimeout(appState.timerHandle);
  appState.mode = 'voting';
  appState.question = question;
  appState.voteType = type;
  appState.voteOptions = options;
  appState.votingDuration = duration;
  appState.votingEndTime = Date.now() + duration * 1000;
  appState.votes = {};
  appState.answers = {};
  appState.answerList = [];
  appState.pickedAnswers = [];
  appState.starredAnswers = [];
  emitModeChange();

  appState.timerHandle = setTimeout(() => {
    endVoting();
  }, duration * 1000);
}

// ── 이모지 반응 질문 (타이머 없음, 제작진 수동 마감=채팅 복귀) ──
// 관객이 이모지를 고르면 LED에 대량으로 떠오름(비율 X). 여러 번 탭 가능(분위기 고조).
function startEmoji(question, emojis) {
  clearPinnedChat();
  resetSpecialState(); // 대기·함성·엔딩 중에 시작해도 남은 상태 정리
  if (appState.timerHandle) {
    clearTimeout(appState.timerHandle);
    appState.timerHandle = null;
  }
  appState.mode = 'emoji';
  appState.question = question;
  appState.emojiOptions = emojis;
  appState.votingDuration = null;
  appState.votingEndTime = null;
  appState.votes = {};
  emitModeChange();
}

// ── 주관식 질문 (타이머 없음, 제작진 수동 마감) ──
function startSubjective(question, maxLen) {
  clearPinnedChat();
  resetSpecialState(); // 대기·함성·엔딩 중에 시작해도 남은 상태 정리
  if (appState.timerHandle) {
    clearTimeout(appState.timerHandle);
    appState.timerHandle = null;
  }
  appState.mode = 'subjective';
  appState.question = question;
  appState.answerMaxLen = maxLen;
  appState.votingDuration = null;
  appState.votingEndTime = null;
  appState.votes = {};
  appState.answers = {};
  appState.answerList = [];
  appState.pickedAnswers = [];
  appState.starredAnswers = [];
  emitModeChange();
}

function endSubjective() {
  if (appState.mode !== 'subjective') return;
  appState.mode = 'subjectiveResult';
  recordResult({
    kind: 'subjective',
    question: appState.question,
    // 엔딩은 3위까지 보여 주지만, 3위가 4위와 동률인지("공동 3위") 알 수 있게 4개까지 기록
    top: computeCloud().slice(0, 4).map(({ word, count }) => ({ word, count })),
    answerCount: Object.keys(appState.answers).length,
  });
  emitModeChange(); // cloud 포함됨
  emitResults();
}

function endVoting() {
  if (appState.timerHandle) {
    clearTimeout(appState.timerHandle);
    appState.timerHandle = null;
  }
  if (appState.mode !== 'voting') return;
  appState.mode = 'result';
  const { perOption, total } = computeCounts();
  recordResult({
    kind: 'vote',
    question: appState.question,
    voteType: appState.voteType,
    options: [...appState.voteOptions],
    perOption,
    total,
  });
  emitModeChange();
  emitResults();
}

// 질문·함성·엔딩 상태를 모두 비운다 (모드 값은 호출한 쪽이 정함)
// 타이머 슬롯은 투표·함성이 같이 쓰므로 여기서 함께 정리된다.
function resetQuestionState() {
  clearPinnedChat();
  if (appState.timerHandle) {
    clearTimeout(appState.timerHandle);
    appState.timerHandle = null;
  }
  appState.question = null;
  appState.votingDuration = null;
  appState.votingEndTime = null;
  appState.voteType = 'yesno';
  appState.voteOptions = ['YES', 'NO'];
  appState.votes = {};
  appState.answers = {};
  appState.answerList = [];
  appState.pickedAnswers = [];
  appState.starredAnswers = [];
  appState.answerMaxLen = MAX_ANSWER_LENGTH;
  appState.emojiOptions = [];
  resetSpecialState();
}

// 함성·엔딩 상태 초기화 — 질문 시작 등 다른 모드로 넘어갈 때 남은 값이 섞이지 않게
function resetSpecialState() {
  appState.applause = { endTime: null, peak: 0 };
  appState.endingIndex = 0;
  if (applauseRelayTimer) { clearTimeout(applauseRelayTimer); applauseRelayTimer = null; }
  applauseRelayPending = null;
}

function returnToChat() {
  resetQuestionState();
  appState.mode = 'chat';
  emitModeChange();
}

// 대기 화면(입장 QR) — 채팅 복귀와 같이 질문 상태를 비우고 핀도 내린다
function showIdle() {
  resetQuestionState();
  appState.mode = 'idle';
  emitModeChange();
}

// ── 함성 측정 ── LED가 마이크 레벨(0~1)을 보내면 서버가 최고치를 갱신하고 화면들에 중계한다.
// 진행 중인 질문이 있어도 대체한다(새 질문 시작과 같은 규칙). 시간이 끝나면 결과 모드로 자동 전환.
const MIN_APPLAUSE_SECONDS = 5;
const MAX_APPLAUSE_SECONDS = 30;
function startApplause(seconds) {
  resetQuestionState();
  appState.mode = 'applause';
  appState.applause = { endTime: Date.now() + seconds * 1000, peak: 0 };
  emitModeChange();
  appState.timerHandle = setTimeout(endApplause, seconds * 1000);
}

function endApplause() {
  appState.timerHandle = null;
  if (appState.mode !== 'applause') return;
  appState.mode = 'applauseResult';
  emitModeChange(); // 최고치(peak) 포함
}

// 레벨 중계는 APPLAUSE_RELAY_MS에 한 번만 — 첫 값은 즉시, 그 사이 들어온 값은 최신 것 하나만 뒤이어 보낸다
const APPLAUSE_RELAY_MS = 100;
let applauseRelayTimer = null;
let applauseRelayPending = null;
function relayApplause(level) {
  if (applauseRelayTimer) { applauseRelayPending = level; return; }
  io.to(SCREENS).emit('applauseLevel', { level, peak: appState.applause.peak });
  applauseRelayTimer = setTimeout(flushApplauseRelay, APPLAUSE_RELAY_MS);
}
function flushApplauseRelay() {
  applauseRelayTimer = null;
  if (applauseRelayPending == null || appState.mode !== 'applause') { applauseRelayPending = null; return; }
  const level = applauseRelayPending;
  applauseRelayPending = null;
  relayApplause(level);
}

// ── 엔딩 슬라이드 ── 넘김은 관리자만(자동 진행 없음)
function startEnding() {
  resetQuestionState();
  appState.mode = 'ending';
  appState.endingIndex = 0;
  emitModeChange();
}

function endingGo(index) {
  if (appState.mode !== 'ending') return;
  const last = endingSlides().length - 1;
  appState.endingIndex = Math.min(last, Math.max(0, index));
  emitModeChange();
}

// ── 핀 알림용 작성자 기록 ── 메시지 id → 작성 관객 clientId (외부로 보내지 않음, 오래된 것부터 버림)
const MAX_MESSAGE_AUTHORS = 500;
const messageAuthors = new Map();
function rememberAuthor(id, clientId) {
  messageAuthors.set(id, clientId);
  if (messageAuthors.size > MAX_MESSAGE_AUTHORS) messageAuthors.delete(messageAuthors.keys().next().value);
}

// 관리자 조작 유효 시간 — 이보다 늦게 도착한 조작은 실행하지 않는다(화면이 보낸 시각 _t가 있을 때만 검사, 옛 화면은 그대로)
const STALE_ADMIN_MS = 6000;

// 접속 시 인증 키로 역할 결정 — 관객은 키 없이 그대로 접속(audience)
function isValidClientId(v) { return typeof v === 'string' && v.length > 0 && v.length <= 64; }

io.use((socket, next) => {
  if (isLegacyHost(socket.handshake.headers.host)) return next(new Error('moved')); // 옛 주소 소켓 접속 차단
  const auth = asObj(socket.handshake.auth);
  socket.data.role = roleForKey(auth.key);
  // clientId를 접속 시점에 받는다 — 끊긴 동안 쌓인 투표/답변이 identify보다 먼저 도착해 버려지는 문제 방지
  socket.data.clientId = isValidClientId(auth.clientId) ? auth.clientId : null;
  next();
});

io.on('connection', (socket) => {
  console.log('연결됨:', socket.id);
  socket.clientId = socket.data.clientId;
  const role = socket.data.role;
  if (role === 'admin') socket.join([SCREENS, ADMINS]);
  else if (role === 'host') socket.join(SCREENS);

  // 핸들러 예외가 서버 전체를 죽이지 않도록 모든 이벤트를 감싼다
  const on = (event, fn) => socket.on(event, (...args) => {
    try { fn(...args); }
    catch (e) { console.error(`[${event}] 처리 중 오류:`, e); }
  });
  // 권한이 없으면 무시하고, 화면이 키 입력을 안내할 수 있게 1회 알린다
  const denied = (need) => {
    if (socket._authErrorSent) return;
    socket._authErrorSent = true;
    socket.emit('authError', { need });
  };
  // 제작진 이벤트 공통 처리 — 마지막 인자가 함수(ack)면 결과를 { ok, reason }으로 돌려준다(콜백 없는 옛 화면은 그대로 동작).
  // 핸들러는 거부할 때 사유 코드(문자열)를 return 한다 — 화면이 한국어 안내로 바꿔 보여 줌.
  //  auth: 키 없음/틀림(매번 알림 — authError 이벤트는 소켓당 1번), error: 처리 중 오류
  //  stale: 관리자 화면이 보낸 시각(서버 시계 기준 추정, 두 번째 인자 { _t })보다 STALE_ADMIN_MS 넘게 늦게 도착한 조작 —
  //         와이파이 먹통·재연결 버퍼로 한참 뒤에 도착한 [실행]이 뒤늦게 LED를 바꾸지 않게 버린다
  const staffHandler = (need, fn) => (...args) => {
    const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const reply = (reason) => { if (ack) ack(reason ? { ok: false, reason } : { ok: true }); };
    const allowed = need === 'admin' ? role === 'admin' : (role === 'admin' || role === 'host');
    if (!allowed) { denied(need); return reply('auth'); }
    const sentAt = asObj(args[1])._t;
    if (typeof sentAt === 'number' && Number.isFinite(sentAt) && Date.now() - sentAt > STALE_ADMIN_MS) return reply('stale');
    let r;
    try { r = fn(args[0]); }
    catch (e) { reply('error'); throw e; }
    reply(typeof r === 'string' ? r : null);
  };
  const onAdmin = (event, fn) => on(event, staffHandler('admin', fn));
  const onStaff = (event, fn) => on(event, staffHandler('host', fn));

  // 클라이언트 식별 (localStorage 기반 영구 ID) — 투표 중복/재접속 처리용
  on('identify', (clientId) => {
    if (!isValidClientId(clientId)) return;
    // 한 소켓의 clientId는 처음 정해진 값으로 고정 — 바꿔 가며 여러 번 투표하는 것 방지
    if (!socket.clientId) socket.clientId = clientId;
    socket.emit('state', publicState(socket.clientId, socket.rooms.has(SCREENS)));
    // 핀 고정 순간 폰이 잠겨 있거나 다른 앱을 쓰느라 연결이 끊겨 있었으면 알림을 놓친다
    // → 다시 접속했을 때 내 채팅이 아직 고정 중이면 늦게라도 알려준다(late: 폰이 이미 본 알림이면 다시 띄우지 않음)
    const pin = appState.pinnedChat;
    if (pin && messageAuthors.get(pin.id) === socket.clientId) {
      socket.emit('chatPinnedYou', { id: pin.id, text: pin.text, late: true });
    }
  });

  // 연결 확인 — 폰이 다른 앱에서 돌아왔을 때 연결이 살아 있는지 바로 확인하는 용도
  on('alive', (ack) => { if (typeof ack === 'function') ack(true); });

  // 서버 시계·응답 확인 — 관리자 화면이 몇 초마다 물어 '서버 응답 없음'을 알아채고, 조작에 붙일 서버 기준 시각을 맞춘다
  on('serverTime', (ack) => { if (typeof ack === 'function') ack({ now: Date.now(), bootId: BOOT_ID, startedAt: SERVER_STARTED_AT }); });

  // LED 화면 등록 — 화면 전용 이벤트(리액션·투표 집계·주관식 흘려보내기 등)를 받는다
  // isScreen: 함성 레벨을 보낼 수 있는 소켓 표시 (관리자·운영진은 역할로 SCREENS에 들어오므로 방 소속으로 판단하지 않음)
  on('registerScreen', () => { socket.isScreen = true; socket.join(SCREENS); });

  // 클라이언트가 로컬에서 즉시 고른 닉네임 등록 + 동시 중복 확인
  // payload: { name, theme } — 예전 클라이언트를 위해 문자열도 허용
  on('claimNickname', (payload) => {
    const name = typeof payload === 'string' ? payload : (payload && payload.name);
    const theme = (payload && isThemeKey(payload.theme)) ? payload.theme : DEFAULT_THEME;
    if (!name || typeof name !== 'string') return;

    // 관객 접속 집계 — claimNickname을 처음 보낸 소켓을 관객으로 등록(리롤로 여러 번 와도 1회만)
    if (!socket.isAudience && socket.clientId) {
      socket.isAudience = true;
      audienceSockets.set(socket.clientId, (audienceSockets.get(socket.clientId) || 0) + 1);
      if (audienceSockets.size > audiencePeak) audiencePeak = audienceSockets.size;
      broadcastAudience();
    }
    socket.nickTheme = theme;
    claimFor(cleanStr(name, MAX_NICKNAME_LENGTH), theme);
  });

  // 닉네임 등록(동시 중복이면 같은 테마의 안 쓰는 닉네임으로 교체해 알려줌) → 확정된 닉네임 반환
  function claimFor(name, theme) {
    // 한 소켓은 처음 등록한 주인 키를 계속 쓴다(끊길 때 같은 기록의 접속 수를 줄이기 위해)
    const key = socket._nickOwnerKey || (socket._nickOwnerKey = ownerKeyOf(socket, theme));
    // 닉네임도 LED에 그대로 나가므로 비속어가 섞이면 풀에서 새로 배정(정상 풀 닉네임은 걸리지 않음)
    let final = maskProfanity(name) === name ? name : '';
    if (!final || isOldSpacingNickname(final, theme) || isNicknameTaken(final, key)) {
      let guard = 0;
      do {
        final = assignNickname(theme); // 교체 닉네임도 반드시 같은 테마에서
        guard++;
      } while (isNicknameTaken(final, key) && guard < poolSize(theme));
    }
    // 이 기기의 닉네임 기록 갱신 — 리롤 등으로 바뀌면 이전 닉네임은 풀어 준다
    let rec = ownerNicknames.get(key);
    if (rec && rec.name !== final && nicknameOwners.get(rec.name) === key) nicknameOwners.delete(rec.name);
    if (!rec) { rec = { name: final, sockets: 0, releasedAt: 0 }; ownerNicknames.set(key, rec); }
    rec.name = final;
    if (!socket._ownsNickname) { socket._ownsNickname = true; rec.sockets++; }
    nicknameOwners.set(final, key);
    activeNicknames.set(socket.id, final);
    if (final !== name) socket.emit('nicknameReassigned', final);
    return final;
  }

  // 운영자(진행자/제작진) 등록 — /host 화면에서 호출. 이 소켓의 채팅은 isOperator로 표시된다.
  // 관객 집계(claimNickname)와 무관 → 운영자는 '현재 접속자' 수에 포함되지 않는다.
  // 운영진 키(HOST_KEY 또는 ADMIN_KEY)로 접속한 소켓만 운영자로 인정 — 관객의 운영진 사칭 방지
  on('registerOperator', () => {
    if (role !== 'admin' && role !== 'host') return denied('host');
    socket.isOperator = true;
  });

  // 새 연결에 최근 메시지 전송
  socket.emit('history', recentMessages);
  if (role === 'admin') emitChatStars(socket); // 체크한 채팅(관리자끼리 공유) 복원

  // 채팅 메시지 (채팅·대기·엔딩 모드에서 허용)
  // ack(선택): 보낸 사람에게 결과를 알려준다 — { ok: true } 또는 { ok: false, reason: 'mode'|'rate'|'empty' }
  // (예전 화면은 ack 없이 보내므로 함수일 때만 호출)
  on('chat', (data, ack) => {
    const reply = (r) => { if (typeof ack === 'function') ack(r); };
    if (!socket.isOperator && !CHAT_MODES.includes(appState.mode)) return reply({ ok: false, reason: 'mode' });
    const d = asObj(data);
    const raw = cleanStr(d.text, socket.isOperator ? MAX_OPERATOR_CHAT_LENGTH : MAX_CHAT_LENGTH);
    if (!raw) return reply({ ok: false, reason: 'empty' });
    // 도배 제한 (운영진 제외): 5초에 5건 — 정상 입력 속도로는 걸리지 않는 수준
    if (!socket.isOperator) {
      const now = Date.now();
      socket._chatTimes = (socket._chatTimes || []).filter(t => now - t < 5000);
      if (socket._chatTimes.length >= 5) return reply({ ok: false, reason: 'rate' });
      socket._chatTimes.push(now);
    }
    const text = maskProfanity(raw); // 비속어 * 처리
    // 운영진은 직접 입력한 이름, 관객은 서버에 등록된 닉네임만 사용(다른 관객 사칭 방지).
    // 등록 전(재접속 직후 등)이면 보낸 이름으로 즉시 등록 — 중복이면 교체된다.
    const nickname = socket.isOperator
      ? cleanStr(d.nickname, MAX_NICKNAME_LENGTH)
      : (activeNicknames.get(socket.id) || claimFor(cleanStr(d.nickname, MAX_NICKNAME_LENGTH), socket.nickTheme || DEFAULT_THEME));
    const message = {
      id: `${Date.now()}-${msgSeq++}`, // 고유 id (삭제/핀 대상 식별)
      nickname,
      text,
      isOperator: !!socket.isOperator, // 운영자 메시지는 LED에서 배경색으로 구분
    };
    // 핀 알림용으로 관객 작성자만 기억(운영진 메시지는 알릴 대상 없음)
    if (!socket.isOperator && socket.clientId) rememberAuthor(message.id, socket.clientId);
    recentMessages.push(message);
    if (recentMessages.length > MAX_MESSAGES) recentMessages.shift();
    broadcastChat(message);
    reply({ ok: true });
  });

  // 리액션 (하트/붐업/붐따) — LED 화면에 떠오르는 이모지 효과
  // 채팅 모드: 하트/붐업, 결과 모드: 붐업/붐따로 결과에 반응
  // 투표·함성 측정 중엔 차단(답변·함성에 집중), 소켓당 3초에 10회로 스팸 제한
  on('reaction', (data) => {
    const { type } = data || {};
    if (REACTION_BLOCKED_MODES.includes(appState.mode)) return; // 답변 집중 구간엔 차단
    if (type !== 'heart' && type !== 'thumbs' && type !== 'down') return;
    const now = Date.now();
    if (!socket._reactionTimes) socket._reactionTimes = [];
    socket._reactionTimes = socket._reactionTimes.filter(t => now - t < 3000);
    if (socket._reactionTimes.length >= 10) return;
    socket._reactionTimes.push(now);
    io.to(SCREENS).emit('reaction', { type });
  });

  // 투표 (choice = 보기 인덱스 0-based)
  on('vote', (data) => {
    const idx = data && data.choice;
    if (appState.mode !== 'voting') return;
    if (!Number.isInteger(idx) || idx < 0 || idx >= appState.voteOptions.length) return;
    if (!socket.clientId) return;

    appState.votes[socket.clientId] = idx;
    scheduleVoteUpdate();
  });

  // 이모지 반응 질문: 관객이 이모지 선택 → LED에 떠오름. 여러 번 탭 가능(스팸 제한).
  on('emojiPick', (data) => {
    if (appState.mode !== 'emoji') return;
    const emoji = data && data.emoji;
    if (typeof emoji !== 'string' || !appState.emojiOptions.some(o => o && o.emoji === emoji)) return;
    const now = Date.now();
    if (!socket._emojiTimes) socket._emojiTimes = [];
    socket._emojiTimes = socket._emojiTimes.filter(t => now - t < 3000);
    if (socket._emojiTimes.length >= 10) return; // 3초에 10회 상한
    socket._emojiTimes.push(now);
    io.to(SCREENS).emit('emojiFloat', { emoji });
  });

  // 주관식 답변 (1인 1회, 20자 제한)
  on('answer', (data) => {
    if (appState.mode !== 'subjective') return;
    if (!socket.clientId) return;
    if (appState.answers[socket.clientId]) return; // 이미 답변함
    const raw = cleanStr(asObj(data).text, appState.answerMaxLen);
    if (!raw) return;
    const text = maskProfanity(raw); // 비속어 * 처리

    appState.answers[socket.clientId] = text;
    const entry = { id: appState.answerList.length + 1, text };
    appState.answerList.push(entry);
    // LED 흘려보내기 + 관리자 목록/카운트용 (익명: 텍스트만 공개)
    io.to(SCREENS).emit('subjectiveAnswer', {
      id: entry.id,
      text,
      key: answerKey(text), // 워드클라우드 묶음 키 (LED가 흘러가던 답변을 자기 단어로 모을 때)
      answerCount: Object.keys(appState.answers).length,
    });
    socket.emit('answerAccepted'); // 본인 확인용
  });

  // ── 관리자(제작진) 전용 이벤트 ──
  onAdmin('admin:startVoting', (data) => {
    if (appState.mode === 'voting') return 'votingRunning'; // 진행 중 재시작(중복 클릭·관리자 여러 명) 시 표 초기화 방지
    const d = asObj(data);
    const question = cleanStr(d.question, MAX_QUESTION_LENGTH);
    const duration = cleanVotingSeconds(d.duration) ?? DEFAULT_VOTING_SECONDS;
    if (!question) return 'empty';
    const type = d.type === 'choice' ? 'choice' : 'yesno';
    let options;
    if (type === 'choice') {
      options = cleanOptions(d.options);
      if (options.length < 2) return 'options'; // 보기 2개 미만이면 무시
    } else {
      options = ['YES', 'NO'];
    }
    startVoting(question, options, duration, type);
  });

  onAdmin('admin:endVoting', () => {
    if (appState.mode !== 'voting') return 'mode';
    endVoting();
  });

  onAdmin('admin:startSubjective', (data) => {
    if (appState.mode === 'subjective') return 'subjectiveRunning'; // 접수 중 재시작 시 답변 초기화 방지
    const question = cleanStr(asObj(data).question, MAX_QUESTION_LENGTH);
    if (!question) return 'empty';
    let maxLen = parseInt(asObj(data).maxLen, 10);
    if (!Number.isFinite(maxLen) || maxLen < 1) maxLen = MAX_ANSWER_LENGTH;
    maxLen = Math.min(MAX_ANSWER_LENGTH, maxLen); // 상한 20 (LED 가독성)
    startSubjective(question, maxLen);
  });

  onAdmin('admin:startEmoji', (data) => {
    const question = cleanStr(asObj(data).question, MAX_QUESTION_LENGTH);
    if (!question) return 'empty';
    // emojis: [{emoji, label}] — 라벨(뜻)은 관객 폰 버튼에 함께 표시
    const emojiOptions = cleanEmojis(asObj(data).emojis);
    if (emojiOptions.length < 2) return 'emojis'; // 이모지 2개 미만이면 무시
    startEmoji(question, emojiOptions);
  });

  onAdmin('admin:endSubjective', () => {
    if (appState.mode !== 'subjective') return 'mode';
    endSubjective();
  });

  // 관리자: 채팅 핀 고정 — LED 중앙에 해당 채팅을 팝업으로 표시 (채팅 모드 전용)
  onAdmin('admin:pinChat', (data) => {
    if (appState.mode !== 'chat') return 'pinMode';
    const d = asObj(data);
    const nickname = cleanStr(d.nickname, MAX_NICKNAME_LENGTH);
    const text = maskProfanity(cleanStr(d.text, MAX_CHAT_LENGTH));
    if (!text) return 'empty';
    const id = typeof d.id === 'string' || typeof d.id === 'number' ? d.id : Date.now();
    // 운영자 채팅이면 공지 핀(LED·관객 폰 맨 위 띠). 운영자 여부는 서버 보관본 기준(지난 채팅이면 관리자가 보낸 값)
    const known = recentMessages.find(m => m.id === id) || appState.starredChats.find(m => m.id === id);
    if (known ? known.isOperator : d.isOperator === true) {
      appState.pinnedNotice = { id, nickname, text };
      io.emit('noticePinned', { message: appState.pinnedNotice });
      return;
    }
    appState.pinnedChat = { id, nickname, text };
    io.to(SCREENS).emit('chatPinned', { message: appState.pinnedChat });
    // 작성한 관객에게 "내 채팅이 LED에 올라감" 알림 — 같은 사람의 탭이 여러 개면 모두에게
    const author = messageAuthors.get(id);
    if (author) {
      for (const s of io.sockets.sockets.values()) {
        if (s.clientId === author) s.emit('chatPinnedYou', { id, text });
      }
    }
  });

  onAdmin('admin:unpinChat', () => {
    // 일반 핀만 내린다 (공지 핀은 [공지 내리기]로 따로) — clearPinnedChat은 공지까지 내리므로 쓰지 않음
    if (!appState.pinnedChat) return;
    appState.pinnedChat = null;
    io.to(SCREENS).emit('chatPinned', { message: null });
  });

  onAdmin('admin:unpinNotice', () => {
    clearPinnedNotice();
  });

  // 관리자: 채팅 체크(즐겨찾기) 토글 — 좋은 글을 모아 두고 나중에 핀. LED·관객엔 안 보임, 관리자 화면끼리 공유.
  // 메시지 내용째 보관 → 최근 채팅(50개)에서 밀려나도, 새로 연 관리자 화면에서도 체크 목록에서 바로 핀할 수 있다.
  onAdmin('admin:toggleChatStar', (data) => {
    const d = asObj(data);
    if (typeof d.id !== 'string' || d.id.length > 64) return 'invalid';
    const idx = appState.starredChats.findIndex(m => m.id === d.id);
    if (idx !== -1) appState.starredChats.splice(idx, 1);
    else {
      // 서버 보관본(최근 50개)에 있으면 그 내용을, 밀려난 지난 채팅이면 관리자 화면이 보낸 내용을 쓴다
      const m = recentMessages.find(x => x.id === d.id) || {
        id: d.id,
        nickname: cleanStr(d.nickname, MAX_NICKNAME_LENGTH),
        text: maskProfanity(cleanStr(d.text, MAX_CHAT_LENGTH)),
        isOperator: d.isOperator === true,
      };
      if (!m.text) return 'empty';
      appState.starredChats.push({ id: m.id, nickname: m.nickname, text: m.text, isOperator: !!m.isOperator });
      if (appState.starredChats.length > 200) appState.starredChats.shift(); // 과도한 누적 방지
    }
    emitChatStars();
  });

  // 관리자: 개별 채팅 삭제 — 부적절한 메시지를 즉시 내림. 모든 화면에서 사라진다.
  onStaff('admin:deleteMessage', (id) => {
    if (typeof id !== 'string') return 'invalid';
    const idx = recentMessages.findIndex(m => m.id === id);
    if (idx !== -1) recentMessages.splice(idx, 1);
    chatQueue = chatQueue.filter(m => m.id !== id); // 아직 묶음 전송 전이면 대기열에서도 제거
    if (appState.pinnedChat && appState.pinnedChat.id === id) {  // 핀된 걸 지우면 핀도 해제
      appState.pinnedChat = null;
      io.to(SCREENS).emit('chatPinned', { message: null });
    }
    if (appState.pinnedNotice && appState.pinnedNotice.id === id) clearPinnedNotice();
    const starIdx = appState.starredChats.findIndex(m => m.id === id);
    if (starIdx !== -1) { appState.starredChats.splice(starIdx, 1); emitChatStars(); } // 지운 글은 체크 목록에서도 뺌
    io.emit('chatDeleted', id);
  });

  // 관리자: 질문 사전 등록 목록 조회/저장 — 다른 관리자 PC와 실시간 공유
  onAdmin('admin:getPresets', () => {
    socket.emit('presets', questionPresets);
  });
  onAdmin('admin:setPresets', (list) => {
    if (!Array.isArray(list)) return 'invalid';
    questionPresets = list
      .slice(0, 100) // 과도한 등록 방지
      .map(cleanPreset).filter(Boolean); // 형식 검증 (문자열·길이·유형 화이트리스트)
    persistPresets(); // 파일에 저장 → 재시작에도 유지 (삭제로 빈 목록이어도 그대로 저장 = 삭제 확정)
    socket.to(ADMINS).emit('presets', questionPresets); // 나를 제외한 다른 관리자에게 반영
  });

  // 관리자: 접속 통계 초기화 — 최고 동시 접속을 현재값으로 되돌린다.
  // 현재 접속자는 실제 열려 있는 소켓 수라 임의로 못 지운다(peak만 리셋).
  onAdmin('admin:resetAudienceStats', () => {
    audiencePeak = audienceSockets.size;
    io.to(ADMINS).emit('audienceStats', audienceStats());
  });

  // 관리자: 채팅 기록 초기화 — 리허설 뒤 LED/관객 화면을 비우고 본 행사를 시작할 때.
  // 서버 보관본을 비워야 새로 접속하는 관객에게 옛 메시지가 history로 다시 내려가지 않는다.
  onAdmin('admin:clearChat', () => {
    recentMessages.length = 0;
    chatQueue = [];
    messageAuthors.clear();
    clearPinnedChat(); // 지워진 메시지가 LED에 핀(공지 핀 포함)으로 남아 있으면 안 됨
    if (appState.starredChats.length) { appState.starredChats = []; emitChatStars(); }
    io.emit('chatCleared');
  });

  // 관리자: 답변 전체 목록 요청 (제작진이 훑어보고 픽하기 위함)
  onAdmin('admin:getAnswers', () => {
    socket.emit('answerList', {
      answers: appState.answerList,
      picked: appState.pickedAnswers,
      starred: appState.starredAnswers,
    });
  });

  // 관리자: 별표(후보) 토글 — 작가 1차 선별용, 모든 관리자 화면에 공유
  onAdmin('admin:toggleStar', (data) => {
    const id = data && data.id;
    const entry = appState.answerList.find(a => a.id === id);
    if (!entry) return 'notFound';
    const idx = appState.starredAnswers.indexOf(id);
    const starred = idx === -1;
    if (starred) appState.starredAnswers.push(id);
    else appState.starredAnswers.splice(idx, 1);
    io.to(ADMINS).emit('answerStarred', { id, starred });
  });

  // 관리자: 답변 픽 → LED 스포트라이트로 크게 표시 (접수 중/마감 후 모두 가능)
  onAdmin('admin:pickAnswer', (data) => {
    const id = data && data.id;
    if (appState.mode !== 'subjective' && appState.mode !== 'subjectiveResult') return 'mode';
    const entry = appState.answerList.find(a => a.id === id);
    if (!entry) return 'notFound';
    if (!appState.pickedAnswers.includes(id)) appState.pickedAnswers.push(id);
    io.to(SCREENS).emit('answerPicked', { id: entry.id, text: entry.text });
  });

  onAdmin('admin:returnToChat', () => {
    returnToChat();
  });

  onAdmin('admin:showIdle', () => {
    showIdle();
  });

  // 함성 측정 시작 — 초는 5~30 (기본 10)
  onAdmin('admin:startApplause', (data) => {
    const n = parseInt(asObj(data).seconds, 10);
    const seconds = Number.isFinite(n)
      ? Math.min(MAX_APPLAUSE_SECONDS, Math.max(MIN_APPLAUSE_SECONDS, n))
      : 10;
    startApplause(seconds);
  });

  onAdmin('admin:startEnding', () => {
    startEnding();
  });

  onAdmin('admin:endingGo', (data) => {
    const index = asObj(data).index;
    if (typeof index !== 'number' || !Number.isFinite(index)) return 'invalid';
    if (appState.mode !== 'ending') return 'mode';
    endingGo(Math.floor(index));
  });

  // LED 연출 on/off — 화면들에 즉시 반영
  onAdmin('admin:setEffects', (data) => {
    const d = asObj(data);
    if (typeof d.heartBurst !== 'boolean') return 'invalid';
    appState.effects.heartBurst = d.heartBurst;
    io.to(SCREENS).emit('effectsChange', { effects: { ...appState.effects } });
  });

  // 결과 기록 비우기 — 리허설 뒤 본 행사 전에. 엔딩 중이면 슬라이드도 바로 갱신
  onAdmin('admin:clearResults', () => {
    resultsHistory.length = 0;
    if (appState.mode === 'ending') endingGo(appState.endingIndex);
    else io.to(ADMINS).emit('state', publicState(null, true)); // 관리자 화면의 기록 개수 갱신
    emitResults();
  });

  // 결과 기록 한 건만 삭제 — 질문을 두 번 돌렸거나 장난 답변이 1위로 올라온 경우 등
  // id로 지운다 — 관리자 두 명이 동시에 지우거나 20건 상한으로 밀려나도 엉뚱한 항목이 지워지지 않게(모르는 id는 무시)
  onAdmin('admin:removeResult', (data) => {
    const id = asObj(data).id;
    if (!Number.isInteger(id)) return 'invalid'; // 정수 id만
    const index = resultsHistory.findIndex(e => e.id === id);
    if (index < 0) return 'notFound'; // 이미 지워졌거나 밀려난 항목
    resultsHistory.splice(index, 1);
    if (appState.mode === 'ending') {
      // 지운 결과가 지금 슬라이드보다 앞이면 한 칸 당겨서 같은 슬라이드를 유지한다
      // (슬라이드 번호 = 결과 위치 + 1, 0장은 표지). 지금 슬라이드를 지우면 그 자리에 온 장을 보여준다.
      if (index + 1 < appState.endingIndex) appState.endingIndex -= 1;
      // 슬라이드를 다시 만들고 범위 안으로 클램프 — clearResults와 같은 방식으로 전송
      endingGo(appState.endingIndex);
    } else io.to(ADMINS).emit('state', publicState(null, true)); // 관리자 화면의 기록 개수 갱신
    emitResults();
  });

  // 관리자: 결과 기록 요약 목록 조회 (화면 로드 시)
  onAdmin('admin:getResults', () => {
    socket.emit('results', resultsSummaryList());
  });

  // 함성 레벨 (LED → 서버) — 측정 중에만, 운영진 키로 접속해 registerScreen한 화면 소켓만, 소켓당 초당 15회까지
  // (키 없는 소켓은 누구나 registerScreen할 수 있으므로 레벨 위조를 막으려 역할까지 확인)
  on('applauseLevel', (data) => {
    if (!socket.isScreen || appState.mode !== 'applause') return;
    if (role !== 'admin' && role !== 'host') return denied('host'); // 마이크 화면이 키 안내를 띄우도록 1회 알림
    const level = asObj(data).level;
    if (typeof level !== 'number' || !Number.isFinite(level) || level < 0 || level > 1) return;
    const now = Date.now();
    socket._applauseTimes = (socket._applauseTimes || []).filter(t => now - t < 1000);
    if (socket._applauseTimes.length >= 15) return;
    socket._applauseTimes.push(now);
    if (level > appState.applause.peak) appState.applause.peak = level;
    relayApplause(level);
  });

  onAdmin('admin:getState', () => {
    socket.emit('state', publicState(null, true));
  });

  // LED 화면의 채팅 표시만 멈춤/재생. 관객 쪽 채팅 송수신은 계속 정상 동작.
  onAdmin('admin:pauseChat', () => {
    appState.chatPaused = true;
    io.to(SCREENS).emit('chatPauseChange', { chatPaused: true });
  });

  onAdmin('admin:resumeChat', () => {
    appState.chatPaused = false;
    io.to(SCREENS).emit('chatPauseChange', { chatPaused: false });
  });

  socket.on('disconnect', () => {
    activeNicknames.delete(socket.id);
    // 기기의 마지막 소켓이 끊기면 그때부터 보존 시간 시작(clientId 없는 소켓은 바로 해제)
    if (socket._ownsNickname) {
      const key = socket._nickOwnerKey;
      const rec = ownerNicknames.get(key);
      if (rec && --rec.sockets <= 0) {
        rec.sockets = 0;
        rec.releasedAt = Date.now();
        if (!socket.clientId) releaseOwner(key);
      }
    }
    if (socket.isAudience && socket.clientId) {
      const n = (audienceSockets.get(socket.clientId) || 0) - 1;
      if (n <= 0) audienceSockets.delete(socket.clientId);
      else audienceSockets.set(socket.clientId, n);
      broadcastAudience();
    }
    console.log('연결 끊김:', socket.id);
  });
});

// 최후 방어선 — 예상 못 한 오류로 행사 도중 프로세스가 죽어 메모리 상태(채팅·투표)가 날아가는 것 방지
process.on('uncaughtException', (e) => console.error('처리되지 않은 예외:', e));
process.on('unhandledRejection', (e) => console.error('처리되지 않은 Promise 거부:', e));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  console.log(`LED 화면: http://localhost:${PORT}/led`);
});

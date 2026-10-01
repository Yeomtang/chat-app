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

// ── 닉네임 풀 (테마별 25 × 25 = 625개) ──
// chat.html의 THEMES와 같은 단어를 써야 한다. 닉네임은 클라이언트가 로컬에서 즉시 고르지만,
// 동시 접속자와 겹치면 서버가 교체해주는데 이때 테마가 다르면 엉뚱한 닉네임이 내려간다.
const NICKNAME_THEMES = {
  office: {
    prefixes: [
      '야근하는', '퇴근못한', '커피없는', '월요일싫은', '점심기다리는',
      '회의중인', '보고서쓰는', '연차쓰고싶은', '상사눈치보는', '월급날기다리는',
      '카페인의존하는', '스트레스받는', '엑셀여는', '퇴사고민하는', '메신저피하는',
      '칼퇴원하는', '야식먹는', '재택원하는', '회식싫은', '마감쫓기는',
      '탕비실숨는', '화장실피신한', '창문바라보는', '점심혼밥하는', '복사실가는',
    ],
    suffixes: [
      '사원', '대리', '과장', '차장', '부장',
      '팀장', '인턴', '계약직', '신입', '3년차',
      '5년차', '10년차', '직장인', '사무직', '영업사원',
      '기획자', '디자이너', '개발자', '마케터', '경리',
      '총무', '프리랜서', '워커', '비서', '실장',
    ],
  },
  concert: {
    // 무료·공개 공연 기준. 티켓팅/굿즈/투어(첫공·막공·올콘)/응원봉·플카 같은
    // 유료 공연·아이돌 팬덤 전제 표현은 쓰지 않는다 (어떤 행사에서든 재사용 가능하도록).
    prefixes: [
      '소문듣고온', '앞자리사수한', '광대승천한', '앙코르기다리는', '목풀고온',
      '앞사람머리피하는', '친구따라온', '퇴근하고달려온', '지방에서온', '리허설부터온',
      '심장뛰는', '눈물참는', '소리지르는', '박수치는', '세트리스트외운',
      '오늘밤설레는', '두손모은', '무대만보는', '줄서서기다린', '숨죽인',
      '인트로부터운', '노래따라하는', '발끝세운', '조명바라보는', '한곡도못참는',
    ],
    suffixes: [
      '관객', '팬', '덕후', '직관러', '떼창러',
      '관람객', '리스너', '애청자', '1열관객', '2층관객',
      '뒷줄관객', '첫관람객', '감상러', '입장객', '박수러',
      '늦덕', '입덕러', '고인물', '뉴비', '단골',
      '동행인', '혼콘러', '최애러', '응원러', '목청러',
    ],
  },
};
const DEFAULT_THEME = 'office';

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

function assignNickname(theme) {
  const pool = nicknamePools[theme] || nicknamePools[DEFAULT_THEME];
  if (pool.index >= pool.list.length) {
    // 모두 소진되면 재셔플 (실질적으로 500명 이하에서는 발생 안 함)
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
const activeNicknames = new Map(); // socket.id -> nickname

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

function isNicknameTaken(name, excludeSocketId) {
  for (const [sid, n] of activeNicknames) {
    if (sid !== excludeSocketId && n === name) return true;
  }
  return false;
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
// 문자열이 아니면 '', 앞뒤 공백 제거 후 max 글자(이모지가 반으로 잘리지 않게 코드포인트 기준)로 자른다.
function cleanStr(v, max) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t.length <= max ? t : [...t].slice(0, max).join('');
}
function asObj(v) { return v && typeof v === 'object' ? v : {}; }

const MAX_QUESTION_LENGTH = 200; // 질문 문구 상한
const MAX_OPTION_LENGTH = 40;    // 객관식 보기 라벨 상한
const MAX_EMOJI_LENGTH = 16;     // 이모지(ZWJ 조합 포함) 상한
const MAX_EMOJI_LABEL_LENGTH = 30;
const MAX_VOTING_SECONDS = 600;  // setTimeout 한계 초과로 즉시 종료되는 것 방지

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
const PRESET_TYPES = ['yesno', 'choice', 'subjective', 'emoji'];
// 프리셋은 파일에 저장되고 모든 관리자 화면에 그려지므로 형식을 엄격히 맞춘다
function cleanPreset(p) {
  const o = asObj(p);
  const text = cleanStr(o.text, MAX_QUESTION_LENGTH);
  if (!text) return null;
  const type = PRESET_TYPES.includes(o.type) ? o.type : 'yesno';
  const out = { text, type };
  if (type === 'choice') out.options = cleanOptions(o.options);
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
const MAX_CHAT_LENGTH = 100; // 채팅 글자 수 제한 (클라이언트 제한 우회 대비 서버에서도 자름)

const MAX_ANSWER_LENGTH = 20; // 주관식 답변 글자 수 상한 (LED 가독성 보호)
const MAX_NICKNAME_LENGTH = 20; // 닉네임 길이 상한 — 실제 풀은 12자 이하지만
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
//  - voting/result: 선택형 투표. voteType='yesno'(YES/NO 2지) 또는 'choice'(N지선다 2~6지)
//  - subjective/subjectiveResult: 주관식(자유 텍스트, 제작진 수동 마감 → 워드클라우드)
//  - emoji: 이모지 반응 질문(관객이 이모지 선택 → LED에 대량으로 떠오름, 비율 X, 분위기 고조용)
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
  timerHandle: null,
  chatPaused: false,      // LED 화면 채팅 표시 일시정지 여부 (관리자 화면에서 제어, 관객 채팅 송수신엔 영향 없음)
};

// 주관식 답변 → 워드클라우드용 빈도 집계 (상위 40개)
// 단어로 쪼개지 않고 답변 전체를 한 덩어리로 집계 — "나 빼고 다" 같은 문구형 답변의
// 어순/의미가 보존되고, 같은 답변을 쓴 사람이 많을수록 그 문구가 커진다.
function computeCloud() {
  const freq = new Map(); // 정규화 문구 -> { word, count }
  for (const text of Object.values(appState.answers)) {
    const norm = text.replace(/\s+/g, ' ').trim(); // 공백만 정리
    if (!norm) continue;
    const entry = freq.get(norm);
    if (entry) entry.count += 1;
    else freq.set(norm, { word: norm, count: 1 });
  }
  return [...freq.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 40);
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

function publicState(forClientId) {
  const myVote = forClientId != null && appState.votes[forClientId] != null
    ? appState.votes[forClientId] : null;
  return {
    mode: appState.mode,
    question: appState.question,
    votingDuration: appState.votingDuration,
    votingEndTime: appState.votingEndTime,
    voteType: appState.voteType,
    voteOptions: appState.voteOptions,
    counts: computeCounts(),
    myVote, // 내가 고른 보기 인덱스(0-based) 또는 null
    answerCount: Object.keys(appState.answers).length,
    answerMaxLen: appState.answerMaxLen,
    emojiOptions: appState.emojiOptions,
    myAnswered: forClientId ? !!appState.answers[forClientId] : null,
    cloud: appState.mode === 'subjectiveResult' ? computeCloud() : null,
    pinnedChat: appState.pinnedChat,
    chatPaused: appState.chatPaused,
    audience: audienceStats(),
  };
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

// 질문 모드 진입/복귀 시 채팅 핀 해제 (오래된 핀이 남는 것 방지)
function clearPinnedChat() {
  if (!appState.pinnedChat) return;
  appState.pinnedChat = null;
  io.to(SCREENS).emit('chatPinned', { message: null });
}

// options: 보기 라벨 배열, type: 'yesno' | 'choice'
function startVoting(question, options, duration, type) {
  clearPinnedChat();
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
  io.emit('modeChange', publicState());

  appState.timerHandle = setTimeout(() => {
    endVoting();
  }, duration * 1000);
}

// ── 이모지 반응 질문 (타이머 없음, 제작진 수동 마감=채팅 복귀) ──
// 관객이 이모지를 고르면 LED에 대량으로 떠오름(비율 X). 여러 번 탭 가능(분위기 고조).
function startEmoji(question, emojis) {
  clearPinnedChat();
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
  io.emit('modeChange', publicState());
}

// ── 주관식 질문 (타이머 없음, 제작진 수동 마감) ──
function startSubjective(question, maxLen) {
  clearPinnedChat();
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
  io.emit('modeChange', publicState());
}

function endSubjective() {
  if (appState.mode !== 'subjective') return;
  appState.mode = 'subjectiveResult';
  io.emit('modeChange', publicState()); // cloud 포함됨
}

function endVoting() {
  if (appState.timerHandle) {
    clearTimeout(appState.timerHandle);
    appState.timerHandle = null;
  }
  if (appState.mode !== 'voting') return;
  appState.mode = 'result';
  io.emit('modeChange', publicState());
}

function returnToChat() {
  clearPinnedChat();
  if (appState.timerHandle) {
    clearTimeout(appState.timerHandle);
    appState.timerHandle = null;
  }
  appState.mode = 'chat';
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
  io.emit('modeChange', publicState());
}

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
  const onAdmin = (event, fn) => on(event, (...args) => {
    if (role !== 'admin') return denied('admin');
    fn(...args);
  });
  const onStaff = (event, fn) => on(event, (...args) => {
    if (role !== 'admin' && role !== 'host') return denied('host');
    fn(...args);
  });

  // 클라이언트 식별 (localStorage 기반 영구 ID) — 투표 중복/재접속 처리용
  on('identify', (clientId) => {
    if (!isValidClientId(clientId)) return;
    // 한 소켓의 clientId는 처음 정해진 값으로 고정 — 바꿔 가며 여러 번 투표하는 것 방지
    if (!socket.clientId) socket.clientId = clientId;
    socket.emit('state', publicState(socket.clientId));
  });

  // LED 화면 등록 — 화면 전용 이벤트(리액션·투표 집계·주관식 흘려보내기 등)를 받는다
  on('registerScreen', () => socket.join(SCREENS));

  // 닉네임 요청 시 서버에서 고유 닉네임 배정 (레거시, 현재는 클라이언트가 즉시 로컬 배정)
  on('requestNickname', (theme) => {
    socket.emit('assignedNickname', assignNickname(theme));
  });

  // 클라이언트가 로컬에서 즉시 고른 닉네임 등록 + 동시 중복 확인
  // payload: { name, theme } — 예전 클라이언트를 위해 문자열도 허용
  on('claimNickname', (payload) => {
    const name = typeof payload === 'string' ? payload : (payload && payload.name);
    const theme = (payload && payload.theme && NICKNAME_THEMES[payload.theme]) ? payload.theme : DEFAULT_THEME;
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
    if (name && !isNicknameTaken(name, socket.id)) {
      activeNicknames.set(socket.id, name);
      return name;
    }
    let fresh;
    let guard = 0;
    do {
      fresh = assignNickname(theme); // 교체 닉네임도 반드시 같은 테마에서
      guard++;
    } while (isNicknameTaken(fresh, socket.id) && guard < poolSize(theme));
    activeNicknames.set(socket.id, fresh);
    socket.emit('nicknameReassigned', fresh);
    return fresh;
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

  // 채팅 메시지 (채팅 모드일 때만 허용)
  on('chat', (data) => {
    if (appState.mode !== 'chat') return;
    const d = asObj(data);
    const raw = cleanStr(d.text, MAX_CHAT_LENGTH);
    if (!raw) return;
    // 도배 제한 (운영진 제외): 5초에 5건 — 정상 입력 속도로는 걸리지 않는 수준
    if (!socket.isOperator) {
      const now = Date.now();
      socket._chatTimes = (socket._chatTimes || []).filter(t => now - t < 5000);
      if (socket._chatTimes.length >= 5) return;
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
      time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    };
    recentMessages.push(message);
    if (recentMessages.length > MAX_MESSAGES) recentMessages.shift();
    broadcastChat(message);
  });

  // 리액션 (하트/붐업/붐따) — LED 화면에 떠오르는 이모지 효과
  // 채팅 모드: 하트/붐업, 결과 모드: 붐업/붐따로 결과에 반응
  // 투표 중엔 차단(답변에만 집중), 소켓당 3초에 10회로 스팸 제한
  on('reaction', (data) => {
    const { type } = data || {};
    if (appState.mode === 'voting' || appState.mode === 'subjective' || appState.mode === 'emoji') return; // 답변 집중 구간엔 차단
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
    if (typeof idx !== 'number' || idx < 0 || idx >= appState.voteOptions.length) return;
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
      answerCount: Object.keys(appState.answers).length,
    });
    socket.emit('answerAccepted'); // 본인 확인용
  });

  // ── 관리자(제작진) 전용 이벤트 ──
  onAdmin('admin:startVoting', (data) => {
    if (appState.mode === 'voting') return; // 진행 중 재시작(중복 클릭·관리자 여러 명) 시 표 초기화 방지
    const d = asObj(data);
    const question = cleanStr(d.question, MAX_QUESTION_LENGTH);
    const duration = Math.min(MAX_VOTING_SECONDS, Math.max(5, parseInt(d.duration, 10) || 30));
    if (!question) return;
    const type = d.type === 'choice' ? 'choice' : 'yesno';
    let options;
    if (type === 'choice') {
      options = cleanOptions(d.options);
      if (options.length < 2) return; // 보기 2개 미만이면 무시
    } else {
      options = ['YES', 'NO'];
    }
    startVoting(question, options, duration, type);
  });

  onAdmin('admin:endVoting', () => {
    endVoting();
  });

  onAdmin('admin:startSubjective', (data) => {
    if (appState.mode === 'subjective') return; // 접수 중 재시작 시 답변 초기화 방지
    const question = cleanStr(asObj(data).question, MAX_QUESTION_LENGTH);
    if (!question) return;
    let maxLen = parseInt(asObj(data).maxLen, 10);
    if (!Number.isFinite(maxLen) || maxLen < 1) maxLen = MAX_ANSWER_LENGTH;
    maxLen = Math.min(MAX_ANSWER_LENGTH, maxLen); // 상한 20 (LED 가독성)
    startSubjective(question, maxLen);
  });

  onAdmin('admin:startEmoji', (data) => {
    const question = cleanStr(asObj(data).question, MAX_QUESTION_LENGTH);
    if (!question) return;
    // emojis: [{emoji, label}] — 라벨(뜻)은 관객 폰 버튼에 함께 표시
    const emojiOptions = cleanEmojis(asObj(data).emojis);
    if (emojiOptions.length < 2) return; // 이모지 2개 미만이면 무시
    startEmoji(question, emojiOptions);
  });

  onAdmin('admin:endSubjective', () => {
    endSubjective();
  });

  // 관리자: 채팅 핀 고정 — LED 중앙에 해당 채팅을 팝업으로 표시 (채팅 모드 전용)
  onAdmin('admin:pinChat', (data) => {
    if (appState.mode !== 'chat') return;
    const d = asObj(data);
    const nickname = cleanStr(d.nickname, 30);
    const text = maskProfanity(cleanStr(d.text, MAX_CHAT_LENGTH));
    if (!text) return;
    const id = typeof d.id === 'string' || typeof d.id === 'number' ? d.id : Date.now();
    appState.pinnedChat = { id, nickname, text };
    io.to(SCREENS).emit('chatPinned', { message: appState.pinnedChat });
  });

  onAdmin('admin:unpinChat', () => {
    clearPinnedChat();
  });

  // 관리자: 개별 채팅 삭제 — 부적절한 메시지를 즉시 내림. 모든 화면에서 사라진다.
  onStaff('admin:deleteMessage', (id) => {
    if (typeof id !== 'string') return;
    const idx = recentMessages.findIndex(m => m.id === id);
    if (idx !== -1) recentMessages.splice(idx, 1);
    chatQueue = chatQueue.filter(m => m.id !== id); // 아직 묶음 전송 전이면 대기열에서도 제거
    if (appState.pinnedChat && appState.pinnedChat.id === id) clearPinnedChat(); // 핀된 걸 지우면 핀도 해제
    io.emit('chatDeleted', id);
  });

  // 관리자: 질문 사전 등록 목록 조회/저장 — 다른 관리자 PC와 실시간 공유
  onAdmin('admin:getPresets', () => {
    socket.emit('presets', questionPresets);
  });
  onAdmin('admin:setPresets', (list) => {
    if (!Array.isArray(list)) return;
    questionPresets = list
      .slice(0, 100) // 과도한 등록 방지
      .map(cleanPreset).filter(Boolean); // 형식 검증 (문자열·길이·유형 화이트리스트)
    persistPresets(); // 파일에 저장 → 재시작에도 유지 (삭제로 빈 목록이어도 그대로 저장 = 삭제 확정)
    socket.to(ADMINS).emit('presets', questionPresets); // 나를 제외한 다른 관리자에게 반영
  });

  // 관리자: 채팅 기록 초기화 — 리허설 뒤 LED/관객 화면을 비우고 본 행사를 시작할 때.
  // 서버 보관본을 비워야 새로 접속하는 관객에게 옛 메시지가 history로 다시 내려가지 않는다.
  // 관리자: 접속 통계 초기화 — 최고 동시 접속을 현재값으로 되돌린다.
  // 현재 접속자는 실제 열려 있는 소켓 수라 임의로 못 지운다(peak만 리셋).
  onAdmin('admin:resetAudienceStats', () => {
    audiencePeak = audienceSockets.size;
    io.to(ADMINS).emit('audienceStats', audienceStats());
  });

  onAdmin('admin:clearChat', () => {
    recentMessages.length = 0;
    chatQueue = [];
    clearPinnedChat(); // 지워진 메시지가 LED에 핀으로 남아 있으면 안 됨
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
    if (!entry) return;
    const idx = appState.starredAnswers.indexOf(id);
    const starred = idx === -1;
    if (starred) appState.starredAnswers.push(id);
    else appState.starredAnswers.splice(idx, 1);
    io.to(ADMINS).emit('answerStarred', { id, starred });
  });

  // 관리자: 답변 픽 → LED 스포트라이트로 크게 표시 (접수 중/마감 후 모두 가능)
  onAdmin('admin:pickAnswer', (data) => {
    const id = data && data.id;
    if (appState.mode !== 'subjective' && appState.mode !== 'subjectiveResult') return;
    const entry = appState.answerList.find(a => a.id === id);
    if (!entry) return;
    if (!appState.pickedAnswers.includes(id)) appState.pickedAnswers.push(id);
    io.to(SCREENS).emit('answerPicked', { id: entry.id, text: entry.text });
  });

  onAdmin('admin:returnToChat', () => {
    returnToChat();
  });

  onAdmin('admin:getState', () => {
    socket.emit('state', publicState(null));
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

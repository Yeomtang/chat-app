// ── 비속어 필터 (서버 전용 모듈) ──
// 매칭된 부분을 원문 위치에서 '*'로 가린다(차단이 아니라 가림). 방송 화면(LED) 보호가 목적.
//
// 2026-11-10 테스트 보고서의 "권장안 A"(= 시뮬레이션 C4) 구현:
//   ① 정상 단어 예외 목록 ALLOW_WORDS(86개, 사전·문법 근거) — 예외 단어가 덮는 자리의 매칭은 가리지 않음
//   ② 고위험 단어 앞뒤 조건 RISKY_RULES — 오탐이 잦은 짧은 단어(보지·자지·꺼져·닥쳐·조까 등)는 앞뒤 글자로 판단
//   ③ 우회형 정규화 normalize() — 전각·제로폭·자모 분리·글자 사이 기호/숫자·한 글자씩 띄어 쓰기·장음 반복을
//      정규화한 문자열에서 찾고, 각 글자가 기억하는 원문 위치로 되돌려 원문을 가림
// 근거 자료: .superpowers/sdd/profanity-1110/report.md, sim/variants.js(목록·조건 원본), sim/engine.js(엔진 원본)
// 같은 규칙으로 sim C4와 출력이 같아야 한다(검증 스크립트로 확인). 목록을 고칠 땐 이 파일만 고치면 된다.
//
// 처리 순서 (findProfanity)
//   1) normalize: 원문 코드포인트 → 단위 배열 {ch, s, e}(s~e = 원문 코드포인트 범위)
//   2) 예외 단어 보호 표시
//   3) 단어별(긴 것 먼저) 매칭 → 예외 보호·조건 검사 후 채택, 채택한 단위는 소비(다른 단어와 중복 매칭 방지)
//   4) maskProfanity: 채택된 원문 범위의 글자(공백 제외)를 '*'로. 글자 단위는 화면 글자(grapheme) —
//      이모지·조합 이모지·결합 문자를 쪼개지 않고, 가린 글자 1개 = '*' 1개
'use strict';

// ─────────────────────────────────────────────────────────────
// 1. 욕설 목록
// ─────────────────────────────────────────────────────────────
// 기존(2026-08-30) 목록 77개에서 '씹'(1글자: 곱씹다·읽씹·씹다), '닥치'(동사 '닥치다'), 'tprtl'('섹시'의 영타)을 뺐다.
// '미친' 단독은 칭찬("목소리 미쳤다")으로 쓰여 넣지 않음 — '미친놈/미친년'만.
const BASE_WORDS = [
  // 대표 욕설(변형 포함)
  '씨발', '씨발놈', '씨발년', '시발', '시발놈', '시발년', '씨바', '시바', '씨빨', '시빨', '씨발새끼', '시발새끼',
  '개새끼', '개색기', '개세끼', '개새기', '개쌔끼', '새끼', '쌔끼', '새키',
  '병신', '븅신', '빙신', '병맛',
  '지랄', '지럴', '염병', '엿먹어', '닥쳐', '꺼져',
  '좆', '좆같', '좆나', '존나', '존니', '존만', '조까',
  '씹새', '씹창', '씹할', '씨부럴', '씨부랄', '개씹',
  '보지', '자지', '걸레', '창녀', '창놈', '호로', '후장',
  '미친놈', '미친년', '또라이', '돌아이', '썅', '쌍놈', '쌍년',
  // 초성체
  'ㅅㅂ', 'ㅆㅂ', 'ㅄ', 'ㅂㅅ', 'ㅈㄹ', 'ㄲㅈ', 'ㅅㅃ', 'ㅆㅃ', 'ㅗ',
  // 영문/영타
  'fuck', 'fxxk', 'shit', 'bitch', 'asshole', 'tlqkf', 'qudtls', 'wlfkf',
  // '씹'을 뺀 대신 붙여 쓴 복합형을 직접 넣음(안 넣으면 '씹새끼'가 '씹**'로 일부만 가려짐)
  '씹새끼', '씹놈', '씹년', '씹팔', '좆까',
];

// 흔한 변형 철자·초성(우회형). 오탐 위험이 있는 것은 조건(cond: true면 이번 매칭 제외)을 붙였다.
const isHangulSyl = (c) => c >= '가' && c <= '힣';
const isCompatJamo = (c) => c >= 'ㄱ' && c <= 'ㆎ';
const isLatin = (c) => c.length === 1 && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
const isLetter = (c) => isHangulSyl(c) || isCompatJamo(c) || isLatin(c);
const SPACE_RE = /^\s$/u;
const isSpace = (c) => SPACE_RE.test(c);
const isDigit = (c) => c.length === 1 && c >= '0' && c <= '9';
const P = isHangulSyl; // "앞 글자가 한글 음절" = 합성어·어미 안쪽
const startsAny = (s, arr) => arr.some((a) => s.startsWith(a));

const VARIANT_WORDS = [
  '씌발', '쒸발', '씨벌', '시벌', '쒸벌', '씨팔', 'ㅅ발', 'ㅆ발', '시ㅂ', '씨ㅂ', '씨8',
  { w: '시팔', cond: (c) => P(c.prev) && !['아', '에', '개'].includes(c.prev) }, // 역시팔(…) 등 붙여 쓰기 제외
  { w: '시8', cond: (c) => isDigit(c.prev) || P(c.prev) },                       // 4시8분 제외
  { w: '졸라', cond: (c) => ['서', '도', '맨', '매'].includes(c.next) || P(c.prev) }, // 졸라서(조르다)·졸라맨 제외
  '존내', '졸나', 'ㅈㄴ',
  '개색휘', '개새퀴', '개쉐이', '개쉑', '개섀끼', '새퀴', '색휘', 'ㄱㅅㄲ',
  '좃같', '졷같', '좇같', 'ㅈ같', '좃까', '좇까',
  '븅딱', '빙딱', '닭쳐', 'ㅁㅊ놈', 'ㅁㅊ년', '미친넘',
  'fck', 'fxck', 'fuk',
];

// ─────────────────────────────────────────────────────────────
// 2. 정상 단어 예외 목록 (86개) — 이 단어가 덮는 자리의 매칭은 가리지 않는다
// 사전 근거 단어만(한자어 '시발(始發)', 견종·브랜드, 청소용품, 생물 '새끼', 동사 '씹다' 활용 등).
// 공백이 든 항목은 공백을 뺀 형태도 자동으로 함께 등록.
// ─────────────────────────────────────────────────────────────
const ALLOW_WORDS = [
  // 시발(始發) 및 '-시' + '발-' 붙여 쓰기 (즉시·동시·임시·수시·정시·출시·공시·게시·제시·지시·전시 + 발송/발표/발령/발급…)
  '시발점', '시발역', '시발택시', '시발자동차', '시발차',
  '즉시발', '동시발', '임시발', '수시발', '정시발', '출시발', '공시발', '게시발', '제시발', '지시발', '전시발',
  // 호칭 '-씨' + 발/바지/팔
  '아저씨발', '아가씨발', '아저씨바', '아가씨바', '아저씨팔', '아가씨팔',
  // 시바: 견종·브랜드·인명·'다시 바-' 붙여 쓰기
  '시바견', '시바이누', '시바 이누', '도시바', '이시바', '시바스리갈', '다시바',
  // 병신: 질병/감염병 + 신고·신청
  '질병신', '감염병신',
  // 새끼: 신체·생물·민속
  '새끼손가락', '새끼발가락', '새끼손톱', '새끼발톱', '새끼줄', '새끼오리', '새끼고양이', '새끼강아지', '새끼돼지',
  // 존만: '-존' 명사 + 조사 '만'
  '생존만', '의존만', '보존만', '공존만',
  // 보지: '-보지' 명사
  '후보지', '홍보지', '정보지', '화보지',
  // 자지: 자지러지다, '-자' 명사 + '-지'
  '자지러', '남자지', '여자지', '전자지', '가자지구', '투자지', '원자지',
  // 닥치
  '들이닥', '닥치는 대로',
  // 조까: 조사 '까지'
  '조까지',
  // 염병
  '전염병', '감염병',
  // 걸레: 청소 도구
  '걸레질', '물걸레', '대걸레', '손걸레', '걸레받이', '밀대걸레',
  // 호로: 의성어·고유명사
  '호로록', '호로요이', '호로비츠',
  // 씹다/곱씹다/읽씹(직장 은어)
  '곱씹', '읽씹', '씹어', '씹으', '씹는', '씹히', '씹혀', '씹혔', '씹을', '씹었', '씹고',
  // 엿
  '호박엿먹',
  // 영문
  'shitake', 'shiitake', 'shitzu', 'shih tzu', 'matsushita',
];

// ─────────────────────────────────────────────────────────────
// 3. 고위험 단어 앞뒤 조건 — 함수가 true면 '이번 매칭은 가리지 않음'
// ctx: prev(바로 앞 글자), next(바로 뒤 글자), nextTok(공백 건너뛴 뒤 6글자), nextTokRaw(바로 뒤 8글자),
//      prevTok(공백 건너뛴 앞 6글자), full(정규화 문자열), i/j(정규화 위치)
// ─────────────────────────────────────────────────────────────
const GANJI = /(\d{2,4}\s*년|[갑을병정무기경신임계][자축인묘진사오미신유술해]년|띠|년생)/;
const ANIMAL_BODY = ['손가락', '발가락', '손톱', '발톱', '줄', '오리', '고양이', '강아지', '곰', '토끼', '사자', '호랑이', '원숭이', '여우', '낳', '를 낳', '들을 낳'];
const RISKY_RULES = {
  // 보지: '-어 보다'+'-지' 부정/금지(보지 마/말/도/않/못/만), '-보지' 명사(앞 글자 한글: 후보지·해보지)
  '보지': (c) => P(c.prev) || startsAny(c.nextTok, ['마', '말', '도', '않', '못', '만', '는']),
  // 자지: 남자지만·전자지갑(앞 한글), 자지러지다, '자다'+'-지' 부정/금지
  '자지': (c) => P(c.prev) || c.next === '러' || startsAny(c.nextTok, ['마', '말', '못', '않', '도', '그래', '그랬', '는']),
  // 닥쳐: 들이닥쳐(앞 한글), 닥쳐오다/닥쳐서/닥쳐도(일이 다가오다)
  '닥쳐': (c) => P(c.prev) || ['오', '와', '서', '도', '올', '왔'].includes(c.next),
  // 꺼져: 상태·결과 활용(꺼져서/꺼져도/꺼져가/꺼져 있-/꺼져버-/꺼져요)
  '꺼져': (c) => startsAny(c.nextTok, ['서', '도', '가', '있', '버', '요', '갔', '간']),
  // 조까: 조사 '까지'(3조까지)
  '조까': (c) => c.next === '지',
  // 존만: '-존'+'만'(앞 한글: 생존만)
  '존만': (c) => P(c.prev),
  // 시바: 도시바·이시바·다시바(앞 한글), 시바견·시바이누·시바스리갈
  '시바': (c) => P(c.prev) || startsAny(c.nextTok, ['견', '이누', '스리']),
  // 시발: '-시'+'발-' 붙여 쓰기(앞 한글). 단 감탄 접두(아·에·개·좆·씹·존·으) 뒤는 욕으로 유지(아시발)
  '시발': (c) => P(c.prev) && !['아', '에', '개', '좆', '씹', '존', '으'].includes(c.prev),
  // 병신년(丙申年): 같은 문장에 간지/연도 맥락이 있을 때만 제외
  '병신': (c) => c.next === '년' && (c.nextTokRaw.startsWith('년생') || GANJI.test(c.full.slice(0, c.i) + c.full.slice(c.j + 1))),
  // 호로: 호로새끼/호로자식/호로놈/호로년만 가림(호로록 등 제외)
  '호로': (c) => !startsAny(c.nextTok, ['새끼', '자식', '놈', '년', '새']),
  // 걸레: 사람 비하 용법(걸레같은/걸레년/걸레냐/걸레짓)만 가림
  '걸레': (c) => !startsAny(c.nextTok, ['같', '년', '냐', '짓']),
  // 염병: 전염병·감염병(앞 한글)
  '염병': (c) => P(c.prev),
  // 새끼: 생물·신체 용법(뒤에 동물/신체 명사·'낳-')
  '새끼': (c) => startsAny(c.nextTok, ANIMAL_BODY),
  // ㅗ: 다른 자모와 붙은 경우(ㅗㅜㅑ, ㅇㅗㅇ)는 제외, 단독·반복(ㅗㅗ)만 가림
  'ㅗ': (c) => (isCompatJamo(c.prev) && c.prev !== 'ㅗ') || (isCompatJamo(c.next) && c.next !== 'ㅗ'),
  // 엿먹어: 호박엿먹어(앞 한글)
  '엿먹어': (c) => P(c.prev),
  // shit: shitake/shitzu(뒤 a/z), 다른 영어 단어 안쪽(Matsushita) — bullshit/horseshit 은 유지
  'shit': (c) => ['a', 'z'].includes(c.next) || (isLatin(c.prev) && !/(bull|horse|dip)$/.test(c.prevTok)),
};

// ─────────────────────────────────────────────────────────────
// 4. 한글 자모 표 · 두벌식 영타(한/영 전환 안 하고 친 욕: tlqkf=시발) 자동 생성
// ─────────────────────────────────────────────────────────────
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const compose = (l, v, t) => String.fromCharCode(0xAC00 + (l * 21 + v) * 28 + t);
const decompose = (c) => { const n = c.charCodeAt(0) - 0xAC00; return { l: Math.floor(n / 588), v: Math.floor((n % 588) / 28), t: n % 28 }; };
const KEY = { 'ㄱ': 'r', 'ㄲ': 'R', 'ㄴ': 's', 'ㄷ': 'e', 'ㄸ': 'E', 'ㄹ': 'f', 'ㅁ': 'a', 'ㅂ': 'q', 'ㅃ': 'Q', 'ㅅ': 't', 'ㅆ': 'T', 'ㅇ': 'd', 'ㅈ': 'w', 'ㅉ': 'W', 'ㅊ': 'c', 'ㅋ': 'z', 'ㅌ': 'x', 'ㅍ': 'v', 'ㅎ': 'g',
  'ㅏ': 'k', 'ㅐ': 'o', 'ㅑ': 'i', 'ㅒ': 'O', 'ㅓ': 'j', 'ㅔ': 'p', 'ㅕ': 'u', 'ㅖ': 'P', 'ㅗ': 'h', 'ㅘ': 'hk', 'ㅙ': 'ho', 'ㅚ': 'hl', 'ㅛ': 'y', 'ㅜ': 'n', 'ㅝ': 'nj', 'ㅞ': 'np', 'ㅟ': 'nl', 'ㅠ': 'b', 'ㅡ': 'm', 'ㅢ': 'ml', 'ㅣ': 'l',
  'ㄳ': 'rt', 'ㄵ': 'sw', 'ㄶ': 'sg', 'ㄺ': 'fr', 'ㄻ': 'fa', 'ㄼ': 'fq', 'ㄽ': 'ft', 'ㄾ': 'fx', 'ㄿ': 'fv', 'ㅀ': 'fg', 'ㅄ': 'qt' };
function toDubeol(w) {
  let s = '';
  for (const ch of w) { if (!isHangulSyl(ch)) return null; const d = decompose(ch); s += KEY[CHO[d.l]] + KEY[JUNG[d.v]] + (d.t ? KEY[JONG[d.t]] : ''); }
  return s.toLowerCase();
}
// 2음절 이상 순한글 단어만, 영타 4자 이상만(1음절·짧은 영타는 영어 단어와 충돌 위험)
function yeongta(words) {
  const set = new Set();
  for (const w of words) { const s = typeof w === 'string' ? w : w.w; if ([...s].length >= 2 && /^[가-힣]+$/.test(s)) { const t = toDubeol(s); if (t && t.length >= 4) set.add(t); } }
  return [...set];
}

// ─────────────────────────────────────────────────────────────
// 5. 미리 컴파일: 매칭 단어 목록(긴 것 먼저, 같은 길이는 선언 순서) · 예외 단어 · 빠른 사전 검사 정규식
// ─────────────────────────────────────────────────────────────
function escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const MATCHERS = (() => {
  const words = [...BASE_WORDS, ...VARIANT_WORDS];
  const all = [...words, ...yeongta(words).filter((t) => !words.includes(t))];
  return all.map((w) => (typeof w === 'string' ? { w } : w))
    .sort((a, b) => b.w.length - a.w.length) // 안정 정렬
    .map((it) => ({ w: it.w, lw: it.w.toLowerCase(), cond: it.cond || null, rule: Object.prototype.hasOwnProperty.call(RISKY_RULES, it.w) ? RISKY_RULES[it.w] : null }));
})();
const ALLOW = [...new Set([...ALLOW_WORDS, ...ALLOW_WORDS.filter((s) => /\s/.test(s)).map((s) => s.replace(/\s+/g, ''))])].map((a) => a.toLowerCase());
// 정규화 문자열에 목록 단어가 하나라도 있는지 한 번에 보는 정규식(대부분의 정상 채팅은 여기서 끝남)
const ANY_RE = new RegExp(MATCHERS.map((m) => escapeRegex(m.lw)).join('|'));

// ─────────────────────────────────────────────────────────────
// 6. 정규화 — 반환: { cps(원문 코드포인트), units:[{ch, s, e}] } (ch는 소문자, s~e는 원문 코드포인트 범위)
// 순서: 문자(전각·제로폭·자모 결합) → 소문자 → 한 글자 토큰 띄어쓰기 결합 → 글자 사이 기호/숫자 → 장음 반복 ('병 1 신' → '병1신' → '병신')
// ─────────────────────────────────────────────────────────────
const ZERO_WIDTH = new Set([0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF, 0x00AD]);
const LEET = { '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '@': 'a', '$': 's' };
function normalize(text) {
  const cps = [...text];
  // (a) 제로폭·소프트하이픈 제거, 전각→반각
  let u = [];
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i], c = ch.codePointAt(0);
    if (ZERO_WIDTH.has(c)) continue;
    if (c >= 0xFF01 && c <= 0xFF5E) u.push({ ch: String.fromCodePoint(c - 0xFEE0), s: i, e: i });
    else if (c === 0x3000) u.push({ ch: ' ', s: i, e: i });
    else u.push({ ch, s: i, e: i });
  }
  // (b) 조합형(첫가끝) 자모: L V (T) → 완성형, 홀로 쓰인 L → 호환 자모
  let out = [];
  for (let i = 0; i < u.length; i++) {
    const c = u[i].ch.codePointAt(0);
    if (c >= 0x1100 && c <= 0x1112) {
      const l = c - 0x1100;
      const v1 = u[i + 1] && u[i + 1].ch.codePointAt(0);
      if (v1 >= 0x1161 && v1 <= 0x1175) {
        const v = v1 - 0x1161; let t = 0, end = u[i + 1].e, skip = 1;
        const t1 = u[i + 2] && u[i + 2].ch.codePointAt(0);
        if (t1 >= 0x11A8 && t1 <= 0x11C2) { t = t1 - 0x11A7; end = u[i + 2].e; skip = 2; }
        out.push({ ch: compose(l, v, t), s: u[i].s, e: end }); i += skip; continue;
      }
      out.push({ ch: CHO[l], s: u[i].s, e: u[i].e }); continue;
    }
    out.push(u[i]);
  }
  u = out;
  // (c) 호환 자모 결합: 자음+모음(+받침: 그 뒤가 모음이 아닐 때) → 완성형. 'ㅅㅂ' 'ㅋㅋ' 'ㅗㅜㅑ'처럼 자음 뒤 모음이 없으면 그대로
  out = [];
  for (let i = 0; i < u.length; i++) {
    const l = CHO.indexOf(u[i].ch), v = u[i + 1] ? JUNG.indexOf(u[i + 1].ch) : -1;
    if (l >= 0 && v >= 0) {
      let t = 0, end = u[i + 1].e, skip = 1;
      const tc = u[i + 2] && u[i + 2].ch, ti = tc ? JONG.indexOf(tc) : -1;
      const afterIsVowel = u[i + 3] && JUNG.indexOf(u[i + 3].ch) >= 0;
      if (ti > 0 && !afterIsVowel) { t = ti; end = u[i + 2].e; skip = 2; }
      out.push({ ch: compose(l, v, t), s: u[i].s, e: end }); i += skip; continue;
    }
    out.push(u[i]);
  }
  u = out;
  for (const x of u) x.ch = x.ch.toLowerCase();

  // (d) 띄어쓰기: 공백으로 나눈 토큰 중 '한 글자 토큰'이 2개 이상 이어지면 그 사이 공백만 제거
  //     ('씨 발', 'f u c k', '개 새 끼' → 붙임 / '수박씨 발라', '민수씨 발표'처럼 앞 어절이 2글자 이상이면 그대로)
  const toks = []; let cur = [];
  for (const x of u) { if (isSpace(x.ch)) { if (cur.length) toks.push(cur); cur = []; toks.push(x); } else cur.push(x); }
  if (cur.length) toks.push(cur);
  const words = []; for (let i = 0; i < toks.length; i++) if (Array.isArray(toks[i])) words.push(i);
  const drop = new Set();
  for (let w = 0; w + 1 < words.length; w++) {
    const a = words[w], b = words[w + 1];
    if (toks[a].length === 1 && toks[b].length === 1) for (let k = a + 1; k < b; k++) drop.add(k);
  }
  if (drop.size) { out = []; for (let i = 0; i < toks.length; i++) if (!drop.has(i)) { if (Array.isArray(toks[i])) out.push(...toks[i]); else out.push(toks[i]); } u = out; }

  // (e) 글자 사이 기호·숫자: 한글/자모 사이면 제거('씨1발' '개.새.끼'), 영문 사이면 leet 변환(sh!t·sh1t→shit)·나머지 기호 제거(f*ck)
  out = [];
  for (let i = 0; i < u.length; i++) {
    const c = u[i].ch;
    if (isLetter(c) || isSpace(c)) { out.push(u[i]); continue; }
    let j = i; while (j < u.length && !isLetter(u[j].ch) && !isSpace(u[j].ch)) j++;
    const prev = out.length ? out[out.length - 1].ch : '', next = u[j] ? u[j].ch : '';
    const between = isLetter(prev) && isLetter(next);
    if (between && isLatin(prev) && isLatin(next)) {
      for (let k = i; k < j; k++) { const m = LEET[u[k].ch]; if (m) out.push({ ch: m, s: u[k].s, e: u[k].e }); }
    } else if (between && !(isLatin(prev) || isLatin(next))) {
      // 한글/자모 사이 기호·숫자 제거
    } else {
      for (let k = i; k < j; k++) out.push(u[k]);
    }
    i = j - 1;
  }
  u = out;

  // (f) 장음 반복 축약: 받침 없는 음절 뒤에 같은 모음의 'ㅇ+모음' 음절이 이어지면 흡수
  //     (씨이이이발→씨발, 시바아아알→시발, 병시이인→병신, 개새애애끼→개새끼)
  out = [];
  for (let i = 0; i < u.length; i++) {
    const x = u[i];
    if (isHangulSyl(x.ch)) {
      const d = decompose(x.ch);
      if (d.t === 0) {
        let j = i + 1, t = 0, e = x.e;
        while (u[j] && isHangulSyl(u[j].ch)) {
          const dj = decompose(u[j].ch);
          if (dj.l !== 11 || dj.v !== d.v) break; // 11 = ㅇ
          t = dj.t; e = u[j].e; j++;
          if (t) break;
        }
        if (j > i + 1) { out.push({ ch: compose(d.l, d.v, t), s: x.s, e }); i = j - 1; continue; }
      }
    }
    out.push(x);
  }
  return { cps, units: out };
}

// 앞뒤 문맥(조건 판단용)
function ctxOf(N, i, j) {
  const prev = i > 0 ? N[i - 1] : '';
  const next = j < N.length ? N[j] : '';
  let k = j; while (k < N.length && isSpace(N[k])) k++;
  const nextTok = N.slice(k, k + 6).join('');
  const nextTokRaw = N.slice(j, j + 8).join('');
  let p = i - 1; while (p >= 0 && isSpace(N[p])) p--;
  const prevTok = N.slice(Math.max(0, p - 5), p + 1).join('');
  return { prev, next, nextTok, nextTokRaw, prevTok, full: N.join(''), i, j };
}

// utf16 위치 → 단위 인덱스 표
function u16Map(arr) { const m = []; arr.forEach((c, k) => { for (let q = 0; q < c.length; q++) m.push(k); }); m.push(arr.length); return m; }

// ─────────────────────────────────────────────────────────────
// 7. 찾기 — 반환: { cps, matches:[{w, s, e}] } (s~e = 가릴 원문 코드포인트 범위, 양끝 포함)
// ─────────────────────────────────────────────────────────────
function findProfanity(text) {
  if (!text || typeof text !== 'string') return { cps: [], matches: [] };
  const { cps, units } = normalize(text);
  const N = units.map((x) => x.ch);
  const joined = N.join('');
  if (!ANY_RE.test(joined)) return { cps, matches: [] }; // 빠른 길: 후보 단어가 하나도 없음
  const u16 = u16Map(N);
  // 예외 단어 보호 표시
  const prot = new Array(N.length).fill(false);
  for (const a of ALLOW) {
    let idx = joined.indexOf(a);
    while (idx >= 0) { const s = u16[idx], e = u16[idx + a.length]; for (let k = s; k < e; k++) prot[k] = true; idx = joined.indexOf(a, idx + 1); }
  }
  const W = N.slice(); // 소비된 단위는 '\u0000'
  let str = joined, wu16 = u16, dirty = false;
  const matches = [];
  for (const mt of MATCHERS) {
    if (str.indexOf(mt.lw) < 0) continue; // 소비('\u0000')로 새 매칭이 생기지는 않으므로 미리 걸러도 결과 같음
    if (dirty) { str = W.join(''); wu16 = u16Map(W); dirty = false; if (str.indexOf(mt.lw) < 0) continue; }
    let pos = 0, at;
    while ((at = str.indexOf(mt.lw, pos)) >= 0) {
      const i = wu16[at], j = wu16[at + mt.lw.length];
      let ok = true;
      let allProt = true; for (let k = i; k < j; k++) if (!prot[k]) { allProt = false; break; }
      if (allProt) ok = false;
      if (ok && (mt.cond || mt.rule)) {
        const ctx = ctxOf(N, i, j);
        if (mt.cond && mt.cond(ctx)) ok = false;
        if (ok && mt.rule && mt.rule(ctx)) ok = false;
      }
      if (!ok) { pos = at + 1; continue; }
      for (let k = i; k < j; k++) W[k] = '\u0000';
      dirty = true;
      matches.push({ w: mt.w, s: units[i].s, e: units[j - 1].e });
      pos = at + mt.lw.length;
    }
  }
  return { cps, matches };
}

// ─────────────────────────────────────────────────────────────
// 8. 가리기 — 가린 범위에 걸친 화면 글자(grapheme)를 '*' 하나로. 공백은 그대로(씨 발 → * *).
// 가린 범위 밖 글자는 원문 그대로(위치 유지). 이모지·조합 이모지는 통째로 남거나 통째로 '*' 하나가 됨.
// ─────────────────────────────────────────────────────────────
const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });
const WS_RE = /^\s+$/u;
function maskProfanity(text) {
  if (!text || typeof text !== 'string') return text;
  const { cps, matches } = findProfanity(text);
  if (!matches.length) return text;
  const hit = new Uint8Array(cps.length);
  for (const r of matches) for (let k = r.s; k <= r.e; k++) hit[k] = 1;
  let out = '', cp = 0;
  for (const { segment } of segmenter.segment(text)) {
    let n = 0, masked = false;
    for (const _ of segment) { if (hit[cp + n]) masked = true; n++; } // eslint-disable-line no-unused-vars
    cp += n;
    // 공백·보이지 않는 제로폭 문자는 가려도 그대로 둠(보이는 글자 수 유지)
    out += masked && !WS_RE.test(segment) && !(segment.length === 1 && ZERO_WIDTH.has(segment.charCodeAt(0))) ? '*' : segment;
  }
  return out;
}

module.exports = { maskProfanity, findProfanity, normalize, BASE_WORDS, VARIANT_WORDS, ALLOW_WORDS, RISKY_RULES, MATCHERS };

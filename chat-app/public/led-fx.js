// ══════════════════════════════════
//  LED 공용 모션 (led.html · led-concert.html 공용)
//  화면별 DOM 연결은 각 페이지에서, 움직임 계산·타이밍은 여기서 관리한다.
//  (세로형/가로형이 같은 연출을 하도록 한 곳에서만 고친다)
// ══════════════════════════════════
(function () {
  'use strict';

  const reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  // 방송 카메라·멀미 배려: OS 설정이 "동작 줄이기"면 장식 모션을 생략/단축
  function prefersReduced() { return !!(reduceQuery && reduceQuery.matches); }

  const clamp01 = (t) => Math.min(1, Math.max(0, t));
  // 시안(demo.html)과 같은 이징
  const easeBack = (t) => { t = clamp01(t); const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
  const ease = (t) => 1 - Math.pow(1 - clamp01(t), 3);

  // ══════════════════════════════════
  //  글자 맞춤 — 장평을 눌러 폭에 맞추지 않는다 (LED 거리에서 세로줄처럼 보임).
  //  순서: 2줄까지 줄바꿈 → 글자 크기를 읽히는 최소값까지 한 단계씩 축소 → 마지막 수단으로 말줄임 "…"
  // ══════════════════════════════════
  const ELLIPSIS = '…';

  // 글자(grapheme) 단위로 나눔 — 👨‍👩‍👧·국기·피부색 이모지가 줄바꿈·말줄임에서 반으로 쪼개지지 않게.
  // 일반 한글·영문은 Array.from과 결과가 같다. Intl.Segmenter가 없는 브라우저면 코드포인트(Array.from)로 대신
  const graphemeSeg = (typeof Intl !== 'undefined' && Intl.Segmenter)
    ? new Intl.Segmenter('ko', { granularity: 'grapheme' }) : null;
  function splitGraphemes(s) {
    s = String(s == null ? '' : s);
    return graphemeSeg ? Array.from(graphemeSeg.segment(s), (x) => x.segment) : Array.from(s);
  }

  // 캔버스 줄바꿈: 어절(공백) 단위, 한 줄보다 긴 어절(띄어쓰기 없는 긴 글)만 글자 단위로 끊음
  // (CSS keep-all + overflow-wrap:anywhere와 같은 규칙). ctx.font는 미리 지정돼 있어야 함
  function wrapCanvasLines(ctx, text, maxW) {
    const fits = (s) => ctx.measureText(s).width <= maxW;
    const lines = [];
    let cur = '';
    String(text == null ? '' : text).split(/\s+/).filter(Boolean).forEach((w) => {
      const cand = cur ? cur + ' ' + w : w;
      if (fits(cand)) { cur = cand; return; }
      if (cur) { lines.push(cur); cur = ''; }
      if (fits(w)) { cur = w; return; }
      for (const ch of splitGraphemes(w)) {
        if (!cur || fits(cur + ch)) cur += ch;
        else { lines.push(cur); cur = ch; }
      }
    });
    if (cur) lines.push(cur);
    return lines;
  }

  // 마지막 줄 끝을 "…"로 (폭 안에 들어갈 때까지 글자를 덜어냄)
  function ellipsizeCanvas(ctx, line, maxW) {
    let chars = splitGraphemes(line);
    while (chars.length && ctx.measureText(chars.join('').trimEnd() + ELLIPSIS).width > maxW) chars.pop();
    return chars.join('').trimEnd() + ELLIPSIS;
  }

  // o: { maxW, maxPx, minPx, maxLines, weight, family, lineH(줄 간격 배율), maxH(선택: 글자 덩어리 높이 상한) }
  // → { px, lines, cut } — maxPx부터 1px씩 줄이며 maxLines 줄(·maxH) 안에 드는 가장 큰 크기. 최소 크기로도 넘치면 말줄임
  function fitCanvasText(ctx, text, o) {
    const font = (px) => `${o.weight || 700} ${px}px ${o.family}`;
    const lineH = o.lineH || 1.2;
    const maxPx = Math.max(o.minPx, Math.floor(o.maxPx));
    for (let px = maxPx; px >= o.minPx; px--) {
      ctx.font = font(px);
      const lines = wrapCanvasLines(ctx, text, o.maxW);
      const h = lines.length * px * lineH;
      if (lines.length <= o.maxLines && (!o.maxH || h <= o.maxH)) return { px, lines, cut: false };
    }
    const px = o.minPx;
    ctx.font = font(px);
    let lines = wrapCanvasLines(ctx, text, o.maxW);
    let n = o.maxLines;
    if (o.maxH) n = Math.max(1, Math.min(n, Math.floor(o.maxH / (px * lineH))));
    if (lines.length > n) {
      lines = lines.slice(0, n);
      lines[n - 1] = ellipsizeCanvas(ctx, lines[n - 1], o.maxW);
      return { px, lines, cut: true };
    }
    return { px, lines, cut: false };
  }

  // DOM 글자를 maxLines 줄 안으로: 넘치면 앞에서부터 들어가는 만큼 + "…" (CSS line-clamp는 keep-all과 함께면
  // 잘린 어절이 통째로 다음 줄로 넘어가 "…"이 안 그려짐 → 직접 자름). 요소의 line-height는 숫자여야 함
  function clampText(el, text, maxLines) {
    text = String(text == null ? '' : text);
    el.textContent = text;
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    if (!(lh > 0)) return false;
    const limit = lh * maxLines + 1;
    if (el.scrollHeight <= limit) return false;
    const chars = splitGraphemes(text);
    const at = (k) => chars.slice(0, k).join('').trimEnd() + ELLIPSIS;
    let lo = 0, hi = chars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      el.textContent = at(mid);
      if (el.scrollHeight <= limit) lo = mid; else hi = mid - 1;
    }
    el.textContent = at(lo);
    return true;
  }

  // 요소들 안 글자의 실제 폭 중 최댓값(px, 여러 줄이면 가장 긴 줄) — 막대 이름 칸을 가장 긴 이름에 맞출 때
  function maxInkWidth(els) {
    let w = 0;
    els.forEach((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const rs = [...r.getClientRects()].filter((q) => q.width > 0.5);
      if (rs.length) w = Math.max(w, Math.max(...rs.map((q) => q.right)) - Math.min(...rs.map((q) => q.left)));
    });
    return w;
  }

  // 질문 화면 계열 모드 (이 밖의 모드에서 들어올 때만 질문 등장 연출)
  const QUESTION_MODES = ['voting', 'result', 'subjective', 'subjectiveResult', 'emoji'];
  // 질문이 "새로 시작"되는 모드
  const QUESTION_START_MODES = ['voting', 'subjective', 'emoji'];

  // ── 질문 등장: 어절 단위로 하나씩 팝인 (시안 2) ──
  const question = {
    STAGGER: 140,     // 어절 간격(ms)
    START_DELAY: 200, // 카드 팝인이 자리 잡은 뒤 시작

    isQuestionMode(mode) { return QUESTION_MODES.includes(mode); },

    // 채팅·대기·엔딩·함성 → 질문 시작일 때만 재생.
    // 투표→결과 전환이나 재접속 때 받는 state 스냅샷에선 재생하지 않는다.
    shouldAnimate(prevMode, nextMode, isSnapshot) {
      if (isSnapshot) return false;
      return QUESTION_START_MODES.includes(nextMode) && !QUESTION_MODES.includes(prevMode);
    },

    // el에 질문을 넣는다. animate면 어절마다 .fx-word 스팬(페이지 CSS의 .in 팝인)으로 나눔.
    // 같은 질문이 다시 오면(모드 재전송 등) 진행 중인 연출을 끊지 않도록 그대로 둔다.
    render(el, text, animate) {
      text = text || '';
      if (!animate) {
        if (el.dataset.fxText === text) return;
        el.dataset.fxText = text;
        el.textContent = text;
        return;
      }
      el.dataset.fxText = text;
      el.textContent = '';
      const words = text.split(/\s+/).filter(Boolean);
      const reduce = prefersReduced();
      words.forEach((w, i) => {
        if (i > 0) el.appendChild(document.createTextNode(' ')); // 공백에서 자연스럽게 줄바꿈
        const s = document.createElement('span');
        s.className = 'fx-word';
        s.textContent = w;
        // 동작 줄이기면 페이지 CSS가 애니메이션 없이 바로 보이게 처리
        if (!reduce) s.style.animationDelay = (question.START_DELAY + i * question.STAGGER) + 'ms';
        s.classList.add('in');
        el.appendChild(s);
      });
    },
  };

  // ── 타이머 긴장감: 마지막 5초 경고색 + 1초 맥박, 0이면 "마감" (시안 2) ──
  const timer = {
    HOT_SECONDS: 5,
    // remain(초)에 맞춰 상태 클래스만 바꾼다 (모양은 페이지 CSS의 .hot·.done). 숫자는 호출한 쪽이 넣음
    update(el, remain) {
      if (remain <= 0) { timer.done(el); return; }
      el.classList.remove('done');
      el.classList.toggle('hot', remain <= timer.HOT_SECONDS);
    },
    // 마감 표시 — 투표가 끝나 결과를 보여주는 동안 질문 아래에 남는다
    done(el) {
      el.classList.remove('hot');
      el.classList.add('done');
      el.textContent = '마감';
    },
    reset(el) { el.classList.remove('hot', 'done'); },
    // 숫자가 다음 초로 넘어갈 때까지 남은 ms(+여유 15ms) — 200ms 폴링 대신 이 간격으로 갱신하면
    // LED·관리자·관객 폰이 같은 순간에 숫자를 넘긴다 (폴링은 화면마다 최대 0.2초 엇갈림)
    nextTickMs(remainMs) { return ((remainMs - 1) % 1000) + 1 + 15; },
    // 남은 시간 게이지 — card(질문 카드) 안 아래쪽에 막대를 붙인다(모양은 led-fx.css .fx-timer-gauge).
    // start(deadline, totalMs): deadline(이 PC Date.now() 기준 마감 시각, 숫자와 같은 값)에서 지금 비율을 계산해
    // 0까지 linear로 줄인다. Web Animations라 카드가 안 보일 때 시작돼도 시간은 흐르고, 탭이 다시 보이면 마감 시각에 다시 맞춘다.
    createGauge(card) {
      const gauge = document.createElement('div');
      gauge.className = 'fx-timer-gauge';
      const fill = document.createElement('div');
      fill.className = 'fx-timer-gauge-fill';
      gauge.appendChild(fill);
      card.appendChild(gauge);
      let anim = null, deadline = null, total = 0;
      const run = () => {
        if (anim) { anim.cancel(); anim = null; }
        if (deadline == null) return;
        const remainMs = Math.max(0, deadline - Date.now());
        const frac = total > 0 ? Math.min(1, remainMs / total) : 0;
        fill.style.transform = 'scaleX(0)'; // 끝난 뒤 머무는 모양
        if (remainMs > 0 && fill.animate) {
          anim = fill.animate([{ transform: `scaleX(${frac})` }, { transform: 'scaleX(0)' }],
            { duration: remainMs, easing: 'linear' });
        }
      };
      document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });
      return {
        start(endAt, totalMs) {
          deadline = endAt;
          total = totalMs;
          gauge.classList.add('active');
          run();
        },
        hot(on) { gauge.classList.toggle('hot', !!on); },
        stop() {
          deadline = null;
          if (anim) { anim.cancel(); anim = null; }
          gauge.classList.remove('active', 'hot');
        },
      };
    },
  };

  // ── 공 낙하: 상자 헤더 바로 아래에서 제자리로 떨어져 한 번 작게 튕김 ──
  const balls = {
    DROP_MS: 560,      // 낙하+튕김 전체 시간
    IMPACT: 0.72,      // 바닥에 닿는 시점(전체 대비)
    BOUNCE_RATIO: 0.08, // 튕김 높이 = 낙하 거리 × 비율
    BOUNCE_MAX: 14,    // 튕김 높이 상한(논리 px) — 상자가 커도 "작은" 튕김 유지
    STAGGER: 35,       // 한 번에 여러 표가 들어올 때 공끼리 겹쳐 떨어지지 않게 시차(ms)
    STAGGER_MAX: 420,

    // 새 공에 낙하 정보를 붙인다. order = 이번에 함께 들어온 공 중 몇 번째인지
    startDrop(ball, fromY, order, now) {
      const delay = Math.min(balls.STAGGER_MAX, (order || 0) * balls.STAGGER);
      ball.drop = { t0: (now || performance.now()) + delay, fromY };
      ball.y = fromY;
    },

    // 낙하 중이면 위치를 계산해 넣고 true(그릴지 여부는 visible)를 돌려준다.
    // 끝나면 drop을 지워 평소처럼 목표 위치로 lerp(반지름 축소 재배치도 부드럽게)
    step(ball, now) {
      const d = ball.drop;
      if (!d) return { dropping: false, visible: true };
      const elapsed = now - d.t0;
      ball.x = ball.tx; // 재배치로 목표 x가 바뀌어도 따라감
      if (elapsed < 0) { ball.y = d.fromY; return { dropping: true, visible: false }; }
      const reduce = prefersReduced();
      const dur = reduce ? 300 : balls.DROP_MS;
      const t = elapsed / dur;
      if (t >= 1) { ball.y = ball.ty; ball.drop = null; return { dropping: false, visible: true }; }
      const dist = ball.ty - d.fromY;
      if (reduce) {
        // 동작 줄이기: 튕김 없이 짧게 내려앉기
        ball.y = d.fromY + dist * (1 - Math.pow(1 - t, 3));
      } else if (t < balls.IMPACT) {
        const g = t / balls.IMPACT;
        ball.y = d.fromY + dist * g * g; // 중력처럼 가속
      } else {
        const b = (t - balls.IMPACT) / (1 - balls.IMPACT);
        const h = Math.min(Math.abs(dist) * balls.BOUNCE_RATIO, balls.BOUNCE_MAX);
        ball.y = ball.ty - h * Math.sin(Math.PI * b); // 한 번만 작게 튕김
      }
      return { dropping: true, visible: true };
    },
  };

  // ── 하트 폭발: 3초 안 하트 40개 이상이면 가운데 큰 하트 + 링 파티클 (시안 3) ──
  const HEART_WINDOW = 3000;
  const HEART_FIRE = 40;   // 이 이상 몰리면 터짐
  const HEART_REARM = 10;  // 이 아래로 식어야 다시 터질 수 있음 (연속 폭발 방지)
  const HEART_MS = 1400;
  const HEART_MODES = ['chat', 'result', 'subjectiveResult', 'idle'];
  const RING_DOTS = 16;

  // layer: 연출을 얹을 레이어(리액션 레이어), colors: 링 색(OPTION_COLORS 순서)
  function createHeartBurst(layer, colors) {
    let recent = [];
    let armed = true;
    let enabled = true;
    let playing = false;

    function play() {
      playing = true;
      const reduce = prefersReduced();
      const W = layer.clientWidth, H = layer.clientHeight;
      const k = Math.min(W, H) / 1000; // 시안(1000px 캔버스) 대비 배율
      const root = document.createElement('div');
      root.className = 'fx-burst';
      const heart = document.createElement('div');
      heart.className = 'fx-burst-heart';
      heart.textContent = '❤️';
      heart.style.fontSize = Math.round(260 * k) + 'px';
      root.appendChild(heart);
      const dots = [];
      if (!reduce) {
        for (let i = 0; i < RING_DOTS; i++) {
          const d = document.createElement('div');
          d.className = 'fx-burst-dot';
          d.style.background = colors[i % 5];
          d.style.width = d.style.height = Math.round(20 * k) + 'px';
          root.appendChild(d);
          dots.push(d);
        }
      }
      layer.appendChild(root);

      const t0 = performance.now();
      const frame = (now) => {
        const p = (now - t0) / HEART_MS;
        if (p >= 1) { root.remove(); playing = false; return; }
        const fade = 1 - Math.max(0, p - 0.7) / 0.3; // 마지막 30% 동안 사라짐
        if (reduce) {
          // 동작 줄이기: 크기 변화·파티클 없이 잠깐 나타났다 사라짐
          heart.style.opacity = String(Math.min(1, p * 4) * fade);
        } else {
          const s = easeBack(Math.min(1, p * 2.2)) * fade;
          heart.style.opacity = String(fade);
          heart.style.transform = `translate(-50%, -50%) scale(${Math.max(0.001, s)})`;
          const r = (120 + p * 260) * k;
          const ds = Math.max(0, 1 - p);
          dots.forEach((d, i) => {
            const a = i / RING_DOTS * Math.PI * 2;
            d.style.opacity = String(fade);
            d.style.transform = `translate(-50%, -50%) translate(${Math.cos(a) * r}px, ${Math.sin(a) * r}px) scale(${ds})`;
          });
        }
        requestAnimationFrame(frame);
      };
      heart.style.transform = reduce ? 'translate(-50%, -50%)' : 'translate(-50%, -50%) scale(0.001)';
      requestAnimationFrame(frame);
    }

    return {
      setEnabled(v) { enabled = v !== false; },
      isEnabled() { return enabled; },
      // reaction 이벤트마다 호출. 하트만 세고, 허용 모드에서 조건이 맞으면 터뜨린다.
      onReaction(type, mode) {
        if (type !== 'heart') return false;
        const now = performance.now();
        recent = recent.filter((t) => now - t < HEART_WINDOW);
        if (recent.length < HEART_REARM) armed = true;
        recent.push(now);
        if (recent.length > HEART_FIRE) recent.shift(); // 판정엔 최근 40개만 필요 — 하트가 몰려도 배열이 커지지 않게
        if (recent.length >= HEART_FIRE && armed && enabled && !playing && HEART_MODES.includes(mode)) {
          armed = false;
          play();
          return true;
        }
        return false;
      },
    };
  }

  // 연출 설정(state.effects / effectsChange)에서 하트 폭발 on/off — 값이 없으면 켬
  function heartBurstEnabled(effects) {
    return !(effects && effects.heartBurst === false);
  }

  // ── 결과 요약: 1위(동률이면 여럿)와 1위 비율 ──
  function summarize(perOption) {
    const per = (perOption || []).map((v) => Math.max(0, Number(v) || 0));
    const total = per.reduce((a, b) => a + b, 0);
    const max = per.length ? Math.max(...per) : 0;
    const top = max > 0 ? per.map((v, i) => (v === max ? i : -1)).filter((i) => i >= 0) : [];
    return { per, total, max, top, tie: top.length > 1, pct: total ? Math.round(max / total * 100) : 0 };
  }

  // 두 색을 k 비율로 섞어 '#rrggbb'로 돌려준다 (진 쪽 점 = 이긴 색의 옅은 톤, 색 전환도 부드럽게)
  function mixHex(a, b, k) {
    const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const x = p(a), y = p(b);
    return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * clamp01(k)).toString(16).padStart(2, '0')).join('');
  }

  // ── 결과 공개 (2지선다): 시안 6 그대로 — 두 원형 공 덩어리에서 시작해 원 + 비율로 끝남 ──
  // 0~0.7s 마감: 이긴 원이 부풀었다 돌아오고 진 쪽은 흐려짐 / 0.7~1.5s 공이 흩어짐 /
  // 1.5~2.8s 결과 숫자(예: "62%") 점 모양으로 모임(2.5s 색종이) / 2.9~4.7s 점→면(1.8s) / 6.4s까지 유지 /
  // 면→점 0.5s / 6.9~8.1s 원으로 복귀 → 페이지가 원 위에 비율을 띄움
  const REVEAL = {
    EMPH: 700, SCATTER: 1500, GATHER_MS: 1100, CONFETTI: 2500,
    SOLID: 2900, SOLID_MS: 1800, UNSOLID: 6400, UNSOLID_MS: 500,
    RETURN: 6900, RETURN_MS: 1200,
    DOTS: 260, // 숫자를 이루는 점 개수(표 수와 무관 — 표가 적어도 숫자 모양이 또렷하게)
  };
  REVEAL.END = REVEAL.RETURN + REVEAL.RETURN_MS;
  // 숫자 글꼴은 웹폰트 로딩과 무관한 시스템 글꼴로 고정 — 점을 뽑을 때와 면으로 그릴 때 모양이 정확히 겹치도록
  const NUM_FAMILY = "-apple-system, 'Helvetica Neue', Arial, sans-serif";

  // 원 아래 보기 이름의 투명도 — 마감 땐 보이고, 숫자 구간엔 숨었다가 원으로 돌아오며 다시 나타남
  function revealLabelAlpha(t) {
    const R = REVEAL;
    if (t < R.EMPH) return 1;
    if (t < R.SCATTER) return 1 - ease((t - R.EMPH) / (R.SCATTER - R.EMPH));
    if (t < R.RETURN) return 0;
    return ease((t - R.RETURN) / R.RETURN_MS);
  }

  // opts: { W, H (논리 캔버스), sides: [{ color, count, balls:[{x,y}] }] (공 = 원 덩어리 안 실제 위치),
  //         centers: [{x,y}] (원 중심), ballR, winner(-1=동률), pct, label, labelFamily, ink, confettiColors }
  // 반환 객체의 draw(ctx, now)를 매 프레임 부르고, true가 오면 끝(페이지가 원 + 비율을 그림)
  function createReveal(opts) {
    const { W, H, ink } = opts;
    const tie = opts.winner < 0;
    const numColor = tie ? ink : opts.sides[opts.winner].color;
    const text = opts.pct + '%';

    // 숫자 크기: 캔버스 폭 78%·높이 62% 안에 들어가게
    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.round(W)); off.height = Math.max(1, Math.round(H));
    const o = off.getContext('2d');
    o.font = '700 100px ' + NUM_FAMILY;
    const w100 = Math.max(1, o.measureText(text).width);
    const size = Math.round(Math.min(H * 0.62, W * 0.78 / w100 * 100));
    const numFont = '700 ' + size + 'px ' + NUM_FAMILY;
    const numY = H * 0.44;
    const labelSize = Math.round(Math.max(22, Math.min(52, size * 0.18)));
    const labelY = numY + size * 0.42 + labelSize;
    // 이긴 보기 이름: 폭 90% 안에 2줄까지 → 최소 22px까지 축소 → 말줄임 (장평 압축 없음). 캔버스 아래 끝을 넘지 않게
    const LABEL_LH = 1.2;
    const labelTop = labelY - labelSize / 2;
    const labelFit = fitCanvasText(o, opts.label, {
      maxW: W * 0.9, maxPx: labelSize, minPx: Math.min(labelSize, 22), maxLines: 2,
      family: opts.labelFamily, lineH: LABEL_LH, maxH: Math.max(labelSize * LABEL_LH, H - labelTop - 4),
    });

    // 글자를 격자로 훑어 점 위치를 뽑는다 — 격자 간격은 점이 REVEAL.DOTS개 안팎이 되게
    o.font = numFont; o.textAlign = 'center'; o.textBaseline = 'middle';
    o.fillText(text, W / 2, numY);
    const data = o.getImageData(0, 0, off.width, off.height).data;
    const sample = (step) => {
      const out = [];
      for (let y = step / 2; y < off.height; y += step) {
        for (let x = step / 2; x < off.width; x += step) {
          if (data[(Math.floor(y) * off.width + Math.floor(x)) * 4 + 3] > 128) out.push([x, y]);
        }
      }
      return out;
    };
    let step = Math.max(4, size / 23);
    let pts = sample(step);
    if (pts.length) { step = Math.max(4, step * Math.sqrt(pts.length / REVEAL.DOTS)); pts = sample(step); }
    const dotR = step * 0.42;      // 처음엔 틈이 보이는 점
    const dotRFull = step * 0.66;  // 맞닿아 면처럼 보이는 크기

    // 점을 보기별로 득표 비율만큼 나눈다(시안: 62%면 점의 62%가 이긴 쪽 공). 실제 공이 모자라면
    // 그 쪽 공 자리에서 '분신' 점이 생겨 함께 날아가고, 돌아올 때 원래 공 위로 겹치며 사라진다.
    // 실제 공이 더 많으면 남는 공은 숫자 구간 동안 흐려졌다 돌아올 때 다시 나타난다.
    const counts = opts.sides.map((s) => s.balls.length);
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    const N = pts.length;
    const share = counts.map((c) => (c ? Math.round(N * c / total) : 0));
    if (counts[0] && counts[1]) share[1] = N - share[0]; else share[counts[0] ? 0 : 1] = N;
    const parts = [];
    opts.sides.forEach((s, side) => {
      const balls = s.balls;
      if (!balls.length) return;
      for (let k = 0; k < Math.max(share[side], balls.length); k++) {
        if (k < balls.length) parts.push({ b: balls[k], side, hx: balls[k].x, hy: balls[k].y, extra: false, dot: k < share[side] });
        else { const h = balls[Math.floor(Math.random() * balls.length)]; parts.push({ b: null, side, hx: h.x, hy: h.y, extra: true, dot: true }); }
      }
    });
    // 점 자리는 섞어서 배정(한쪽 보기 점이 숫자 한 부분에 몰리지 않게)
    const dotParts = parts.filter((p) => p.dot);
    for (let i = dotParts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [dotParts[i], dotParts[j]] = [dotParts[j], dotParts[i]]; }
    dotParts.forEach((p, k) => { const q = pts[k % N]; p.tx = q[0]; p.ty = q[1]; });
    const m = W * 0.06;
    parts.forEach((p, k) => {
      if (!p.dot) p.tx = null;
      p.sx = m + Math.random() * (W - m * 2);
      p.sy = m + Math.random() * (H - m * 2);
      p.delay = (k % 40) * 6; // 한꺼번에 몰리지 않게 살짝 시차
    });

    const confetti = [];
    let confettiDone = false;
    let t0 = null, last = null;

    function burst() {
      const k = W / 1000; // 시안(1000px) 대비 배율
      const cols = opts.confettiColors;
      for (let i = 0; i < 100; i++) {
        const a = Math.random() * Math.PI * 2, v = (4 + Math.random() * 10) * k;
        confetti.push({ x: W / 2, y: numY, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 5 * k, r: Math.random() * Math.PI, c: cols[i % 5], s: (8 + Math.random() * 9) * k, g: 0.35 * k });
      }
    }

    function draw(ctx, now) {
      if (t0 === null) { t0 = now; last = now; }
      const t = now - t0;
      const dt = Math.min(50, now - last); last = now;
      const R = REVEAL;

      // 점→면: 점이 커져 맞닿고(0~40%) 그 위로 같은 모양의 글자가 차오르며 점은 사라짐(40~100%)
      const solid = t > R.SOLID && t < R.RETURN ? ease((t - R.SOLID) / R.SOLID_MS) * (1 - ease((t - R.UNSOLID) / R.UNSOLID_MS)) : 0;
      const dotAlpha = 1 - clamp01((solid - 0.4) / 0.6);
      const grownR = dotR + (dotRFull - dotR) * Math.min(1, solid / 0.4);

      // 점 색: 모이는 동안 이긴 색(진 쪽은 옅은 톤)으로, 복귀하며 원래 색으로
      const toMorph = t < R.RETURN ? ease((t - R.SCATTER) / 700) : 1 - ease((t - R.RETURN) / 800);
      const colors = opts.sides.map((s, i) => {
        const target = tie ? ink : (i === opts.winner ? numColor : mixHex(numColor, '#ffffff', 0.45));
        return toMorph <= 0 ? s.color : mixHex(s.color, target, toMorph);
      });
      const emphP = clamp01(t / R.EMPH);
      const emphS = 1 + Math.sin(emphP * Math.PI) * 0.16; // 이긴 원만 부풀었다 돌아옴(시안)
      const loserDim = tie ? 1 : t < R.EMPH ? 1 - 0.45 * emphP : t < R.SCATTER ? 0.55 + 0.45 * ease((t - R.EMPH) / (R.SCATTER - R.EMPH)) : 1;

      parts.forEach((p) => {
        let x, y, r, a = 1;
        const r0 = opts.ballR;
        if (t < R.EMPH) {
          if (p.extra) return;
          const s = !tie && p.side === opts.winner ? emphS : 1, c = opts.centers[p.side];
          x = c.x + (p.hx - c.x) * s; y = c.y + (p.hy - c.y) * s; r = r0 * s;
        } else if (t < R.SCATTER) {
          const q = ease((t - R.EMPH) / (R.SCATTER - R.EMPH));
          x = p.hx + (p.sx - p.hx) * q; y = p.hy + (p.sy - p.hy) * q; r = r0 + (dotR - r0) * q;
          if (p.extra) { a = q; r = dotR * q; }
        } else if (t < R.RETURN) {
          if (p.tx === null) {
            x = p.sx; y = p.sy; r = dotR; a = 1 - ease((t - R.SCATTER) / 600);
          } else {
            const q = easeBack((t - R.SCATTER - p.delay) / R.GATHER_MS);
            x = p.sx + (p.tx - p.sx) * q; y = p.sy + (p.ty - p.sy) * q; r = solid > 0 ? grownR : dotR; a = dotAlpha;
          }
        } else {
          const q = ease((t - R.RETURN) / R.RETURN_MS);
          const fx = p.tx === null ? p.sx : p.tx, fy = p.tx === null ? p.sy : p.ty;
          x = fx + (p.hx - fx) * q; y = fy + (p.hy - fy) * q; r = dotR + (r0 - dotR) * q;
          if (p.tx === null) a = q;
          if (p.extra) a = 1 - q; // 분신 점은 원래 공 위로 겹치며 사라짐
        }
        if (!tie && p.side !== opts.winner) a *= loserDim;
        if (a <= 0.01) return;
        if (p.b) { p.b.x = x; p.b.y = y; } // 끝나면 공이 제자리에서 그대로 이어지도록
        ctx.globalAlpha = a;
        ctx.fillStyle = colors[p.side];
        ctx.beginPath(); ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2); ctx.fill();
      });
      ctx.globalAlpha = 1;

      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      // 면이 된 글자 — 점을 뽑을 때와 같은 글꼴·크기·위치라 모양이 그대로 겹친다
      if (solid > 0) {
        ctx.globalAlpha = clamp01((solid - 0.15) / 0.85);
        ctx.font = numFont; ctx.fillStyle = numColor;
        ctx.fillText(text, W / 2, numY);
      }
      // 숫자 아래 이긴 보기 이름(동률이면 "동률")
      const labelA = t < R.RETURN ? ease((t - R.SCATTER) / 800) : 1 - ease((t - R.RETURN) / 400);
      if (labelA > 0.01) {
        ctx.globalAlpha = labelA;
        ctx.font = '700 ' + labelFit.px + 'px ' + opts.labelFamily;
        ctx.fillStyle = numColor;
        // 첫 줄 윗선은 원래 자리(labelTop)에 두고 아래로 줄을 이어 씀
        labelFit.lines.forEach((ln, i) => ctx.fillText(ln, W / 2, labelTop + labelFit.px / 2 + i * labelFit.px * LABEL_LH));
      }
      ctx.globalAlpha = 1;

      if (!confettiDone && t >= R.CONFETTI) { confettiDone = true; burst(); }
      for (let i = confetti.length - 1; i >= 0; i--) {
        const q = confetti[i];
        q.vy += q.g * dt / 16; q.x += q.vx * dt / 16; q.y += q.vy * dt / 16; q.r += 0.1 * dt / 16;
        if (q.y > H + 40) { confetti.splice(i, 1); continue; }
        ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.r); ctx.fillStyle = q.c; ctx.fillRect(-q.s / 2, -q.s / 4, q.s, q.s / 2); ctx.restore();
      }

      if (t >= R.END) {
        parts.forEach((p) => { if (p.b) { p.b.x = p.hx; p.b.y = p.hy; } });
        return true;
      }
      return false;
    }

    // 원 아래 보기 이름 투명도(페이지가 그림), 연출 시작 기준
    const labelAlpha = (now) => (t0 === null ? 1 : revealLabelAlpha(now - t0));
    return { draw, labelAlpha, numColor, text, labelFit, labelMaxW: W * 0.9, dots: N };
  }

  // ── 객관식 3지 이상: 막대 경주 (시안 4) ──
  // 막대가 흔들리며 자라 중간에 순위가 바뀌다가, 3.2초 뒤 정렬된 결과로 확정
  const RACE_MS = 3200;
  // 막대 경주 중 순위 바꾸기 조건 — 매 프레임 바꾸면 접전일 때 행이 오가다 한자리에 겹쳐 보임(비율 숫자 섞임)
  const RACE_SWAP_PCT = 1.5;  // 뒤 행이 앞 행보다 이만큼(%p) 앞서야 자리를 바꿈
  const RACE_SWAP_GAP = 550;  // 직전 자리바꿈 후 이 시간(ms) 안엔 다시 바꾸지 않음 (행 이동 전환 0.5초가 끝난 뒤)

  // 글자 배율 단계(--fx-bar-s): 행이 칸에 다 안 들어가면 한 단계씩 줄임. 0.75 = 보기 이름 15px(세로형 800 기준) — 이보다 작게는 안 줄임
  const BAR_STEPS = [1, 0.92, 0.84, 0.75];

  function createBarRace(container) {
    let raf = null;
    let rows = [], area = null, labels = [], winners = [];
    let cur = null; // 지금 자리 { vals, order, done } — 창 크기가 바뀌면 이 상태로 다시 배치
    let geo = null; // 행 배치 { y0, pitch, rowH } (px)

    function clear() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      rows = []; area = null; cur = null; geo = null;
      container.classList.remove('active');
      container.innerHTML = '';
    }

    // 행 높이 = 보기 이름 줄 수(최대 2줄)에 맞춘 실제 높이. 행끼리 겹치지 않게 칸이 모자라면 글자를 한 단계씩 줄이고,
    // 그래도 모자라면 이름을 1줄로. 남으면 행 간격을 행 높이의 45%까지만 벌리고 가운데 모음 (3지에서 빈 띠 방지)
    function layout() {
      if (!area || !rows.length) return;
      const H = area.clientHeight;
      if (!H) return;
      const u = parseFloat(getComputedStyle(container).getPropertyValue('--u')) || 1;
      const n = rows.length;
      const gapMin = 8 * u;
      // 재는 동안은 최종 1위 표시(· 1위)를 켜 둔다 — 결과가 확정되며 배지가 붙어도 줄 수가 늘지 않게
      container.style.removeProperty('--fx-bar-labw'); // 이름 칸은 최대 폭(32%)에서 줄바꿈을 정한 뒤 실제 폭으로 좁힘
      rows.forEach((r, i) => { r.style.height = ''; r.classList.toggle('win', winners.includes(i)); });
      const measure = (lines) => {
        rows.forEach((r, i) => clampText(r.querySelector('.fx-bar-name'), labels[i], lines));
        return Math.max(...rows.map((r) => r.offsetHeight));
      };
      let rowH = 0, ok = false;
      for (const lines of [2, 1]) {
        for (const s of BAR_STEPS) {
          container.style.setProperty('--fx-bar-s', String(s));
          rowH = Math.max(measure(lines), 44 * u * s);
          if (n * rowH + (n - 1) * gapMin <= H) { ok = true; break; }
        }
        if (ok) break;
      }
      // 극단적으로 좁을 때(글자는 이미 최소·1줄): 행 높이를 글자 높이 아래로 줄이지 않는다(행끼리 겹침 방지) —
      // 행 간격은 하한(gapMin)만 두고 칸 위 끝부터 쌓아, 모자라는 만큼은 아래 여백 쪽으로 넘침
      // 이름 칸을 가장 긴 이름(1위 배지 포함)의 실제 폭으로 — 막대·% 묶음이 화면 가운데에 오게 (줄바꿈은 그대로)
      const labW = maxInkWidth(rows.map((r) => r.querySelector('.fx-bar-label')));
      if (labW > 0) container.style.setProperty('--fx-bar-labw', Math.ceil(labW + 1) + 'px');
      const pitch = !ok ? rowH + gapMin : n > 1 ? Math.min((H - rowH) / (n - 1), rowH * 1.45) : 0;
      geo = { y0: ok ? (H - rowH - (n - 1) * pitch) / 2 : 0, pitch, rowH };
      rows.forEach((r) => { r.style.height = rowH + 'px'; r.classList.remove('win'); });
      if (cur) place(cur.vals, cur.order, cur.done);
    }

    let scaleMax = 10, top = [];
    function place(vals, order, done) {
      cur = { vals, order, done };
      rows.forEach((r, i) => {
        if (geo) r.style.top = (geo.y0 + order.indexOf(i) * geo.pitch) + 'px';
        r.querySelector('.fx-bar-fill').style.width = (vals[i] / scaleMax * 100) + '%';
        r.querySelector('.fx-bar-pct').textContent = Math.round(vals[i]) + '%';
        r.classList.toggle('win', done && top.includes(i)); // 1위 동률이면 모두 표시
      });
    }

    // opts: { labels, colors, perOption, animate }
    function show(opts) {
      clear();
      const sum = summarize(opts.perOption);
      labels = opts.labels.map((l) => String(l));
      const pcts = labels.map((_, i) => (sum.total ? Math.round((sum.per[i] || 0) / sum.total * 100) : 0));
      const maxPct = Math.max(0, ...pcts);
      scaleMax = Math.max(10, maxPct * 1.12); // 1위 막대가 트랙을 거의 채우게
      top = sum.top;
      winners = sum.total ? sum.top : [];
      // 흔들림 폭: 중간에 순위가 뒤집히는 재미용. 접전(이웃 순위 차 3%p 미만)이면 줄여 자리바꿈이 잦지 않게
      const sorted = pcts.slice().sort((x, y) => y - x);
      const tight = sorted.some((v, i) => i > 0 && sorted[i - 1] - v < 3);
      const wobbleAmp = maxPct * (tight ? 0.16 : 0.26);
      // 최종 순서: 득표 내림차순, 같으면 보기 순서
      const finalOrder = pcts.map((v, i) => [sum.per[i] || 0, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map((x) => x[1]);

      area = document.createElement('div');
      area.className = 'fx-bars-area';
      rows = labels.map((label, i) => {
        const r = document.createElement('div');
        r.className = 'fx-bar-row';
        r.innerHTML = '<div class="fx-bar-label"><span class="fx-bar-name"></span><span class="fx-bar-rank">· 1위</span></div>' +
          '<div class="fx-bar-track"><div class="fx-bar-fill"></div></div><div class="fx-bar-pct">0%</div>';
        r.querySelector('.fx-bar-name').textContent = label;
        r.querySelector('.fx-bar-fill').style.background = opts.colors[i % opts.colors.length];
        area.appendChild(r);
        return r;
      });
      container.appendChild(area);
      // 첫 배치는 전환 없이 (행이 0에서 미끄러져 들어오지 않게)
      container.classList.add('fx-instant');
      layout();

      if (!opts.animate || prefersReduced() || !sum.total) {
        place(pcts, finalOrder, true);
        void container.offsetWidth;
        container.classList.remove('fx-instant');
        container.classList.add('active');
        return;
      }
      place(pcts.map(() => 0), labels.map((_, i) => i), false);
      void container.offsetWidth;
      container.classList.remove('fx-instant');
      container.classList.add('active');
      const t0 = performance.now();
      let order = labels.map((_, i) => i), swappedAt = -Infinity;
      const frame = (now) => {
        const t = (now - t0) / RACE_MS;
        if (t >= 1) { raf = null; place(pcts, finalOrder, true); return; } // 확정 순위 = 실제 득표 순위
        // 보기마다 다른 흔들림 → 중간에 순위가 뒤집혔다가 제자리로
        const vals = pcts.map((v, i) => Math.max(0, v * ease(t) + Math.sin(t * Math.PI * 2.2 + i * 1.7) * wobbleAmp * (1 - t) * ease(t)));
        // 순위 바꾸기(히스테리시스): 바로 위 행보다 RACE_SWAP_PCT 이상 앞설 때만, 직전 자리바꿈 후 RACE_SWAP_GAP 지난 뒤에만
        if (now - swappedAt >= RACE_SWAP_GAP) {
          const next = order.slice();
          for (let j = 1; j < next.length; j++) {
            for (let k = j; k > 0 && vals[next[k]] - vals[next[k - 1]] >= RACE_SWAP_PCT; k--) [next[k - 1], next[k]] = [next[k], next[k - 1]];
          }
          if (next.some((v, j) => v !== order[j])) { order = next; swappedAt = now; }
        }
        place(vals, order, false);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    }

    return {
      show, clear,
      isActive: () => container.classList.contains('active'),
      // 창 크기·글꼴 로딩으로 칸이 바뀌면 행 높이·간격을 다시 잼 (전환 없이)
      relayout() {
        if (!area) return;
        container.classList.add('fx-instant');
        layout();
        void container.offsetWidth;
        container.classList.remove('fx-instant');
      },
    };
  }

  // ══════════════════════════════════
  //  주관식: 답변 흘려보내기 · 워드클라우드 · 제작진 픽
  // ══════════════════════════════════
  // 서버 computeCloud와 같은 정규화(공백만 정리) — 흘러가는 답변과 클라우드 단어를 맞춰 보기 위해
  const normText = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  // ── 답변 흘려보내기: 대기열 + 가로 레인 (폭주해도 버리지 않고 고른 밀도로 배출) ──
  const STREAM = {
    MAX_QUEUE: 200,     // 대기열 상한 (초과 시 오래된 것부터 포기)
    LANES: 8,           // 가로 레인 수
    LANE_COOLDOWN: 3500, // 같은 레인 재사용 대기(ms) — 워드클라우드로 모일 때 들어오는 말풍선용
    MIN_MS: 9000,       // 화면을 지나가는 시간 9~14초 (빠를수록 짧음)
    MAX_MS: 14000,
    GAP: 40,            // 같은 레인 앞 말풍선과의 최소 간격(논리 px) — 들어올 때도, 지나가는 내내도
    RETRY_MS: 120,      // 빈 레인이 없으면 대기열에서 기다렸다 이 간격으로 다시 봄
  };

  // opts: { el: 흘려보내기 레이어, scale: () => 화면 배율(--u),
  //         area: () => { top, bottom } 말풍선이 지나갈 세로 범위(px, 레이어 기준) — 질문 카드 아래만 쓰도록 }
  function createAnswerStream(opts) {
    const el = opts.el;
    const scale = opts.scale || (() => 1);
    const area = opts.area || (() => ({ top: el.clientHeight * 0.14, bottom: el.clientHeight * 0.82 + 64 * scale() }));
    const BUBBLE_H = 64; // 가장 큰 말풍선 높이(논리 px) — 맨 아래 레인도 범위 안에 들도록
    const queue = [];
    const laneBusy = new Array(STREAM.LANES).fill(0);
    // 레인마다 마지막으로 내보낸 말풍선 { t0(출발 시각), x0(출발 left), w(폭), v(px/ms) } — 뒤 말풍선이 따라잡지 않게
    const laneLast = new Array(STREAM.LANES).fill(null);
    let items = []; // 화면에 떠 있는 답변 { el, id, text, anim }
    let spawnTimer = null;
    let running = false;

    // 레인: 질문 카드 아래 ~ 화면 아래 여백 사이를 균등 분할. 범위가 좁으면(긴 질문) 레인 수를 줄여
    // 큰 말풍선끼리도 위아래로 겹치지 않게 (레인 간격 ≥ 56px·배율)
    function laneSpan() {
      const a = area();
      return { top: a.top, span: Math.max(0, a.bottom - a.top - BUBBLE_H * scale()) };
    }
    function laneCount() {
      return Math.max(2, Math.min(STREAM.LANES, Math.floor(laneSpan().span / (56 * scale())) + 1));
    }
    const laneTop = (lane) => {
      const { top, span } = laneSpan();
      const n = laneCount();
      return top + Math.min(lane, n - 1) * (span / (n - 1));
    };

    function pickLane() {
      const now = performance.now();
      const free = [];
      const n = laneCount();
      for (let i = 0; i < n; i++) if (laneBusy[i] <= now) free.push(i);
      // 모두 사용 중이면 가장 먼저 비는 레인
      const busy = laneBusy.slice(0, n);
      const lane = free.length ? free[Math.floor(Math.random() * free.length)] : busy.indexOf(Math.min(...busy));
      laneBusy[lane] = now + STREAM.LANE_COOLDOWN;
      return lane;
    }

    // 말풍선 하나 (워드클라우드로 모일 때 오른쪽에서 들어오는 답변도 같은 모양)
    function makeBubble(text, lane) {
      const b = document.createElement('div');
      b.className = 'answer-float';
      b.textContent = text;
      b.style.fontSize = Math.round((18 + Math.random() * 12) * scale()) + 'px';
      if (lane !== false) b.style.top = laneTop(lane == null ? pickLane() : lane) + 'px'; // false: 레인은 부른 쪽이 정함
      el.appendChild(b);
      return b;
    }

    // 이 레인에 폭 w 말풍선을 지금 내보낼 때 쓸 수 있는 가장 빠른 속도(px/ms). 못 쓰면 0
    // 앞 말풍선 꼬리(오른쪽 끝)와 GAP 이상 떨어져 들어오고, 앞 말풍선이 화면을 다 지날 때까지 따라잡지 않아야 한다
    function laneMaxSpeed(lane, sw, w, now) {
      const last = laneLast[lane];
      const vMax = (sw + w + 60 * scale()) / STREAM.MIN_MS;
      if (!last) return vMax;
      const gap = STREAM.GAP * scale();
      const tailAt = (t) => last.x0 - last.v * (t - last.t0) + last.w; // 앞 말풍선 오른쪽 끝(레이어 x)
      if (tailAt(now) + gap > sw) return 0; // 앞 말풍선이 아직 다 들어오지 않음
      const tEnd = last.t0 + (last.x0 + last.w + 60 * scale()) / last.v; // 앞 말풍선이 왼쪽 밖으로 다 나가는 시각
      if (tEnd <= now) return vMax;
      // 새 말풍선 머리(left) = sw - v·(t - now) ≥ 앞 꼬리 + gap  (t = tEnd에서 가장 빡빡함 — 둘 다 직선이라 양 끝만 보면 됨)
      const v = (sw - tailAt(tEnd) - gap) / (tEnd - now);
      return Math.max(0, Math.min(vMax, v));
    }

    // 큐 앞 답변을 비어 있는 레인에 내보냄. 빈 레인이 없으면 false(대기열에 남김)
    function spawn(a) {
      const b = makeBubble(a.text, false);
      const w = b.offsetWidth;
      const sw = el.clientWidth;
      const now = performance.now();
      const dist = sw + w + 60 * scale();
      const vMin = dist / STREAM.MAX_MS;
      const want = dist / (STREAM.MIN_MS + Math.random() * (STREAM.MAX_MS - STREAM.MIN_MS)); // 9~14초 무작위
      const n = laneCount();
      const ok = [];
      for (let i = 0; i < n; i++) { const vm = laneMaxSpeed(i, sw, w, now); if (vm >= vMin) ok.push([i, vm]); }
      if (!ok.length) { b.remove(); return false; }
      // 원하는 속도를 그대로 낼 수 있는 레인 중 무작위, 없으면 가장 빨리 갈 수 있는 레인을 그 속도로
      const full = ok.filter((x) => x[1] >= want);
      const [lane, vm] = full.length ? full[Math.floor(Math.random() * full.length)] : ok.reduce((p, q) => (q[1] > p[1] ? q : p));
      const v = Math.min(want, vm);
      b.style.top = laneTop(lane) + 'px';
      b.style.left = sw + 'px'; // 오른쪽 밖에서 시작
      laneLast[lane] = { t0: now, x0: sw, w, v };
      laneBusy[lane] = now + (w + STREAM.GAP * scale()) / v; // 다 들어올 때까지 (클라우드 쪽 말풍선도 피해 감)
      // key: 서버가 붙인 워드클라우드 묶음 키(표기 차이를 지운 것) — 마감 때 자기 단어로 모일 자리를 찾는 데 씀 (옛 서버면 글 그대로)
      const it = { el: b, id: a.id, text: normText(a.text), key: a.key || normText(a.text) };
      it.anim = b.animate([
        { transform: 'translateX(0)' },
        { transform: `translateX(${-dist}px)` },
      ], { duration: dist / v, easing: 'linear' });
      it.anim.onfinish = () => { b.remove(); items = items.filter((x) => x !== it); };
      items.push(it);
      return true;
    }

    function schedule() {
      if (spawnTimer || !running) return;
      const tick = () => {
        if (!running || !queue.length) { spawnTimer = null; return; }
        // 빈 레인이 없으면 내보내지 않고 대기열 앞에서 잠시 기다림 (겹치거나 앞지르지 않게)
        if (!spawn(queue[0])) { spawnTimer = setTimeout(tick, STREAM.RETRY_MS); return; }
        queue.shift();
        // 밀린 답변이 많을수록 배출 간격을 자동으로 줄임
        const delay = queue.length > 60 ? 150 : queue.length > 25 ? 250 : 420;
        spawnTimer = setTimeout(tick, delay);
      };
      spawnTimer = setTimeout(tick, 50);
    }

    function stop() {
      running = false;
      queue.length = 0;
      if (spawnTimer) { clearTimeout(spawnTimer); spawnTimer = null; }
    }

    // 흐르던 답변을 지금 보이는 자리에 멈춰 세우고 넘겨준다 (레이어 기준 좌상단 x,y)
    function detach(it) {
      const sr = el.getBoundingClientRect();
      const r = it.el.getBoundingClientRect();
      it.anim.onfinish = null;
      it.anim.cancel();
      it.el.style.left = (r.left - sr.left) + 'px';
      it.el.style.top = (r.top - sr.top) + 'px';
      items = items.filter((x) => x !== it);
      return { el: it.el, id: it.id, text: it.text, key: it.key, x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height, rect: r };
    }

    return {
      el,
      makeBubble,
      laneTop,
      // 답변 접수 중: 대기열 배출 시작 (이미 떠 있는 답변은 그대로)
      start() { el.classList.add('active'); running = true; schedule(); },
      push(a) {
        if (!a || typeof a.text !== 'string') return;
        queue.push({ id: a.id, text: a.text, key: a.key });
        if (queue.length > STREAM.MAX_QUEUE) queue.shift();
        schedule();
      },
      stop,
      clear() {
        stop();
        items.forEach((it) => { it.anim.onfinish = null; it.anim.cancel(); });
        items = [];
        laneLast.fill(null);
        el.innerHTML = '';
        el.classList.remove('active');
        el.style.zIndex = '';
      },
      // 마감: 배출을 멈추고 화면의 답변을 모두 넘겨받음
      takeAll() { stop(); return items.slice().map(detach); },
      // 픽된 답변이 지금 화면에 보이는 말풍선인지 — id 우선, 없으면 같은 글 중 가운데에 가장 가까운 것
      find(id, text) {
        const sr = el.getBoundingClientRect();
        const visible = items.filter((it) => {
          const r = it.el.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          return r.width > 0 && cx > sr.left && cx < sr.right;
        });
        const byId = id != null ? visible.find((it) => it.id === id) : null;
        if (byId) return byId;
        const t = normText(text);
        const mx = sr.left + sr.width / 2, my = sr.top + sr.height / 2;
        let best = null, bestD = Infinity;
        visible.forEach((it) => {
          if (it.text !== t) return;
          const r = it.el.getBoundingClientRect();
          const d = Math.hypot(r.left + r.width / 2 - mx, r.top + r.height / 2 - my);
          if (d < bestD) { bestD = d; best = it; }
        });
        return best;
      },
      take: detach,
    };
  }

  // ── 워드클라우드 (시안 7 "추천"): 흐르던 답변이 자기 단어 자리로 모이며 커짐 → 1등 비추기 → 둥실 ──
  const CLOUD = {
    FLY_MS: 1100,      // 답변 하나가 날아가는 시간
    STAGGER: 70,       // 출발 간격(ms)
    SPREAD_MAX: 2800,  // 출발 간격 총합 상한 — 답변이 많아도 모이는 시간이 너무 길어지지 않게
    MAX_FLY: 60,       // 날아가는 말풍선 상한 (나머지 수는 마지막 도착 때 한 번에 반영)
    SPOT_DELAY: 400,   // 다 모인 뒤 1등 비추기까지
    SPOT_MS: 2800,     // 1등 비추는 시간
    TOP_SCALE: 1.25,   // 1등 비추기 배율 (영역 밖으로 나가면 들어가는 만큼만)
    MIN_PX: 26,        // 가장 작은 단어의 읽히는 하한(논리 px, 800/1040 기준) — 한 답이 압도적이어도 1표 단어가 18px로 작아지지 않게
    MIN_PX_LAST: 18,   // 단어가 너무 많아 하한을 지키면 영역에 안 들어갈 때만 여기까지 내림
  };
  // 빈도 비례 18~92px — 지수(^1.6)로 상위 단어가 확실히 크게 (기존 LED 공식)
  const cloudSize = (count, max) => 18 + 74 * Math.pow(max > 1 ? (count - 1) / (max - 1) : 0.5, 1.6);

  // opts: { wrap: 클라우드 영역, stream: createAnswerStream 결과, colors: CLOUD_COLORS, scale: () => --u }
  function createCloud(opts) {
    const wrap = opts.wrap, stream = opts.stream, colors = opts.colors;
    const scale = opts.scale || (() => 1);
    let key = null, data = [];
    let box = null, words = new Map(), max = 1;
    let flights = [], timers = [], raf = null, flying = false;
    let relayoutTimer = null;

    const later = (fn, ms) => timers.push(setTimeout(fn, ms));

    function stopTimers() {
      timers.forEach(clearTimeout); timers = [];
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      flights = [];
    }

    // 영역에 맞춘 글자 배율 — 단어가 많거나 영역이 낮으면(긴 질문) 모든 크기를 같은 비율로 줄인다
    // 큰 단어만 줄어들고 작은 단어는 하한(floor)을 지킴 → 영역이 모자라면 1등 쪽이 먼저 작아진다
    let fit = 1, floor = CLOUD.MIN_PX;
    let lim = null; // 단어가 머물 수 있는 영역(상자 좌표) — 1등 비추기 배율 제한에도 씀
    const sizeOf = (count) => Math.round(Math.max(floor, cloudSize(count, max) * fit) * scale());

    // 두 단어(기울어진 사각형)가 pad 간격 안으로 들어오는지 — 분리축 검사
    function hits(a, b, pad) {
      const axes = [a.rot, a.rot + Math.PI / 2, b.rot, b.rot + Math.PI / 2];
      const dx = b.x - a.x, dy = b.y - a.y;
      const ext = (r, ax) => (r.w / 2 + pad / 2) * Math.abs(Math.cos(ax - r.rot)) + (r.h / 2 + pad / 2) * Math.abs(Math.sin(ax - r.rot));
      return axes.every((ax) => Math.abs(dx * Math.cos(ax) + dy * Math.sin(ax)) < ext(a, ax) + ext(b, ax));
    }

    // 최종 배치를 flex로 한 번 잡아 단어별 중심을 잰 뒤, 그 자리에 절대 위치로 고정한다
    // (단어가 커지는 동안 다른 단어가 밀리지 않게).
    // 영역(질문 카드 아래 ~ 화면 아래)보다 크면 글자 배율을 줄여 다시 잼 — 넘쳐서 카드 뒤로 숨는 단어가 없게
    function build(cloud) {
      wrap.innerHTML = '';
      words = new Map();
      box = document.createElement('div');
      box.className = 'fx-cloud';
      if (!cloud.length) {
        const empty = document.createElement('div');
        empty.className = 'cloud-empty';
        empty.textContent = '접수된 답변이 없습니다';
        box.appendChild(empty);
        wrap.appendChild(box);
        return;
      }
      const u = scale();
      max = cloud[0].count; // 서버가 빈도순 정렬해서 보냄
      // 큰 단어가 한쪽에 몰리지 않게 섞되, 1등은 가운데 쪽
      const rest = cloud.slice(1);
      for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
      rest.splice(Math.floor(rest.length / 2), 0, cloud[0]);
      const recs = rest.map((entry, i) => {
        const s = document.createElement('span');
        s.className = 'fx-cloud-word';
        s.textContent = entry.word;
        s.style.color = colors[i % colors.length]; // 표시 순서대로 팔레트 순환 — 이웃끼리 다른 색
        box.appendChild(s);
        return { el: s, word: entry.key || normText(entry.word), label: entry.word, count: entry.count, shown: 0 }; // word = 묶음 키 (흘러가던 답변과 짝 맞춤), label = 보이는 글
      });
      wrap.appendChild(box);
      // 영역에 들어가는 가장 큰 배율을 이분 탐색 (1이면 그대로, 최소 0.3) — 작은 단어는 하한 26px 유지.
      // 하한을 지키면 배율 0.3으로도 넘칠 때(단어가 아주 많을 때)만 하한을 18px까지 내림
      const cs = getComputedStyle(wrap);
      const availH = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const target = availH * 0.9; // 둥실(±6px)·흩뿌림 여유
      const fitsAt = (f, fl) => {
        fit = f; floor = fl;
        recs.forEach((r) => { r.el.style.fontSize = sizeOf(r.count) + 'px'; });
        return !availH || box.offsetHeight <= target;
      };
      const search = (lo, hi, test) => { for (let k = 0; k < 7; k++) { const mid = (lo + hi) / 2; if (test(mid)) lo = mid; else hi = mid; } return lo; };
      if (!fitsAt(1, CLOUD.MIN_PX)) {
        if (fitsAt(0.3, CLOUD.MIN_PX)) fitsAt(search(0.3, 1, (f) => fitsAt(f, CLOUD.MIN_PX)), CLOUD.MIN_PX);
        else fitsAt(0.3, search(CLOUD.MIN_PX_LAST, CLOUD.MIN_PX, (fl) => fitsAt(0.3, fl)));
      }
      // offset*은 정수로 반올림돼 폭을 그대로 쓰면 줄이 바뀔 수 있어 실제 사각형으로 잰다
      // (영역 팝인 배율이 걸려 있을 수 있어 그 배율로 나눔)
      const bb = box.getBoundingClientRect();
      const k = bb.width / (box.offsetWidth || 1) || 1;
      const m = recs.map((r) => { const q = r.el.getBoundingClientRect(); return { x: (q.left - bb.left + q.width / 2) / k, y: (q.top - bb.top + q.height / 2) / k, w: q.width / k, h: q.height / k }; });
      // 잰 최종 줄바꿈을 고정 — 줄마다 나눠 <br> + nowrap (채팅 핀 들어올리기 splitLines와 같은 방식).
      // 글자가 커지는 도중(크기 전환이 목표를 살짝 넘었다 돌아옴·통통)에 폭이 모자라 줄이 다시 나뉘며
      // 옆 단어를 덮지 않게. 폭은 지정하지 않음(nowrap이라 글자 폭 그대로 → 가운데 기준으로 커짐)
      recs.forEach((r) => {
        const node = r.el.firstChild;
        const lines = node ? splitLines(node) : [];
        if (lines.length > 1) {
          // 줄 사이 원래 공백은 앞 줄 끝에 남김(nowrap 줄 끝 공백은 그려지지 않음) → textContent가 원문 그대로
          const src = node.textContent;
          let pos = 0;
          const parts = [];
          lines.forEach((t) => {
            const at = src.indexOf(t, pos);
            if (at < 0) { parts.push(t); return; }
            if (parts.length && at > pos) parts[parts.length - 1] += src.slice(pos, at);
            parts.push(t);
            pos = at + t.length;
          });
          r.el.textContent = '';
          parts.forEach((t, j) => {
            if (j) r.el.appendChild(document.createElement('br'));
            r.el.appendChild(document.createTextNode(t));
          });
        }
        r.el.style.whiteSpace = 'nowrap';
      });
      // 영역 안쪽 경계(상자 좌표) — 흩뿌린 단어도 영역 밖(질문 카드 쪽)으로 나가지 않게
      lim = { top: -box.offsetTop, bottom: wrap.clientHeight - box.offsetTop, left: -box.offsetLeft, right: wrap.clientWidth - box.offsetLeft };
      box.style.width = box.offsetWidth + 'px';
      box.style.height = box.offsetHeight + 'px';
      box.classList.add('placed');
      // 랜덤 흩뿌림: 위아래로 어긋나게 + 살짝 기울여서 서로 다른 사람의 답변처럼 (1등은 똑바로).
      // 이웃 단어와 겹치면(둥실 6px까지 감안한 간격) 흔들림을 줄여 다시 시도 → 끝내 안 되면 flex 자리 그대로(겹치지 않음).
      // 아직 안 놓인 단어는 flex 자리 기준으로 검사하므로, 언제나 서로 겹치지 않는 상태가 유지된다
      const pad = 8 * u;
      const placed = m.map((q) => ({ x: q.x, y: q.y, w: q.w, h: q.h, rot: 0 }));
      const inside = (c) => {
        const ex = (c.w / 2) * Math.abs(Math.cos(c.rot)) + (c.h / 2) * Math.abs(Math.sin(c.rot));
        const ey = (c.w / 2) * Math.abs(Math.sin(c.rot)) + (c.h / 2) * Math.abs(Math.cos(c.rot));
        return c.x - ex >= lim.left && c.x + ex <= lim.right && c.y - ey >= lim.top + 6 * u && c.y + ey <= lim.bottom;
      };
      const TRIES = 10;
      recs.forEach((r, i) => {
        const isFirst = r.word === (cloud[0].key || normText(cloud[0].word));
        let cand = placed[i];
        if (!isFirst) {
          for (let t = 0; t < TRIES; t++) {
            const f = 1 - t / TRIES; // 시도할수록 흔들림을 줄임
            const c = {
              x: m[i].x + Math.round(Math.random() * 20 - 10) * u * f,
              y: m[i].y + Math.round(Math.random() * 30 - 15) * u * f,
              w: m[i].w, h: m[i].h,
              rot: (Math.random() * 8 - 4) * f * Math.PI / 180,
            };
            if (inside(c) && placed.every((o, j) => j === i || !hits(c, o, pad))) { cand = c; break; }
          }
        }
        placed[i] = cand;
        r.cx = cand.x;
        r.cy = cand.y;
        r.h = m[i].h;
        r.w = m[i].w;
        r.el.style.left = r.cx + 'px';
        r.el.style.top = r.cy + 'px';
        r.el.style.setProperty('--rot', (cand.rot * 180 / Math.PI).toFixed(1) + 'deg');
        if (!words.has(r.word)) words.set(r.word, r);
      });
      // 도착 때 부푸는 배율(팝인 1.05·통통 1.18)을 단어마다 여유만큼으로 제한 — 최종 크기에서 그 배율로 커져도
      // 이웃 단어(최종 크기)와 닿지 않고 영역 밖으로 나가지 않는 가장 큰 값 (여유가 없으면 1 = 부풀지 않음)
      // 이웃도 동시에 부풀 수 있으므로 두 단어를 같은 배율로 함께 키워 봄 → 단어 배율 = 이웃마다 구한 한계 중 최솟값
      // (두 단어가 각자 자기 한계 이하로만 커지면 서로 닿지 않음)
      const grow = (q, sc) => Object.assign({}, q, { w: q.w * sc, h: q.h * sc });
      const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < (Math.hypot(a.w, a.h) + Math.hypot(b.w, b.h)) * 0.6 + 8 * u;
      const limitBy = (ok) => { let lo = 1, hi = 1.18; if (ok(hi)) return hi; for (let t = 0; t < 8; t++) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid; } return lo; };
      recs.forEach((r, i) => {
        let lim1 = limitBy((sc) => inside(grow(placed[i], sc)));
        placed.forEach((o, j) => {
          if (j === i || !near(placed[i], o)) return;
          lim1 = Math.min(lim1, limitBy((sc) => !hits(grow(placed[i], sc), grow(o, sc), 0)));
        });
        r.el.style.setProperty('--bump', lim1.toFixed(3)); // 통통(ease, 넘침 없음)의 꼭짓점
        // 팝인은 공용 popIn 곡선(cubic-bezier 0.34,1.56…)이라 0.4→꼭짓점 구간에서 약 10% 더 넘침 — 넘친 값이 한계 안에 들게
        r.el.style.setProperty('--pop', Math.min(1.05, (lim1 + 0.04) / 1.1).toFixed(3));
      });
    }

    function setShown(r, n) {
      r.shown = n;
      r.el.style.fontSize = sizeOf(n) + 'px';
    }

    function startBob() {
      if (prefersReduced()) return;
      words.forEach((r) => {
        r.el.classList.remove('pop', 'bump');
        const d = 4 + Math.random() * 3; // 4~7초 주기, 단어마다 다른 위상
        r.el.style.setProperty('--bd', d.toFixed(2) + 's');
        r.el.style.setProperty('--bdl', (-Math.random() * d).toFixed(2) + 's');
        r.el.classList.add('bob');
      });
    }

    // 1등 비추기: 나머지는 흐리게, 1등(동률이면 모두)은 1.25배 + "N명이 같은 답"
    function spotlightTop(done) {
      const tops = [...words.values()].filter((r) => r.count === max);
      if (max <= 1 || !tops.length) { done(); return; } // 전부 1명씩이면 생략
      const pills = [];
      words.forEach((r) => {
        r.el.classList.remove('pop', 'bump');
        if (r.count !== max) r.el.classList.add('dim');
      });
      // 1등 배율은 키운 단어와 "N명이 같은 답"이 영역 안에 머무는 만큼만 (긴 1등 단어가 화면 밖으로 나가지 않게, 들어가면 1.25 그대로)
      const u = scale();
      const m = 8 * u; // 화면 끝·둥실(6px) 여유
      const gap = 4 * u;
      tops.forEach((r) => {
        const p = document.createElement('div');
        p.className = 'fx-cloud-count';
        p.textContent = tops.length > 1 ? `공동 1위 · ${max}명` : `${max}명이 같은 답`; // 동률이면 모두 비추고 "공동 1위"(알약이 길어져 이웃 단어를 덜 가리게 짧게)
        box.appendChild(p);
        const pw = p.offsetWidth, ph = p.offsetHeight;
        const L = lim || { top: 0, left: 0, right: box.offsetWidth, bottom: box.offsetHeight };
        const half = Math.min(r.cx - L.left, L.right - r.cx) - m; // 가로로 쓸 수 있는 반폭
        let sc = Math.min(CLOUD.TOP_SCALE, (2 * half) / (r.w || 1), (r.cy - L.top - m) / (r.h / 2));
        // 알약은 단어 아래 — 아래 자리가 모자라면 배율을 더 줄이고, 그래도 안 되면 단어 위에
        const below = (L.bottom - m - ph - gap - r.cy) / (r.h / 2);
        let pillTop;
        if (below >= 1) { sc = Math.min(sc, below); pillTop = r.cy + sc * r.h / 2 + gap; }
        else { sc = Math.min(sc, (r.cy - L.top - m - ph - gap) / (r.h / 2)); pillTop = r.cy - Math.max(1, sc) * r.h / 2 - gap - ph; }
        sc = Math.max(1, sc); // 처음 자리(배율 1)는 이미 영역 안
        r.el.style.setProperty('--s', sc.toFixed(3));
        p.style.left = Math.min(L.right - m - pw / 2, Math.max(L.left + m + pw / 2, r.cx)) + 'px';
        p.style.top = pillTop + 'px';
        pills.push(p);
      });
      requestAnimationFrame(() => requestAnimationFrame(() => pills.forEach((p) => p.classList.add('on'))));
      later(() => {
        // 1등이 제 크기로 돌아온 뒤(배율 전환 0.8초)에 나머지를 다시 밝힘 — 아직 큰 1등이 이웃과 겹쳐 보이지 않게
        words.forEach((r) => r.el.style.setProperty('--s', '1'));
        pills.forEach((p) => p.classList.remove('on'));
        later(() => pills.forEach((p) => p.remove()), 600);
        later(() => { words.forEach((r) => r.el.classList.remove('dim')); done(); }, 800);
      }, CLOUD.SPOT_MS);
    }

    // 도착: 처음이면 팝인으로 등장, 이후엔 한 단계씩 커지며 통통 (마지막 도착이면 최종 크기로)
    function arrive(r, last) {
      const first = r.shown === 0;
      setShown(r, last ? r.count : Math.min(r.count, r.shown + 1));
      r.el.classList.remove('pop', 'bump');
      void r.el.offsetWidth; // 연속 도착 시 애니메이션 재시작
      r.el.classList.add('in', first ? 'pop' : 'bump');
    }

    function frame(now) {
      const u = scale();
      flights.forEach((f) => {
        if (f.done || now < f.t0) return;
        const p = Math.min(1, (now - f.t0) / CLOUD.FLY_MS);
        const e = 1 - Math.pow(1 - p, 3);
        if (f.el) {
          const x = f.sx + (f.tx - f.sx) * e;
          const y = f.sy + (f.ty - f.sy) * e - Math.sin(p * Math.PI) * 40 * u; // 살짝 포물선
          f.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${1 - 0.5 * e})`;
          f.el.style.opacity = String(1 - Math.max(0, (p - 0.6) / 0.4));
        }
        if (p >= 1) {
          f.done = true;
          if (f.el) f.el.remove();
          arrive(f.word, f.last);
        }
      });
      if (flights.every((f) => f.done)) { raf = null; landed(); return; }
      raf = requestAnimationFrame(frame);
    }

    function finalState(bob) {
      words.forEach((r) => { setShown(r, r.count); r.el.classList.add('in'); });
      if (bob) startBob();
    }

    // 실시간 마감: 흐르던 답변 → 자기 단어로 / 모자란 수는 오른쪽에서 빠르게 들어옴
    function fly() {
      const taken = stream.takeAll();
      const sr = stream.el.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      // 단어 중심(클라우드 영역) → 흘려보내기 레이어 좌표
      const target = (r) => ({ x: br.left - sr.left + r.cx, y: br.top - sr.top + r.cy });
      const planned = new Map();
      const n = (r) => planned.get(r) || 0;
      const plan = [];
      const fade = (el) => {
        el.style.transition = 'opacity 0.5s ease';
        el.style.opacity = '0';
        later(() => el.remove(), 550);
      };
      taken.sort((a, b) => a.x - b.x).forEach((t) => {
        const r = words.get(t.key || t.text);
        if (r && n(r) < r.count && plan.length < CLOUD.MAX_FLY) { plan.push({ src: t, word: r }); planned.set(r, n(r) + 1); }
        else fade(t.el); // 상위 40개 밖이거나 상한 초과 → 그냥 사라짐 (수는 도착 때 반영)
      });
      // 남은 수: 아직 한 번도 안 온 단어부터, 이후엔 돌아가며 하나씩 — 날아가는 말풍선은 상한까지만
      const list = [...words.values()];
      const extra = [];
      const give = (r) => { extra.push({ src: null, word: r }); planned.set(r, n(r) + 1); };
      list.forEach((r) => { if (plan.length + extra.length < CLOUD.MAX_FLY && n(r) === 0 && r.count > 0) give(r); });
      let more = true;
      while (more && plan.length + extra.length < CLOUD.MAX_FLY) {
        more = false;
        for (const r of list) {
          if (plan.length + extra.length >= CLOUD.MAX_FLY) break;
          if (n(r) < r.count) { give(r); more = true; }
        }
      }
      for (let i = extra.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [extra[i], extra[j]] = [extra[j], extra[i]]; }
      // 상한 때문에 하나도 못 받은 단어는 말풍선 없이 제자리에서 등장
      const silent = list.filter((r) => n(r) === 0).map((r) => ({ src: null, word: r, silent: true }));
      const all = plan.concat(extra, silent);
      const lastIdx = new Map();
      all.forEach((p, i) => lastIdx.set(p.word, i));

      const stagger = Math.min(CLOUD.STAGGER, CLOUD.SPREAD_MAX / Math.max(1, all.length));
      const now = performance.now();
      const u = scale();
      const sw = stream.el.clientWidth;
      stream.el.style.zIndex = '2'; // 모이는 말풍선이 클라우드 위로 지나가게
      // 단어는 첫 도착 크기에서 시작 (최종 크기에서 줄어드는 전환이 보이지 않게 전환 없이)
      words.forEach((r) => {
        r.el.style.transition = 'none';
        setShown(r, 1);
        r.shown = 0;
        void r.el.offsetWidth;
        r.el.style.transition = '';
      });
      flights = all.map((p, k) => {
        const t = target(p.word);
        const f = { word: p.word, last: lastIdx.get(p.word) === k, t0: now + k * stagger, tx: t.x, ty: t.y, el: null };
        if (p.src) {
          f.el = p.src.el;
          f.sx = p.src.x + p.src.w / 2; f.sy = p.src.y + p.src.h / 2;
          Object.assign(f.el.style, { left: '0px', top: '0px', transform: `translate(${f.sx}px, ${f.sy}px) translate(-50%, -50%)` });
        } else if (!p.silent) {
          // 아직 접수 중이던 답변: 출발 시각에 오른쪽 끝 밖에서 만들어져 들어옴
          f.t0 = Infinity;
          later(() => {
            const el = stream.makeBubble(p.word.label);
            const top = el.offsetTop, w = el.offsetWidth, h = el.offsetHeight;
            f.sx = sw + w / 2 + (k % 6) * 40 * u; f.sy = top + h / 2;
            Object.assign(el.style, { left: '0px', top: '0px', transform: `translate(${f.sx}px, ${f.sy}px) translate(-50%, -50%)` });
            f.el = el;
            f.t0 = performance.now();
          }, k * stagger);
        }
        return f;
      });
      raf = requestAnimationFrame(frame);
    }

    // 모두 도착 → 흘려보내기 정리 → 1등 비추기 → 둥실
    function landed() {
      flying = false;
      stream.clear();
      later(() => spotlightTop(startBob), CLOUD.SPOT_DELAY);
    }

    function clear() {
      stopTimers();
      if (flying) stream.clear();
      flying = false;
      key = null;
      data = [];
      box = null;
      words = new Map();
      wrap.innerHTML = '';
      wrap.classList.remove('active');
      wrap.style.animation = '';
    }

    // cloud: 서버의 상위 40개(빈도 내림차순). live: 접수 중 화면에서 실시간으로 마감된 경우만 true
    function show(cloud, o) {
      if (relayoutTimer) { clearTimeout(relayoutTimer); relayoutTimer = null; } // 새 결과가 오면 대기 중인 재배치는 버림
      cloud = Array.isArray(cloud) ? cloud : [];
      const k = JSON.stringify(cloud);
      if (k === key && wrap.classList.contains('active')) return; // 같은 결과 재전송 — 진행 중 연출 유지
      const live = !!(o && o.live) && !prefersReduced();
      clear();
      key = k; data = cloud;
      wrap.classList.add('active');
      if (live) wrap.style.animation = 'none'; // 자리 계산이 팝인 배율에 흔들리지 않게 (등장은 단어별로)
      build(cloud);
      if (!live || !words.size) {
        stream.clear();
        finalState(true);
        return;
      }
      flying = true;
      fly();
    }

    return {
      show,
      clear,
      // 창 크기가 바뀌면 자리 계산이 어긋나므로 최종 모습으로 다시 배치.
      // 창 크기를 바꾸는 동안 resize가 연달아 오므로 멈춘 뒤 150ms에 한 번만 (매번 섞이며 깜빡이지 않게)
      relayout() {
        if (relayoutTimer) clearTimeout(relayoutTimer);
        relayoutTimer = setTimeout(() => {
          relayoutTimer = null;
          if (key === null) return;
          const cloud = data;
          clear();
          show(cloud, { live: false });
        }, 150);
      },
      isActive: () => key !== null,
    };
  }

  // ══════════════════════════════════
  //  들어올리기 (시안 8 채팅 핀 · 시안 10 제작진 픽 공용)
  //  화면의 말풍선이 제자리에서 카드 색으로 물든 뒤(0~24%), 한 번의 미끄러짐으로
  //  상자는 최종 카드 자리·크기로, 글자는 카드의 줄바꿈 그대로 커지며 제자리로 → 똑같은 카드로 바꿔 끼움
  // ══════════════════════════════════
  const LIFT = {
    MS: 1450,
    TINT: 0.24,       // 제자리에서 물드는 구간(전체 대비)
    OUT_MS: 500,      // 교체: 기존 카드가 위로 빠짐
    HIDE_MS: 700,     // 해제: 작아지며 사라짐
    POP_COVER_MS: 400,
  };
  const TINT_EASE = 'cubic-bezier(.4,0,.2,1)';
  const GLIDE_EASE = 'cubic-bezier(.22,.75,.25,1)';

  // el 안의 글자 노드(공백뿐인 것 제외) — 문서 순서
  function textNodes(el) {
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent.trim()) out.push(n);
    return out;
  }

  // 글자 노드의 화면상 사각형 (줄이 여럿이면 전체를 감싸는 사각형)
  function inkRect(node) {
    const r = document.createRange();
    r.selectNodeContents(node);
    return r.getBoundingClientRect();
  }

  // 글자 노드를 지금 화면에 보이는 줄 단위 문자열로 나눈다 (글자마다 위치를 재서 줄이 바뀌는 곳을 찾음)
  function splitLines(node) {
    const s = node.textContent;
    const r = document.createRange();
    const lines = [];
    let start = 0, top = null;
    for (let i = 0; i < s.length;) {
      const len = s.codePointAt(i) > 0xffff ? 2 : 1; // 이모지(서로게이트 쌍)는 한 글자로
      if (s[i].trim()) {
        r.setStart(node, i);
        r.setEnd(node, i + len);
        const q = r.getClientRects()[0];
        if (q) {
          if (top === null) top = q.top;
          else if (q.top - top > q.height * 0.5) { lines.push(s.slice(start, i)); start = i; top = q.top; }
        }
      }
      i += len;
    }
    lines.push(s.slice(start));
    return lines.map((t) => t.trim()).filter(Boolean);
  }

  function stripIds(el) {
    el.removeAttribute('id');
    el.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
  }

  // opts: { layer: 카드 레이어(가운데 정렬 flex, .active로 표시), scale: () => --u,
  //         coverAt: 가림막이 깔리기 시작하는 시점(전체 대비), coverMs: 가림막 페이드 시간, popClass }
  // 카드는 show마다 새 요소로 받는다 (교체할 때 이전 카드와 함께 보이므로)
  function createLift(opts) {
    const layer = opts.layer;
    const scale = opts.scale || (() => 1);
    const coverAt = opts.coverAt != null ? opts.coverAt : 0.25;
    const coverMs = opts.coverMs || LIFT.MS * (1 - coverAt);
    const popClass = opts.popClass || 'pop';
    let cover = null, card = null, src = null, lift = null, offTimer = null;

    function fadeCover(to, ms, delay) {
      if (!cover) {
        cover = document.createElement('div');
        cover.className = 'fx-lift-cover';
        layer.prepend(cover);
      }
      // clear()가 cover를 비운 뒤 끝나도 오류 나지 않게 이 요소를 붙잡아 둔다
      const el = cover;
      const from = getComputedStyle(el).opacity;
      el.getAnimations().forEach((a) => a.cancel());
      el.style.opacity = from;
      const a = el.animate([{ opacity: from }, { opacity: to }], { duration: ms, delay: delay || 0, fill: 'forwards', easing: 'ease' });
      a.onfinish = () => { el.style.opacity = String(to); a.cancel(); };
    }

    // 화면 말풍선을 원래대로 (교체·해제·정리 때)
    function releaseSrc() {
      if (src && src.release) src.release();
      src = null;
    }

    // 사라지는 카드는 지금 자리에 고정해 흐름에서 뺀다 (새 카드가 가운데 자리를 바로 차지하도록)
    function pinInPlace(c) {
      const lr = layer.getBoundingClientRect();
      const r = c.getBoundingClientRect();
      c.classList.remove(popClass);
      c.removeAttribute('id');
      Object.assign(c.style, { position: 'absolute', left: (r.left - lr.left) + 'px', top: (r.top - lr.top) + 'px', width: r.width + 'px', margin: '0' });
    }

    function releaseUp(c) {
      pinInPlace(c);
      if (prefersReduced()) { c.remove(); return; }
      c.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${-60 * scale()}px)` }],
        { duration: LIFT.OUT_MS, fill: 'forwards', easing: TINT_EASE }).onfinish = () => c.remove();
    }

    // 말풍선(s.el) → 카드(c). 레이아웃은 모두 처음에 한 번 재고, 움직이는 동안엔 transform·상자 크기만 바뀐다.
    //  - 상자: 말풍선 자리 → (물들며) 카드 글자를 담을 만큼 → 카드 자리·크기·모서리·그림자
    //  - 물드는 동안 글자: 원래 말풍선 줄바꿈 그대로 고정, 색·굵기만 카드 값으로
    //  - 미끄러지는 동안 글자: 최종 카드와 똑같이 줄바꿈된 복제본을 말풍선 글자 크기로 줄여 원래 글자 자리에 맞춘 뒤
    //    배율 1·제자리(=카드 글자 위치)로 → 끝에서 카드와 픽셀 단위로 같다
    function morph(s, c) {
      const lr = layer.getBoundingClientRect();
      const L = (r) => ({ left: r.left - lr.left, top: r.top - lr.top, right: r.right - lr.left, bottom: r.bottom - lr.top, width: r.width, height: r.height });
      const se = s.el;
      const sNodes = textNodes(se);
      c.style.opacity = '0'; // 최종 카드: 숨긴 채 자리 잡기
      const cNodes = textNodes(c);
      if (!sNodes.length || !cNodes.length) return null;
      const sr = L(s.rect || se.getBoundingClientRect());
      const scs = getComputedStyle(se);
      const ccs = getComputedStyle(c);
      const cr = L(c.getBoundingClientRect());

      // 줄 단위 짝: 끝(본문)부터 맞춤 — 말풍선 [닉네임, 본문] ↔ 카드 [닉네임, 본문]
      const leafOf = (n) => n.parentElement;
      const pairs = cNodes.map((cn, j) => {
        const i = Math.max(0, sNodes.length - cNodes.length + j);
        return { si: i, cn, sn: sNodes[i] };
      });

      // 물드는 동안의 글자: 말풍선 복제본, 지금 보이는 줄바꿈대로 줄마다 고정 (굵어져도 줄이 다시 나뉘지 않음)
      const from = se.cloneNode(true);
      stripIds(from);
      const fNodes = textNodes(from);
      const fLeaves = fNodes.map(leafOf);
      sNodes.forEach((n, i) => {
        const frag = document.createDocumentFragment();
        splitLines(n).forEach((t, k) => {
          if (k) frag.appendChild(document.createElement('br'));
          frag.appendChild(document.createTextNode(t));
        });
        fNodes[i].replaceWith(frag);
      });
      from.classList.add('fx-lift-from');
      Object.assign(from.style, {
        position: 'absolute', left: sr.left + 'px', top: sr.top + 'px', right: 'auto', bottom: 'auto', margin: '0',
        width: 'auto', height: 'auto', maxWidth: 'none', transform: 'none', animation: 'none', transition: 'none',
        background: 'transparent', boxShadow: 'none', whiteSpace: 'nowrap', opacity: '1', visibility: 'visible',
      });

      // 미끄러지는 동안의 글자: 최종 카드 복제본 (같은 폭·같은 글꼴 → 같은 줄바꿈)
      const to = c.cloneNode(true);
      stripIds(to);
      to.classList.remove(popClass);
      to.classList.add('fx-lift-to');
      Object.assign(to.style, {
        position: 'absolute', left: cr.left + 'px', top: cr.top + 'px', width: cr.width + 'px', height: cr.height + 'px',
        margin: '0', maxWidth: 'none', background: 'transparent', boxShadow: 'none', animation: 'none', transform: 'none', opacity: '0',
      });
      const tNodes = textNodes(to);

      const box = document.createElement('div');
      box.className = 'fx-lift-box';
      layer.append(box, from, to);

      // 물든 뒤(카드 굵기) 말풍선 글자가 차지하는 폭 — 상자를 그만큼 넓혀 둠
      const tintMap = new Map();
      pairs.forEach((p) => { if (!tintMap.has(fLeaves[p.si])) tintMap.set(fLeaves[p.si], getComputedStyle(leafOf(p.cn))); });
      const tint = [...tintMap].map(([el, cs]) => ({ el, cs }));
      const w0 = tint.map((t) => t.el.style.fontWeight);
      tint.forEach((t) => { t.el.style.fontWeight = t.cs.fontWeight; });
      let boldRight = sr.left;
      textNodes(from).forEach((n) => { boldRight = Math.max(boldRight, L(inkRect(n)).right); });
      tint.forEach((t, k) => { t.el.style.fontWeight = w0[k]; });

      // 카드 글자 줄마다: 말풍선 글자 크기로 줄여 원래 글자 왼쪽 위에 맞추는 transform
      const padR = parseFloat(scs.paddingRight) || 0, padB = parseFloat(scs.paddingBottom) || 0;
      let right = Math.max(sr.right, boldRight + padR), bottom = sr.bottom;
      const moves = pairs.map((p, j) => {
        const leaf = leafOf(p.cn);
        const k = parseFloat(getComputedStyle(leafOf(p.sn)).fontSize) / parseFloat(getComputedStyle(leaf).fontSize) || 1;
        const o = L(leaf.getBoundingClientRect()); // transform 기준점(줄 상자 왼쪽 위)
        const ci = L(inkRect(p.cn));
        const si = L(inkRect(p.sn));
        const dx = si.left - o.left - k * (ci.left - o.left);
        const dy = si.top - o.top - k * (ci.top - o.top);
        right = Math.max(right, si.left + ci.width * k + padR);
        bottom = Math.max(bottom, si.top + ci.height * k + padB);
        const el = leafOf(tNodes[j]);
        el.style.transformOrigin = '0 0';
        return { el, t0: `translate(${dx}px, ${dy}px) scale(${k})` };
      });

      const r0 = parseFloat(scs.borderTopLeftRadius) || 0;
      const rect = (r, rad) => ({ left: r.left + 'px', top: r.top + 'px', width: (r.right - r.left) + 'px', height: (r.bottom - r.top) + 'px', borderRadius: rad });
      const mid = { left: sr.left, top: sr.top, right, bottom };
      const T = LIFT.TINT;
      const o = { duration: LIFT.MS, easing: 'linear', fill: 'forwards' };
      const anims = [];
      const boxA = box.animate([
        { ...rect(sr, Math.min(r0, sr.height / 2) + 'px'), backgroundColor: scs.backgroundColor, boxShadow: scs.boxShadow, easing: TINT_EASE },
        { ...rect(mid, Math.min(r0, (bottom - sr.top) / 2) + 'px'), backgroundColor: ccs.backgroundColor, boxShadow: scs.boxShadow, offset: T, easing: GLIDE_EASE },
        { ...rect(cr, ccs.borderTopLeftRadius), backgroundColor: ccs.backgroundColor, boxShadow: ccs.boxShadow },
      ], o);
      anims.push(boxA);
      // 물들기: 글자색·굵기를 카드 값으로 (줄은 고정돼 있어 다시 나뉘지 않음)
      tint.forEach((t) => {
        const cs0 = getComputedStyle(t.el);
        anims.push(t.el.animate([
          { color: cs0.color, fontWeight: cs0.fontWeight, easing: TINT_EASE },
          { color: t.cs.color, fontWeight: t.cs.fontWeight, offset: T },
          { color: t.cs.color, fontWeight: t.cs.fontWeight },
        ], o));
      });
      // 물들기가 끝나는 순간 카드 줄바꿈의 글자로 바꿔 끼움 (상자가 움직이기 시작하는 바로 그 순간, 겹침·페이드 없음)
      anims.push(from.animate([{ opacity: 1 }, { opacity: 1, offset: T }, { opacity: 0, offset: T }, { opacity: 0 }], o));
      anims.push(to.animate([{ opacity: 0 }, { opacity: 0, offset: T }, { opacity: 1, offset: T }, { opacity: 1 }], o));
      moves.forEach((m) => {
        anims.push(m.el.animate([
          { transform: m.t0 },
          { transform: m.t0, offset: T, easing: GLIDE_EASE },
          { transform: 'translate(0px, 0px) scale(1)' },
        ], o));
      });
      fadeCover(1, coverMs, LIFT.MS * coverAt);

      const l = { done: false };
      const swap = () => {
        if (l.done) return;
        l.done = true;
        c.style.opacity = ''; // 다 커진 순간 모양이 똑같은 카드로 바꿔 끼움
        anims.forEach((a) => a.cancel());
        box.remove(); from.remove(); to.remove();
        if (lift === l) lift = null;
      };
      boxA.onfinish = swap;
      // 들어올리는 중에 다음 핀·해제가 오면 그 자리에서 바로 카드 상태로 (onfinish는 비동기라 직접 바꿈)
      l.finish = () => { boxA.onfinish = null; swap(); };
      return l;
    }

    function popIn(c) {
      if (!prefersReduced()) c.classList.add(popClass);
      fadeCover(1, prefersReduced() ? 1 : LIFT.POP_COVER_MS, 0);
    }

    function hide() {
      if (lift) lift.finish();
      releaseSrc();
      const c = card;
      card = null;
      if (!c) return;
      const reduce = prefersReduced();
      if (reduce) c.remove();
      else {
        pinInPlace(c);
        c.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.94)' }],
          { duration: LIFT.HIDE_MS, fill: 'forwards', easing: TINT_EASE }).onfinish = () => c.remove();
      }
      fadeCover(0, reduce ? 1 : LIFT.HIDE_MS, 0);
      if (offTimer) clearTimeout(offTimer);
      offTimer = setTimeout(() => { offTimer = null; if (!card) layer.classList.remove('active'); }, reduce ? 0 : LIFT.HIDE_MS + 50);
    }

    return {
      // c: 새 카드 요소(아직 레이어 밖), s: { el: 화면 말풍선, rect?, hide?(), release?() } 또는 null(팝인)
      show(c, s) {
        if (offTimer) { clearTimeout(offTimer); offTimer = null; }
        if (lift) lift.finish(); // 들어올리던 중이면 바로 카드 상태로
        if (card) releaseUp(card); // 교체: 기존 카드는 위로 빠지며 사라짐
        releaseSrc();
        layer.classList.add('active');
        layer.appendChild(c);
        card = c;
        const l = s && !prefersReduced() ? morph(s, c) : null;
        if (l) {
          lift = l;
          src = s;
          if (s.hide) s.hide();
        } else {
          c.style.opacity = '';
          popIn(c);
        }
        return !!l;
      },
      hide,
      // 즉시 정리 (모드 전환) — 진행 중인 애니메이션과 만든 요소를 모두 걷어냄
      clear() {
        if (offTimer) { clearTimeout(offTimer); offTimer = null; }
        if (lift) lift.finish();
        releaseSrc();
        if (cover) cover.getAnimations().forEach((a) => a.cancel());
        lift = null;
        card = null;
        cover = null;
        layer.innerHTML = '';
        layer.classList.remove('active');
      },
      // 창 크기가 바뀌면 진행 중인 들어올리기를 바로 카드 상태로 (잰 좌표가 어긋나므로)
      settle() { if (lift) lift.finish(); },
      current: () => card,
    };
  }

  // ── 제작진 픽 스포트라이트 (시안 10): 흐르던 답변이 남색으로 물든 뒤 가운데 카드로 늘어남 ──
  const PICK = {
    COVER_AT: 0.25,  // 배경 가림막이 깔리기 시작하는 시점
  };

  // opts: { layer: 스포트라이트 레이어(가운데 정렬 flex), cardClass, stream, duration, scale }
  function createPickSpotlight(opts) {
    const stream = opts.stream;
    const cardClass = opts.cardClass || 'spotlight-card';
    const duration = opts.duration || 8000;
    const lift = createLift({ layer: opts.layer, scale: opts.scale, coverAt: PICK.COVER_AT });
    let hideTimer = null;

    function hide() {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      lift.hide();
    }

    return {
      // data: answerPicked { id, text }
      pick(data) {
        if (!data || typeof data.text !== 'string') return;
        lift.settle(); // 들어올리던 중이면 먼저 카드 상태로 (흐르던 답변을 새로 찾기 전에)
        const c = document.createElement('div');
        c.className = cardClass;
        c.textContent = data.text;
        const it = !prefersReduced() && stream ? stream.find(data.id, data.text) : null;
        const b = it ? stream.take(it) : null;
        lift.show(c, b ? { el: b.el, rect: b.rect } : null);
        if (b) b.el.remove(); // 흐르던 말풍선은 복제본이 이어받았으므로 치움
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, duration);
      },
      hide,
      clear() {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        lift.clear();
      },
      settle: lift.settle,
    };
  }

  // ── 채팅 핀 (시안 8): 채팅 흐름의 말풍선이 핀 카드 색(세로형 주황·가로형 흰색)으로 물든 뒤 가운데 카드로 떠오름 ──
  const PIN = {
    COVER_AT: 0.28,  // 배경(반투명 블러시)이 깔리기 시작하는 시점
    COVER_MS: 700,
  };

  // opts: { layer: #chat-pin, feed: 채팅 목록(보이는 영역), findBubble(id) → 말풍선 요소|null,
  //         canLift() → 지금 말풍선에서 들어올려도 되는지(일시정지면 false),
  //         cardClass, nickClass, textClass, scale }
  function createChatPin(opts) {
    const lift = createLift({ layer: opts.layer, scale: opts.scale, coverAt: PIN.COVER_AT, coverMs: PIN.COVER_MS });
    let key = null; // 지금 보이는 핀 (같은 핀이 다시 오면 그대로 둠)
    let lifted = null; // 들어올려 자리를 비워 둔 말풍선 { id, el } — 채팅을 다시 그리면 새 요소로 옮겨 숨김

    function makeCard(m) {
      const c = document.createElement('div');
      c.className = opts.cardClass;
      const nick = document.createElement('div');
      nick.className = opts.nickClass;
      nick.textContent = m.nickname || '';
      const text = document.createElement('div');
      text.className = opts.textClass;
      text.textContent = m.text || '';
      c.append(nick, text);
      return c;
    }

    // 말풍선이 채팅 영역 안에 통째로 보일 때만 (스크롤로 잘렸거나 일시정지면 팝인)
    function visibleBubble(id) {
      if (id == null || (opts.canLift && !opts.canLift())) return null;
      const el = opts.findBubble(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const v = opts.feed.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= v.top && r.bottom <= v.bottom && r.left >= v.left && r.right <= v.right ? el : null;
    }

    function hide() {
      key = null;
      lift.hide();
    }

    return {
      // message: { id, nickname, text } | null. live: 관리자가 방금 고정함(chatPinned) — 말풍선이 보이면 들어올림.
      // 접속·채팅 복귀 때 받는 상태(live=false)는 팝인.
      show(message, live) {
        if (!message) { if (key !== null || lift.current()) hide(); return; }
        const k = JSON.stringify([message.id, message.nickname, message.text]);
        if (k === key && lift.current()) return; // 같은 핀 재전송 — 진행 중 연출 유지
        key = k;
        const el = live ? visibleBubble(message.id) : null;
        lift.show(makeCard(message), el ? {
          el,
          // 떠오른 말풍선 자리는 비워 둠 (시안처럼)
          hide: () => { lifted = { id: message.id, el }; el.style.visibility = 'hidden'; },
          // 교체·해제되면 다시 보임 (그사이 다시 그려졌으면 지금 요소 기준)
          release: () => { if (lifted) lifted.el.style.visibility = ''; lifted = null; },
        } : null);
      },
      hide,
      clear() { key = null; lift.clear(); },
      settle: lift.settle,
      // 채팅 목록을 다시 그린 뒤(일시정지 해제·재접속 history) 호출 — 핀으로 떠오른 말풍선이 새로 그려져 다시 보이지 않게
      reconcile() {
        if (!lifted) return;
        const el = opts.findBubble(lifted.id);
        if (!el || el === lifted.el) return;
        lifted.el.style.visibility = '';
        el.style.visibility = 'hidden';
        lifted.el = el;
      },
    };
  }

  // ── 운영진 공지 핀 ── 관리자가 운영진 채팅을 핀하면 화면 맨 위 띠로 고정 (일반 채팅 핀과 별개, 함께 떠 있을 수 있음)
  // layer: .fx-notice 요소. show(message|null) — 같은 공지가 다시 오면 그대로 둔다.
  const NOTICE_OUT_MS = 400;
  function createNotice(layer) {
    let key = null;
    let outTimer = null;
    return {
      show(message) {
        const k = message ? JSON.stringify([message.id, message.nickname, message.text]) : null;
        if (k === key) return;
        key = k;
        clearTimeout(outTimer);
        if (!message) {
          if (!layer.classList.contains('on')) return;
          layer.classList.remove('on');
          layer.classList.add('leaving');
          outTimer = setTimeout(() => { layer.classList.remove('leaving'); layer.textContent = ''; }, prefersReduced() ? 0 : NOTICE_OUT_MS);
          return;
        }
        layer.textContent = '';
        const icon = document.createElement('span');
        icon.className = 'fx-notice-icon';
        icon.textContent = '📢';
        icon.setAttribute('aria-hidden', 'true');
        const body = document.createElement('div');
        body.className = 'fx-notice-body';
        const nick = document.createElement('div');
        nick.className = 'fx-notice-nick';
        nick.textContent = message.nickname || '';
        const text = document.createElement('div');
        text.className = 'fx-notice-text';
        text.textContent = message.text || '';
        body.append(nick, text);
        layer.append(icon, body);
        layer.classList.remove('on', 'leaving');
        void layer.offsetWidth; // 교체 때도 팝인 재시작
        layer.classList.add('on');
      },
    };
  }

  // ══════════════════════════════════
  //  대기 화면 (시안 11) · 엔딩 "오늘의 결과" (시안 12) · 함성 미터 (시안 5)
  // ══════════════════════════════════

  // 레이어 공용 표시/숨김: 서서히 나타나고 사라진 뒤 display를 끈다 (.active = 표시, .on = 불투명)
  const LAYER_FADE_MS = 600;
  function fadeLayer(layer, on) {
    if (layer._fxOff) { clearTimeout(layer._fxOff); layer._fxOff = null; }
    if (on) {
      if (layer.classList.contains('on')) return;
      layer.classList.add('active');
      void layer.offsetWidth; // display가 켜진 뒤 전환이 시작되도록
      layer.classList.add('on');
      return;
    }
    if (!layer.classList.contains('active')) return;
    layer.classList.remove('on');
    layer._fxOff = setTimeout(() => { layer._fxOff = null; layer.classList.remove('active'); }, prefersReduced() ? 0 : LAYER_FADE_MS);
  }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // 레이어(페이지 :root)에 정의된 색 토큰 값 — 캔버스 그리기용
  const cssVar = (node, name, fallback) => (getComputedStyle(node).getPropertyValue(name).trim() || fallback);

  // ── 입장 QR: 오류 복구 Q, 둘레 4칸 여백, 흰 바탕에 --ink 칸 (vendor/qrcode.js, MIT) ──
  const QR_QUIET = 4;
  // px: 그릴 크기(기기 픽셀) — 칸당 정수 픽셀로 맞춰 경계가 흐려지지 않게
  function drawQr(canvas, text, opts) {
    if (typeof window.qrcode !== 'function') return false;
    const q = window.qrcode(0, 'Q'); // 0 = 주소 길이에 맞춰 버전 자동
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    const total = n + QR_QUIET * 2;
    const cell = Math.max(2, Math.floor((opts.px || 600) / total));
    canvas.width = canvas.height = total * cell;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = opts.ink || '#1e1e42';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (q.isDark(r, c)) ctx.fillRect((c + QR_QUIET) * cell, (r + QR_QUIET) * cell, cell, cell);
    }
    return true;
  }

  // ── 대기 화면: 큰 입장 QR + 최근 채팅이 옆(세로형은 아래)에서 천천히 위로 흐름 + 느린 배경 번짐 ──
  const IDLE = {
    POOL_MAX: 30,    // 피드에 돌려 보여줄 최근 채팅 수
    SEEN_MAX: 300,   // 이미 받은 채팅 id 기억 수 (페이지 버퍼 MAX_BUFFER와 같게) — 다시 그리기로 온 채팅을 새것으로 착각하지 않게
    QUEUE_MAX: 8,    // 아직 안 나온 새 채팅 대기열 (몰리면 최신 것만)
    SPEED: 20,       // 위로 흐르는 속도(논리 px/초, 화면 배율 곱함) — 시안 26초에 한 바퀴와 비슷
    GAP: 14,         // 말풍선 간격(논리 px)
    QR_PULSE_MS: 2600,
  };
  // 배경 번짐: [색 인덱스, 크기(레이어 폭 대비), 왼쪽%, 위%] — 시안 배치를 화면 비율에 맞춤
  const IDLE_BLOBS = [[0, 0.62, -18, -10], [1, 0.52, 62, 58], [3, 0.4, 22, 66]];

  // opts: { layer, url: 관객 주소, colors: OPTION_COLORS, scale: () => --u }
  function createIdle(opts) {
    const layer = opts.layer;
    const scale = opts.scale || (() => 1);
    const colors = opts.colors || [];
    const url = opts.url;

    IDLE_BLOBS.forEach(([ci, size, x, y], i) => {
      const b = el('div', 'fx-idle-blob');
      Object.assign(b.style, { background: colors[ci] || '', width: size * 100 + '%', left: x + '%', top: y + '%' });
      b.dataset.i = i;
      layer.appendChild(b);
    });
    const main = el('div', 'fx-idle-main');
    main.append(
      el('div', 'fx-idle-eyebrow', '직장 썰루션 토크콘서트'),
      el('div', 'fx-idle-title'),
      el('div', 'fx-idle-sub', 'QR을 찍으면 앱 설치 없이 바로 익명 채팅에 들어갑니다'),
    );
    main.querySelector('.fx-idle-title').append('폰으로', document.createElement('br'), '참여하세요');
    const qrRow = el('div', 'fx-idle-qrwrap');
    const qrBox = el('div', 'fx-idle-qr');
    const qrCanvas = el('canvas');
    qrBox.appendChild(qrCanvas);
    const urlBox = el('div', 'fx-idle-url');
    // 주소는 프로토콜 없이. 길면 '.'·'/' 뒤에서만 줄바꿈 (단어 중간에서 끊기지 않게)
    const urlText = el('span');
    const urlParts = url.replace(/^https?:\/\//, '').replace(/\/$/, '').split(/(?<=[./])/);
    // breaks=false: 한 줄 글자만 (<wbr>은 white-space:nowrap이어도 줄바꿈 기회가 되므로 아예 뺌)
    function setUrlText(breaks) {
      urlText.textContent = '';
      urlParts.forEach((part, i) => {
        if (i && breaks) urlText.appendChild(document.createElement('wbr'));
        urlText.appendChild(document.createTextNode(part));
      });
    }
    setUrlText(true);
    urlBox.append(el('small', null, '주소로 들어와도 돼요'), urlText);
    qrRow.append(qrBox, urlBox);
    main.appendChild(qrRow);
    const feed = el('div', 'fx-idle-feed');
    const track = el('div', 'fx-idle-track');
    feed.appendChild(track);
    layer.append(main, feed);

    let pool = [];   // 최근 채팅 { m, shown } (오래된 → 최신)
    let queue = [];  // 피드에 아직 안 나온 새 채팅
    let items = [];  // 트랙 위 말풍선 { el, rec, y, h }
    let offset = 0;  // 트랙이 위로 올라간 거리(px)
    let cursorY = 0; // 다음 말풍선이 놓일 y
    let raf = null, last = 0, active = false;
    let anims = [];
    const seen = new Set(); // 받은 채팅 id (오래된 것부터 지움 — Set은 넣은 순서를 유지)

    function drawCode() {
      const w = qrBox.clientWidth;
      if (!w) return;
      drawQr(qrCanvas, url, { px: w * (window.devicePixelRatio || 1), ink: cssVar(layer, '--ink', '#1e1e42') });
    }

    // 주소는 한 줄이 가장 읽기 쉬움: 넘치면 글자 크기를 70%까지 줄여 한 줄에 맞추고,
    // 그래도 길면(긴 실제 도메인) 원래 크기로 '.'·'/' 뒤에서 줄바꿈 (<wbr>)
    function fitUrl() {
      urlText.style.fontSize = '';
      urlText.style.whiteSpace = 'nowrap';
      setUrlText(false);
      const base = parseFloat(getComputedStyle(urlText).fontSize);
      if (urlBox.clientWidth && base) {
        for (let f = 1; f >= 0.699; f -= 0.05) {
          urlText.style.fontSize = (base * f).toFixed(2) + 'px';
          // 줄바꿈이 없으면 줄이 QR 줄(qrRow)을 밀어 넓히므로 안내 열(main) 폭과도 비교
          if (urlBox.scrollWidth <= urlBox.clientWidth + 0.5 && qrRow.offsetWidth <= main.clientWidth + 0.5) return;
        }
      }
      urlText.style.fontSize = '';
      urlText.style.whiteSpace = '';
      setUrlText(true);
    }

    function bubble(m) {
      const b = el('div', 'fx-idle-b' + (m.isOperator ? ' operator' : ''));
      b.append(el('b', null, m.nickname || ''), el('span', null, m.text || ''));
      return b;
    }

    const gap = () => IDLE.GAP * scale();
    const onScreen = (rec) => items.some((it) => it.rec === rec);

    // 다음에 띄울 채팅: 새 채팅 먼저, 없으면 화면에 없는 최근 채팅 중 가장 오래전에 보인 것 (끊김 없이 흐르게)
    function nextRec() {
      while (queue.length) {
        const rec = queue.shift();
        if (pool.includes(rec) && !onScreen(rec)) return rec;
      }
      let best = null;
      pool.forEach((rec) => { if (!onScreen(rec) && (!best || rec.shown < best.shown)) best = rec; });
      return best;
    }

    function place(rec, y) {
      const b = bubble(rec.m);
      b.style.top = y + 'px';
      track.appendChild(b);
      const it = { el: b, rec, y, h: b.offsetHeight };
      rec.shown = performance.now();
      items.push(it);
      cursorY = y + it.h + gap();
      return it;
    }

    function render() { track.style.transform = `translateY(${-offset}px)`; }

    // 화면을 채운 상태로 시작: 최신 채팅부터 피드 높이만큼, 위에서부터 오래된 순 (모자라면 아래쪽에 붙임)
    function prefill() {
      track.innerHTML = '';
      items = []; queue = [];
      offset = 0; cursorY = 0;
      const H = feed.clientHeight;
      const pick = [];
      let sum = 0;
      for (let i = pool.length - 1; i >= 0; i--) {
        const probe = bubble(pool[i].m);
        track.appendChild(probe);
        const h = probe.offsetHeight + gap();
        probe.remove();
        if (pick.length && sum + h > H) break;
        pick.unshift(pool[i]);
        sum += h;
      }
      pick.forEach((rec) => place(rec, cursorY));
      if (cursorY < H) offset = cursorY - H; // 적으면 아래쪽에 모아 두고 거기서부터 올라감
      render();
    }

    function frame(now) {
      const dt = Math.min(100, now - last);
      last = now;
      const H = feed.clientHeight;
      offset += IDLE.SPEED * scale() * dt / 1000;
      // 위로 다 빠진 말풍선 정리
      while (items.length && items[0].y + items[0].h < offset) { items[0].el.remove(); items.shift(); }
      // 비었으면 좌표를 0으로 되돌림 (오래 켜 둬도 값이 끝없이 커지지 않게)
      if (!items.length) { offset = 0; cursorY = 0; }
      // 아래가 비면 다음 채팅을 피드 아래 끝에서 들여보냄
      if (cursorY - offset < H) {
        const rec = nextRec();
        if (rec) place(rec, Math.max(cursorY, offset + H));
      }
      render();
      raf = requestAnimationFrame(frame);
    }

    // 동작 줄이기: 흐름 없이 최신 채팅을 아래쪽에 쌓아 보여줌
    function staticFill() { prefill(); }

    function startMotion() {
      stopMotion();
      if (prefersReduced()) return;
      layer.querySelectorAll('.fx-idle-blob').forEach((b, i) => {
        anims.push(b.animate([{ transform: 'translate(0, 0)' }, { transform: `translate(${(i % 2 ? -1 : 1) * 8}%, ${(i ? -1 : 1) * 6}%)` }],
          { duration: 9000 + i * 2500, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' }));
      });
      anims.push(qrBox.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.03)' }],
        { duration: IDLE.QR_PULSE_MS, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' }));
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }

    function stopMotion() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      anims.forEach((a) => a.cancel());
      anims = [];
    }

    const idOf = (rec) => rec.m.id;
    // id가 같은 것을 모두 걷어냄 (풀·대기열·화면)
    function dropWhere(test) {
      pool = pool.filter((r) => !test(idOf(r)));
      queue = queue.filter((r) => !test(idOf(r)));
      items = items.filter((it) => { if (!test(idOf(it.rec))) return true; it.el.remove(); return false; });
    }

    return {
      show() {
        if (active) return;
        active = true;
        fadeLayer(layer, true);
        drawCode();
        fitUrl();
        prefill();
        startMotion();
      },
      hide() {
        if (!active) return;
        active = false;
        stopMotion();
        fadeLayer(layer, false);
      },
      // 채팅 화면에 그려지는 메시지마다 호출 (대기 화면이 꺼져 있어도 최근 목록은 유지)
      push(m) {
        if (!m || typeof m.text !== 'string') return;
        if (m.id != null) {
          if (seen.has(m.id)) return; // 다시 그리기(일시정지 해제·재접속 history)로 온 같은 메시지
          seen.add(m.id);
          if (seen.size > IDLE.SEEN_MAX) seen.delete(seen.values().next().value);
        }
        const rec = { m, shown: 0 };
        pool.push(rec);
        if (pool.length > IDLE.POOL_MAX) pool.shift();
        if (!active) return;
        if (prefersReduced()) { staticFill(); return; }
        queue.push(rec);
        if (queue.length > IDLE.QUEUE_MAX) queue.shift();
      },
      // 재접속 history(서버 전체 기록): 끊긴 사이 지워진 채팅만 id로 골라 뺀다 — 남은 말풍선은 그대로 흐름
      // (새로 온 채팅은 push가 처리. 기록에 없는 id = 삭제됐거나 서버 기록에서 밀려난 아주 오래된 것)
      reset(history) {
        if (!Array.isArray(history)) return;
        const keep = new Set(history.map((m) => m && m.id));
        dropWhere((id) => id != null && !keep.has(id));
      },
      remove(id) {
        if (id == null) return;
        dropWhere((x) => x === id);
      },
      clearFeed() {
        seen.clear();
        pool = []; queue = []; items = [];
        track.innerHTML = '';
        offset = 0; cursorY = 0;
        render();
      },
      // 창 크기가 바뀌면 QR과 피드를 새 크기로
      relayout() {
        if (!active) return;
        drawCode();
        fitUrl();
        prefill();
      },
      // 글꼴이 늦게 도착했을 때 — 흐르는 피드는 그대로 두고 주소 크기만 다시
      refitUrl() { if (active) fitUrl(); },
      isActive: () => active,
      // 점검용: 최근 목록·대기열·화면 말풍선의 채팅 id
      stats: () => ({ pool: pool.map(idOf), queue: queue.map(idOf), items: items.map((it) => idOf(it.rec)) }),
      qrCanvas,
    };
  }

  // ── 엔딩 "오늘의 결과": 관리자가 넘기는 대로(state.ending.index) 한 장씩, 왼쪽으로 밀리며 바뀜 ──
  // opts: { layer, colors: OPTION_COLORS, yesnoColors }
  // 엔딩 슬라이드 맞춤 단계 [글자 배율, 질문 최대 줄 수(0 = 제한 없음)] — 앞에서부터 처음 맞는 단계를 씀.
  // 먼저 배율만 0.85까지, 그래도 넘치면 질문을 4→3→2줄로 줄이며(말줄임) 배율을 0.6까지. 0.6 = 세로형 막대 이름 15.6px(800 기준)
  const END_FIT = [[1, 0], [0.92, 0], [0.85, 0], [0.85, 4], [0.78, 3], [0.72, 3], [0.66, 2], [0.6, 2]];

  function createEnding(opts) {
    const layer = opts.layer;
    let key = null, slides = [], dots = [], index = -1, frameReq = null;
    let fitted = false; // 지금 화면 크기로 슬라이드 맞춤을 했는지

    // 내용(질문·막대·안내)이 위아래 여백(아래는 페이지 점 자리) 안에 들어가도록 글자 배율을 줄이고, 그래도 넘치면 질문 줄 수를 제한.
    // 보기 이름은 단계마다 2줄 + "…"로 다시 자름 (배율이 바뀌면 줄바꿈이 바뀌므로)
    function fitSlide(d) {
      const q = d.querySelector('.fx-end-q');
      const labs = [...d.querySelectorAll('.fx-end-lab')];
      if (q && q.dataset.full == null) q.dataset.full = q.textContent;
      labs.forEach((l) => { if (l.dataset.full == null) l.dataset.full = l.textContent; });
      const kids = [...d.children];
      if (!kids.length || !d.clientHeight) return;
      const cs = getComputedStyle(d);
      const avail = d.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const need = () => {
        const last = kids[kids.length - 1];
        return last.offsetTop + last.offsetHeight - kids[0].offsetTop;
      };
      d.style.removeProperty('--fx-end-labw'); // 이름 칸 최대 폭(30%)에서 줄바꿈을 정한 뒤 아래에서 실제 폭으로 좁힘
      for (const [k, qLines] of END_FIT) {
        d.style.setProperty('--fx-end-s', String(k));
        if (q) { if (qLines) clampText(q, q.dataset.full, qLines); else q.textContent = q.dataset.full; }
        labs.forEach((l) => clampText(l, l.dataset.full, 2));
        if (need() <= avail + 1) break;
      }
      // 막대 묶음을 가운데로: 이름 칸 = 가장 긴 이름의 실제 폭 (결과 막대와 같은 방식)
      const labW = maxInkWidth(labs);
      if (labW > 0) d.style.setProperty('--fx-end-labw', Math.ceil(labW + 1) + 'px');
    }

    function fitAll() {
      if (!layer.classList.contains('active') || !layer.clientHeight) return;
      slides.forEach(fitSlide);
      fitted = true;
    }

    function voteSlide(s, n) {
      const d = el('div', 'fx-end-slide');
      d.appendChild(el('div', 'fx-end-kicker', `질문 ${n} · ${s.voteType === 'yesno' ? 'YES/NO' : '객관식'}`));
      d.appendChild(el('div', 'fx-end-q', s.question || ''));
      const labels = Array.isArray(s.options) ? s.options : [];
      const sum = summarize(Array.isArray(s.perOption) ? s.perOption : []);
      const pcts = labels.map((_, i) => (sum.total ? Math.round((sum.per[i] || 0) / sum.total * 100) : 0));
      const maxPct = Math.max(1, ...pcts);
      const palette = s.voteType === 'yesno' ? (opts.yesnoColors || opts.colors) : opts.colors;
      const rows = el('div', 'fx-end-rows');
      labels.forEach((label, i) => {
        const r = el('div', 'fx-end-row' + (sum.total && sum.top.includes(i) ? ' win' : ''));
        const trk = el('span', 'fx-end-trk');
        const fil = el('span', 'fx-end-fil');
        fil.style.background = palette[i % palette.length];
        fil.dataset.w = String(pcts[i] / maxPct * 100); // 1위 막대가 트랙을 채움 (실제 비율은 % 숫자)
        trk.appendChild(fil);
        r.append(el('span', 'fx-end-lab', String(label)), trk, el('span', 'fx-end-pct', pcts[i] + '%'));
        rows.appendChild(r);
      });
      d.appendChild(rows);
      if (!sum.total) d.appendChild(el('div', 'fx-end-note', '참여한 표가 없었어요'));
      return d;
    }

    function subjectiveSlide(s, n) {
      const d = el('div', 'fx-end-slide');
      const top = (Array.isArray(s.top) ? s.top : []).filter((t) => t && typeof t.word === 'string');
      // 순위는 같은 수면 같은 순위(5·5·3명 → 1·1·3위), 같은 순위가 둘 이상이면 "공동"
      const rank = rankLabels(top.map((t) => t.count));
      d.appendChild(el('div', 'fx-end-kicker', `질문 ${n} · 주관식 ${top.length ? rank[0] : '1위'}`));
      d.appendChild(el('div', 'fx-end-q', s.question || ''));
      if (!top.length) {
        d.appendChild(el('div', 'fx-end-note', '접수된 답변이 없었어요'));
        return d;
      }
      d.appendChild(el('div', 'fx-end-big', `“${top[0].word}”`));
      d.appendChild(el('div', 'fx-end-note', top[0].count > 1 ? `${top[0].count}명이 같은 답` : '1명의 답'));
      if (top.length > 1) {
        const more = el('div', 'fx-end-more');
        top.slice(1, 3).forEach((t, i) => {
          const r = el('div', 'fx-end-more-row');
          r.append(el('span', 'fx-end-rank', rank[i + 1]), el('span', 'fx-end-word', t.word), el('span', 'fx-end-count', `${t.count}명`));
          more.appendChild(r);
        });
        d.appendChild(more);
      }
      return d;
    }

    function makeSlide(s, n) {
      if (s && s.kind === 'vote') return voteSlide(s, n);
      if (s && s.kind === 'subjective') return subjectiveSlide(s, n);
      const d = el('div', 'fx-end-slide');
      if (s && s.kind === 'thanks') {
        const t = el('div', 'fx-end-title');
        t.append('함께해 주셔서', document.createElement('br'), '감사합니다');
        d.append(t, el('div', 'fx-end-note', '오늘도 수고 많으셨어요'));
      } else {
        d.append(el('div', 'fx-end-kicker', '직장 썰루션 토크콘서트'), el('div', 'fx-end-title', '오늘의 결과'),
          el('div', 'fx-end-note', '여러분이 함께 만든 답을 모아 봤어요'));
      }
      return d;
    }

    function build(list) {
      layer.innerHTML = '';
      slides = list.map((s, i) => { const d = makeSlide(s, i); layer.appendChild(d); return d; });
      const dw = el('div', 'fx-end-dots');
      dots = list.map(() => { const i = el('i'); dw.appendChild(i); return i; });
      layer.appendChild(dw);
      index = -1;
    }

    // n번째 슬라이드로: 이전 것들은 왼쪽으로, 다음 것들은 오른쪽 대기. 막대는 지금 슬라이드만 0에서 차오름
    // slideAnim: 슬라이드가 밀리며 바뀜 / barAnim: 막대가 차오름 (재접속 스냅샷이면 둘 다 없이 바로)
    function go(n, slideAnim, barAnim) {
      if (prefersReduced()) { slideAnim = false; barAnim = false; }
      if (frameReq) { cancelAnimationFrame(frameReq); frameReq = null; }
      if (!slideAnim) layer.classList.add('fx-instant');
      slides.forEach((s, i) => {
        s.classList.toggle('on', i === n);
        s.classList.toggle('off', i < n);
      });
      // 들어오는 장의 막대만 0으로 (전환 없이 바로) — 나가는 장은 막대를 유지한 채 사라짐
      if (barAnim) slides[n].querySelectorAll('.fx-end-fil').forEach((f) => {
        f.style.transition = 'none';
        f.style.width = '0';
        void f.offsetWidth;
        f.style.transition = '';
      });
      dots.forEach((d, i) => d.classList.toggle('on', i === n));
      index = n;
      const fill = () => slides[n].querySelectorAll('.fx-end-fil').forEach((f) => { f.style.width = f.dataset.w + '%'; });
      if (!barAnim) fill();
      void layer.offsetWidth; // 바로 바뀐 상태를 먼저 확정한 뒤 전환을 다시 켬
      layer.classList.remove('fx-instant');
      // 다음 프레임에 막대 폭을 줘야 0에서 차오름
      if (barAnim) frameReq = requestAnimationFrame(() => { frameReq = requestAnimationFrame(() => { frameReq = null; fill(); }); });
    }

    return {
      // ending: state.ending { index, slides }. o.animate: 실시간 전환(재접속 스냅샷이면 false)
      show(ending, o) {
        const list = ending && Array.isArray(ending.slides) && ending.slides.length ? ending.slides : [{ kind: 'title' }, { kind: 'thanks' }];
        const n = Math.min(list.length - 1, Math.max(0, Math.floor(Number(ending && ending.index) || 0)));
        const animate = !!(o && o.animate);
        const k = JSON.stringify(list);
        const entering = !layer.classList.contains('on');
        if (k !== key) { key = k; build(list); fitted = false; }
        fadeLayer(layer, true);
        if (!fitted) fitAll(); // 레이어가 보인 뒤에 재야 크기가 나옴
        if (n === index) return; // 같은 장 재전송 — 그대로
        // 처음 들어올 땐 레이어가 서서히 나타나므로 슬라이드는 제자리에서 (막대만 차오름)
        go(n, animate && !entering, animate);
      },
      hide() {
        if (frameReq) { cancelAnimationFrame(frameReq); frameReq = null; }
        key = null; index = -1;
        fadeLayer(layer, false);
      },
      current: () => index,
      // 창 크기·글꼴 로딩으로 슬라이드 크기가 바뀌면 다시 맞춤
      relayout() { fitted = false; fitAll(); },
    };
  }

  // 많은 순으로 정렬된 수 목록 → 순위 글자 ("1위", 같은 수가 둘 이상이면 "공동 1위"). 같은 수 = 같은 순위(5·5·3 → 1·1·3위)
  function rankLabels(counts) {
    return counts.map((c) => {
      const r = 1 + counts.filter((x) => x > c).length;
      return (counts.filter((x) => x === c).length > 1 ? '공동 ' : '') + r + '위';
    });
  }

  // ── 함성 미터: 화면들이 받은 레벨(서버 중계)로 게이지가 차오르고, 목표선을 처음 넘으면 터짐 ──
  const APPLAUSE = {
    GOAL: 0.85,
    WIN_MS: 2500,   // "대단해요! 목표 달성" 문구 유지 시간
    STALE_MS: 700,  // 이만큼 레벨이 안 오면(마이크 화면 끊김) 게이지가 서서히 내려감
    SPARKS: 60,
  };

  // opts: { layer, colors: OPTION_COLORS }
  function createApplause(opts) {
    const layer = opts.layer;
    const colors = opts.colors || [];
    const box = el('div', 'fx-clap');
    const head = el('div', 'fx-clap-head');
    const gauge = el('div', 'fx-clap-gauge');
    const fill = el('div', 'fx-clap-fill');
    const peakMark = el('div', 'fx-clap-peak');
    const goal = el('div', 'fx-clap-goal');
    goal.appendChild(el('span', null, '목표'));
    goal.style.left = APPLAUSE.GOAL * 100 + '%';
    gauge.append(fill, peakMark, goal);
    const num = el('div', 'fx-clap-num', '0');
    const cap = el('div', 'fx-clap-cap', '함성 지수');
    box.append(head, gauge, num, cap);
    layer.appendChild(box);

    let mode = null;       // 'live' | 'result' | null
    let session = null;    // 측정 회차 (endTime) — 같은 회차 재전송이면 이어감
    let level = 0, target = 0, peak = 0, lastData = 0;
    let wonAt = null, reached = false;
    let raf = null, last = 0, shownNum = -1;
    let sparks = [];

    function setHead(text, win) {
      if (head.textContent !== text) head.textContent = text;
      head.classList.toggle('win', !!win);
    }

    function burst() {
      if (prefersReduced()) return;
      const lr = layer.getBoundingClientRect();
      const hr = head.getBoundingClientRect();
      const k = lr.width / 1000; // 시안(1000px) 대비 배율
      const x0 = hr.left - lr.left + hr.width / 2, y0 = hr.top - lr.top + hr.height / 2;
      for (let i = 0; i < APPLAUSE.SPARKS; i++) {
        const a = Math.random() * Math.PI * 2, v = (3 + Math.random() * 8) * k;
        const d = el('div', 'fx-clap-spark');
        d.style.background = colors[i % 5] || '';
        d.style.width = d.style.height = Math.round(14 * k) + 'px';
        layer.appendChild(d);
        sparks.push({ el: d, x: x0, y: y0, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4 * k, g: 0.3 * k });
      }
    }

    function clearSparks() { sparks.forEach((s) => s.el.remove()); sparks = []; }

    function draw() {
      const w = gauge.clientWidth, h = gauge.clientHeight;
      const minFrac = w ? h / w : 0; // 0이어도 둥근 머리는 보이게 (시안: max(높이, 폭×레벨))
      const f = Math.max(minFrac, Math.min(1, level));
      fill.style.clipPath = `inset(0 ${((1 - f) * 100).toFixed(2)}% 0 0 round ${h / 2}px)`;
      peakMark.style.left = (Math.min(1, peak) * 100).toFixed(2) + '%';
      peakMark.style.opacity = mode === 'live' && peak > 0.01 ? '1' : '0'; // 결과에선 게이지 자체가 최고치
      const n = Math.round((mode === 'result' ? peak : level) * 100);
      if (n !== shownNum) { shownNum = n; num.textContent = String(n); }
    }

    function frame(now) {
      const dt = Math.min(50, now - last);
      last = now;
      if (mode === 'live' && now - lastData > APPLAUSE.STALE_MS) target = 0;
      // 오를 땐 빠르게, 내릴 땐 천천히 (시안과 같은 계수)
      level += (target - level) * (target > level ? 0.18 : 0.05) * dt / 16;
      if (mode === 'live') {
        if (level >= APPLAUSE.GOAL && !reached) { reached = true; wonAt = now; burst(); }
        const win = wonAt !== null && now - wonAt < APPLAUSE.WIN_MS;
        setHead(win ? '대단해요! 목표 달성' : '더 크게! 박수 주세요', win);
      }
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.vy += s.g * dt / 16; s.x += s.vx * dt / 16; s.y += s.vy * dt / 16;
        if (s.y > layer.clientHeight + 20) { s.el.remove(); sparks.splice(i, 1); continue; }
        s.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -50%)`;
      }
      // 결과 화면에서 게이지가 다 따라붙고 불꽃도 다 떨어졌으면 루프를 멈춘다(정지 화면에 매 프레임 낭비 방지)
      // — 다시 움직일 일이 생기면 start()/result()의 run()이 새로 돌린다
      if (mode === 'result' && Math.abs(target - level) < 0.001 && !sparks.length) {
        level = target;
        draw();
        raf = null;
        return;
      }
      draw();
      raf = requestAnimationFrame(frame);
    }

    function run() {
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }

    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      clearSparks();
    }

    return {
      // 측정 중 (state.applause { endTime, peak })
      start(ap) {
        const s = ap && ap.endTime;
        layer.classList.remove('result');
        if (mode === 'live' && s === session) { fadeLayer(layer, true); return; } // 같은 회차 재전송
        mode = 'live';
        session = s;
        peak = Math.max(0, Number(ap && ap.peak) || 0);
        level = target = 0;
        lastData = 0;
        reached = peak >= APPLAUSE.GOAL; // 재접속 때 이미 넘었으면 다시 터뜨리지 않음
        wonAt = null;
        shownNum = -1;
        clearSparks();
        setHead('더 크게! 박수 주세요', false);
        fadeLayer(layer, true);
        draw();
        run();
      },
      // 서버 중계 applauseLevel { level, peak }
      level(data) {
        if (mode !== 'live' || !data) return;
        const lv = Number(data.level), pk = Number(data.peak);
        if (Number.isFinite(lv)) target = Math.min(1, Math.max(0, lv));
        if (Number.isFinite(pk)) peak = Math.max(peak, Math.min(1, pk));
        lastData = performance.now();
      },
      // 측정 끝: 최고치로 게이지 고정 + "함성 지수 NN"
      result(ap) {
        const pk = Math.min(1, Math.max(0, Number(ap && ap.peak) || 0));
        const wasLive = mode === 'live';
        mode = 'result';
        session = null;
        peak = pk;
        target = pk;
        if (!wasLive || prefersReduced()) level = pk;
        layer.classList.add('result');
        setHead(`함성 지수 ${Math.round(pk * 100)}`, pk >= APPLAUSE.GOAL);
        fadeLayer(layer, true);
        draw();
        run();
      },
      hide() {
        if (mode === null) return;
        mode = null;
        session = null;
        stop();
        fadeLayer(layer, false);
      },
    };
  }

  // ── 함성 측정 마이크 (LED 주소에 ?mic=1 일 때만) ──
  // 측정 시작 후 1.5초 소리의 중앙값을 바닥(dB)으로 잡고, 그보다 30dB 크면 1. ?gain= 으로 감도 조절
  const MIC = {
    SEND_MS: 75,       // 초당 약 13회 (서버 한도 15회/초 아래)
    BASELINE_MS: 1500,
    SPAN_DB: 30,
  };

  function micLevel(db, baselineDb, gain) {
    return clamp01((db - baselineDb) / MIC.SPAN_DB * gain);
  }

  function median(arr) {
    if (!arr.length) return -100;
    const s = arr.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // opts: { search: location.search, emit(level), host: 경고를 띄울 요소 }
  // ?mic=1이 아니면 null — 마이크를 아예 요청하지 않는다
  function createMic(opts) {
    const params = new URLSearchParams(opts.search || '');
    if (params.get('mic') !== '1') return null;
    const g = parseFloat(params.get('gain'));
    const gain = Number.isFinite(g) && g > 0 ? g : 1;
    const warnEl = el('div', 'fx-mic-warn');
    opts.host.appendChild(warnEl);

    let stream = null, ctx = null, analyser = null, buf = null, source = null;
    let timer = null, running = false, run = 0, key = null;
    let baseline = null, samples = [], t0 = 0;
    let warnKind = null, tapArmed = false;
    let authMsg = '', statusMsg = '';

    // 안내 두 칸을 따로 둔다 — 운영진 키 안내(auth)는 측정 상태 안내가 나오고 사라져도 지워지지 않게.
    // 상태 kind: 'denied'(권한·장치 — 다음 측정 전까지 유지) | 'suspended'(탭 안내 — 측정이 끝나면 지움)
    function render() {
      warnEl.textContent = [authMsg, statusMsg].filter(Boolean).join('\n'); // 둘 다면 위아래로 (CSS pre-line)
      warnEl.classList.toggle('active', !!(authMsg || statusMsg));
    }
    function warn(msg, kind) {
      warnKind = msg ? kind || null : null;
      statusMsg = msg || '';
      render();
    }

    // 소리가 멈춰 있으면(자동재생 정책) 화면을 한 번 누르면 재개 — 리스너는 한 번만 걸어 둔다
    function resumeOnTap() {
      if (tapArmed) return;
      tapArmed = true;
      document.addEventListener('pointerdown', () => {
        tapArmed = false;
        if (!ctx || !running) return; // 측정이 끝난 뒤 누르면 다시 켜지 않음
        ctx.resume().then(() => { if (ctx.state === 'running' && warnKind === 'suspended') warn(''); }).catch(() => {});
      }, { once: true });
    }

    async function ensure() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('no mic'), { name: 'NotFoundError' });
      const live = stream && stream.getAudioTracks().some((t) => t.readyState === 'live');
      if (!live) {
        // 박수·함성은 잡음처럼 처리되므로 잡음 제거·자동 음량은 끔 (가능한 브라우저에서만)
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        if (source) { source.disconnect(); source = null; }
      }
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (!source) {
        source = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        buf = new Float32Array(analyser.fftSize);
        source.connect(analyser);
      }
      if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { /* 아래에서 안내 */ } }
    }

    function readDb() {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      return 20 * Math.log10(Math.max(rms, 1e-8));
    }

    function tick() {
      if (!running) return;
      const now = performance.now();
      // 소리가 멈춰 있으면(자동재생 정책) 무음만 읽히므로 바닥값은 재개된 뒤부터 잰다
      if (ctx.state !== 'running') { t0 = now; samples = []; baseline = null; return; }
      const db = readDb();
      if (baseline === null) {
        samples.push(db);
        if (now - t0 >= MIC.BASELINE_MS) baseline = median(samples);
        return;
      }
      opts.emit(Math.round(micLevel(db, baseline, gain) * 1000) / 1000);
    }

    function stopTimer() {
      if (timer) clearInterval(timer);
      timer = null;
    }

    return {
      // 측정 시작 (k: 측정 회차 — 다른 회차면 바닥값을 새로 잼). 마이크 스트림은 처음 허용 뒤 재사용
      start(k) {
        if (running && k === key) return;
        stopTimer();
        running = true;
        key = k;
        const my = ++run;
        baseline = null; samples = [];
        ensure().then(() => {
          if (my !== run || !running) return;
          if (ctx.state !== 'running') { warn('마이크 소리가 멈춰 있어요 — 화면을 한 번 눌러 주세요', 'suspended'); resumeOnTap(); }
          else warn(''); // 지난 상태 안내만 지움 (키 안내는 따로라 그대로 남음)
          t0 = performance.now();
          timer = setInterval(tick, MIC.SEND_MS);
        }).catch((e) => {
          if (my !== run) return;
          running = false;
          warn(e && e.name === 'NotAllowedError' ? '마이크 권한이 거부되어 함성을 잴 수 없어요' : '마이크를 쓸 수 없어 함성을 잴 수 없어요', 'denied');
        });
      },
      // 측정 끝(모드 전환): 분석만 멈춤 — 스트림은 다음 측정을 위해 유지
      stop() {
        if (!running && !timer) return;
        running = false;
        run++;
        key = null;
        stopTimer();
        if (warnKind === 'suspended') warn(''); // 탭 안내는 측정 중에만 의미 (권한 거부 안내는 남김)
        if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
      },
      // 서버가 이 화면의 레벨을 받지 않을 때(운영진 키 없음·틀림) — 측정 시작과 무관하게 계속 띄움
      authWarn(msg) { authMsg = msg || ''; render(); },
      gain,
    };
  }

  window.LedFx = {
    prefersReduced,
    easeBack,
    ease,
    text: { fit: fitCanvasText, wrap: wrapCanvasLines, clamp: clampText, ELLIPSIS },
    question,
    timer,
    balls,
    hearts: { create: createHeartBurst, enabledFrom: heartBurstEnabled, MODES: HEART_MODES },
    result: { summarize, createReveal, createBarRace, REVEAL, RACE_MS },
    answers: { create: createAnswerStream, normalize: normText, STREAM },
    cloud: { create: createCloud, size: cloudSize, CLOUD },
    lift: { create: createLift, LIFT },
    spotlight: { create: createPickSpotlight, PICK },
    pin: { create: createChatPin, PIN },
    notice: { create: createNotice },
    qr: { draw: drawQr, QUIET: QR_QUIET },
    idle: { create: createIdle, IDLE },
    ending: { create: createEnding },
    applause: { create: createApplause, createMic, micLevel, APPLAUSE, MIC },
  };
})();

// ══════════════════════════════════
//  LED 페이지 배선 (led.html · led-concert.html 공용)
//  소켓 이벤트 → 화면 모드 전환, 채팅 목록, 투표 상자 캔버스, 각 연출(LedFx.*) 연결.
//  두 페이지는 마크업·CSS와 아래 설정만 다르다 — 동작 수정은 여기 한 곳에서.
//  (원래 각 페이지 <script>에 있던 코드를 그대로 옮김: 전역이 아닌 함수 안이라 페이지 전역 변수는 없다)
// ══════════════════════════════════
(function () {
  const ease = (t) => window.LedFx.ease(t); // 공용 감속 곡선 (위 모듈과 같은 것)
  // cfg: {
  //   baseW: 설계 기준 폭(px) — 화면 배율 --u의 기준,
  //   box: 보기 상자 상수 덮어쓰기 (예: { headerH: 48 }),
  //   clusterLayout(n) → { cols, rows }: 보기 n개의 상자 격자,
  //   boxLabel: { maxPx(n) → 보기 n개일 때 상자 헤더 라벨 최대 글자 크기, minPx: 읽히는 최소 크기 } (논리 px, 2줄까지 줄바꿈),
  //   audiencePath: 대기 화면 QR이 가리킬 관객 주소 경로 ('/' 또는 '/concert'),
  // }
  function start(cfg) {
    const MAX_VISIBLE = 40; // LED에 유지할 최대 메시지 수 — 화면 높이를 가득 채우고, 넘치는 위쪽은 overflow+페이드로 자연스럽게 잘림
    const MAX_BUFFER = 300; // 일시정지 중에도 누적되는 메시지 버퍼 상한(메모리 보호용)
    const messages = [];
    let chatPaused = false; // 관리자 화면에서 LED 채팅 표시를 멈춘 상태인지 (서버 chatPaused)

    const container = document.getElementById('led-messages');
    // ── 마이크 화면 운영진 키 ── 주소에 ?mic=1&key=운영진키 로 열면 키를 이 브라우저에 기억하고 주소창에서는 지운다.
    // 함성 레벨은 운영진 키로 접속한 소켓만 받으므로(관객 위조 방지) 마이크 화면만 키를 싣는다 — 일반 LED는 그대로 접속
    const MIC_KEY_STORE = 'ledMicKey';
    function loadMicKey() {
      const params = new URLSearchParams(location.search);
      if (params.get('mic') !== '1') return null;
      const fromUrl = params.get('key');
      if (fromUrl) {
        try { localStorage.setItem(MIC_KEY_STORE, fromUrl); } catch {}
        params.delete('key');
        const qs = params.toString();
        history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
        return fromUrl;
      }
      try { return localStorage.getItem(MIC_KEY_STORE) || ''; } catch { return ''; }
    }
    const micKey = loadMicKey();
    const socket = micKey === null ? io() : io({ auth: { key: micKey } });

    socket.on('history', (history) => {
      // 재접속 때도 history가 다시 오므로 기존 화면·버퍼를 비우고 다시 그린다(중복 표시 방지)
      messages.length = 0;
      // 일시정지 중 재접속이면 멈춘 화면은 그대로 둔다 — 비우면 재생할 때까지 채팅창이 빈 화면이 된다.
      // 버퍼만 history로 다시 채우고(addMessage가 정지 중엔 그리지 않음) 재생 때 최신으로 이어 그린다.
      // 단, history가 비었으면(채팅 초기화·서버 재시작) 멈춘 화면도 비운다.
      if (!chatPaused || history.length === 0) container.innerHTML = '';
      const recent = history.slice(-MAX_VISIBLE);
      recent.forEach(addMessage);
      idleFx.reset(history); // 대기 화면 피드: 끊긴 사이 지워진 채팅만 id로 뺌 (남은 말풍선은 그대로)
      pinFx.reconcile(); // 다시 그린 말풍선 중 핀으로 떠오른 것은 다시 숨김
    });

    socket.on('chat', (msg) => {
      addMessage(msg);
    });

    // 채팅이 몰릴 때 서버가 묶어서 보내는 메시지
    socket.on('chatBatch', (list) => {
      list.forEach(addMessage);
    });

    // 관리자가 채팅을 초기화하면 화면과 버퍼를 함께 비운다
    // (버퍼를 안 비우면 일시정지 해제 시 지운 메시지가 되살아난다)
    socket.on('chatCleared', () => {
      messages.length = 0;
      container.innerHTML = '';
      idleFx.clearFeed();
    });

    // 관리자가 개별 채팅을 삭제하면 화면·버퍼에서 제거
    socket.on('chatDeleted', (id) => {
      const i = messages.findIndex(m => m.id === id);
      if (i !== -1) messages.splice(i, 1);
      const el = container.querySelector('[data-id="' + CSS.escape(String(id)) + '"]');
      if (el) el.remove();
      idleFx.remove(id);
    });

    // 메시지 수신: 항상 버퍼(messages)에는 기록하되, 일시정지 중이면 화면엔 그리지 않음
    function addMessage(msg) {
      messages.push(msg);
      if (messages.length > MAX_BUFFER) messages.shift();
      if (chatPaused) return;
      renderMessage(msg);
    }

    function renderMessage(msg) {
      const group = document.createElement('div');
      group.className = 'led-msg-group';
      if (msg.id != null) group.dataset.id = msg.id;

      const bubble = document.createElement('div');
      bubble.className = 'led-bubble' + (msg.isOperator ? ' operator' : '');

      const nick = document.createElement('div');
      nick.className = 'led-nickname';
      nick.textContent = msg.nickname;

      const text = document.createElement('div');
      text.className = 'led-text';
      text.textContent = msg.text;

      bubble.appendChild(nick);
      bubble.appendChild(text);
      group.appendChild(bubble);
      container.appendChild(group);

      // 최대 개수 초과 시 가장 오래된 것 제거
      const groups = container.querySelectorAll('.led-msg-group');
      if (groups.length > MAX_VISIBLE) {
        groups[0].remove();
      }

      idleFx.push(msg); // 대기 화면 피드에도 (화면에 그려지는 채팅만 — 일시정지 중엔 보류)
    }

    // 일시정지: 화면 갱신만 멈춤(버퍼링은 계속) — 더블클릭 시 최신 상태로 점프
    function pauseChat() {
      if (chatPaused) return;
      chatPaused = true;
    }

    function resumeChat() {
      if (!chatPaused) return;
      chatPaused = false;
      container.innerHTML = '';
      messages.slice(-MAX_VISIBLE).forEach(renderMessage);
      pinFx.reconcile(); // 다시 그린 말풍선 중 핀으로 떠오른 것은 다시 숨김
    }

    // ══════════════════════════════════
    //  투표 모드
    // ══════════════════════════════════
    const chatLayer = document.getElementById('chat-layer');

    // 채팅 일시정지는 LED 화면 클릭이 아니라 관리자 화면(admin.html)에서 제어한다.
    // 서버가 보내는 'chatPauseChange'/state.chatPaused 값을 그대로 따른다.

    const votingLayer = document.getElementById('voting-layer');
    const votingQuestion = document.getElementById('voting-question');
    const votingTimer = document.getElementById('voting-timer');
    const resultBanner = document.getElementById('result-banner');
    const resultLine = document.getElementById('result-line');

    const canvas = document.getElementById('voting-canvas');
    const ctx = canvas.getContext('2d');

    // 보기 색 팔레트 (관객 폰과 순서 동일 — 같은 보기 = 같은 색)
    const YESNO_COLORS = ['#fb7e55', '#5b5cc4'];
    const OPTION_COLORS = ['#fb7e55', '#5b5cc4', '#2fb3a3', '#f2a03d', '#e3557f', '#4a4a7a'];
    function colorFor(i) {
      const arr = voteType === 'yesno' ? YESNO_COLORS : OPTION_COLORS;
      return arr[i % arr.length];
    }

    // ── 공 크기 ──
    // 1표 = 공 1개. 표가 가장 많은 보기가 상자를 거의 채우도록 반지름을 역산하고,
    // 그 값을 모든 보기에 똑같이 적용한다(보기마다 크기가 다르면 양 비교가 왜곡됨).
    const BALL_MIN_R = 2.5;
    const BALL_MAX_R = 15;  // 표가 적을 땐 이 크기를 유지해 차오르는 과정이 보이게

    // ── 보기 상자 ── 시안대로 컬러 헤더 + 흰 본문, 공이 그 안에 담김
    // 페이지 설정(cfg.box)이 기본값을 덮어씀 — 가로형은 헤더가 조금 높다
    const BOX = Object.assign({ headerH: 46, pad: 16, radius: 18, gap: 22, minW: 120, marginRatio: 0.11 }, cfg.box);

    // 세로 비율 상한(높이 ÷ 너비). 열이 많아 상자가 좁아질수록 세로로 길어야
    // 담긴 높이가 읽히므로 상한을 키운다. 2지선다는 시안대로 정사각형에 가깝게 유지.
    function maxAspectFor(cols, rows) {
      if (rows > 1) return 1.6;
      return cols <= 2 ? 1.15 : 2.2;
    }
    const BOX_FONT = "'Pretendard Variable', Pretendard, -apple-system, sans-serif";

    // 보기별 공 목록: ballState[i] = { balls: [{ x, y, tx, ty, phase, drop }] } (drop = 낙하 중 정보, LedFx.balls)
    let ballState = [];
    let ballR = BALL_MAX_R;    // 목표 공 반지름
    let curBallR = BALL_MAX_R; // 실제 렌더 반지름 (목표값으로 부드럽게 수렴)
    let voteOptions = [];      // 현재 질문 보기 라벨 배열
    let voteType = 'yesno';    // 'yesno' | 'choice'
    let optCount = 0;          // 보기 수

    // 투표 마감 시각 — 서버가 보낸 남은 시간(votingRemainMs, 서버 시계로 계산)을 받은 순간의 이 PC Date.now()에 더해 잡는다.
    // (서버의 votingEndTime을 이 PC 시계로 빼면 LED PC·관리자 PC·폰 시계 차이만큼 남은 초가 달랐음)
    let voteDeadline = null;
    const timerGauge = LedFx.timer.createGauge(document.getElementById('voting-question-card'));

    // ── 2지선다(YES/NO·보기 2개): 시안 1·6의 원형 공 덩어리 (그리기는 아래 roundLayout·drawRound) ──
    const isRound = () => optCount === 2;
    const ROUND = {
      GROW_MS: 900,        // 새 공이 0 → 제 크기로 커지는 시간 (시안 1)
      FLY_MS: 700,         // 새 표가 화면 아래에서 원 가운데로 날아오는 시간 (시안 1 — 표가 "들어오는" 게 보이게)
      FLY_ARC: 60,         // 날아오는 곡선의 솟음 높이(논리 px)
      STAGGER: 60, STAGGER_MAX: 600,
      SPACING: 1.19,       // 해바라기 배치 간격 = r × SPACING (공 사이가 거의 맞닿게)
      GAP: 1.06,           // 겹침 풀기 최소 거리 = 2r × GAP
      PULL: 0.012,         // 원 중심으로 끌어당기는 비율(16ms마다 거리의 1.2%, 시안 1) — 바깥 공일수록 세게 당겨 둥근 덩어리 유지
      JIGGLE: 0.25,        // 겹침 풀기가 길쭉한 모양으로 굳지 않게 매 프레임 주는 아주 작은 흔들림(논리 px)
      LABEL_LH: 1.2,
    };
    const css = getComputedStyle(document.documentElement);
    const INK = css.getPropertyValue('--ink').trim() || '#1e1e42';
    const INK_SOFT = css.getPropertyValue('--ink-soft').trim() || '#6e6a86';
    let rlay = null;          // 원 배치 캐시 (캔버스 크기·보기가 바뀌면 다시)
    let resultPer = null;     // 결과 화면 득표 (원 위 비율)
    let resultShownAt = 0;    // 연출이 끝나 비율이 나타나기 시작한 시각(0 = 바로 보임)

    let timerInterval = null;
    let rafHandle = null;
    let currentMode = 'chat';

    // 화면 배율: 설계 기준 폭(cfg.baseW — 세로형 800, 가로형 1040) 대비 실제 #screen 폭. CSS(--u)와 캔버스 좌표계에 함께 적용해
    // LED 해상도가 600이든 1080이든 화면 구성 비율이 완전히 동일하게 보이도록 한다.
    const BASE_W = cfg.baseW;
    const screenEl = document.getElementById('screen');
    let uScale = 1;

    function applyScreenScale() {
      uScale = (screenEl.clientWidth || BASE_W) / BASE_W;
      screenEl.style.setProperty('--u', uScale.toFixed(4));
    }
    applyScreenScale();

    // 캔버스 논리 크기 — 항상 BASE_W 기준으로 환산해서 쓴다 (상자·공 상수를 그대로 재사용)
    function logicalW() { return canvas.width / devicePixelRatio / uScale; }
    function logicalH() { return canvas.height / devicePixelRatio / uScale; }

    const canvasWrap = document.getElementById('voting-canvas-wrap');
    // 2지선다 결과(원 + 비율)는 캔버스가 직접 그린다(시안 6) — DOM 결과 배너는 비율 글자 보관용으로만 남음
    // 배너가 숨겨져 있어도(display:none) 잴 수 있게 잠깐 보이지 않는 채로 펼쳐서 fn 실행
    function withBannerShown(fn) {
      if (resultBanner.classList.contains('active')) return fn();
      resultBanner.style.visibility = 'hidden';
      resultBanner.style.display = 'block';
      try { return fn(); } finally {
        resultBanner.style.display = '';
        resultBanner.style.visibility = '';
      }
    }

    function resizeCanvas() {
      const rect = canvasWrap.getBoundingClientRect();
      canvas.width = rect.width * devicePixelRatio;
      canvas.height = rect.height * devicePixelRatio;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      headFit = null; // 상자 폭이 바뀌면 헤더 라벨 줄바꿈도 다시
      rlay = null;    // 2지선다 원 배치도 다시
      // 캔버스 크기가 바뀌면 클러스터 중심도 바뀐다 → 공 목표 위치 재계산 (원 배치는 해바라기 자리로 바로)
      for (let i = 0; i < ballState.length; i++) repackSide(i, true);
    }
    // 질문 카드 실제 아래 끝에 맞춰 그 아래 콘텐츠(공 상자·막대·워드클라우드·흘러가는 답변)의 시작 위치를 잡는다.
    // 질문이 길어 카드가 커지면 CSS 기본값(22%/24%)으로는 카드가 콘텐츠를 덮는다. 아래 끝은 CSS(화면 아래 여백만)
    let belowQ = 0; // 질문 카드 아래 콘텐츠가 시작하는 y(px, 투표 레이어 기준)
    // 공 상자·막대가 최소한 차지할 높이(레이어 높이 대비, cfg.question.minAreaRatio). 질문 카드가 아무리 커도 이만큼은 남긴다
    const MIN_AREA = (cfg.question && cfg.question.minAreaRatio) || 0;
    function layoutBelowQuestion() {
      const layerH = votingLayer.clientHeight;
      if (!layerH) return; // 채팅 모드에선 레이어가 숨겨져 있어 측정 불가
      const qWrap = document.getElementById('voting-question-wrap');
      const qCard = document.getElementById('voting-question-card');
      // offsetHeight는 팝인 transform의 영향을 받지 않아 등장 애니메이션 중에도 정확
      const bottom = qWrap.offsetTop + qCard.offsetHeight;
      const gap = 16 * uScale; // 카드와 콘텐츠 사이 (예전 3%는 긴 질문일 때 막대 칸을 너무 많이 먹음)
      belowQ = bottom + gap;
      // 아래 끝은 CSS(공 상자 3%·워드클라우드 5% 여백) — 최소 높이를 넘겨 밀어내지 않음
      const cap = (bottomRatio) => (MIN_AREA ? layerH * (1 - bottomRatio - MIN_AREA) : Infinity);
      canvasWrap.style.top = Math.min(cap(0.03), Math.max(layerH * 0.22, belowQ)) + 'px';
      cloudWrap.style.top = Math.min(cap(0.05), Math.max(layerH * 0.24, belowQ)) + 'px';
    }

    // 질문 글자 맞춤 (cfg.question { maxLines, minPx } — 가로형): 최대 maxLines줄 → 넘치면 글자를 minPx(논리 px)까지
    // 한 단계씩 축소 → 그래도 넘치면 maxLines줄째 끝에서 말줄임 "…" (장평 압축 없음, 기존 글자 맞춤 원칙 순서).
    // 돌려준 글자를 LedFx.question.render에 넘긴다. 같은 질문·같은 화면 폭이면 DOM을 다시 재지 않음(진행 중인 어절 등장 유지)
    const QFIT = cfg.question && cfg.question.maxLines ? cfg.question : null;
    let qFitKey = null, qFit = null, qMeasure = null;
    function fitQuestion(text) {
      text = text || '';
      if (!QFIT) return text;
      const el = votingQuestion;
      const qWrap = document.getElementById('voting-question-wrap');
      const qCard = document.getElementById('voting-question-card');
      const pad = (e) => { const c = getComputedStyle(e); return parseFloat(c.paddingLeft) + parseFloat(c.paddingRight); };
      // 카드는 글자만큼 줄어드는 inline-block(최대 폭 100%) — 긴 질문은 최대 폭에서 줄이 바뀌므로 그 폭으로 잰다
      const maxW = qWrap.clientWidth - pad(qWrap) - pad(qCard);
      const k = text + '\u0000' + Math.round(maxW);
      if (k === qFitKey) { el.style.fontSize = qFit.font; return qFit.shown; }
      // 화면에 보이는 질문(어절 등장 중일 수 있음)은 건드리지 않고, 같은 글꼴·줄바꿈 규칙의 숨은 복사본으로 잰다
      el.style.fontSize = '';
      const cs = getComputedStyle(el);
      if (!qMeasure) {
        qMeasure = document.createElement('div');
        qMeasure.setAttribute('aria-hidden', 'true');
        qMeasure.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;';
      }
      if (qMeasure.parentNode !== qWrap) qWrap.appendChild(qMeasure);
      ['fontFamily', 'fontWeight', 'letterSpacing', 'wordBreak', 'overflowWrap', 'textAlign', 'textWrap'].forEach((p) => { qMeasure.style[p] = cs[p]; });
      qMeasure.style.width = maxW + 'px';
      const basePx = parseFloat(cs.fontSize) || 0;
      const lhRatio = (parseFloat(cs.lineHeight) || basePx * 1.4) / basePx;
      const minPx = Math.min(basePx, QFIT.minPx * uScale);
      const setPx = (px) => { qMeasure.style.fontSize = px + 'px'; qMeasure.style.lineHeight = (px * lhRatio) + 'px'; };
      const lines = (px) => qMeasure.scrollHeight / (px * lhRatio);
      qMeasure.textContent = text;
      let px = basePx;
      setPx(px);
      const step = Math.max(1, uScale);
      while (lines(px) > QFIT.maxLines + 0.25 && px > minPx) { px = Math.max(minPx, px - step); setPx(px); }
      let shown = text;
      if (lines(px) > QFIT.maxLines + 0.25 && LedFx.text.clamp(qMeasure, text, QFIT.maxLines)) shown = qMeasure.textContent;
      qMeasure.remove();
      qFitKey = k;
      qFit = { font: px < basePx ? px + 'px' : '', shown, px: px / uScale, cut: shown !== text };
      el.style.fontSize = qFit.font;
      return shown;
    }

    // 창 크기를 바꾸는 동안 resize가 연달아 오므로, 무거운 DOM 다시 재기(막대·엔딩·대기 화면)는 멈춘 뒤 150ms에 한 번만
    // (캔버스 크기·배율은 그리기 좌표와 맞아야 하므로 바로)
    let relayoutTimer = null;
    // 가로형 질문 글자 맞춤은 화면 폭이 바뀌면 다시 (어절 등장 없이)
    function refitQuestion() {
      if (!QFIT || !votingLayer.classList.contains('active') || votingQuestion.dataset.fxSrc == null) return;
      const shown = fitQuestion(votingQuestion.dataset.fxSrc);
      if (shown !== votingQuestion.dataset.fxText) LedFx.question.render(votingQuestion, shown, false); // 글자가 같으면 어절 등장 유지
    }
    window.addEventListener('resize', () => {
      applyScreenScale(); refitQuestion(); layoutBelowQuestion(); resizeCanvas();
      // 숫자 변신 중 크기가 바뀌면 글자 위치가 어긋나므로 바로 최종 화면(원 + 비율)으로
      if (reveal) { reveal = null; resultShownAt = 0; }
      cloudFx.relayout(); // 워드클라우드 자리도 새 크기로 다시 잡음 (자체 150ms 지연)
      pickFx.settle(); pinFx.settle(); // 들어올리던 카드는 바로 최종 자리로 (잰 좌표가 어긋나므로)
      if (relayoutTimer) clearTimeout(relayoutTimer);
      relayoutTimer = setTimeout(() => {
        relayoutTimer = null;
        barRace.relayout(); // 막대 행 높이·간격도 새 칸에 맞춰
        endingFx.relayout(); // 엔딩 슬라이드도 새 화면 높이에 맞춰
        idleFx.relayout(); // 대기 화면 QR·피드도 새 크기로
      }, 150);
    });

    // 웹폰트(Pretendard 글자 묶음)가 늦게 도착하면 글자 폭·줄바꿈이 바뀌므로 잰 배치를 다시 잰다
    // (워드클라우드는 자리를 다시 섞어 깜빡이므로 제외 — 질문 카드는 클라우드보다 먼저 그려져 이미 글꼴이 있음)
    if (document.fonts && document.fonts.addEventListener) {
      document.fonts.addEventListener('loadingdone', () => {
        if (votingLayer.classList.contains('active')) { qFitKey = null; refitQuestion(); layoutBelowQuestion(); resizeCanvas(); barRace.relayout(); }
        endingFx.relayout();
        idleFx.refitUrl();
      });
    }

    // 점검용(QA 하네스): 지금 그려진 상자 헤더 라벨·숫자 변신 라벨의 글자 크기와 줄
    window.LedFx.page.inspect = () => {
      const f = headFit;
      const measure = (px, lines) => { ctx.font = `700 ${px}px ${BOX_FONT}`; return lines.map((t) => ({ t, w: Math.round(ctx.measureText(t).width) })); };
      return {
        u: uScale,
        canvas: { top: canvasWrap.offsetTop, h: canvasWrap.clientHeight, layerH: votingLayer.clientHeight, belowQ },
        question: qFit && { px: qFit.px, cut: qFit.cut },
        header: f ? { px: f.px, maxW: Math.round(f.maxW), h: f.h, labels: f.labels.map((ls) => measure(f.px, ls)) } : null,
        reveal: reveal ? { px: reveal.labelFit.px, maxW: Math.round(reveal.labelMaxW), cut: reveal.labelFit.cut, lines: measure(reveal.labelFit.px, reveal.labelFit.lines) } : null,
      };
    };

    function initBallState(n) {
      ballState = [];
      for (let i = 0; i < n; i++) ballState.push({ balls: [] });
    }

    // 보기 수에 맞춘 상자 격자 { cols, rows } — 화면 비율마다 다르므로 페이지 설정에서
    const clusterLayout = cfg.clusterLayout;

    // 모서리별 반경을 따로 주는 둥근 사각형 경로 (헤더는 위쪽만 둥글게)
    function roundRectPath(x, y, w, h, tl, tr, br, bl) {
      ctx.beginPath();
      ctx.moveTo(x + tl, y);
      ctx.lineTo(x + w - tr, y);
      ctx.arcTo(x + w, y, x + w, y + tr, tr);
      ctx.lineTo(x + w, y + h - br);
      ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
      ctx.lineTo(x + bl, y + h);
      ctx.arcTo(x, y + h, x, y + h - bl, bl);
      ctx.lineTo(x, y + tl);
      ctx.arcTo(x, y, x + tl, y, tl);
      ctx.closePath();
    }

    // 보기 상자 위치·크기. 본문(헤더 아래) 한가운데가 공 클러스터 중심과 맞도록 배치하고,
    // 표가 쌓여 무리가 커지면 셀 크기 한도까지 상자도 함께 커진다.
    function boxRect(i) {
      const w = logicalW();
      const h = logicalH();
      const n = Math.max(1, optCount);
      const { cols, rows } = clusterLayout(n);
      const row = Math.floor(i / cols);
      const col = i % cols;
      const itemsInRow = (row === rows - 1) ? (n - row * cols) : cols;

      // 크기는 표 수와 무관하게 고정 — 보기끼리 상자 크기가 달라 보이거나 서로 겹치면 안 됨.
      // 표가 많아 무리가 상자보다 커지면 공 쪽을 축소해 담는다(drawFrame의 fit).
      const margin = w * BOX.marginRatio;
      const bw = Math.max(BOX.minW, (w - margin * 2 - BOX.gap * (cols - 1)) / cols);
      const bh = Math.min(Math.max(BOX.minW, (h - BOX.gap * (rows - 1)) / rows), bw * maxAspectFor(cols, rows));

      // 마지막 행이 덜 찼으면 그 행만 가운데 정렬
      const rowW = itemsInRow * bw + (itemsInRow - 1) * BOX.gap;
      const gridH = rows * bh + (rows - 1) * BOX.gap;
      return {
        x: (w - rowW) / 2 + col * (bw + BOX.gap),
        y: (h - gridH) / 2 + row * (bh + BOX.gap),
        w: bw,
        h: bh,
      };
    }

    // ── 상자 헤더 라벨: 장평 압축 없이 2줄까지 → 글자 크기를 cfg.boxLabel.minPx까지 → 말줄임 ──
    // 모든 상자가 같은 글자 크기·같은 헤더 높이 (같은 역할 = 같은 모양). 헤더는 2줄이면 그만큼 높아진다
    const HEAD_PAD_X = 10, HEAD_PAD_Y = 7, HEAD_LH = 1.18;
    let headFit = null; // { px, labels: [줄 배열], maxW, h } — 보기·캔버스 크기·글꼴이 바뀌면 다시 계산
    function headerFit() {
      if (headFit) return headFit;
      const n = Math.max(1, optCount);
      const maxW = boxRect(0).w - HEAD_PAD_X * 2;
      const o = { maxW, maxPx: cfg.boxLabel.maxPx(n), minPx: cfg.boxLabel.minPx, maxLines: 2, family: BOX_FONT, lineH: HEAD_LH };
      let px = o.maxPx;
      voteOptions.forEach((l) => { px = Math.min(px, LedFx.text.fit(ctx, String(l), o).px); });
      const fits = voteOptions.map((l) => LedFx.text.fit(ctx, String(l), Object.assign({}, o, { maxPx: px })));
      const lines = Math.max(1, ...fits.map((f) => f.lines.length));
      headFit = { px, labels: fits.map((f) => f.lines), maxW, h: Math.max(BOX.headerH, Math.ceil(lines * px * HEAD_LH + HEAD_PAD_Y * 2)) };
      return headFit;
    }
    const headH = () => headerFit().h;

    function drawBox(box, color, i) {
      const r = BOX.radius;
      // 흰 본문 + 그림자
      ctx.save();
      ctx.shadowColor = 'rgba(30, 30, 66, 0.12)';
      ctx.shadowBlur = 24;
      ctx.shadowOffsetY = 8;
      roundRectPath(box.x, box.y, box.w, box.h, r, r, r, r);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();
      // 컬러 헤더 (위쪽 모서리만 둥글게)
      ctx.save();
      const hf = headerFit();
      roundRectPath(box.x, box.y, box.w, hf.h, r, r, 0, 0);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.clip();
      ctx.font = `700 ${hf.px}px ${BOX_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      const lines = hf.labels[i] || [];
      const lh = hf.px * HEAD_LH;
      lines.forEach((ln, k) => ctx.fillText(ln, box.x + box.w / 2, box.y + hf.h / 2 + 1 + (k - (lines.length - 1) / 2) * lh));
      ctx.restore();
    }

    // ── 벌집 쌓기 ── 상자 바닥부터 한 줄씩 채워 올린다. 쌓인 높이가 곧 표 수.
    const BALL_GAP = 1.1;   // 공 사이 간격 배율 (1이면 딱 붙어 겹쳐 보임)
    const HEADROOM = 1.12;  // 1등 보기가 천장에 닿지 않도록 남기는 여유
    const ROW_RATIO = Math.sqrt(3); // 벌집 배열의 줄 간격 = r * √3

    function hexPerRow(innerW, r) { return Math.max(1, Math.floor(innerW / (2 * r * BALL_GAP))); }
    function hexRowCount(innerH, r) { return Math.max(1, Math.floor((innerH - 2 * r) / (r * ROW_RATIO * BALL_GAP)) + 1); }

    // 반지름 r일 때 상자 하나에 담기는 공의 최대 개수 (홀수 줄은 반 칸 어긋나 하나 적음)
    function hexCapacity(innerW, innerH, r) {
      const per = hexPerRow(innerW, r);
      const rows = hexRowCount(innerH, r);
      const odd = Math.floor(rows / 2);
      return (rows - odd) * per + odd * Math.max(1, per - 1);
    }

    // 가장 많은 표(maxCount)가 상자에 딱 담기는 최대 반지름을 이분 탐색으로 찾는다
    function computeBallR(maxCount) {
      if (maxCount <= 0) return BALL_MAX_R;
      if (isRound()) {
        // 해바라기 배치 바깥 반지름 ≈ 간격 × √n + r 이 원 반지름 안에 들어가게
        const R = roundLayout().R;
        return Math.max(BALL_MIN_R, Math.min(BALL_MAX_R, R * 0.94 / (ROUND.SPACING * Math.sqrt(maxCount * HEADROOM + 0.5) + 1)));
      }
      const b = boxRect(0);
      const innerW = b.w - BOX.pad * 2;
      const innerH = b.h - headH() - BOX.pad * 2;
      const need = maxCount * HEADROOM;
      if (hexCapacity(innerW, innerH, BALL_MAX_R) >= need) return BALL_MAX_R;
      let lo = BALL_MIN_R, hi = BALL_MAX_R;
      for (let k = 0; k < 20; k++) {
        const mid = (lo + hi) / 2;
        if (hexCapacity(innerW, innerH, mid) >= need) lo = mid; else hi = mid;
      }
      return lo;
    }

    function hexPositions(box, r, count) {
      const per = hexPerRow(box.w - BOX.pad * 2, r);
      const step = 2 * r * BALL_GAP;
      const rowH = r * ROW_RATIO * BALL_GAP;
      const bottom = box.y + box.h - BOX.pad - r;
      const cx = box.x + box.w / 2;
      const out = [];
      let row = 0;
      while (out.length < count && row < 600) {
        const cap = (row % 2 && per > 1) ? per - 1 : per;
        const take = Math.min(cap, count - out.length);
        const startX = cx - (take - 1) * step / 2; // 줄마다 가운데 정렬 → 홀수 줄이 자연스럽게 반 칸 어긋남
        for (let c = 0; c < take; c++) out.push({ x: startX + c * step, y: bottom - row * rowH });
        row++;
      }
      return out;
    }

    function repackSide(i, snap) {
      const slots = ballState[i];
      if (!slots) return;
      if (isRound()) { if (snap) placeRound(i); return; } // 원 배치는 겹침 풀기가 자리를 잡음 — 스냅 때만 해바라기 자리로
      const pos = hexPositions(boxRect(i), curBallR, slots.balls.length);
      slots.balls.forEach((p, k) => {
        if (!pos[k]) return;
        p.tx = pos[k].x;
        p.ty = pos[k].y;
      });
    }

    // 표 개수에 맞춰 공 배열 길이 조정. 새 공은 헤더 바로 아래, 자기 자리 바로 위에서 떨어진다.
    // snap=true(모드 진입·재접속)면 낙하 없이 제자리에 바로 놓는다.
    function syncBalls(i, desired, snap) {
      const arr = ballState[i].balls;
      if (isRound()) {
        // 새 표는 화면 아래 가장자리에서 원 가운데로 곡선을 그리며 날아온 뒤(시안 1), 가운데에서 0부터 커지며
        // 주변 공을 바깥으로 밀어낸다. 한꺼번에 들어오면 조금씩 시차. 동작 줄이기면 날지 않고 가운데에서 커지기만
        const c = roundLayout().centers[i];
        const now = performance.now();
        const fly = !snap && !LedFx.prefersReduced();
        let order = 0;
        while (arr.length < desired) {
          const a = Math.random() * Math.PI * 2;
          const w = logicalW();
          arr.push({ x: c.x + Math.cos(a) * 2, y: c.y + Math.sin(a) * 2, phase: Math.random() * Math.PI * 2,
            born: snap ? -1e9 : now + Math.min(ROUND.STAGGER_MAX, order++ * ROUND.STAGGER), rr: 0,
            fly: fly ? { x: w * (0.08 + Math.random() * 0.84), y: logicalH() + 20 } : null });
        }
        while (arr.length > desired) arr.pop();
        return;
      }
      if (arr.length < desired) {
        const box = boxRect(i);
        const pos = hexPositions(box, curBallR, desired);
        const fromY = box.y + headH() + curBallR;
        const now = performance.now();
        let order = 0;
        while (arr.length < desired) {
          // 표가 비정상적으로 많아 hexPositions가 줄 상한에서 멈추면 칸이 모자람 → 상자 가운데로 대신
          const slot = pos[arr.length] || { x: box.x + box.w / 2, y: fromY };
          const ball = { x: slot.x, y: slot.y, tx: slot.x, ty: slot.y, phase: Math.random() * Math.PI * 2, drop: null };
          if (!snap) LedFx.balls.startDrop(ball, fromY, order++, now);
          arr.push(ball);
        }
      }
      while (arr.length > desired) arr.pop();
    }

    // 모든 보기를 한 번에 갱신 — 공 크기는 보기 전체의 최댓값 기준이라 개별 갱신하면 안 됨.
    // snap=true면 크기 변화 애니메이션 없이 즉시 반영(모드 진입·재접속 시).
    function applyAllCounts(perOption, snap) {
      let maxCount = 0;
      for (let i = 0; i < optCount; i++) maxCount = Math.max(maxCount, (perOption && perOption[i]) || 0);
      ballR = computeBallR(maxCount);
      if (snap) curBallR = ballR;
      for (let i = 0; i < optCount; i++) {
        if (!ballState[i]) continue;
        syncBalls(i, (perOption && perOption[i]) || 0, snap);
        repackSide(i, snap);
      }
    }

    // ── 2지선다(YES/NO·보기 2개): 시안 1·6의 원형 공 덩어리 ──
    // 새 표 = 원 가운데에서 커지며 주변 공을 바깥으로 스르륵 밀어냄(겹침 풀기). 원 아래 보기 이름,
    // 결과 화면에선 원 위에 비율(이긴 쪽 크게). 3지 이상은 상자 + 막대 경주 그대로
    function roundLayout() {
      if (rlay) return rlay;
      const w = logicalW(), h = logicalH();
      const pctPx = Math.round(Math.min(64, w * 0.068, h * 0.1));
      const o = { maxW: w * 0.42, maxPx: Math.round(Math.min(40, w * 0.046)), minPx: cfg.boxLabel.minPx, maxLines: 2, family: BOX_FONT, lineH: ROUND.LABEL_LH };
      let px = o.maxPx;
      voteOptions.forEach((l) => { px = Math.min(px, LedFx.text.fit(ctx, String(l), o).px); });
      const labels = voteOptions.map((l) => LedFx.text.fit(ctx, String(l), Object.assign({}, o, { maxPx: px })).lines);
      const labH = Math.max(1, ...labels.map((ls) => ls.length)) * px * ROUND.LABEL_LH;
      const pctBand = pctPx * 1.6, gap = 18;
      const R = Math.max(30, Math.min(w * 0.2, (h - pctBand - gap - labH - 16) / 2));
      const y0 = Math.max(0, (h - (pctBand + 2 * R + gap + labH)) / 2);
      const cy = y0 + pctBand + R;
      const dx = Math.max(w * 0.22, R + w * 0.035);
      rlay = { R, pctPx, px, labels, pctY: y0 + pctPx * 0.8, labTop: cy + R + gap,
        centers: [{ x: w / 2 - dx, y: cy }, { x: w / 2 + dx, y: cy }] };
      return rlay;
    }

    // 스냅(모드 진입·재접속·창 크기 변경): 해바라기 자리에 바로 놓음
    function placeRound(i) {
      const c = roundLayout().centers[i];
      const step = ballR * ROUND.SPACING;
      ballState[i].balls.forEach((b, k) => {
        const d = step * Math.sqrt(k + 0.5), a = k * 2.39996;
        b.x = c.x + d * Math.cos(a); b.y = c.y + d * Math.sin(a);
      });
    }

    // 겹침 풀기: 원 중심으로 살짝 끌어당기고, 겹친 공끼리 조금씩 밀어냄(격자로 이웃만 검사 — 표가 많아도 가벼움)
    function relaxRound(arr, c, r, dt, now) {
      const pull = Math.min(0.2, ROUND.PULL * dt / 16);
      for (const b of arr) {
        const age = now - b.born - (b.fly ? ROUND.FLY_MS : 0); // 날아오는 동안은 덩어리에 끼지 않음
        if (b.fly && age >= 0) b.fly = null;
        b.rr = age <= 0 ? 0 : age >= ROUND.GROW_MS ? r : r * ease(age / ROUND.GROW_MS);
        b.x += (c.x - b.x) * pull + (b.rr ? (Math.random() - 0.5) * ROUND.JIGGLE : 0);
        b.y += (c.y - b.y) * pull + (b.rr ? (Math.random() - 0.5) * ROUND.JIGGLE : 0);
      }
      const cell = 2 * r * ROUND.GAP;
      for (let it = 0; it < 4; it++) {
        const grid = new Map();
        arr.forEach((b, i) => {
          if (!b.rr) return;
          const key = Math.floor(b.x / cell) * 65536 + Math.floor(b.y / cell);
          let g = grid.get(key); if (!g) grid.set(key, g = []); g.push(i);
        });
        arr.forEach((p, i) => {
          if (!p.rr) return;
          const gx = Math.floor(p.x / cell), gy = Math.floor(p.y / cell);
          for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
            const g = grid.get((gx + ox) * 65536 + gy + oy);
            if (!g) continue;
            for (const j of g) {
              if (j <= i) continue;
              const q = arr[j];
              let dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
              const min = (p.rr + q.rr) * ROUND.GAP;
              if (d >= min) continue;
              if (d < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = Math.hypot(dx, dy); }
              const push = (min - d) * 0.5 * 0.35; // 한 번에 겹침의 일부만 풀어 부드럽게
              p.x -= dx / d * push; p.y -= dy / d * push; q.x += dx / d * push; q.y += dy / d * push;
            }
          }
        });
      }
    }

    // 원 위 비율 한 줄: YES/NO처럼 짧은 이름은 "YES 62%", 긴 보기 이름은 아래에 있으니 "62%"만
    function drawRoundPct(L, alpha) {
      const sum = LedFx.result.summarize(resultPer || []);
      if (!sum.total) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let i = 0; i < 2; i++) {
        const pct = Math.round((sum.per[i] || 0) / sum.total * 100);
        const lab = String(voteOptions[i] || '');
        const t = lab.length <= 5 ? lab + ' ' + pct + '%' : pct + '%';
        const win = !sum.tie && sum.top[0] === i;
        let px = sum.tie || win ? L.pctPx : Math.round(L.pctPx * 0.8);
        ctx.font = `700 ${px}px ${BOX_FONT}`;
        const wMax = logicalW() * 0.44, tw = ctx.measureText(t).width;
        if (tw > wMax) { px = Math.floor(px * wMax / tw); ctx.font = `700 ${px}px ${BOX_FONT}`; }
        ctx.fillStyle = sum.tie || win ? INK : INK_SOFT;
        ctx.fillText(t, L.centers[i].x, L.pctY);
      }
      ctx.restore();
    }

    function drawRound(time) {
      const L = roundLayout();
      const now = performance.now();
      const dt = Math.min(50, now - (drawRound.last || now)); drawRound.last = now;
      if (reveal) {
        const done = reveal.draw(ctx, time);
        drawRoundLabels(L, reveal ? reveal.labelAlpha(time) : 1);
        if (done) { reveal = null; resultShownAt = time; }
        return;
      }
      for (let i = 0; i < 2; i++) {
        const arr = ballState[i] ? ballState[i].balls : [];
        relaxRound(arr, L.centers[i], curBallR, dt, now);
        ctx.fillStyle = colorFor(i);
        arr.forEach((b) => { if (b.rr > 0.2) { ctx.beginPath(); ctx.arc(b.x, b.y, b.rr, 0, Math.PI * 2); ctx.fill(); } });
        drawFlying(arr, L.centers[i], now);
      }
      drawRoundLabels(L, 1);
      if (currentMode === 'result') drawRoundPct(L, resultShownAt ? ease((time - resultShownAt) / 500) : 1);
    }

    // 날아오는 새 표: 화면 아래에서 원 가운데로 위로 솟는 곡선(시안 1) — 살짝 투명, 제 크기의 80%
    function drawFlying(arr, c, now) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      for (const b of arr) {
        if (!b.fly) continue;
        const t = now - b.born;
        if (t < 0) continue;
        const p = ease(t / ROUND.FLY_MS);
        const x = b.fly.x + (c.x - b.fly.x) * p;
        const y = b.fly.y + (c.y - b.fly.y) * p - Math.sin(p * Math.PI) * ROUND.FLY_ARC;
        ctx.beginPath(); ctx.arc(x, y, curBallR * 0.8, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }

    // 원 아래 보기 이름 (보기 색)
    function drawRoundLabels(L, alpha) {
      if (alpha <= 0.01) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `700 ${L.px}px ${BOX_FONT}`;
      for (let i = 0; i < 2; i++) {
        ctx.fillStyle = colorFor(i);
        (L.labels[i] || []).forEach((ln, k) => ctx.fillText(ln, L.centers[i].x, L.labTop + L.px / 2 + k * L.px * ROUND.LABEL_LH));
      }
      ctx.restore();
    }

    function drawBalls(balls, radius, color, time) {
      const jitter = radius * 0.07; // 흔들림도 공 크기에 비례 (겹쳐 보이지 않을 만큼만)
      ctx.fillStyle = color;
      const now = performance.now();
      balls.forEach((p) => {
        // 낙하 중엔 시간 기반 낙하(LedFx.balls), 끝나면 목표 위치로 부드럽게 수렴(반지름 축소 재배치 포함)
        const st = LedFx.balls.step(p, now);
        if (!st.dropping) {
          p.x += (p.tx - p.x) * 0.12;
          p.y += (p.ty - p.y) * 0.12;
        }
        if (!st.visible) return; // 시차를 두고 떨어질 공은 차례가 올 때까지 숨김
        ctx.beginPath();
        ctx.arc(
          p.x + Math.sin(time / 600 + p.phase) * jitter,
          p.y + Math.cos(time / 700 + p.phase) * jitter,
          radius, 0, Math.PI * 2
        );
        ctx.fill();
      });
    }

    function drawFrame(time) {
      ctx.save();
      ctx.scale(devicePixelRatio * uScale, devicePixelRatio * uScale); // 논리 좌표계(BASE_W 기준)
      ctx.clearRect(0, 0, logicalW(), logicalH());

      // 표가 늘어 공이 작아질 때 크기가 툭 튀지 않도록 부드럽게 수렴시키고, 그 크기로 다시 쌓는다
      curBallR += (ballR - curBallR) * 0.15;
      if (Math.abs(curBallR - ballR) < 0.05) curBallR = ballR;

      // 2지선다: 원형 공 덩어리 (결과 공개 연출 포함)
      if (isRound()) {
        drawRound(time);
        ctx.restore();
        rafHandle = requestAnimationFrame(drawFrame);
        return;
      }

      for (let i = 0; i < optCount; i++) repackSide(i);

      for (let i = 0; i < optCount; i++) {
        const slots = ballState[i];
        if (!slots) continue;
        const color = colorFor(i);
        const box = boxRect(i);
        drawBox(box, color, i); // 라벨은 헤더 안에

        ctx.save();
        roundRectPath(box.x, box.y + headH(), box.w, box.h - headH(), 0, 0, BOX.radius, BOX.radius);
        ctx.clip();
        drawBalls(slots.balls, curBallR, color, time);
        ctx.restore();
      }

      ctx.restore();
      rafHandle = requestAnimationFrame(drawFrame);
    }

    function startRenderLoop() {
      if (rafHandle) cancelAnimationFrame(rafHandle);
      resizeCanvas();
      rafHandle = requestAnimationFrame(drawFrame);
    }

    function stopRenderLoop() {
      if (rafHandle) cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }

    function updateTimerDisplay() {
      if (voteDeadline == null) return;
      const remain = Math.max(0, Math.ceil((voteDeadline - Date.now()) / 1000));
      votingTimer.textContent = remain;
      LedFx.timer.update(votingTimer, remain); // 마지막 5초 경고색·맥박, 0이면 멈춤
      timerGauge.hot(remain > 0 && remain <= LedFx.timer.HOT_SECONDS); // 게이지도 같은 시점에 경고색
    }

    function updateResultLine(counts) {
      const per = counts && counts.perOption ? counts.perOption : [];
      const total = counts && counts.total ? counts.total : 0;
      resultLine.innerHTML = '';
      voteOptions.forEach((label, i) => {
        const pct = total ? Math.round((per[i] || 0) / total * 100) : 0;
        // 항목 간격은 화면 배율을 따르는 공용 클래스(.fx-result-item). 보기 이름이 길면 한 줄 안에서 "…" — %는 항상 보임
        const item = document.createElement('span');
        item.className = 'fx-result-item';
        item.style.color = colorFor(i);
        const lab = document.createElement('span');
        lab.className = 'fx-result-lab';
        lab.textContent = String(label);
        item.append(lab, ` ${pct}%`);
        resultLine.appendChild(item);
      });
      // 한 줄에 다 안 들어가는 이름만 글자 단위로 줄여 "…" (CSS text-overflow 대신 — 잘린 글자가 반쯤 보이지 않게)
      withBannerShown(() => resultLine.querySelectorAll('.fx-result-lab').forEach((lab) => LedFx.text.clamp(lab, lab.textContent, 1)));
    }

    // ── 결과 연출 ── 2지선다(YES/NO 포함)는 숫자 변신, 3지 이상은 막대 경주.
    // 투표 → 결과로 "실시간" 넘어올 때만 재생하고, 재접속(state 스냅샷)은 최종 화면만 보여준다.
    let reveal = null;          // 진행 중인 숫자 변신 연출 (LedFx.result.createReveal)
    let canvasStopTimer = null; // 막대 경주로 넘어갈 때 캔버스가 사라진 뒤 렌더 루프를 멈춤
    let resultKey = null;       // 지금 보여주는 결과(질문·보기·득표) — 같은 결과 재전송 판별용
    const barRace = LedFx.result.createBarRace(document.getElementById('bar-race'));

    function stopResultFx() {
      reveal = null;
      resultPer = null;
      resultShownAt = 0;
      barRace.clear();
      if (canvasStopTimer) { clearTimeout(canvasStopTimer); canvasStopTimer = null; }
      canvas.classList.remove('fx-hidden');
    }

    function showResult(counts, live) {
      const per = counts && counts.perOption ? counts.perOption : [];
      updateResultLine(counts);

      if (optCount >= 3) {
        // 막대 경주: 상자 캔버스를 숨기고(실시간이면 서서히) 같은 자리에 막대를 보여준다. 배너는 막대가 대신함
        resultBanner.classList.remove('active');
        if (live) {
          canvas.classList.add('fx-hidden');
          canvasStopTimer = setTimeout(() => { canvasStopTimer = null; stopRenderLoop(); }, 500);
        } else {
          canvas.style.transition = 'none'; // 스냅샷은 바로 숨김
          canvas.classList.add('fx-hidden');
          void canvas.offsetWidth;
          canvas.style.transition = '';
          stopRenderLoop();
        }
        barRace.show({ labels: voteOptions, colors: OPTION_COLORS, perOption: per, animate: live });
        return;
      }

      // 2지선다: 원 + 비율(시안 6). 실시간으로 넘어오면 숫자 변신 연출 뒤 비율이 나타남
      resultBanner.classList.remove('active');
      resultPer = per;
      resultShownAt = 0;
      const sum = LedFx.result.summarize(per);
      // 표가 없거나·동작 줄이기·재접속이면 연출 없이 바로 원 + 비율
      if (!live || !sum.total || LedFx.prefersReduced()) return;
      const winner = sum.tie ? -1 : sum.top[0];
      reveal = LedFx.result.createReveal({
        W: logicalW(), H: logicalH(),
        sides: ballState.map((s, i) => ({ color: colorFor(i), balls: s.balls })),
        centers: roundLayout().centers,
        ballR: curBallR,
        winner,
        pct: sum.pct,
        label: winner < 0 ? '동률' : (voteOptions[winner] || ''),
        labelFamily: BOX_FONT,
        ink: INK,
        confettiColors: OPTION_COLORS,
      });
    }

    const answerStream = document.getElementById('answer-stream');
    const cloudWrap = document.getElementById('cloud-wrap');

    // isSnapshot: 접속(재접속) 때 받는 'state' — 질문 등장 연출을 다시 재생하지 않는다
    function applyState(state, isSnapshot) {
      const prevMode = currentMode;
      currentMode = state.mode;
      if (state.effects) heartBurst.setEnabled(LedFx.hearts.enabledFrom(state.effects));

      // 채팅 일시정지 상태는 모드와 별개로 항상 서버 값을 따른다(관리자 화면에서 제어)
      if (state.chatPaused) pauseChat(); else resumeChat();
      noticeFx.show(state.mode === 'chat' ? state.pinnedNotice : null); // 운영진 공지 띠는 채팅 화면에서만

      // 결과 화면에서 "같은" 결과가 다시 오면(재전송) 진행 중인 연출·막대를 끊지 않는다.
      // (끊긴 사이 다른 투표가 끝났다면 내용이 달라 새로 그림)
      const key = state.mode === 'result' ? JSON.stringify([state.question, state.voteOptions, state.counts]) : null;
      if (key && prevMode === 'result' && key === resultKey && (reveal || barRace.isActive())) return;
      resultKey = key;
      stopResultFx();

      // 대기·엔딩·함성 화면은 각 레이어가 맡고, 해당 모드가 아니면 숨긴다
      applySpecialScreens(state, isSnapshot);

      if (state.mode === 'chat' || SPECIAL_MODES.includes(state.mode)) {
        // 함성 미터는 흐린 채팅 위 반투명 판, 대기·엔딩은 불투명 화면이라 흐림 불필요
        chatLayer.classList.toggle('blurred', state.mode === 'applause' || state.mode === 'applauseResult');
        votingLayer.classList.remove('active');
        resultBanner.classList.remove('active');
        answerFx.clear();
        pickFx.clear();
        cloudFx.clear();
        stopRenderLoop();
        if (timerInterval) clearInterval(timerInterval);
        LedFx.timer.reset(votingTimer);
        timerGauge.stop();
        if (state.mode === 'chat') pinFx.show(state.pinnedChat || null, false); // 재접속·채팅 복귀 시 핀 상태 복원 (같은 핀이면 그대로)
        else pinFx.clear(); // 대기·엔딩·함성 화면에선 핀 숨김
        return;
      }

      // 질문 모드 공통 (voting/result/subjective/subjectiveResult)
      pinFx.clear(); // 질문 모드에선 핀 숨김 (들어올리던 중이어도 바로 정리)
      chatLayer.classList.add('blurred');
      votingLayer.classList.add('active');
      // 채팅 등 다른 화면에서 질문이 새로 시작될 때만 어절 단위 등장 (투표→결과·재접속 땐 그대로)
      votingQuestion.dataset.fxSrc = state.question || ''; // 맞추기 전 원래 질문 (화면 크기가 바뀌면 다시 맞춤)
      LedFx.question.render(votingQuestion, fitQuestion(state.question), LedFx.question.shouldAnimate(prevMode, state.mode, isSnapshot));
      votingQuestion.style.display = 'block'; // 질문은 결과에서도 항상 유지
      layoutBelowQuestion();                  // 질문 길이에 따라 아래 콘텐츠 위치 재조정

      // 마감 직전 경고 맥박은 투표 중에만 (서버 마감이 0초 표시보다 먼저 올 수 있음). 결과 화면은 아래에서 "마감"
      if (state.mode !== 'voting') { LedFx.timer.reset(votingTimer); timerGauge.stop(); }

      const isVote = state.mode === 'voting' || state.mode === 'result';
      if (isVote) {
        // 선택형(YES/NO·N지선다): 공 클러스터 렌더
        answerFx.clear();
        pickFx.clear();
        cloudFx.clear();
        voteOptions = state.voteOptions || [];
        voteType = state.voteType || 'yesno';
        optCount = voteOptions.length;
        initBallState(optCount);
        resizeCanvas(); // 공 배치 전에 캔버스 실제 크기 확정 (기본값 300x150 상태로 배치되는 것 방지)
        const per = state.counts && state.counts.perOption ? state.counts.perOption : [];
        applyAllCounts(per, true);
        startRenderLoop();
      } else {
        // 주관식/이모지: 공 캔버스 정지 + 잔상 제거
        stopRenderLoop();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }

      if (state.mode === 'voting') {
        // 투표 중엔 숫자 배너 없이 공 클러스터 이동만으로 실시간 현황을 보여줌
        resultBanner.classList.remove('active');
        votingTimer.style.display = 'inline-flex';
        const remainMs = Math.max(0, Number(state.votingRemainMs) || 0);
        voteDeadline = Date.now() + remainMs;
        timerGauge.start(voteDeadline, (Number(state.votingDuration) || 0) * 1000);
        if (timerInterval) clearInterval(timerInterval); // setTimeout id도 clearInterval로 지워진다(같은 id 목록)
        const tick = () => {
          updateTimerDisplay();
          const r = voteDeadline - Date.now();
          timerInterval = r > 0 ? setTimeout(tick, LedFx.timer.nextTickMs(r)) : null;
        };
        tick();
      } else if (state.mode === 'result') {
        // 타이머 원은 "마감"으로 남기고(시안 2), 질문은 상단에 유지해 무엇에 대한 결과인지 상기시킴
        if (timerInterval) clearInterval(timerInterval);
        votingTimer.style.display = 'inline-flex';
        LedFx.timer.done(votingTimer);
        // 투표 중이던 화면에서 실시간으로 넘어올 때만 결과 공개 연출
        showResult(state.counts, !isSnapshot && prevMode === 'voting');
      } else if (state.mode === 'subjective') {
        // 답변 접수 중: 타이머 없음, 답변 흘려보내기
        if (timerInterval) clearInterval(timerInterval);
        votingTimer.style.display = 'none';
        resultBanner.classList.remove('active');
        cloudFx.clear();
        if (prevMode !== 'subjective') pickFx.clear(); // 새 주관식 질문: 이전 질문의 픽 카드가 남아 있지 않게
        answerFx.start();
      } else if (state.mode === 'subjectiveResult') {
        // 마감: 접수 화면에서 실시간으로 넘어오면 흐르던 답변이 단어 자리로 모이고,
        // 재접속(state)이면 최종 워드클라우드를 바로 보여줌
        if (timerInterval) clearInterval(timerInterval);
        votingTimer.style.display = 'none';
        resultBanner.classList.remove('active');
        cloudFx.show(state.cloud || [], { live: !isSnapshot && prevMode === 'subjective' });
      } else if (state.mode === 'emoji') {
        // 이모지 반응: 타이머/배너/공 없음. 이모지는 reaction-layer로 떠오름(emojiFloat)
        if (timerInterval) clearInterval(timerInterval);
        votingTimer.style.display = 'none';
        resultBanner.classList.remove('active');
        answerFx.clear();
        pickFx.clear();
        cloudFx.clear();
      }
    }

    // ── 대기 화면 · 엔딩 · 함성 미터 ── 움직임은 LedFx, 여기서는 레이어와 설정만
    const SPECIAL_MODES = ['idle', 'ending', 'applause', 'applauseResult'];
    // 대기 화면 QR = 이 LED 테마의 관객 주소 (cfg.audiencePath — 세로형 '/', 가로형 '/concert')
    const idleFx = LedFx.idle.create({ layer: document.getElementById('idle-layer'), url: location.origin + cfg.audiencePath, colors: OPTION_COLORS, scale: () => uScale });
    const endingFx = LedFx.ending.create({ layer: document.getElementById('ending-layer'), colors: OPTION_COLORS, yesnoColors: YESNO_COLORS });
    const applauseFx = LedFx.applause.create({ layer: document.getElementById('applause-layer'), colors: OPTION_COLORS });
    // 주소에 ?mic=1 인 화면만 마이크로 함성을 잰다 (그 외 화면은 마이크를 요청하지 않음 → null)
    const micFx = LedFx.applause.createMic({
      search: location.search,
      host: screenEl,
      // volatile: 끊긴 동안의 레벨은 쌓아 두지 않고 버린다 (다시 붙었을 때 지난 값이 몰려가지 않게)
      emit: (level) => socket.volatile.emit('applauseLevel', { level }),
    });
    // 키가 없거나 틀리면 서버가 레벨을 받지 않는다 — 마이크 화면에 작게 안내
    const MIC_KEY_WARN = '마이크 화면은 운영진 키가 필요합니다 (주소에 &key=운영진키)';
    if (micFx) {
      if (!micKey) micFx.authWarn(MIC_KEY_WARN);
      socket.on('authError', () => micFx.authWarn(MIC_KEY_WARN));
    }

    function applySpecialScreens(state, isSnapshot) {
      const m = state.mode;
      if (m === 'idle') idleFx.show(); else idleFx.hide();
      // 엔딩 장 넘김은 서버 상태(관리자)만 따른다 — 실시간 전환일 때만 밀리는 연출
      if (m === 'ending') endingFx.show(state.ending, { animate: !isSnapshot }); else endingFx.hide();
      if (m === 'applause') applauseFx.start(state.applause);
      else if (m === 'applauseResult') applauseFx.result(state.applause);
      else applauseFx.hide();
      // 측정 중에만 마이크 분석 (회차 = 종료 시각 — 새 회차면 바닥 소음을 다시 잼)
      if (micFx) { if (m === 'applause') micFx.start(state.applause && state.applause.endTime); else micFx.stop(); }
    }

    // 서버가 모은 함성 레벨(모든 마이크 화면 공용) → 게이지
    socket.on('applauseLevel', (data) => {
      if (currentMode !== 'applause') return;
      applauseFx.level(data);
    });

    // ── 주관식: 답변 흘려보내기 · 워드클라우드 · 제작진 픽 ──
    // 움직임·판단은 LedFx(공용)에서, 여기서는 화면 요소와 설정만 넘긴다
    // 흘러가는 답변은 질문 카드 아래로만 (카드 뒤로 지나가지 않게)
    const answerFx = LedFx.answers.create({
      el: answerStream,
      scale: () => uScale,
      area: () => ({ top: belowQ || answerStream.clientHeight * 0.24, bottom: answerStream.clientHeight * 0.95 }),
    });

    // 인접한 답변이 같은 색이 되지 않도록 팔레트를 순환 배정 (랜덤 X)
    const CLOUD_COLORS = [
      '#1e1e42', '#fb7e55', '#5b5cc4', '#2fb3a3', '#e3557f',
      '#f2a03d', '#4a4a7a', '#c2544a', '#7b6cf0', '#1f8f83',
    ];
    const cloudFx = LedFx.cloud.create({ wrap: cloudWrap, stream: answerFx, colors: CLOUD_COLORS, scale: () => uScale });

    const SPOTLIGHT_DURATION = 8000; // 픽 카드 표시 유지 시간(ms)
    const pickFx = LedFx.spotlight.create({
      layer: document.getElementById('spotlight'),
      cardClass: 'spotlight-card',
      stream: answerFx,
      duration: SPOTLIGHT_DURATION,
      scale: () => uScale,
    });

    socket.on('subjectiveAnswer', (data) => {
      if (currentMode !== 'subjective') return;
      answerFx.push(data);
    });

    // 제작진 픽 → 흐르던 답변이면 카드로 늘어나고, 아니면 카드 팝인 (접수 중/마감 후 모두)
    socket.on('answerPicked', (data) => {
      if (currentMode !== 'subjective' && currentMode !== 'subjectiveResult') return;
      pickFx.pick(data);
    });

    socket.on('state', (s) => applyState(s, true));
    socket.on('modeChange', (s) => applyState(s, false));

    // 관리자가 연출 설정(하트 폭발 on/off)을 바꾸면 화면에 바로 반영
    socket.on('effectsChange', (data) => {
      heartBurst.setEnabled(LedFx.hearts.enabledFrom(data && data.effects));
    });

    socket.on('voteUpdate', (data) => {
      if (currentMode !== 'voting') return;
      applyAllCounts(data.counts && data.counts.perOption ? data.counts.perOption : [], false);
    });

    // ── 리액션 (하트/붐업) — 랜덤 위치에서 떠오르며 사라지는 이모지 ──
    const reactionLayer = document.getElementById('reaction-layer');
    const MAX_REACTIONS = 80; // 동시 표시 상한 (LED 성능 보호)

    const REACTION_EMOJI = { heart: '❤️', thumbs: '👍', down: '👎' };

    // 하트가 3초 안에 40개 이상 몰리면 가운데 큰 하트가 터짐 (채팅·결과·대기 화면에서만)
    const heartBurst = LedFx.hearts.create(reactionLayer, OPTION_COLORS);

    // 이모지 하나를 랜덤 위치에서 떠오르게 (리액션·이모지 질문 공용)
    function spawnFloat(text) {
      if (reactionLayer.childElementCount >= MAX_REACTIONS) return;
      const el = document.createElement('div');
      el.className = 'reaction-float';
      el.textContent = text;
      el.style.left = (8 + Math.random() * 80) + '%';   // 랜덤 가로 위치
      // 크기·떠오르는 높이·흔들림은 화면 배율(--u)을 따름 — 설계 기준 화면(세로 800·가로 1040 폭)에선 예전과 같은 28~54px·140px
      const u = uScale;
      const size = Math.round((28 + Math.random() * 26) * u);
      const rise = 140 * u;
      const H = reactionLayer.clientHeight;
      if (votingLayer.classList.contains('active') && belowQ && H) {
        // 질문 화면: 떠오르는 높이만큼 띄워 질문 카드 글자를 가리지 않게 — 카드 아래 ~ 화면 아래 사이
        const min = belowQ + rise + size, max = Math.max(min, H * 0.9 - size);
        el.style.top = Math.min(max, min + Math.random() * (max - min)) + 'px';
      } else {
        el.style.top = (25 + Math.random() * 60) + '%';   // 랜덤 세로 위치
      }
      el.style.fontSize = size + 'px'; // 랜덤 크기
      reactionLayer.appendChild(el);

      const driftX = (Math.random() * 60 - 30) * u; // 좌우로 살짝 흔들리며 상승
      el.animate([
        { transform: 'translate(0, 0) scale(0)', opacity: 0 },
        { transform: `translate(${driftX * 0.3}px, ${-25 * u}px) scale(1.2)`, opacity: 1, offset: 0.15 },
        { transform: `translate(${driftX}px, ${-rise}px) scale(1)`, opacity: 0 },
      ], {
        duration: 1800 + Math.random() * 700,
        easing: 'ease-out',
      }).onfinish = () => el.remove();
    }

    socket.on('reaction', (data) => {
      const type = data && data.type;
      if (!REACTION_EMOJI[type]) return;
      spawnFloat(REACTION_EMOJI[type]);
      heartBurst.onReaction(type, currentMode);
    });

    // 이모지 반응 질문: 관객이 고른 이모지가 떠오름
    socket.on('emojiFloat', (data) => {
      const emo = data && data.emoji;
      if (typeof emo === 'string' && emo) spawnFloat(emo);
    });

    // 관리자 화면에서 채팅 정지/재생을 누르면 서버가 모든 화면에 broadcast
    socket.on('chatPauseChange', (data) => {
      if (data && data.chatPaused) pauseChat(); else resumeChat();
    });

    // ── 채팅 핀 (관리자가 특정 채팅을 클릭해 고정) ──
    // 채팅 화면에 보이는 말풍선이면 카드 색으로 물든 뒤 가운데 카드로 떠오르고, 아니면 카드가 팝인 (LedFx.pin)
    const pinFx = LedFx.pin.create({
      layer: document.getElementById('chat-pin'),
      feed: container,
      findBubble: (id) => container.querySelector('.led-msg-group[data-id="' + CSS.escape(String(id)) + '"] .led-bubble'),
      canLift: () => !chatPaused, // 일시정지 중엔 화면이 멈춰 있어 말풍선 대신 팝인
      cardClass: 'chat-pin-card',
      nickClass: 'chat-pin-nick',
      textClass: 'chat-pin-text',
      scale: () => uScale,
    });

    socket.on('chatPinned', (data) => {
      pinFx.show(data && data.message, true);
    });

    // ── 운영진 공지 핀 (관리자가 운영진 채팅을 핀) — 세로형은 헤더 바로 아래 띠 ──
    // cfg.notice === false(가로형 콘서트 LED)면 받아도 표시하지 않는다 (사용자 결정: 세로형 LED·관객 폰·운영진 화면만)
    const noticeEl = document.getElementById('notice-pin');
    const noticeFx = cfg.notice === false || !noticeEl ? { show() {} } : LedFx.notice.create(noticeEl);
    socket.on('noticePinned', (data) => {
      noticeFx.show(currentMode === 'chat' ? (data && data.message) : null);
    });

    // 접속(재접속 포함)할 때마다 상태를 다시 받고 화면 전용 이벤트를 구독한다
    // (최초 1회만 보내면 서버 재시작·네트워크 끊김 뒤 옛 모드에 고착됨)
    const ledScreenId = 'led-screen-' + Math.random().toString(36).slice(2);
    socket.on('connect', () => {
      // 화면 등록을 먼저 — identify 응답(state)이 화면용(엔딩 슬라이드 전체 포함)으로 오게
      socket.emit('registerScreen');
      socket.emit('identify', ledScreenId);
    });
  }

  window.LedFx.page = { start };
})();

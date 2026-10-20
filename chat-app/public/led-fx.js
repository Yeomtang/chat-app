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

  // ── 타이머 긴장감: 마지막 5초 경고색 + 1초 맥박 (시안 2) ──
  const timer = {
    HOT_SECONDS: 5,
    // remain(초)에 맞춰 상태 클래스만 바꾼다 (모양은 페이지 CSS의 .hot)
    update(el, remain) {
      el.classList.toggle('hot', remain > 0 && remain <= timer.HOT_SECONDS);
    },
    reset(el) { el.classList.remove('hot'); },
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

  window.LedFx = {
    prefersReduced,
    easeBack,
    question,
    timer,
    balls,
    hearts: { create: createHeartBurst, enabledFrom: heartBurstEnabled, MODES: HEART_MODES },
  };
})();

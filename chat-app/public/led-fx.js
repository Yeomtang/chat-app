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

  // ── 결과 공개 (2지선다): 시안 6을 상자 화면에 맞춤 ──
  // 0~0.7s 이긴 상자 강조·진 쪽 흐려짐 / 0.7~1.5s 공이 상자 밖으로 흩어짐 /
  // 1.5~2.8s 숫자 모양으로 모임(2.5s 색종이) / 2.9~4.7s 점→면 / 1.5s 유지 / 면→점 0.5s / 1.2s 제자리 복귀
  const REVEAL = {
    EMPH: 700, SCATTER: 1500, GATHER_MS: 1100, CONFETTI: 2500,
    SOLID: 2900, SOLID_MS: 1800, UNSOLID: 6200, UNSOLID_MS: 500,
    RETURN: 6700, RETURN_MS: 1200,
  };
  REVEAL.END = REVEAL.RETURN + REVEAL.RETURN_MS;
  // 숫자 글꼴은 웹폰트 로딩과 무관한 시스템 글꼴로 고정 — 점을 뽑을 때와 면으로 그릴 때 모양이 정확히 겹치도록
  const NUM_FAMILY = "-apple-system, 'Helvetica Neue', Arial, sans-serif";

  // opts: { W, H (논리 캔버스), sides: [{ color, balls:[{tx,ty}] }], centers: [{x,y}] (상자 중심),
  //         ballR, winner(-1=동률), pct, label, labelFamily, ink, confettiColors }
  // 반환 객체의 draw(ctx, now, drawBox)를 매 프레임 부르고, true가 오면 끝(페이지가 배너 표시)
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

    // 글자를 격자로 훑어 점 위치를 뽑는다
    o.font = numFont; o.textAlign = 'center'; o.textBaseline = 'middle';
    o.fillText(text, W / 2, numY);
    const step = Math.max(6, Math.round(size / 23));
    const data = o.getImageData(0, 0, off.width, off.height).data;
    const pts = [];
    for (let y = step / 2; y < off.height; y += step) {
      for (let x = step / 2; x < off.width; x += step) {
        if (data[(Math.floor(y) * off.width + Math.floor(x)) * 4 + 3] > 128) pts.push([x, y]);
      }
    }
    const dotR = step * 0.42;      // 처음엔 틈이 보이는 점
    const dotRFull = step * 0.66;  // 맞닿아 면처럼 보이는 크기

    // 공마다 집(상자 칸)·흩어질 곳·글자 점을 정한다. 공이 점보다 적으면 점을 고르게 고르고,
    // 많으면 남는 공은 숫자 구간 동안 흐려졌다 돌아올 때 다시 나타난다
    const parts = [];
    opts.sides.forEach((s, side) => s.balls.forEach((b) => parts.push({ b, side, hx: b.tx, hy: b.ty })));
    for (let i = parts.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [parts[i], parts[j]] = [parts[j], parts[i]]; }
    const used = Math.min(parts.length, pts.length);
    const m = W * 0.06;
    parts.forEach((p, k) => {
      p.sx = m + Math.random() * (W - m * 2);
      p.sy = m + Math.random() * (H - m * 2);
      p.delay = (k % 40) * 6; // 한꺼번에 몰리지 않게 살짝 시차
      if (k < used) { const q = pts[Math.floor(k * pts.length / used)]; p.tx = q[0]; p.ty = q[1]; } else p.tx = null;
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

    function draw(ctx, now, drawBox) {
      if (t0 === null) { t0 = now; last = now; }
      const t = now - t0;
      const dt = Math.min(50, now - last); last = now;
      const R = REVEAL;

      // 상자: 흩어질 때 사라졌다가 복귀할 때 다시 나타남
      const boxA = t < R.EMPH ? 1 : t < R.RETURN ? 1 - ease((t - R.EMPH) / (R.SCATTER - R.EMPH)) : ease((t - R.RETURN) / R.RETURN_MS);
      const emphP = clamp01(t / R.EMPH);
      const emphS = t < R.EMPH ? 1 + Math.sin(emphP * Math.PI) * 0.05 : 1; // 이긴 상자만 살짝 부풀었다 돌아옴
      const withScale = (side, fn) => {
        if (tie || side !== opts.winner || emphS === 1) { fn(); return; }
        const c = opts.centers[side];
        ctx.save(); ctx.translate(c.x, c.y); ctx.scale(emphS, emphS); ctx.translate(-c.x, -c.y); fn(); ctx.restore();
      };
      if (boxA > 0.001) opts.sides.forEach((s, i) => withScale(i, () => drawBox(i, boxA)));

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
      const loserDim = tie ? 1 : t < R.EMPH ? 1 - 0.45 * emphP : t < R.SCATTER ? 0.55 + 0.45 * ease((t - R.EMPH) / (R.SCATTER - R.EMPH)) : 1;

      parts.forEach((p) => {
        let x, y, r, a = 1;
        const r0 = opts.ballR;
        if (t < R.EMPH) {
          x = p.hx; y = p.hy; r = r0;
        } else if (t < R.SCATTER) {
          const q = ease((t - R.EMPH) / (R.SCATTER - R.EMPH));
          x = p.hx + (p.sx - p.hx) * q; y = p.hy + (p.sy - p.hy) * q; r = r0 + (dotR - r0) * q;
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
        }
        if (!tie && p.side !== opts.winner) a *= loserDim;
        if (a <= 0.01) return;
        p.b.x = x; p.b.y = y; // 끝나면 공이 제자리에서 그대로 이어지도록
        ctx.globalAlpha = a;
        ctx.fillStyle = colors[p.side];
        if (t < R.EMPH) {
          withScale(p.side, () => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); });
        } else {
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        }
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
        ctx.font = '700 ' + labelSize + 'px ' + opts.labelFamily;
        ctx.fillStyle = numColor;
        ctx.fillText(opts.label, W / 2, labelY, W * 0.9);
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
        parts.forEach((p) => { p.b.x = p.hx; p.b.y = p.hy; });
        return true;
      }
      return false;
    }

    return { draw, numColor, text };
  }

  // ── 객관식 3지 이상: 막대 경주 (시안 4) ──
  // 막대가 흔들리며 자라 중간에 순위가 바뀌다가, 3.2초 뒤 정렬된 결과로 확정
  const RACE_MS = 3200;

  function createBarRace(container) {
    let raf = null;
    let rows = [];

    function clear() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      rows = [];
      container.classList.remove('active');
      container.innerHTML = '';
    }

    // opts: { labels, colors, perOption, animate }
    function show(opts) {
      clear();
      const sum = summarize(opts.perOption);
      const n = opts.labels.length;
      const pcts = opts.labels.map((_, i) => (sum.total ? Math.round((sum.per[i] || 0) / sum.total * 100) : 0));
      const maxPct = Math.max(0, ...pcts);
      const scaleMax = Math.max(10, maxPct * 1.12); // 1위 막대가 트랙을 거의 채우게
      const wobbleAmp = maxPct * 0.26;
      const slot = 100 / n;
      // 최종 순서: 득표 내림차순, 같으면 보기 순서
      const finalOrder = pcts.map((v, i) => [sum.per[i] || 0, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map((x) => x[1]);

      const area = document.createElement('div');
      area.className = 'fx-bars-area';
      rows = opts.labels.map((label, i) => {
        const r = document.createElement('div');
        r.className = 'fx-bar-row';
        r.style.height = (slot * 0.78) + '%';
        r.innerHTML = '<div class="fx-bar-label"><span class="fx-bar-name"></span><span class="fx-bar-rank">· 1위</span></div>' +
          '<div class="fx-bar-track"><div class="fx-bar-fill"></div></div><div class="fx-bar-pct">0%</div>';
        r.querySelector('.fx-bar-name').textContent = label;
        r.querySelector('.fx-bar-fill').style.background = opts.colors[i % opts.colors.length];
        area.appendChild(r);
        return r;
      });
      container.appendChild(area);

      const place = (vals, order, done) => {
        rows.forEach((r, i) => {
          r.style.top = (order.indexOf(i) * slot + slot * 0.11) + '%';
          r.querySelector('.fx-bar-fill').style.width = (vals[i] / scaleMax * 100) + '%';
          r.querySelector('.fx-bar-pct').textContent = Math.round(vals[i]) + '%';
          r.classList.toggle('win', done && sum.top.includes(i)); // 1위 동률이면 모두 표시
        });
      };

      if (!opts.animate || prefersReduced() || !sum.total) {
        place(pcts, finalOrder, true);
        container.classList.add('active');
        return;
      }
      place(pcts.map(() => 0), opts.labels.map((_, i) => i), false);
      container.classList.add('active');
      const t0 = performance.now();
      const frame = (now) => {
        const t = (now - t0) / RACE_MS;
        if (t >= 1) { raf = null; place(pcts, finalOrder, true); return; }
        // 보기마다 다른 흔들림 → 중간에 순위가 뒤집혔다가 제자리로
        const vals = pcts.map((v, i) => Math.max(0, v * ease(t) + Math.sin(t * Math.PI * 2.2 + i * 1.7) * wobbleAmp * (1 - t) * ease(t)));
        const order = vals.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map((x) => x[1]);
        place(vals, order, false);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    }

    return { show, clear, isActive: () => container.classList.contains('active') };
  }

  window.LedFx = {
    prefersReduced,
    easeBack,
    question,
    timer,
    balls,
    hearts: { create: createHeartBurst, enabledFrom: heartBurstEnabled, MODES: HEART_MODES },
    result: { summarize, createReveal, createBarRace, REVEAL, RACE_MS },
  };
})();

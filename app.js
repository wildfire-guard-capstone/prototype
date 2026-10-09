/* =====================================================================
   산불 대응 AI 의사결정 지원 시스템 — 시연 목업 (app.js)
   요구사항분석서 유스케이스(UC-AUTH-01, UC-REPORT-01, UC-SIT-01~03, UC-PRED-01~02, UC-PROP-01~04, UC-QA-01~02, UC-ADMIN-01~02) 기준.
   지도(MapLibre) · 합성 확산 모델 · 규칙 판정 · 대응 제안(진화 7·대피 7) · 근거 열람 · 제안 이력 · AI 어시스턴트(질의·정정, 대본)
   실제 ELMFIRE·RAG·LLM·기상 API는 없다. 모든 판단은 이 파일 안의 규칙과 템플릿이다.
   ===================================================================== */
(() => {
  "use strict";
  const S = window.SCENARIO;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const fmt1 = (n) => (Math.round(n * 10) / 10).toString();
  const fmt0 = (n) => Math.round(n).toLocaleString("ko-KR");
  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  const joinKo = (arr) => arr.join("·");
  const hasBatchim = (w) => {
    const c = String(w)
      .replace(/[)\]"'\s]+$/, "")
      .slice(-1)
      .charCodeAt(0);
    return c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 !== 0 : false;
  };
  const josa = (w, a, b) => `${w}${hasBatchim(w) ? a : b}`;
  const eul = (w) => josa(w, "을", "를"),
    eun = (w) => josa(w, "은", "는");
  const tip = (text, cls = "") =>
    `<i class="info ${cls}" data-tip="${esc(text)}"></i>`;
  const ROLE_LABEL = {
    commander: "통합지휘권자",
    viewer: "열람자",
    reporter: "상황 보고자",
    admin: "전산 관리자",
  };
  const PERM_LABEL = {
    commander: "조작",
    viewer: "열람",
    reporter: "보고",
    admin: "관리",
  };

  // ------------------------------------------------------------------ 시각
  const T0 = new Date(S.meta.now);
  const pad2 = (n) => String(n).padStart(2, "0");
  const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const hhmmss = (d) => `${hhmm(d)}:${pad2(d.getSeconds())}`;
  const ymd = (d) =>
    `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
  const ymdhm = (d) => `${ymd(d)} ${hhmm(d)}`;
  const isoLocal = (d) =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const addH = (d, h) => new Date(d.getTime() + h * 3600e3);
  const timeAt = (h) => hhmm(addH(T0, h));
  const parseHM = (s) => {
    const [h, m] = s.split(":").map(Number);
    const d = new Date(T0);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const SUNSET = parseHM(S.astronomy.sunset),
    SUNRISE = parseHM(S.astronomy.sunrise);
  const isNight = (d) => d >= SUNSET || d < SUNRISE;
  const hm = (ms) => {
    const m = Math.round(ms / 60e3);
    return `${Math.floor(m / 60)}:${pad2(m % 60)}`;
  };
  // 근거 부족 비표시: 근거로 뒷받침되지 않는 문장·수량·답변은 출력하지 않고 해당 칸에 이 안내만 보이며, 이벤트 로그에 「근거 부족」으로 남긴다
  const NO_EVIDENCE = "근거가 부족하여 표시하지 않았습니다.";
  const nowSim = () =>
    new Date(T0.getTime() + (state.loginAt ? Date.now() - state.loginAt : 0)); // 시연 시계: t0 + 로그인 후 경과

  // ------------------------------------------------------------------ 상태
  const state = {
    role: null,
    user: null,
    loginAt: null,
    incId: S.incidents[0].id,
    inc: {},
    playing: false,
    timer: null,
    wind: {
      ms: S.weather.series[0].wind_ms,
      dir: S.weather.series[0].wind_dir,
    },
    events: [],
    chatCtx: null,
    corrMode: false,
    sat: true,
    axis: "진화",
    filter: "all",
    resAvailOnly: true,
    listMode: "진행",
    houses: null,
    markers: {},
    emdLabels: [],
    crewMarkers: [],
    rep: {
      editingId: null,
      pickMode: false,
      drawMode: false,
      pts: [],
      ring: null,
      ringSource: null,
      perimMode: "new",
      intake: [],
      listMode: "진행",
    },
  };
  const inc = () => S.incidents.find((i) => i.id === state.incId);
  const IS = (id = state.incId) =>
    (state.inc[id] = state.inc[id] || {
      predicted: false,
      slices: [],
      t: 0,
      runs: [],
      currentRun: null,
      viewRun: null,
      runSeq: 0,
      stale: false,
      predPerim: null,
      latestRisk: null,
    });
  const canOperate = () => state.role === "commander";

  // ------------------------------------------------------------------ 기하 (원점: 시나리오 첫 사건 발화점, 의성군 전역에서 근사 유효)
  const [LNG0, LAT0] = S.incidents[0].ignition;
  const MX = 111320 * Math.cos((LAT0 * Math.PI) / 180),
    MY = 110540;
  const toM = (lng, lat) => [(lng - LNG0) * MX, (lat - LAT0) * MY];
  const fromM = (x, y) => [LNG0 + x / MX, LAT0 + y / MY];
  const distKm = (a, b) => {
    const [x1, y1] = toM(a[0], a[1]),
      [x2, y2] = toM(b[0], b[1]);
    return Math.hypot(x1 - x2, y1 - y2) / 1000;
  };
  const distFromFire = (lng, lat) => distKm(inc().ignition, [lng, lat]);
  function pointInRing(pt, ring) {
    const [x, y] = pt;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i],
        [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
    return inside;
  }
  function pointInGeom(pt, geom) {
    if (!geom) return false;
    if (geom.type === "Polygon") return pointInRing(pt, geom.coordinates[0]);
    if (geom.type === "MultiPolygon")
      return geom.coordinates.some((p) => pointInRing(pt, p[0]));
    return false;
  }
  function ringAreaHa(ring) {
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = toM(ring[i][0], ring[i][1]),
        [x2, y2] = toM(ring[i + 1][0], ring[i + 1][1]);
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2 / 1e4;
  }
  function lineSamples(coords, stepM = 120) {
    const out = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i],
        b = coords[i + 1],
        n = Math.max(1, Math.ceil((distKm(a, b) * 1000) / stepM));
      for (let k = 0; k <= n; k++)
        out.push([
          a[0] + ((b[0] - a[0]) * k) / n,
          a[1] + ((b[1] - a[1]) * k) / n,
        ]);
    }
    return out;
  }
  const lineHitsRing = (coords, ring) =>
    lineSamples(coords).some((p) => pointInRing(p, ring));
  const firstSlice = (slices, test) => {
    for (let t = 1; t <= 8; t++) if (test(slices[t - 1])) return t;
    return null;
  };
  const dirName = (deg) =>
    [
      "북",
      "북북동",
      "북동",
      "동북동",
      "동",
      "동남동",
      "남동",
      "남남동",
      "남",
      "남남서",
      "남서",
      "서남서",
      "서",
      "서북서",
      "북서",
      "북북서",
    ][Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
  // 실측 화선 폴리곤의 방사 거리(m): 중심에서 각도 방향으로 뻗은 반직선과 폴리곤 변의 교점 중 가장 먼 거리
  function radialMax(center, ring, ang) {
    const [cx, cy] = toM(center[0], center[1]),
      dx = Math.cos(ang),
      dy = Math.sin(ang);
    let best = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay] = toM(ring[i][0], ring[i][1]),
        [bx, by] = toM(ring[i + 1][0], ring[i + 1][1]);
      const ex = bx - ax,
        ey = by - ay,
        den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((ax - cx) * ey - (ay - cy) * ex) / den,
        u = ((ax - cx) * dy - (ay - cy) * dx) / den;
      if (t > 0 && u >= 0 && u <= 1) best = Math.max(best, t);
    }
    return best;
  }
  function firePolygon(center, tHours, wind, actualRing) {
    const fm = S.fire_model,
      U = wind.ms;
    const head = fm.head[0] + fm.head[1] * U,
      flank = fm.flank[0] + fm.flank[1] * U,
      back = fm.back;
    const a = ((head + back) / 2) * tHours,
      b = flank * tHours,
      c = ((head - back) / 2) * tHours;
    const th = Math.PI / 2 - ((wind.dir + 180) * Math.PI) / 180;
    const [cx, cy] = toM(center[0], center[1]);
    const ring = [];
    for (let i = 0; i <= 72; i++) {
      const phi = (i / 72) * 2 * Math.PI;
      let x = c + a * Math.cos(phi),
        y = b * Math.sin(phi);
      const r = Math.hypot(x, y),
        al = Math.atan2(y, x);
      const m =
        1 +
        fm.noise_amp *
          (0.55 * Math.sin(3 * al + 0.7) +
            0.3 * Math.sin(7 * al + 2.1) +
            0.15 * Math.sin(11 * al + 4.0));
      x = r * m * Math.cos(al);
      y = r * m * Math.sin(al);
      let X = (x * Math.cos(th) - y * Math.sin(th)) * 1000,
        Y = (x * Math.sin(th) + y * Math.cos(th)) * 1000;
      if (actualRing) {
        const ang = Math.atan2(Y, X),
          rr = Math.hypot(X, Y),
          ra = radialMax(center, actualRing, ang) * (1 + 0.04 * tHours) + 60;
        if (ra > rr) {
          X = ra * Math.cos(ang);
          Y = ra * Math.sin(ang);
        }
      }
      ring.push(fromM(cx + X, cy + Y));
    }
    ring[ring.length - 1] = ring[0];
    return ring;
  }
  const buildSlices = (center, wind, actualRing) =>
    Array.from({ length: 8 }, (_, i) =>
      firePolygon(center, i + 1, wind, actualRing),
    );
  function circleRing(center, rM = 150) {
    const [cx, cy] = toM(center[0], center[1]);
    const r = [];
    for (let i = 0; i <= 36; i++) {
      const a = (i / 36) * 2 * Math.PI;
      r.push(fromM(cx + rM * Math.cos(a), cy + rM * Math.sin(a)));
    }
    return r;
  }
  // 실측 화선 버전(UC-REPORT-01): 최신 '유효' 버전이 현재 화선이며 예측의 시작점이다(없으면 발화점)
  const curPerim = (i = inc()) => {
    const v = (i.perimeters || []).filter((p) => p.status === "유효");
    return v.length ? v[v.length - 1] : null;
  };
  const actualRing = (i = inc()) => {
    const p = curPerim(i);
    return p ? p.ring : null;
  };
  const perimTag = (p) => (p ? `v${p.version}` : "없음(발화점)");
  function mulberry(seed) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function genHouses() {
    const rnd = mulberry(7),
      out = [];
    S.villages.forEach((v) => {
      const n = Math.max(6, Math.round(v.hh / 3));
      for (let i = 0; i < n; i++) {
        const r = 120 + rnd() * 330,
          a = rnd() * 2 * Math.PI;
        const [x, y] = toM(v.lng, v.lat);
        out.push({
          v: v.id,
          pt: fromM(x + r * Math.cos(a), y + r * Math.sin(a)),
        });
      }
    });
    return out;
  }
  function powerLineCoords() {
    const osm = (window.OSM_LINES || { features: [] }).features.filter(
      (f) => f.properties.kind === "line",
    );
    if (osm.length)
      return {
        name: "송전선(OSM)",
        coords: osm[0].geometry.coordinates,
        multi: osm,
      };
    return S.power_line_fallback;
  }

  // ------------------------------------------------------------------ 진화자원 집계 (UC-ADMIN-02 데이터 → UC-SIT-03 현황 · S3 입력)
  const RTYPES = ["헬기", "차량", "인력"];
  function resSummary() {
    const by = {};
    RTYPES.forEach(
      (t) => (by[t] = { 보유: 0, 투입: 0, 대기: 0, 정비: 0, 가용: 0 }),
    );
    S.resources.forEach((r) => {
      const b = by[r.type];
      if (!b) return;
      const q = r.type === "인력" ? Number(r.qty) || 0 : 1;
      b.보유 += q;
      b[r.status] = (b[r.status] || 0) + q;
    });
    RTYPES.forEach((t) => (by[t].가용 = by[t].투입 + by[t].대기));
    return by;
  }
  function rsView() {
    const b = resSummary();
    return {
      heli_deployed: b.헬기.투입,
      heli_available: b.헬기.대기,
      ground_crew_deployed: b.인력.투입,
      fire_trucks_deployed: b.차량.투입,
      trucks_available: b.차량.대기,
      crew_positions: S.resources
        .filter((r) => r.type === "인력" && r.status === "투입" && r.pos)
        .map((r) => r.pos),
    };
  }
  // "헬기 6대 투입"처럼 투입 수량을 맞춘다(대기 ↔ 투입 이동). 반환: 실제 반영된 투입 수
  function setDeployed(type, n) {
    const units = S.resources.filter(
      (r) => r.type === type && r.status !== "정비",
    );
    const dep = units.filter((r) => r.status === "투입"),
      stb = units.filter((r) => r.status === "대기");
    let cur = dep.length;
    if (n > cur) {
      for (const r of stb) {
        if (cur >= n) break;
        r.status = "투입";
        cur++;
      }
    } else if (n < cur) {
      for (const r of dep.slice().reverse()) {
        if (cur <= n) break;
        r.status = "대기";
        cur--;
      }
    }
    rebuildCrewMarkers();
    return cur;
  }

  // ------------------------------------------------------------------ 규칙 판정
  const STAGES = S.stage_rules.area_ha.map((r) => r.stage);
  const stageByRange = (rules, v) => {
    for (const r of rules)
      if ((r.min == null || v >= r.min) && (r.max == null || v < r.max))
        return r.stage;
    return STAGES[0];
  };
  const stageIdx = (s) => Math.max(0, STAGES.indexOf(s));
  const burnedAreaHa = (i = inc()) =>
    actualRing(i) ? ringAreaHa(actualRing(i)) : 0;
  function computeRules(I, slices) {
    const P5 = slices[4],
      P8 = slices[7],
      es = I.evacuation_state,
      rs = rsView(),
      ign = I.ignition;
    const R = {
      t0: T0,
      sunset: S.astronomy.sunset,
      sunrise: S.astronomy.sunrise,
      rs,
    };
    R.areaByT = slices.map(ringAreaHa);
    R.areaP5 = R.areaByT[4];
    R.areaP8 = R.areaByT[7];
    R.areaNow = burnedAreaHa(I);
    R.avgWind =
      S.weather.series.slice(0, 6).reduce((a, w) => a + w.wind_ms, 0) / 6;
    R.maxWind = S.weather.series.reduce(
      (m, w) => (w.wind_ms > m.wind_ms ? w : m),
      S.weather.series[0],
    );
    R.spreadDir = dirName(state.wind.dir + 180);
    R.villages = S.villages.map((v) => {
      const arrival = firstSlice(slices, (ring) =>
        pointInRing([v.lng, v.lat], ring),
      );
      const at = arrival ? addH(T0, arrival) : null;
      const zone =
        arrival == null ? "none" : arrival <= 5 ? "immediate" : "standby";
      const status = es.completed_villages.includes(v.name)
        ? "completed"
        : null;
      return {
        ...v,
        arrival,
        arrivalTime: at ? hhmm(at) : null,
        zone,
        night: at ? isNight(at) : false,
        status,
      };
    });
    const byOrder = (a, b) => a.arrival - b.arrival || b.elderly - a.elderly;
    R.immediate = R.villages
      .filter((v) => v.zone === "immediate")
      .sort(byOrder);
    R.standby = R.villages.filter((v) => v.zone === "standby").sort(byOrder);
    R.ordered = [...R.immediate, ...R.standby];
    R.nightVillages = R.ordered.filter((v) => v.night);
    R.unreached = es.order_issued
      ? R.immediate.filter((v) => !es.completed_villages.includes(v.name))
      : [];
    R.facilities = S.facilities.map((f) => ({
      ...f,
      arrival: firstSlice(slices, (ring) => pointInRing([f.lng, f.lat], ring)),
    }));
    R.careIn = R.facilities.filter(
      (f) => (f.type === "care" || f.type === "welfare") && f.arrival != null,
    );
    R.heritageIn5 = R.facilities.filter(
      (f) =>
        (f.type === "heritage" || f.type === "temple") &&
        f.arrival != null &&
        f.arrival <= 5,
    );
    R.housesP5 = state.houses.filter((h) => pointInRing(h.pt, P5)).length;
    R.housesP8 = state.houses.filter((h) => pointInRing(h.pt, P8)).length;
    R.powerLine = powerLineCoords();
    R.powerIn = firstSlice(slices, (ring) =>
      lineHitsRing(R.powerLine.coords, ring),
    );
    R.shelters = S.shelters.map((s) => ({
      ...s,
      inP8: pointInRing([s.lng, s.lat], P8),
      inP5: pointInRing([s.lng, s.lat], P5),
      load: 0,
      assigned: [],
    }));
    const safe = R.shelters.filter((s) => !s.inP8);
    R.assignments = [];
    R.ordered.forEach((v) => {
      const cand = safe
        .map((s) => ({ s, d: distKm([v.lng, v.lat], [s.lng, s.lat]) }))
        .sort((a, b) => a.d - b.d);
      const pick =
        cand.find((c) => c.s.load + v.pop <= c.s.capacity) || cand[0];
      if (!pick) return;
      pick.s.load += v.pop;
      pick.s.assigned.push(v.name);
      R.assignments.push({
        village: v,
        shelter: pick.s,
        km: pick.d,
        minutes: Math.round((pick.d / 40) * 60) + 10,
        overflow: pick.s.load > pick.s.capacity,
      });
    });
    R.overflow = R.shelters.filter((s) => s.load > s.capacity);
    const conflict = S.routes.find((r) => r.kind === "conflict");
    R.routeInFire = conflict
      ? firstSlice(slices, (ring) => lineHitsRing(conflict.coords, ring))
      : null;
    R.crewIn5 = rs.crew_positions.filter((p) => pointInRing(p, P5)).length;
    R.crewTotal = rs.crew_positions.length;
    // 대응단계 4요소 판정(p.73): 예상 피해면적·평균풍속·예상 진화시간·시설피해 중 가장 높은 단계. 예상 진화시간은 상황 정정 값, 없으면 제외
    const SR = S.stage_rules,
      hrs = I.field_report.expected_suppression_hours;
    R.facMajor =
      R.heritageIn5.length + R.careIn.filter((f) => f.arrival <= 5).length;
    R.stageFactors = [
      {
        name: "예상 피해면적(5h)",
        val: `${fmt1(R.areaP5)} ha`,
        stage: stageByRange(SR.area_ha, R.areaP5),
      },
      {
        name: "평균풍속",
        val: `${fmt1(R.avgWind)} m/s`,
        stage: stageByRange(SR.wind_ms, R.avgWind),
      },
      {
        name: "예상 진화시간",
        val: hrs == null ? "미입력" : `${hrs}시간`,
        stage: hrs == null ? null : stageByRange(SR.hours, hrs),
      },
      {
        name: "시설피해 우려",
        val: `주택 ${R.housesP5}동·주요시설 ${R.facMajor}동`,
        stage:
          R.facMajor >= SR.facility.stage2_major ||
          R.housesP5 >= SR.facility.stage2_houses
            ? STAGES[2]
            : R.housesP5 >= SR.facility.stage1_houses
              ? STAGES[1]
              : STAGES[0],
      },
    ];
    R.recStage = R.stageFactors.reduce(
      (best, f) =>
        f.stage && stageIdx(f.stage) > stageIdx(best) ? f.stage : best,
      STAGES[0],
    );
    R.stageDrivers = R.stageFactors
      .filter((f) => f.stage === R.recStage)
      .map((f) => f.name);
    R.official = I.official_stage;
    R.stageUp = stageIdx(R.recStage) > stageIdx(R.official);
    R.outOfScope = stageIdx(R.official) >= 2;
    const B = window.BOUNDARIES || { features: [] };
    const sig = B.features.find((f) => f.properties.level === "sigungu");
    R.crossesSigungu = sig
      ? P5.some((p) => !pointInGeom(p, sig.geometry))
      : false;
    const emds = B.features.filter((f) => f.properties.level === "emd");
    const emdOf = (ring) =>
      emds
        .filter(
          (f) =>
            ring.some((p) => pointInGeom(p, f.geometry)) ||
            pointInGeom(ign, f.geometry),
        )
        .map((f) => f.properties.name);
    R.emdIn5 = emdOf(P5);
    if (!R.emdIn5.length)
      R.emdIn5 = [...new Set(R.immediate.map((v) => v.emd))];
    R.emdIn8 = emdOf(P8);
    if (!R.emdIn8.length) R.emdIn8 = [...new Set(R.ordered.map((v) => v.emd))];
    R.nextHolder =
      R.recStage === "확산대응 2단계" || R.crossesSigungu
        ? "시·도지사(경상북도지사)"
        : null;
    R.heliOkNow = state.wind.ms < 15 && !isNight(T0);
    R.night5 = isNight(addH(T0, 5));
    R.cbsStage = es.order_issued
      ? "대피 명령"
      : R.immediate.length
        ? "대피 명령(발령 시)"
        : "산불 발생";
    R.injuries = es.injuries || [];
    return R;
  }

  // ------------------------------------------------------------------ 제안 생성(템플릿) — 진화 S1~S7 · 대피 E1~E7
  const vn = (list) => (list.length ? joinKo(list.map((v) => v.name)) : "없음");
  const vnP = (list) =>
    list.length ? joinKo(list.map((v) => `${v.name}(P${v.arrival})`)) : "없음";
  const E = (keys) => keys.map((key, i) => ({ k: i + 1, key }));
  function buildProposal(R, I) {
    const es = I.evacuation_state,
      rs = R.rs;
    const B = [];
    const none = (id) => ({
      id,
      finding: "",
      status: ["(없음)"],
      text: "(없음)",
      targets: [],
      conflicts: [],
      evidence: [],
    });
    const cat = Object.fromEntries(S.catalog.map((c) => [c.id, c]));
    const push = (b) => {
      const c = cat[b.id];
      B.push({
        axis: c.axis,
        name: c.name,
        authority: c.authority,
        targets: [],
        conflicts: [],
        withheld: [],
        ...b,
      });
    };
    {
      const drivers = R.stageDrivers.join("·");
      const finding = `현재 피해면적 ${R.areaNow ? fmt1(R.areaNow) + " ha(실측 화선)" : "미입력"} / 4요소 판정: ${R.stageFactors.map((f) => `${f.name} ${f.val} → ${f.stage || "판정 제외"}`).join(" / ")} → 가장 높은 단계 ${R.recStage}(${drivers}), 공식 ${R.official}`;
      if (R.stageUp) {
        let text = `대응단계 판단기준 4요소 중 ${drivers}${hasBatchim(drivers) ? "이" : "가"} ${R.recStage} 기준(${R.recStage === "확산대응 2단계" ? "피해면적 100 ha 이상·평균풍속 7 m/s 이상·예상 진화시간 24시간 이상·주요시설 피해 우려" : "피해면적 10 ha 이상·평균풍속 4 m/s 이상·예상 진화시간 8시간 이상·주택 피해 우려"})에 해당합니다 [1]. 산림청장과 대응단계 격상을 협의하십시오 [2].`;
        if (R.nextHolder)
          text += ` 격상되면 지휘권이 ${R.nextHolder}에게 넘어가므로 피해상황·투입 자원·추가 피해 가능성을 인계할 준비를 하십시오 [3].`;
        push({
          id: "S1",
          finding,
          status: ["협의"],
          text,
          targets: ["산림청장"],
          evidence: E(["SM-p073", "SM-p022", "SM-p072"]),
        });
      } else push({ ...none("S1"), finding, evidence: E(["SM-p073"]) });
    }
    {
      const g1 = [
        ...R.immediate.map((v) => v.name),
        ...R.careIn.filter((f) => f.arrival <= 5).map((f) => f.name),
      ];
      const g2 = [
        ...R.heritageIn5.map((f) => f.name),
        ...(R.powerIn && R.powerIn <= 5 ? [`송전선(P${R.powerIn})`] : []),
      ];
      const g3 = R.housesP5 ? [`주택 ${R.housesP5}동`] : [];
      const finding = `P5 내 보호대상 ① 인명: ${g1.length ? joinKo(g1) : "없음"} ② 국가기간·군사·국가유산: ${g2.length ? joinKo(g2) : "없음"} ③ 재산: ${g3.length ? g3[0] : "없음"} ④·⑤ 산림: P5 ${fmt1(R.areaP5)} ha`;
      const order = [
        g1.length ? joinKo(g1) : null,
        g2.length ? joinKo(g2) : null,
        g3[0] || null,
      ].filter(Boolean);
      if (order.length)
        push({
          id: "S2",
          finding,
          status: ["즉시"],
          text: `${order.join(" → ")} 순으로 진화 우선지역을 정하십시오 [1]. 인명·국가유산·고압선 피해 여부와 확대 가능성을 우선 판단하십시오 [2].`,
          targets: order,
          evidence: E(["SM-p077", "SM-p118"]),
        });
      else push({ ...none("S2"), finding, evidence: E(["SM-p077"]) });
    }
    {
      const finding = `투입 헬기 ${rs.heli_deployed}대·지상 ${rs.ground_crew_deployed}명·소방차 ${rs.fire_trucks_deployed}대 / 가용(대기) 헬기 ${rs.heli_available}대·차량 ${rs.trucks_available}대 / 진화구역 후보: 주 확산 방향(${R.spreadDir}) 1순위, 양 측면 2순위 / 소요 산식 없음`;
      push({
        id: "S3",
        finding,
        status: ["즉시"],
        text: `주 확산 방향인 ${R.spreadDir}쪽 구역(${vn(R.immediate)})에 지상진화 자원을 우선 배치하고, 진화전략도에 구역별 진화율을 반영해 재배치하십시오 [1]. 가용 진화헬기 ${rs.heli_available}대를 집중 투입하십시오 [2].`,
        targets: [`${R.spreadDir} 구역`, "가용 헬기"],
        withheld: [
          { slot: "추가 투입 헬기 대수", why: "표준매뉴얼에 산정 기준 없음" },
        ],
        evidence: E(["SM-p041", "SM-p077"]),
      });
    }
    {
      const finding = `현재 풍속 ${state.wind.ms} m/s(${dirName(state.wind.dir)}풍) / 최대 ${R.maxWind.wind_ms} m/s(${R.maxWind.t}) / 헬기 운용 ${R.heliOkNow ? "가능" : "제한"} / 일몰 ${R.sunset}, t0+5h ${timeAt(5)}(${R.night5 ? "야간 포함" : "주간"})`;
      push({
        id: "S4",
        finding,
        status: ["즉시"],
        text: `현재 풍속에서는 헬기 운용이 가능하므로 가용 헬기를 집중 투입하십시오 [1]. ${R.maxWind.t} 전후 풍속이 ${R.maxWind.wind_ms} m/s로 강해지는 시간대에는 지상진화에 집중할 준비를 하고, 일몰(${R.sunset}) 이후 풍속이 잦아드는 시간대에 집중 진화를 지시하십시오 [2].`,
        targets: ["전 진화자원"],
        evidence: E(["SM-p077", "SM-p078"]),
      });
    }
    {
      const finding = `P5 내 주택 ${R.housesP5}동(P8 누적 ${R.housesP8}동) / 송전선 ${R.powerIn ? `P${R.powerIn} 통과` : "범위 밖"} / 취약시설 ${R.careIn.length ? joinKo(R.careIn.map((f) => `${f.name}(P${f.arrival})`)) : "없음"}`;
      const st = R.housesP5 ? ["즉시"] : [];
      if (R.powerIn) st.push("요청");
      let text = "";
      if (R.housesP5)
        text += `${vn(R.immediate)} 주택군 주변에 소방차 등 진화장비를 집중 배치하고 인접 산림에 예비 살수를 지시하십시오 [1].`;
      if (R.powerIn)
        text += ` 송전선이 P${R.powerIn} 확산 범위를 지나므로 전류 차단과 우회선로 확보를 한전에 요청하십시오 [2].`;
      if (st.length)
        push({
          id: "S5",
          finding,
          status: st,
          text,
          targets: [
            R.housesP5 ? "주택군(소방)" : null,
            R.powerIn ? "송전선(한전)" : null,
          ].filter(Boolean),
          evidence: E(["SM-p079", "SM-p095"]),
        });
      else push({ ...none("S5"), finding, evidence: E(["SM-p079"]) });
    }
    {
      const finding = `걸친 시·군·구 ${R.crossesSigungu ? "2개 이상" : "1개(의성군)"}, 지휘권 변경 ${R.nextHolder ? "검토(" + R.nextHolder + ")" : "없음"} / 확산 범위 읍면 ${joinKo(R.emdIn5)} / 자원 부족분 산출 불가(소요 기준 없음)`;
      const st = R.immediate.length >= 2 ? ["요청"] : [];
      if (R.nextHolder) st.unshift("협의");
      let text = R.crossesSigungu
        ? `확산 범위가 인접 시·군에 걸치므로 지휘권이 시·도지사로 바뀌는지 협의하십시오 [1].`
        : `확산 범위가 의성군 안에 있어 걸친 행정구역에 따른 지휘권 변경은 없습니다 [1].`;
      if (R.immediate.length >= 2)
        text += ` 진화자원이 확산 정도에 미치지 못하면 인접 시·군의 진화자원과 소방·경찰·군의 인력·장비 동원을 요청하고, 산불현장 대책회의에서 기관별 임무를 부여하십시오 [2].`;
      push({
        id: "S6",
        finding,
        status: st.length ? st : ["(없음)"],
        text: st.length ? text : "(없음)",
        targets: st.length ? ["인접 시·군", "소방·경찰·군"] : [],
        withheld:
          R.immediate.length >= 2
            ? [{ slot: "동원 요청 수량", why: "표준매뉴얼에 소요 기준 없음" }]
            : [],
        evidence: E(["SM-p072", "SM-p022"]),
      });
    }
    {
      const finding = `진화인력 ${R.crewTotal}개 조 중 P5 내 ${R.crewIn5}개 조 / 퇴로: 풍상측(${dirName(state.wind.dir)}) 도로 확보 / 풍향 급변 없음(예보 ${S.weather.series[0].wind_dir}°→${S.weather.series[8].wind_dir}°)`;
      if (R.crewTotal)
        push({
          id: "S7",
          finding,
          status: ["즉시"],
          text: `P5 안에서 작업 중인 지상진화인력의 위치추적장치 휴대와 진화복·안전장구를 확인하고, 풍상측(${dirName(state.wind.dir)})으로 퇴로를 지정하십시오 [1]. ${R.maxWind.t} 전후 풍속이 최대가 되는 시간대에는 화선 전방(${R.spreadDir})으로의 투입을 제한하십시오 [2].`,
          targets: [`지상진화인력 ${rs.ground_crew_deployed}명`],
          evidence: E(["SM-p077", "SM-p118"]),
        });
      else push({ ...none("S7"), finding, evidence: E(["SM-p077"]) });
    }
    {
      const finding = `위험구역(≤5h) ${vnP(R.immediate)} / 잠재 위험구역(≤8h) ${vnP(R.standby)}`;
      const st = [];
      if (R.immediate.length) st.push("즉시");
      if (R.standby.length) st.push("대기");
      let text = "";
      if (R.immediate.length)
        text += `${eul(vn(R.immediate))} 위험구역(즉시 실행)으로 설정하십시오 [1].`;
      if (R.standby.length)
        text += ` ${eul(vn(R.standby))} 잠재 위험구역(실행 대기)으로 설정하십시오 [1].`;
      push({
        id: "E1",
        finding,
        status: st.length ? st : ["(없음)"],
        text: text || "(없음)",
        targets: R.ordered.map((v) => v.name),
        evidence: E(["SM-p074"]),
      });
    }
    {
      const ord = R.ordered
        .map((v) => `${v.name}(${v.arrivalTime} 도달, 고령 ${v.elderly})`)
        .join(" → ");
      const finding = `순위 ${ord || "없음"} / 야간 포함 ${vn(R.nightVillages)} / 대피명령 ${es.order_issued ? "발령" : "미발령"} / 완료 ${es.completed_villages.length ? joinKo(es.completed_villages) : "없음"}`;
      let text = "",
        st = [];
      if (!R.ordered.length)
        push({ ...none("E2"), finding, evidence: E(["SM-p074"]) });
      else {
        const done = R.immediate.filter((v) => v.status === "completed"),
          toOrder = R.immediate.filter((v) => v.status !== "completed");
        if (!es.order_issued && toOrder.length) {
          st.push("즉시");
          text += `${vn(toOrder)} 순으로 마을 단위 대피명령을 즉시 내리고 안전취약계층부터 대피시키십시오 [1][2].`;
        }
        if (!es.order_issued && done.length)
          text += ` ${eun(vn(done))} 대피 완료 보고가 있으므로 명령 대상에서 제외하고 완료 여부를 재확인하십시오 [3].`;
        if (es.order_issued) {
          st.push("즉시");
          text += `대피명령이 발령된 상태입니다. ${R.unreached.length ? `미대피 마을 ${vn(R.unreached)}의 대피 완료를 확인하고 완료 보고를 받으십시오 [3].` : "위험구역 마을의 대피 완료 보고를 확인하십시오 [3]."}`;
        }
        if (R.standby.length) {
          st.push("대기");
          text += ` ${eun(vn(R.standby))} 실행 대기로 두고 대피 준비를 지시하십시오 [1].`;
        }
        if (R.nightVillages.length)
          text += ` ${eun(joinKo(R.nightVillages.map((v) => `${v.name}(${v.arrivalTime})`)))} 화선 도달 예상 시각이 일몰(${R.sunset}) 이후이므로 일몰 전 사전대피를 지시하십시오 [1].`;
        push({
          id: "E2",
          finding,
          status: st.length ? st : ["대기"],
          text,
          targets: R.ordered.map((v) => v.name),
          evidence: E(["SM-p074", "SM-p079", "SM-p084"]),
        });
      }
    }
    {
      const finding = `취약시설 ${R.careIn.length ? joinKo(R.careIn.map((f) => `${f.name}(P${f.arrival}, ${f.capacity}명)`)) : "확산 범위 내 없음"} / 미대피 ${vn(R.unreached)} / 부상 ${R.injuries.length ? joinKo(R.injuries) : "없음"}`;
      let text = "",
        st = [];
      R.careIn.forEach((f) => {
        st.push(f.arrival <= 5 ? "즉시" : "대기");
        text += `${f.name}(수용 ${f.capacity}명)이 P${f.arrival} 범위에 들므로 위험구역에 포함해 별도 이송을 지시하십시오 [1]. `;
      });
      if (R.unreached.length) {
        st.push("즉시");
        text += `대피하지 않은 ${vn(R.unreached)} 주민은 강제로 대피시키십시오 [2].`;
      }
      st = [...new Set(st)];
      if (st.length)
        push({
          id: "E3",
          finding,
          status: st,
          text: text.trim(),
          targets: [
            ...R.careIn.map((f) => f.name),
            ...R.unreached.map((v) => v.name),
          ],
          evidence: E(["SM-p074", "SM-p084"]),
        });
      else push({ ...none("E3"), finding, evidence: E(["SM-p074"]) });
    }
    {
      const safe = R.shelters.filter((s) => !s.inP8),
        unsafe = R.shelters.filter((s) => s.inP8);
      const finding = `안전 대피소 ${joinKo(safe.map((s) => `${s.name}(${s.capacity})`))} / P8 안 대피소 ${unsafe.length ? joinKo(unsafe.map((s) => s.name)) : "없음"} / 배정 ${R.assignments.map((a) => `${a.village.name}→${a.shelter.name} ${a.shelter.load}/${a.shelter.capacity}`).join(", ") || "없음"} / 초과 ${R.overflow.length ? joinKo(R.overflow.map((s) => s.name)) : "없음"}`;
      if (R.assignments.length) {
        const byShelter = {};
        R.assignments.forEach((a) => {
          (byShelter[a.shelter.name] = byShelter[a.shelter.name] || []).push(a);
        });
        const names = Object.keys(byShelter);
        let text =
          names
            .map((sn) => {
              const as = byShelter[sn];
              return `${joinKo(as.map((a) => a.village.name))} 주민은 ${sn}(${as[0].shelter.load}/${as[0].shelter.capacity}명, 최대 ${Math.max(...as.map((a) => a.minutes))}분)`;
            })
            .join(", ") +
          (hasBatchim(names[names.length - 1]) ? "으로" : "로") +
          " 배정하십시오 [1].";
        if (unsafe.length)
          text += ` ${eun(joinKo(unsafe.map((s) => s.name)))} P8 범위 안이므로 대피소에서 제외하십시오 [2].`;
        if (R.overflow.length)
          text += ` ${eun(joinKo(R.overflow.map((s) => s.name)))} 수용 인원을 초과하므로 인접 대피소로 분산하십시오 [1].`;
        push({
          id: "E4",
          finding,
          status: ["즉시"],
          text,
          targets: names,
          evidence: E(["SM-p065", "SM-p074"]),
        });
      } else push({ ...none("E4"), finding, evidence: E(["SM-p065"]) });
    }
    {
      const finding = `대피로 A(박곡리→의성 실내체육관)가 진화차량 진입로와 겹침 / 겹침 구간 화선 도달 ${R.routeInFire ? `P${R.routeInFire}` : "8시간 내 없음"}`;
      if (R.ordered.length || R.routeInFire) {
        let text = `대피로와 진화차량 진입로가 같은 구간을 쓰므로 경찰에 해당 구간의 교통통제(일방통행)와 주민대피 지원을 요청하십시오 [1].`;
        if (R.routeInFire)
          text += ` 겹침 구간이 P${R.routeInFire}에 확산 범위에 들므로 ${timeAt(R.routeInFire)} 전에 통제를 마치십시오 [2].`;
        push({
          id: "E5",
          finding,
          status: ["요청"],
          text,
          targets: ["경찰(겹침 구간)"],
          conflicts: [
            {
              type: "대피로·진입로 겹침",
              with: "진화자원 배치",
              resolution: "요청 전환",
            },
          ],
          evidence: E(["SM-p119", "SM-p065"]),
        });
      } else push({ ...none("E5"), finding, evidence: E(["SM-p119"]) });
    }
    {
      const finding = `대상 읍면동 ${joinKo(R.emdIn8) || "없음"} / 송출 단계 ${R.cbsStage} / 송출 이력 ${es.cbs_sent.length ? es.cbs_sent.join(", ") : "없음"}`;
      if (R.ordered.length)
        push({
          id: "E6",
          finding,
          status: ["즉시"],
          text: `${es.order_issued ? "대피명령 발령에 따라" : "대피명령과 동시에"} ${joinKo(R.emdIn8)}에 긴급재난문자(CBS)와 자막방송(DITS)을 대피 명령 단계로 송출하십시오 [1].${es.cbs_sent.length ? ` 이미 송출한 ${es.cbs_sent.join(", ")}은 단계가 바뀔 때 다시 송출하십시오 [1].` : ""}`,
          targets: R.emdIn8,
          evidence: E(["SM-p078b"]),
        });
      else push({ ...none("E6"), finding, evidence: E(["SM-p078b"]) });
    }
    {
      const finding = `고립 후보 없음 / 부상 보고 ${R.injuries.length ? joinKo(R.injuries) : "없음"}`;
      if (R.injuries.length)
        push({
          id: "E7",
          finding,
          status: ["요청"],
          text: `${joinKo(R.injuries)} 부상 보고에 따라 소방 긴급구조통제단에 구조·구급을 요청하십시오 [1][2].`,
          targets: ["소방(긴급구조통제단)"],
          evidence: E(["SM-p021", "SM-p119"]),
        });
      else push({ ...none("E7"), finding, evidence: E(["SM-p021"]) });
    }
    return B;
  }
  function summarize(blocks) {
    const c = { 즉시: 0, 대기: 0, 협의: 0, 요청: 0, 없음: 0 };
    blocks.forEach((b) =>
      b.status.forEach((s) => {
        const k = s === "(없음)" ? "없음" : s;
        if (k in c) c[k]++;
      }),
    );
    return c;
  }
  // 상태를 변경하지 않고 후보 제안만 생성
  function buildProposalCandidate(I, st, slices, predPerim, reason) {
    const R = computeRules(I, slices);
    const blocks = buildProposal(R, I);
    const seq = st.runSeq + 1;

    const run = {
      id: `버전 ${seq}`,
      seq,
      createdAt: nowSim(),
      reason,
      R,
      blocks,
      summary: summarize(blocks),
      perim: predPerim,
      snapshot: {
        official_stage: I.official_stage,
        alert_level: I.alert_level,
      },
    };

    const prev = st.currentRun;

    run.changed = prev
      ? blocks
          .filter((b) => {
            const p = prev.blocks.find((x) => x.id === b.id);
            return (
              !p ||
              p.text !== b.text ||
              p.status.join() !== b.status.join() ||
              p.finding !== b.finding
            );
          })
          .map((b) => b.id)
      : [];

    return run;
  }

  // 후보 제안을 확정하고 화면에 반영
  function generateProposal(reason, preparedRun = null) {
    const I = inc();
    const st = IS();

    const run =
      preparedRun ||
      buildProposalCandidate(I, st, st.slices, st.predPerim, reason);

    st.runSeq = run.seq;
    st.runs.push(run);
    st.currentRun = run;
    st.viewRun = run;

    addEvent(
      "제안",
      `대응 제안 ${run.id} 생성(${reason})` +
        (run.changed.length ? ` · 변경 ${run.changed.length}건` : ""),
    );

    run.blocks.forEach((b) => {
      b.withheld.forEach((w) => {
        addEvent(
          "근거 부족",
          `${run.id} ${b.name} — ${w.slot} 비표시(${w.why})`,
        );
      });
    });

    renderAll();
    return run;
  }

  // ------------------------------------------------------------------ 위험도 (UC-PRED-02)
  // 조건위험도 = 25 × (요인 점수(1~5) 가중평균 − 1). 기상 0.35 · 지형 0.30 · 연료 0.25 · 인프라 0.10
  // 등급 실수 경계: 낮음 ≤50 · 보통 50 초과~65 · 높음 65 초과~85 · 매우 높음 85 초과
  const gradeOf = (score) =>
    (S.risk_model.grades.find((g) => g.max == null || score <= g.max) || {})
      .name;
  const wx = () => S.weather.series[0];
  const wxText = (w = wx()) =>
    `${dirName(w.wind_dir)}풍 ${w.wind_ms} m/s · 습도 ${w.rh}% · 기온 ${w.temp_c}℃ · 시정 ${w.vis_m >= 1000 ? fmt1(w.vis_m / 1000) + " km" : w.vis_m + " m"}`;
  function computeRisk(I = inc(), demo = null) {
    const RM = S.risk_model,
      sc = demo?.scores || I.risk_scores || {};
    const fs = RM.factors.map((f) => ({
      ...f,
      score: sc[f.key] != null ? sc[f.key] : f.score,
      values:
        demo?.values?.[f.key] ??
        (f.key === "weather"
          ? `풍속 ${wx().wind_ms} m/s · 풍향 ${wx().wind_dir}° · 습도 ${wx().rh}% · 기온 ${wx().temp_c}℃ · ${S.weather.warnings.join("·")}`
          : f.values),
    }));
    const wsum = fs.reduce((a, f) => a + f.weight, 0);
    const mean = fs.reduce((a, f) => a + f.score * f.weight, 0) / wsum;
    const score = mean;
    return {
      score,
      grade: gradeOf(score),
      mean,
      factors: fs.map((f) => ({
        ...f,
        contrib: Math.round(((f.score * f.weight) / wsum) * 100) / 100,
      })),
      missing: demo?.missing_vars ?? RM.missing_vars ?? [],
    };
  }
  // 최신 예측에서 저장한 위험도 시연 결과만 조회
  function riskOf(I = inc()) {
    return IS(I.id).latestRisk;
  }

  // ------------------------------------------------------------------ 아이콘 · 지도
  const svg = (paths) => `<svg viewBox="0 0 24 24">${paths}</svg>`;
  const ICONS = {
    house: svg(
      '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    ),
    shelter: svg('<path d="M4 21V9l8-5 8 5v12"/><path d="M12 10v6M9 13h6"/>'),
    care: svg(
      '<path d="M3 18V8M3 14h18v4"/><circle cx="7.5" cy="10.5" r="1.8"/><path d="M11 12h7a3 3 0 0 1 3 3"/>',
    ),
    heritage: svg(
      '<path d="M4 20h16M6 20v-5h12v5M5 15l7-4 7 4M12 4v3M4 9h16l-2 3H6z"/>',
    ),
    school: svg(
      '<path d="M3 9l9-4 9 4-9 4-9-4z"/><path d="M7 11v5c0 1 2.5 2 5 2s5-1 5-2v-5M21 9v5"/>',
    ),
    crew: svg(
      '<circle cx="12" cy="6.5" r="3"/><path d="M5 21a7 7 0 0 1 14 0"/>',
    ),
    flame: svg(
      '<path d="M12 3c1 3 4 4.5 4 8.5A4 4 0 0 1 8 11.5c0-1.2.4-2 .8-2.6.4 1.3 1.2 1.8 1.7 2C10 8 10.5 5 12 3z"/>',
    ),
    bolt: svg('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'),
    drop: svg('<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>'),
    fire: svg(
      '<path d="M3 17V9h11l3 4h4v4"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>',
    ),
    police: svg('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>'),
    gov: svg('<path d="M4 20h16M5 20V9h14v11M9 20v-4h6v4M3 9l9-5 9 5"/>'),
    pin: svg(
      '<path d="M12 21s6-6 6-11a6 6 0 0 0-12 0c0 5 6 11 6 11z"/><circle cx="12" cy="10" r="2"/>',
    ),
  };
  const ICON_COLOR = {
    village: "#e0a325",
    shelter: "#2e9e5b",
    care: "#d64f86",
    heritage: "#7b5cd6",
    school: "#2b8fc4",
    crew: "#f2f2f2",
    f0: "#e5341a",
    water: "#2f7fe0",
    agency: "#4b5f8a",
    pick: "#ff6a00",
  };
  const AG_ICON = { fire: "fire", police: "police", gov: "gov", kepco: "bolt" };
  const WATER = (window.WATER_SOURCES || []).map((w, i) => ({
    ...w,
    id: `w${i}`,
  }));

  let map;
  const EMPTY = { type: "FeatureCollection", features: [] };
  const fc = (feats) => ({ type: "FeatureCollection", features: feats });
  const poly = (ring, props = {}) => ({
    type: "Feature",
    properties: props,
    geometry: { type: "Polygon", coordinates: [ring] },
  });
  const line = (coords, props = {}) => ({
    type: "Feature",
    properties: props,
    geometry: { type: "LineString", coordinates: coords },
  });
  const pt = (c, props = {}) => ({
    type: "Feature",
    properties: props,
    geometry: { type: "Point", coordinates: c },
  });
  const BASE_STYLE = "https://tiles.openfreemap.org/styles/liberty";
  const FALLBACK_STYLE = {
    version: 8,
    sources: {
      carto: {
        type: "raster",
        tiles: [
          "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
          "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        ],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors © CARTO",
      },
    },
    layers: [{ id: "carto", type: "raster", source: "carto" }],
  };
  const SAT_TILES = [
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  ];

  function initMap() {
    map = new maplibregl.Map({
      container: "map",
      style: BASE_STYLE,
      center: [128.64, 36.38],
      zoom: 11.4,
      maxZoom: 18.5,
      attributionControl: true,
    });
    map.addControl(
      new maplibregl.ScaleControl({ unit: "metric" }),
      "bottom-left",
    );
    let fellBack = false;
    map.on("error", (e) => {
      const msg = e && e.error ? String(e.error.message || e.error) : "";
      if (
        !fellBack &&
        !map.isStyleLoaded() &&
        /style|fetch|network|403|404|Failed/i.test(msg)
      ) {
        fellBack = true;
        toast("벡터 지도를 불러오지 못해 래스터 지도로 대체합니다.");
        map.setStyle(FALLBACK_STYLE);
      }
    });
    map.on("mousemove", (e) => {
      $("#coord").textContent =
        `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}`;
    });
    map.on("zoom", () => {
      $("#ts-zoom").value = map.getZoom();
    });
    map.on("click", (e) => onMapClick([e.lngLat.lng, e.lngLat.lat]));
    map.on("load", () => {
      const firstSymbol = (
        map.getStyle().layers.find((l) => l.type === "symbol") || {}
      ).id;
      const add = (id, data, layers) => {
        map.addSource(id, { type: "geojson", data });
        layers.forEach((l) => map.addLayer({ source: id, ...l }, firstSymbol));
      };
      map.addSource("sat", {
        type: "raster",
        tiles: SAT_TILES,
        tileSize: 256,
        maxzoom: 19,
        attribution: "Imagery: Esri, Maxar, Earthstar Geographics",
      });
      map.addLayer(
        {
          id: "sat",
          type: "raster",
          source: "sat",
          paint: { "raster-saturation": -0.1, "raster-brightness-min": 0.05 },
        },
        firstSymbol,
      );
      if (map.getLayer("building-3d"))
        map.setLayoutProperty("building-3d", "visibility", "none");
      add("admin", window.BOUNDARIES || EMPTY, [
        {
          id: "admin-emd",
          type: "line",
          filter: ["==", ["get", "level"], "emd"],
          paint: {
            "line-color": "#ffffff",
            "line-width": 1.2,
            "line-dasharray": [3, 3],
            "line-opacity": 0.8,
          },
        },
        {
          id: "admin-sig",
          type: "line",
          filter: ["==", ["get", "level"], "sigungu"],
          paint: {
            "line-color": "#ffe066",
            "line-width": 2,
            "line-opacity": 0.9,
          },
        },
      ]);
      add("risk", EMPTY, [
        {
          id: "risk-8",
          type: "fill",
          filter: ["==", ["get", "z"], 8],
          paint: { "fill-color": "#ffd166", "fill-opacity": 0.14 },
        },
        {
          id: "risk-5",
          type: "fill",
          filter: ["==", ["get", "z"], 5],
          paint: { "fill-color": "#ff8f66", "fill-opacity": 0.18 },
        },
        {
          id: "risk-8-line",
          type: "line",
          filter: ["==", ["get", "z"], 8],
          paint: {
            "line-color": "#ffd166",
            "line-width": 1.4,
            "line-dasharray": [4, 3],
          },
        },
        {
          id: "risk-5-line",
          type: "line",
          filter: ["==", ["get", "z"], 5],
          paint: { "line-color": "#ff8f66", "line-width": 1.8 },
        },
      ]);
      add("osm-lines", window.OSM_LINES || EMPTY, [
        {
          id: "roads",
          type: "line",
          filter: [
            "in",
            ["get", "kind"],
            ["literal", ["motorway", "trunk", "primary", "secondary"]],
          ],
          paint: {
            "line-color": [
              "match",
              ["get", "kind"],
              "motorway",
              "#ffb400",
              "primary",
              "#ffd966",
              "#ffffff",
            ],
            "line-width": [
              "match",
              ["get", "kind"],
              "motorway",
              2.6,
              "primary",
              2,
              1.4,
            ],
            "line-opacity": 0.85,
          },
        },
        {
          id: "rail",
          type: "line",
          filter: ["==", ["get", "kind"], "rail"],
          layout: { visibility: "none" },
          paint: {
            "line-color": "#b0b0b0",
            "line-width": 2,
            "line-dasharray": [2, 2],
          },
        },
      ]);
      const pl = powerLineCoords();
      add(
        "power",
        fc(pl.multi ? pl.multi : [line(pl.coords, { name: pl.name })]),
        [
          {
            id: "power",
            type: "line",
            paint: {
              "line-color": "#ffe066",
              "line-width": 2.2,
              "line-dasharray": [1, 1.5],
            },
          },
        ],
      );
      add(
        "routes",
        fc(
          S.routes.map((r) =>
            line(r.coords, { id: r.id, kind: r.kind, name: r.name }),
          ),
        ),
        [
          {
            id: "route-access",
            type: "line",
            filter: ["==", ["get", "kind"], "access"],
            paint: {
              "line-color": "#ffffff",
              "line-width": 2.2,
              "line-dasharray": [2, 1.5],
              "line-opacity": 0.9,
            },
          },
          {
            id: "route-evac",
            type: "line",
            filter: ["==", ["get", "kind"], "evac"],
            paint: {
              "line-color": "#3d8bff",
              "line-width": 3.4,
              "line-opacity": 0.95,
            },
          },
          {
            id: "route-conflict",
            type: "line",
            filter: ["==", ["get", "kind"], "conflict"],
            paint: {
              "line-color": "#ff3b3b",
              "line-width": 7,
              "line-opacity": 0.55,
            },
          },
        ],
      );
      add("houses", fc(state.houses.map((h) => pt(h.pt, { v: h.v }))), [
        {
          id: "houses",
          type: "circle",
          layout: { visibility: "none" },
          paint: {
            "circle-radius": 2.6,
            "circle-color": "#ffcf7a",
            "circle-stroke-color": "#5a3a12",
            "circle-stroke-width": 0.6,
          },
        },
      ]);
      add("fire-past", EMPTY, [
        {
          id: "fire-past",
          type: "line",
          paint: {
            "line-color": "#ff5a2b",
            "line-width": 1,
            "line-opacity": 0.7,
          },
        },
      ]);
      add("fire-cum", EMPTY, [
        {
          id: "fire-cum-fill",
          type: "fill",
          paint: { "fill-color": "#ff4d1f", "fill-opacity": 0.4 },
        },
        {
          id: "fire-cum-line",
          type: "line",
          paint: { "line-color": "#ff2a00", "line-width": 2.4 },
        },
      ]);
      add("fire-next", EMPTY, [
        {
          id: "fire-next",
          type: "line",
          paint: {
            "line-color": "#ffb347",
            "line-width": 1.8,
            "line-dasharray": [3, 2],
          },
        },
      ]);
      add("f0", EMPTY, [
        {
          id: "f0-fill",
          type: "fill",
          paint: { "fill-color": "#b3001b", "fill-opacity": 0.55 },
        },
        {
          id: "f0-line",
          type: "line",
          paint: { "line-color": "#ffffff", "line-width": 1.6 },
        },
      ]);
      add("draw", EMPTY, [
        {
          id: "draw-fill",
          type: "fill",
          filter: ["==", ["geometry-type"], "Polygon"],
          paint: { "fill-color": "#ff6a00", "fill-opacity": 0.25 },
        },
        {
          id: "draw-line",
          type: "line",
          filter: ["==", ["geometry-type"], "LineString"],
          paint: {
            "line-color": "#ff6a00",
            "line-width": 2.5,
            "line-dasharray": [2, 1.5],
          },
        },
        {
          id: "draw-pt",
          type: "circle",
          filter: ["==", ["geometry-type"], "Point"],
          paint: {
            "circle-radius": 4.5,
            "circle-color": "#ff6a00",
            "circle-stroke-color": "#fff",
            "circle-stroke-width": 1.5,
          },
        },
      ]);
      makeMarkers();
      [
        ["route-evac", "name"],
        ["route-access", "name"],
        ["route-conflict", "name"],
        ["power", "name"],
        ["roads", "name"],
      ].forEach(([id, key]) => {
        map.on("click", id, (e) => {
          if (state.rep.pickMode || state.rep.drawMode) return;
          const p = e.features[0].properties;
          new maplibregl.Popup({ closeButton: false })
            .setLngLat(e.lngLat)
            .setHTML(
              `<div class="map-popup"><b>${esc(p[key] || p.ref || "도로")}</b>${p.ref ? ` <span style="color:#666">${esc(p.ref)}</span>` : ""}</div>`,
            )
            .addTo(map);
        });
        map.on(
          "mouseenter",
          id,
          () => (map.getCanvas().style.cursor = "pointer"),
        );
        map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
      });
      applyLayerVisibility();
      applySat();
      updateFireLayers();
    });
  }
  function markerEl(cls, icon, label, sub) {
    const el = document.createElement("div");
    el.className = `mk ${cls}`;
    el.innerHTML = `<span class="ico" style="background:${ICON_COLOR[cls] || "#999"}">${ICONS[icon]}</span><span class="lb">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ""}</span>`;
    return el;
  }
  const mkMarker = (key, el, lngLat, onClick) => {
    if (onClick)
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (state.rep.pickMode || state.rep.drawMode) return;
        onClick();
      });
    state.markers[key] = new maplibregl.Marker({
      element: el,
      anchor: "bottom",
    })
      .setLngLat(lngLat)
      .addTo(map);
    return state.markers[key];
  };
  // 주요 시설 지도 표시(위치·종류만 — 상세 정보 조회 기능은 두지 않음)
  const simplePopup = (key, lngLat, name, kind) =>
    popup(
      lngLat,
      `<b>${esc(name)}</b> <span style="color:#666">${esc(kind)}</span>`,
    );
  function makeMarkers() {
    S.villages.forEach((v) =>
      mkMarker(
        `v:${v.id}`,
        markerEl("village", "house", v.name, v.emd),
        [v.lng, v.lat],
        () => simplePopup(v.id, [v.lng, v.lat], v.name, `${v.emd} 마을`),
      ),
    );
    S.facilities.forEach((f) => {
      const cls =
        f.type === "care" || f.type === "welfare"
          ? "care"
          : f.type === "heritage" || f.type === "temple"
            ? "heritage"
            : "school";
      const kind = {
        care: "요양시설",
        welfare: "복지시설",
        heritage: "국가유산",
        temple: "사찰",
        school: "학교",
      }[f.type];
      mkMarker(
        `f:${f.id}`,
        markerEl(cls, cls, f.name, kind),
        [f.lng, f.lat],
        () => simplePopup(f.id, [f.lng, f.lat], f.name, kind),
      );
    });
    S.shelters.forEach((s) =>
      mkMarker(
        `s:${s.id}`,
        markerEl("shelter", "shelter", s.name, "대피소"),
        [s.lng, s.lat],
        () => simplePopup(s.id, [s.lng, s.lat], s.name, "대피소"),
      ),
    );
    S.agencies.forEach((a) =>
      mkMarker(
        `a:${a.id}`,
        markerEl("agency", AG_ICON[a.type] || "gov", a.name, "유관기관"),
        [a.lng, a.lat],
        () => simplePopup(a.id, [a.lng, a.lat], a.name, "유관기관"),
      ),
    );
    WATER.slice(0, 25).forEach((w) =>
      mkMarker(
        `w:${w.id}`,
        markerEl("water", "drop", w.name, "담수지"),
        [w.lng, w.lat],
        () => simplePopup(w.id, [w.lng, w.lat], w.name, "담수지(저수지)"),
      ),
    );
    state.markers["f0"] = new maplibregl.Marker({
      element: markerEl("f0", "flame", "발화점", ""),
      anchor: "bottom",
    })
      .setLngLat(inc().ignition)
      .addTo(map);
    const pk = markerEl("pick", "pin", "발화 위치(입력 중)", "");
    pk.style.display = "none";
    state.markers["pick"] = new maplibregl.Marker({
      element: pk,
      anchor: "bottom",
    })
      .setLngLat(inc().ignition)
      .addTo(map);
    (window.BOUNDARIES || EMPTY).features
      .filter((f) => f.properties.level === "emd")
      .forEach((f) => {
        const ring =
          f.geometry.type === "Polygon"
            ? f.geometry.coordinates[0]
            : f.geometry.coordinates
                .slice()
                .sort((a, b) => b[0].length - a[0].length)[0][0];
        const c = ring
          .reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0])
          .map((x) => x / ring.length);
        const el = document.createElement("div");
        el.className = "mk emd";
        el.textContent = f.properties.name;
        state.emdLabels.push(
          new maplibregl.Marker({ element: el }).setLngLat(c).addTo(map),
        );
      });
    rebuildCrewMarkers();
  }
  function rebuildCrewMarkers() {
    if (!map) return;
    state.crewMarkers.forEach((m) => m.remove());
    state.crewMarkers = [];
    Object.keys(state.markers)
      .filter((k) => k.startsWith("c:"))
      .forEach((k) => delete state.markers[k]);
    S.resources
      .filter((r) => r.type === "인력" && r.status === "투입" && r.pos)
      .forEach((r) => {
        const el = markerEl("crew", "crew", r.name, `${r.qty}명`);
        const m = mkMarker(`c:${r.id}`, el, r.pos, () =>
          simplePopup(r.id, r.pos, r.name, `진화인력 ${r.qty}명`),
        );
        state.crewMarkers.push(m);
      });
    applyLayerVisibility();
  }
  const popup = (lngLat, html) =>
    new maplibregl.Popup({ closeButton: true, maxWidth: "280px" })
      .setLngLat(lngLat)
      .setHTML(`<div class="map-popup">${html}</div>`)
      .addTo(map);
  function updateFireLayers() {
    if (!map || !map.getSource("fire-cum")) return;
    const I = inc(),
      st = IS(),
      t = st.t,
      sl = st.slices,
      ar = actualRing(I);
    map
      .getSource("f0")
      .setData(fc([poly(ar || circleRing(I.ignition, 120), {})]));
    if (
      state.role === "reporter" ||
      !st.predicted ||
      !sl.length ||
      I.status === "종료"
    ) {
      ["fire-cum", "fire-past", "fire-next", "risk"].forEach((id) =>
        map.getSource(id).setData(EMPTY),
      );
      S.villages.forEach((v) =>
        state.markers[`v:${v.id}`].getElement().classList.remove("burned"),
      );
      S.shelters.forEach((s) =>
        state.markers[`s:${s.id}`].getElement().classList.remove("unsafe"),
      );
      return;
    }
    map
      .getSource("fire-cum")
      .setData(fc(t === 0 ? [] : [poly(sl[t - 1], { t })]));
    map
      .getSource("fire-past")
      .setData(
        fc(
          sl.slice(0, Math.max(0, t - 1)).map((r, i) => poly(r, { t: i + 1 })),
        ),
      );
    map
      .getSource("fire-next")
      .setData(fc(t < 8 ? [poly(sl[t], { t: t + 1 })] : []));
    map
      .getSource("risk")
      .setData(fc([poly(sl[7], { z: 8 }), poly(sl[4], { z: 5 })]));
    S.villages.forEach((v) =>
      state.markers[`v:${v.id}`]
        .getElement()
        .classList.toggle(
          "burned",
          t > 0 && pointInRing([v.lng, v.lat], sl[t - 1]),
        ),
    );
    S.shelters.forEach((s) =>
      state.markers[`s:${s.id}`]
        .getElement()
        .classList.toggle("unsafe", pointInRing([s.lng, s.lat], sl[7])),
    );
  }
  const layerOn = (id) => {
    const b = document.querySelector(`.lyr-btn[data-layer="${id}"]`);
    return !b || !b.classList.contains("off");
  };
  function applyLayerVisibility() {
    if (!map || !map.getLayer("roads")) return;
    const set = (layers, v) =>
      layers.forEach(
        (l) =>
          map.getLayer(l) &&
          map.setLayoutProperty(l, "visibility", v ? "visible" : "none"),
      );
    set(
      [
        "fire-cum-fill",
        "fire-cum-line",
        "fire-past",
        "fire-next",
        "f0-fill",
        "f0-line",
      ],
      layerOn("fire"),
    );
    set(["risk-5", "risk-8", "risk-5-line", "risk-8-line"], layerOn("risk"));
    set(["houses"], layerOn("houses"));
    set(["roads"], layerOn("roads"));
    set(["rail"], layerOn("rail"));
    set(["power"], layerOn("power"));
    set(["route-access", "route-evac", "route-conflict"], layerOn("routes"));
    set(["admin-emd", "admin-sig"], layerOn("admin"));
    const show = (prefix, v) =>
      Object.entries(state.markers).forEach(([k, m]) => {
        if (k.startsWith(prefix))
          m.getElement().style.display = v ? "" : "none";
      });
    show("v:", layerOn("villages"));
    show("s:", layerOn("shelters"));
    show("c:", layerOn("crew"));
    show("w:", layerOn("water"));
    show("a:", layerOn("agencies"));
    Object.entries(state.markers).forEach(([k, m]) => {
      if (k.startsWith("f:")) {
        const el = m.getElement();
        el.style.display = (
          el.classList.contains("heritage")
            ? layerOn("heritage")
            : layerOn("care")
        )
          ? ""
          : "none";
      }
    });
    state.emdLabels.forEach(
      (m) => (m.getElement().style.display = layerOn("admin") ? "" : "none"),
    );
  }
  function applySat() {
    if (!map || !map.getLayer("sat")) return;
    map.setLayoutProperty("sat", "visibility", state.sat ? "visible" : "none");
    $("#ts-sat").classList.toggle("on", state.sat);
    document.body.classList.toggle("satmap", state.sat);
  }
  function fitAll() {
    const st = IS(),
      I = inc();
    const showPred = st.predicted && st.slices.length && I.status !== "종료";
    const pts = showPred
      ? st.slices[7]
      : actualRing(I) || circleRing(I.ignition, 4000);
    const b = pts.reduce(
      (bb, p) => bb.extend(p),
      new maplibregl.LngLatBounds(pts[0], pts[0]),
    );
    if (showPred) S.shelters.forEach((s) => b.extend([s.lng, s.lat]));
    const w = map.getContainer().clientWidth,
      h = map.getContainer().clientHeight;
    const rightOpen =
        $("#info-panel").classList.contains("on") ||
        $("#rep-panel").classList.contains("on"),
      leftOpen = $("#left-panel").classList.contains("on");
    map.fitBounds(b, {
      padding:
        w > 1000 && h > 600
          ? {
              top: 70,
              bottom: 60,
              left: leftOpen ? 350 : 40,
              right: rightOpen ? 490 : 80,
            }
          : 30,
      maxZoom: 13.5,
      duration: 800,
    });
  }
  function selectIncident(id, fly) {
    pause();
    state.incId = id;
    if (map) {
      state.markers["f0"].setLngLat(inc().ignition);
      updateFireLayers();
      if (fly) map.flyTo({ center: inc().ignition, zoom: 12.3, duration: 800 });
    }
    setT(IS().t);
    renderAll();
  }

  // ------------------------------------------------------------------ 재생 · 예측
  function setT(t) {
    const st = IS();
    st.t = Math.max(0, Math.min(8, t));
    $("#time-slider").value = st.t;
    const d = addH(T0, st.t);
    $("#time-label").innerHTML =
      inc().status === "종료"
        ? `${hhmm(T0)}<small>종료 — 예측 미표시</small>`
        : st.predicted
          ? `${hhmm(d)}<small>t0+${st.t}h${isNight(d) ? " · 야간" : ""}</small>`
          : `${hhmm(T0)}<small>예측 전</small>`;
    $("#ip-clock").textContent = `${ymd(d)} ${hhmm(d)}`;
    updateFireLayers();
  }
  function play() {
    if (inc().status === "종료") {
      toast("종료된 산불은 예측 범위(P1~P8)를 표시하지 않습니다.");
      return;
    }
    if (!IS().predicted) {
      toast(
        canOperate()
          ? "먼저 확산 예측을 실행해야 재생할 수 있습니다."
          : "통합지휘권자가 확산 예측을 실행하면 재생할 수 있습니다.",
      );
      return;
    }
    if (state.playing) {
      pause();
      return;
    }
    if (IS().t >= 8) setT(0);
    state.playing = true;
    $("#btn-play").innerHTML = svg(
      '<path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor" stroke="none"/>',
    );
    const step = () => {
      if (IS().t >= 8) {
        pause();
        return;
      }
      setT(IS().t + 1);
      state.timer = setTimeout(step, 1400 / Number($("#speed-sel").value));
    };
    state.timer = setTimeout(step, 600);
  }
  function pause() {
    state.playing = false;
    clearTimeout(state.timer);
    $("#btn-play").innerHTML = svg(
      '<path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none"/>',
    );
  }
  // UC-PRED-01: 통합지휘권자가 누를 때만 실행(자동 실행 없음). 누른 시점의 최신 실측 화선(없으면 발화점)·기상·자원 상태 기준
  function runPrediction() {
    const I = inc(),
      st = IS();
    if (!canOperate()) return;
    if (I.status === "종료") {
      toast("종료된 산불에는 예측을 실행하지 않습니다.");
      return;
    }
    if (state.predicting) return;
    const shouldFailPrediction = S.prediction_demo?.mock_fail_next === true;

    const shouldFailProposal =
      S.prediction_demo?.mock_fail_proposal_next === true;

    if (S.prediction_demo) {
      S.prediction_demo.mock_fail_next = false;
      S.prediction_demo.mock_fail_proposal_next = false;
    }
    pause();
    const btn = $("#btn-predict"),
      bar = $("#predict-progress"),
      sl = $("#predict-status");
    btn.disabled = true;
    state.predicting = true;
    let p = 0;
    const steps = [
      "입력 검증(발화점·실측 화선·t0)",
      "기상청 단기예보 조회",
      "확산 모델 실행",
      "P1~P8 누적성 검증",
      "규칙 판정·제안 생성",
    ];
    const tick = () => {
      p += 9;
      bar.style.width = Math.min(100, p) + "%";
      sl.textContent =
        steps[Math.min(steps.length - 1, Math.floor(p / 21))] + "…";
      if (p < 100) setTimeout(tick, 180);
      else {
        if (shouldFailPrediction) {
          // 새 결과를 저장하지 않아 이전 결과를 그대로 유지
          state.predicting = false;
          btn.disabled = false;
          btn.textContent = st.predicted ? "다시 예측" : "확산 예측 실행";

          bar.style.width = "0%";

          sl.textContent = st.predicted
            ? "예측에 실패했습니다. 이전 결과를 유지합니다. 다시 예측해 주세요."
            : "예측에 실패했습니다. 다시 실행해 주세요.";

          addEvent("예측", "확산예측 실패 시연 — 새 결과를 저장하지 않음");

          toast("예측에 실패했습니다. 다시 실행해 주세요.");
          return;
        }
        // 새 예측은 우선 임시 변수에만 준비
        const nextWind = {
          ms: wx().wind_ms,
          dir: wx().wind_dir,
        };

        const perim = curPerim(I);

        const nextSlices = buildSlices(
          I.ignition,
          nextWind,
          perim ? perim.ring : null,
        );

        const nextPredPerim = perim
          ? {
              version: perim.version,
              area: ringAreaHa(perim.ring),
              at: perim.at,
            }
          : null;

        let preparedRun;

        try {
          if (shouldFailProposal) {
            throw new Error("제안 생성 실패 시연");
          }

          // 새 예측을 확정하기 전에 제안 생성 확인
          preparedRun = buildProposalCandidate(
            I,
            st,
            nextSlices,
            nextPredPerim,
            "예측 갱신",
          );
        } catch (error) {
          state.predicting = false;
          btn.disabled = false;
          btn.textContent = st.predicted ? "다시 예측" : "확산 예측 실행";

          bar.style.width = "0%";

          sl.textContent = st.predicted
            ? "제안 생성에 실패했습니다. 이전 예측·위험도·제안을 유지합니다."
            : "제안 생성에 실패했습니다. 새 예측을 확정하지 않았습니다.";

          addEvent(
            "예측",
            "제안 생성 실패 — 새 예측·위험도·제안을 확정하지 않음",
          );

          toast("제안 생성에 실패했습니다. 다시 실행해 주세요.");
          return;
        }

        // 제안 생성 성공 후 새 예측 상태 반영
        state.wind = nextWind;
        st.slices = nextSlices;
        st.predicted = true;
        st.stale = false;
        st.predictedAt = nowSim();
        st.predPerim = nextPredPerim;
        // 제안서 버전과 별도로 예측 회차를 기록
        st.predictionSeq = (st.predictionSeq || 0) + 1;
        // 위험도 결과 상태 시연: 실제 계산 실패 검사가 아님
        st.riskStatus = S.risk_model.mock_fail_next ? "failed" : "ready";

        // 실패 설정은 한 번 사용한 뒤 해제: 다음 예측에서는 정상 시연
        S.risk_model.mock_fail_next = false;
        // 정상 시연 결과의 계산 시각: 기존 예측 완료 시각 사용
        st.riskComputedAt =
          st.riskStatus === "ready" ? new Date(st.predictedAt.getTime()) : null;
        // 점수가 낮아져도 최신 예측의 시연 결과로 대체
        // 일반 시연: 사건별 예측 회차에 맞는 결과 선택
        const demoRuns = I.risk_demo_runs || [];

        const demoIndex = Math.min(
          Math.max(st.predictionSeq - 1, 0),
          demoRuns.length - 1,
        );

        const normalDemo = demoRuns[demoIndex] || null;

        // 병합 시연: 설정을 켠 경우에만 공통 결과 사용
        const mergeDemo = S.risk_merge_demo;

        const useMergedDemo =
          mergeDemo?.enabled === true &&
          (mergeDemo.mergedIds || []).includes(I.id);

        const riskDemo = useMergedDemo ? mergeDemo : normalDemo;

        // 화면과 AI가 함께 읽는 최신 위험도 결과
        st.latestRisk =
          st.riskStatus === "ready"
            ? {
                ...computeRisk(I, riskDemo),
                predictionId: st.predictionSeq,
                computedAt: st.riskComputedAt,
                mergedIds: useMergedDemo ? [...mergeDemo.mergedIds] : [],
              }
            : null;
        btn.disabled = false;
        state.predicting = false;
        addEvent(
          "예측",
          `확산 예측 갱신 — 5h ${fmt0(ringAreaHa(st.slices[4]))} ha, 8h ${fmt0(ringAreaHa(st.slices[7]))} ha, 주 방향 ${dirName(state.wind.dir + 180)} · 기준 실측 화선 ${perimTag(perim)}`,
        );
        setT(0);
        const run = generateProposal("예측 갱신", preparedRun);
        toast(`예측이 끝나 진화·대피 대응 제안서를 생성했습니다(${run.id}).`);
        fitAll();
      }
    };
    tick();
  }

  // ------------------------------------------------------------------ 이벤트 로그 · 토스트 · 모달
  // 이벤트 로그(추가 전용). 구분: 시스템·입력·예측·제안·근거 부족·정정·종료·관리. 시스템·관리 이벤트는 사건 없이(inc null) 기록
  function addEvent(kind, text) {
    state.events.push({
      t: hhmmss(nowSim()),
      kind,
      text,
      inc: kind === "시스템" || kind === "관리" ? null : state.incId,
      user: state.user,
    });
    renderHistory();
  }
  function toast(msg, ms = 2600) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("on");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove("on"), ms);
  }
  function openModal(title, bodyHTML, actions) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = bodyHTML;
    const ac = $("#modal-actions");
    ac.innerHTML = "";
    const seq = ++modalSeq;
    (actions || [{ label: "닫기" }]).forEach((a) => {
      const b = document.createElement("button");
      b.textContent = a.label;
      if (a.cls) b.className = a.cls;
      b.onclick = () => {
        const r = a.onClick ? a.onClick() : undefined;
        if (r !== false && modalSeq === seq) closeModal();
      };
      ac.appendChild(b);
    });
    $("#modal-bg").classList.add("on");
  }
  let modalSeq = 0;
  const closeModal = () => $("#modal-bg").classList.remove("on");

  // ------------------------------------------------------------------ 패널 제어
  function showPanel(id, on) {
    const p = $(id);
    p.classList.toggle("on", on == null ? !p.classList.contains("on") : on);
    syncVtabs();
  }
  function syncVtabs() {
    $$(".vtab").forEach((v) =>
      v.classList.toggle(
        "on",
        $(
          {
            fire: state.role === "reporter" ? "#rep-panel" : "#info-panel",
            legend: "#legend-panel",
          }[v.dataset.v],
        ).classList.contains("on"),
      ),
    );
  }
  const COMMANDER_TABS = ["risk", "proposal", "history"];
  function showTab(tab) {
    if (state.role === "reporter") {
      showPanel("#rep-panel", true);
      return;
    }
    if (!canOperate() && COMMANDER_TABS.includes(tab)) tab = "status";
    showPanel("#info-panel", true);
    $$(".ip-tab").forEach((b) =>
      b.classList.toggle("on", b.dataset.tab === tab),
    );
    $$(".ipt").forEach((p) => p.classList.toggle("on", p.id === `ipt-${tab}`));
    $$(".menu-btn").forEach((b) =>
      b.classList.toggle("on", b.dataset.menu === tab),
    );
  }
  function openChatPopup() {
    if (!canOperate()) {
      toast("AI 어시스턴트는 통합지휘권자만 사용할 수 있습니다.");
      return;
    }
    showPanel("#chat-panel", true);
    $("#chat-fab").style.display = "none";
    openChat();
    $("#chat-input").focus();
  }
  function makeDraggable(panel) {
    const hd = panel.querySelector(".fhd");
    if (!hd) return;
    let sx,
      sy,
      ox,
      oy,
      drag = false;
    hd.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      drag = true;
      sx = e.clientX;
      sy = e.clientY;
      const r = panel.getBoundingClientRect(),
        pr = $("#stage").getBoundingClientRect();
      ox = r.left - pr.left;
      oy = r.top - pr.top;
      panel.style.right = "auto";
      panel.style.left = ox + "px";
      panel.style.top = oy + "px";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!drag) return;
      panel.style.left = ox + e.clientX - sx + "px";
      panel.style.top = Math.max(0, oy + e.clientY - sy) + "px";
    });
    document.addEventListener("mouseup", () => (drag = false));
  }

  // ------------------------------------------------------------------ 렌더링: 헤더 · 산불현황(UC-SIT-02) · 종료(UC-SIT-01)
  const stBadge = (s) =>
    `<span class="badge b-${s === "진행 중" ? "진행" : s}">${esc(s)}</span>`;
  const fmtIso = (s) => (s ? ymdhm(new Date(s)) : "—");
  const fmtHM = (s) => (s ? hhmm(new Date(s)) : "—");
  function renderHeader() {
    const I = inc(),
      w = wx();
    $("#hdr-user").innerHTML =
      `<b>${esc(state.user)}</b> · ${ROLE_LABEL[state.role] || ""}(${PERM_LABEL[state.role] || ""})`;
    $("#ip-name").textContent = `| ${I.name}`;
    $("#ip-addr").textContent = I.addr;
    $("#ip-report").textContent = `${fmtHM(I.report_time)} ${I.report_text}`;
    $("#ip-status").innerHTML =
      `${stBadge(I.status)} <span class="muted small">접수 ${fmtIso(I.report_time)}</span>`;
    $("#ip-stage").innerHTML =
      `<b>${esc(I.official_stage)}</b> · ${esc(I.alert_level)}`;
    // 기상청 단기예보 캐시: 호출에 실패해도 마지막으로 받은 값과 수신 시각을 함께 표시한다(UC-SIT-03 E1)
    const weatherFailed = S.weather.fetch_status === "failed";

    $("#ip-weather").innerHTML =
      `${esc(wxText(w))}` +
      (S.weather.warnings.length
        ? ` · <b style="color:var(--red)">${esc(
            S.weather.warnings.join("·"),
          )}</b>`
        : "") +
      `<br><span class="small muted">` +
      `${esc(S.weather.source)} ${esc(S.weather.base_time)} 발표 · ` +
      `수신 ${fmtIso(S.weather.received_at)} · ${esc(w.t)} 기준` +
      `</span>` +
      (weatherFailed
        ? `
    <br>
    <span
      class="small"
      style="display:inline-flex;align-items:center;gap:5px;margin-top:4px;color:#8a5700"
    >
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        style="flex-shrink:0"
      >
        <path
          d="M12 3 2 21h20L12 3Z"
          fill="#fff4ce"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linejoin="round"
        />
        <path
          d="M12 9v5"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
        <circle cx="12" cy="17" r="1" fill="currentColor" />
      </svg>
      <span>기상 갱신 실패 · 마지막 수신값 표시 중</span>
    </span>
  `
        : "");
  }
  // 산불 목록(UC-SIT-02): 기본은 접수·진행 중 목록, 「종료」로 바꾸면 종료 처리된 산불 목록
  function incidentListHTML(mode, selId) {
    const list = S.incidents.filter((i) =>
      mode === "종료" ? i.status === "종료" : i.status !== "종료",
    );
    const empty =
      mode === "종료"
        ? "종료 처리된 산불이 없습니다."
        : "진행 중인 산불이 없습니다.";
    return list.length
      ? `<table class="grid"><thead><tr><th>산불 · 발생 장소</th><th style="width:78px">발생 시각</th><th style="width:60px">상태</th></tr></thead><tbody>${list.map((i) => `<tr class="clickable ${i.id === selId ? "sel" : ""}" data-inc="${i.id}"><td><b>${esc(i.name)}</b><br><span class="small muted">${esc(i.addr)}</span></td><td class="num small">${i.start_time ? esc(ymdhm(new Date(i.start_time)).slice(5)) : '<span class="muted">미확인</span>'}</td><td style="text-align:center">${stBadge(i.status)}</td></tr>`).join("")}</tbody></table>`
      : `<div class="muted small" style="padding:8px 4px;border:1px dashed #ccc;text-align:center">${empty}</div>`;
  }
  const listModeHTML = (mode, key) =>
    `<span class="seg">${["진행", "종료"].map((m) => `<button data-${key}="${m}" class="${mode === m ? "on" : ""}">${m === "진행" ? "접수·진행 중" : "종료"}</button>`).join("")}</span>`;
  const intakeHTML = (I) =>
    (I.intake || []).length
      ? I.intake
          .map(
            (r) =>
              `<span style="display:inline-block;margin:1px 8px 1px 0">${esc(r.org)} <b>${esc(r.at)}</b> <span class="small muted">${esc(r.channel || "")}</span></span>`,
          )
          .join("")
      : "—";
  const perimHTML = (I) => {
    const p = curPerim(I),
      n = (I.perimeters || []).length;
    return p
      ? `<b>${perimTag(p)}</b> · ${fmt1(ringAreaHa(p.ring))} ha · 꼭짓점 ${p.ring.length - 1}개 <span class="small muted">(${fmtIso(p.at)} ${esc(p.by || "")} ${esc(p.source || "")}${n > 1 ? ` · 이전 버전 ${n - 1}개 보존` : ""})</span>`
      : '<span class="muted">미보고 — 초기대응에서는 생략 가능(발화점 기준 예측)</span>';
  };
  function renderStatus() {
    const I = inc(),
      st = IS();
    $("#st-mode").innerHTML = listModeHTML(state.listMode, "lm");
    $$("#st-mode [data-lm]").forEach(
      (b) =>
        (b.onclick = () => {
          state.listMode = b.dataset.lm;
          renderStatus();
        }),
    );
    $("#st-list").innerHTML = incidentListHTML(state.listMode, I.id);
    $$("#st-list tr.clickable").forEach(
      (tr) => (tr.onclick = () => selectIncident(tr.dataset.inc, true)),
    );
    $("#st-detail").innerHTML = `<table class="grid">
      <tr><td class="k">발생 장소</td><td colspan="3">${esc(I.addr)}<br><span class="small muted num">발화 위치 ${I.ignition[1].toFixed(5)}, ${I.ignition[0].toFixed(5)}</span></td></tr>
      <tr><td class="k">발생 일시</td><td>${I.start_time ? fmtIso(I.start_time) : '<span class="muted">미확인</span>'}</td><td class="k">신고 접수</td><td>${fmtIso(I.report_time)}</td></tr>
      <tr><td class="k">신고 내용</td><td colspan="3">${esc(I.report_text)}</td></tr>
      <tr><td class="k">접수 기록</td><td colspan="3">${intakeHTML(I)}</td></tr>
      <tr><td class="k">진행상태</td><td>${stBadge(I.status)}${I.ended_at ? ` <span class="small muted">종료 ${fmtIso(I.ended_at)}${I.ended_by ? " · " + esc(I.ended_by) : ""}</span>` : ""}</td><td class="k">공식 단계</td><td>${esc(I.official_stage)} · ${esc(I.alert_level)}</td></tr>
      <tr><td class="k">실측 화선</td><td colspan="3">${perimHTML(I)}</td></tr>
      ${I.status === "종료" ? "" : `<tr><td class="k">예측</td><td colspan="3">${st.predicted ? `${fmt0(ringAreaHa(st.slices[4]))} ha(5h) · ${fmt0(ringAreaHa(st.slices[7]))} ha(8h) <span class="small muted">기준 실측 화선 ${st.predPerim ? "v" + st.predPerim.version : "없음(발화점)"}</span>${st.stale ? ' <span class="badge b-대기">재예측 필요</span>' : ""}` : '<span class="muted">예측 전</span>'}</td></tr>`}
    </table>`;
    const ac = $("#st-actions");
    ac.innerHTML = "";
    // UC-SIT-01: 「종료 처리」는 통합지휘권자에게, '진행 중' 산불에만 보인다(이미 종료된 산불에는 표시하지 않음)
    if (canOperate() && I.status === "진행 중") {
      const b = document.createElement("button");
      b.className = "primary";
      b.textContent = "종료 처리";
      b.onclick = openEndModal;
      ac.appendChild(b);
    }
    if (I.status === "종료")
      ac.innerHTML = `<span class="small muted">종료된 산불입니다. 제안서·이력은 조회만 가능합니다.</span>`;
    else if (I.status === "접수")
      ac.innerHTML = `<span class="small muted">접수 상태 — 상황 보고자가 실측 화선을 처음 보고하면 '진행 중'으로 바뀝니다.</span>`;
  }
  function openEndModal() {
    const I = inc();
    if (state.predicting) {
      toast("실행이 끝난 뒤 종료할 수 있습니다.");
      return;
    }
    if (I.status !== "진행 중") return;
    openModal(
      "발화 종료 처리",
      `<p><b>${esc(I.name)}</b>의 진화가 끝났으면 <b>종료</b> 상태로 바꿉니다.</p><p style="color:var(--red);font-weight:700">종료하면 상황 보고·예측 실행·상황 정정이 막힙니다.</p><table class="grid"><tr><td class="k">종료 시각</td><td>${ymdhm(nowSim())}</td></tr><tr><td class="k">처리자</td><td>${esc(state.user)}(${ROLE_LABEL[state.role]})</td></tr><tr><td class="k">이후</td><td>진행 중 목록에서 빠져 「종료」 목록으로 옮겨지고, 제안서·이력은 조회만 가능합니다.</td></tr></table>`,
      [
        { label: "취소" },
        {
          label: "확인",
          cls: "primary",
          onClick: () => {
            I.status = "종료";
            I.ended_at = nowSim().toISOString();
            I.ended_by = state.user;
            pause();
            setT(0);
            addEvent("종료", `${I.name} 종료 처리`);
            toast("산불을 종료 상태로 바꿨습니다.");
            renderAll();
          },
        },
      ],
    );
  }

  // ------------------------------------------------------------------ 렌더링: 확산예측 · 위험도
  function renderPredict() {
    const I = inc(),
      st = IS(),
      cp = curPerim(I);
    const btn = $("#btn-predict");
    btn.textContent = st.predicted ? "다시 예측" : "확산 예측 실행";
    btn.disabled = I.status === "종료" || !!state.predicting;
    const basis = cp
      ? `최신 실측 화선 ${perimTag(cp)}(${fmt1(ringAreaHa(cp.ring))} ha, ${fmtHM(cp.at)} 보고)`
      : "실측 화선 없음 — 발화점에서 예측";
    if (I.status === "종료")
      $("#predict-status").textContent =
        "종료된 산불 — 예측 범위(P1~P8)를 표시하지 않습니다";
    else if (!st.predicted)
      $("#predict-status").textContent =
        `${basis} · t0 ${hhmm(T0)} · ${dirName(wx().wind_dir)}풍 ${wx().wind_ms} m/s`;
    else
      $("#predict-status").textContent =
        `완료(${hhmm(st.predictedAt)}) · 기준 실측 화선 ${st.predPerim ? "v" + st.predPerim.version : "없음(발화점)"} · 5h ${fmt0(ringAreaHa(st.slices[4]))} ha · 8h ${fmt0(ringAreaHa(st.slices[7]))} ha · 주 방향 ${dirName(state.wind.dir + 180)}${st.stale ? ` · 새 실측 화선(${cp ? perimTag(cp) : "발화 정보"})이 보고되어 「다시 예측」이 필요합니다` : ""}`;
    $("#predict-progress").style.width =
      st.predicted && I.status !== "종료" ? "100%" : "0%";
  }
  // UC-PRED-02 산불 위험도: 발화 지점의 기상·지형·연료·인프라 값 → 조건위험도(0~100)·등급·요인별 기여, 산불별 최대 위험도 저장
  function renderRisk() {
    if (!canOperate()) {
      $("#risk-box").innerHTML = "";
      return;
    }
    const I = inc();

    if (I.status === "종료") {
      $("#risk-box").innerHTML = `
    <div style="padding:16px 8px">
      <span class="badge b-종료">종료</span>
      <div class="small muted" style="margin-top:8px">
        종료된 산불은 위험도 숫자를 표시하지 않습니다.
      </div>
    </div>
  `;
      return;
    }
    if (!IS().predicted) {
      $("#risk-box").innerHTML = `
    <div style="padding:16px 8px">
      <div>예측 실행 후 표시</div>
      <div class="small muted" style="margin-top:8px">
        확산예측 탭에서 예측을 실행하면 위험도를 확인할 수 있습니다.
      </div>
    </div>
  `;
      return;
    }
    if (IS().riskStatus === "failed") {
      $("#risk-box").innerHTML = `
    <div style="padding:16px 8px">
      <div><b>위험도 계산 실패</b></div>
      <div class="small muted" style="margin-top:8px">
        확산예측 탭에서 다시 예측하면 위험도 계산을 재시도합니다.
      </div>
      <div class="small muted" style="margin-top:8px">
        ※ 계산 실패 상태 시연
      </div>
    </div>
  `;
      return;
    }
    const rk = riskOf(I);
    const mergedIds = rk.mergedIds || [];

    const mergedNames = mergedIds.map((id) => {
      const target = S.incidents.find((item) => item.id === id);
      return target ? target.name : id;
    });

    const mergedInfo =
      mergedIds.length > 1
        ? `
      <div class="sec">
        병합 계산
        <i
          class="info l"
          data-tip="P5 예측 범위가 겹친 산불을 함께 계산한 결과입니다. 대상 산불에는 같은 위험도 R을 표시합니다."
        ></i>
      </div>
      <div class="small" style="margin-bottom:8px">
        대상 산불: ${mergedNames.map((name) => esc(name)).join(" · ")}
      </div>
      <div class="small muted" style="margin-bottom:12px">
        현재 목업은 P5가 겹친 상황을 시연합니다.
      </div>
    `
        : "";
    const st = IS();

    const riskMeta = `
  <div class="small muted" style="margin:6px 0">
    기준 예측 ${st.predictionSeq}회
    · 계산 시각 ${st.riskComputedAt ? ymdhm(st.riskComputedAt) : "미확인"}
  </div>
`;

    $("#risk-box").innerHTML =
      `<div class="risk"><div class="gauge"><div class="v">${rk.score.toFixed(2)}</div><div class="k">산불 위험도 R 1.00~5.00</div></div><div class="fac">${rk.factors.map((f) => `<div class="row"><span title="${esc(f.vars)}">${esc(f.name)}</span><span class="bar"><i style="width:${Math.round((f.score / 5) * 100)}%"></i></span><span class="n">${f.score.toFixed(1)}/5 · 가중치 ${f.weight.toFixed(3)}</span></div>`).join("")}</div></div>
      ${riskMeta}
      ${mergedInfo}
      <div class="sec">요인별 입력 값<i class="info l" data-tip="기상·지형·연료·인프라 요인의 입력 정보를 표시합니다."></i></div>
      <table class="grid">${rk.factors.map((f) => `<tr><td class="k">${esc(f.name)}</td><td class="small">${esc(f.values || f.vars)}</td></tr>`).join("")}</table>
      <div class="small muted" style="margin-top:6px">
  현재 목업은 4요인 시연값을 사용합니다.
  ${rk.missing.length ? `<br>결측 입력: ${esc(rk.missing.join(", "))}` : ""}
</div>`;
  }

  // ------------------------------------------------------------------ 렌더링: 진화자원 현황(UC-SIT-03)
  // 진화자원 현황(UC-SIT-03): 기본은 「가용만 보기」 필터(가용 합계와 가용 단위만), 끄면 보유·투입·대기까지 모두 표시
  function renderResources() {
    const by = resSummary(),
      only = state.resAvailOnly;
    const rows = S.resources
      .filter((r) => !only || r.status !== "정비")
      .sort(
        (a, b) =>
          RTYPES.indexOf(a.type) - RTYPES.indexOf(b.type) ||
          (a.status === "투입" ? -1 : 1),
      );
    const cols = only ? ["가용"] : ["보유", "투입", "대기", "가용"];
    $("#lp-body").innerHTML = `
      <label class="small" style="display:flex;align-items:center;gap:4px;margin-bottom:6px"><input type="checkbox" id="res-avail" ${only ? "checked" : ""}> 가용만 보기 <span class="muted">(가용 = 투입 + 대기, 정비 제외)</span></label>
      <div class="cnt" style="grid-template-columns:56px repeat(${cols.length}, 1fr)"><div class="h">구분</div>${cols.map((c) => `<div class="h">${c}</div>`).join("")}${RTYPES.map((t) => `<div class="h">${t}${t === "인력" ? "(명)" : "(대)"}</div>${cols.map((c) => `<div><b>${by[t][c]}</b></div>`).join("")}`).join("")}</div>
      <table class="grid"><thead><tr><th>구분</th><th>명칭·호출부호</th><th>소속</th><th>수량</th><th>상태</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.type)}</td><td>${esc(r.name)}</td><td class="small">${esc(r.org)}</td><td class="num" style="text-align:center">${r.type === "인력" ? r.qty + "명" : "1대"}</td><td class="${r.status === "투입" ? "g" : r.status === "대기" ? "y" : ""}" style="text-align:center">${esc(r.status)}</td></tr>`).join("")}</tbody></table>`;
    $("#res-avail").onchange = (e) => {
      state.resAvailOnly = e.target.checked;
      renderResources();
    };
  }
  function renderLegend() {
    const ico = (cls, key) =>
      `<span class="ico-s" style="background:${ICON_COLOR[cls]}">${ICONS[key]}</span>`;
    $("#lg-body").innerHTML = `
      <div class="row"><span class="sw" style="background:#b3001b;opacity:.7"></span>현재 실측 화선(입력 폴리곤)</div>
      <div class="row"><span class="sw" style="background:#ff4d1f;opacity:.7"></span>재생 시각까지 예측 확산 범위 <span class="sw" style="border:1.5px dashed #e08a00;margin-left:4px"></span>다음 1시간 윤곽</div>
      <div class="row"><span class="sw" style="background:#ff8f66;opacity:.6"></span>위험구역(5h) <span class="sw" style="background:#ffd166;opacity:.7;margin-left:4px"></span>잠재 위험구역(8h)</div>
      <div class="row">${ico("f0", "flame")}발화점 ${ico("village", "house")}마을 ${ico("shelter", "shelter")}대피소 ${ico("care", "care")}취약시설</div>
      <div class="row">${ico("heritage", "heritage")}국가유산·사찰 ${ico("agency", "gov")}유관기관 ${ico("crew", "crew")}진화대 ${ico("water", "drop")}담수지</div>
      <div class="row"><span class="sw" style="background:#3d8bff"></span>대피로 <span class="sw" style="border:1.5px dashed #555;background:#fff;margin-left:4px"></span>진입로 <span class="sw" style="background:#ff3b3b;opacity:.6;margin-left:4px"></span>겹침 구간</div>
      <div class="row"><span class="sw" style="border-top:2px dotted #c9a000"></span>송전선 <span class="sw" style="border-top:1.5px dashed #999;margin-left:4px"></span>읍면 경계</div>
      <div class="small muted" style="margin-top:6px">위성영상 Esri · 지도 OpenFreeMap © OpenMapTiles © OpenStreetMap contributors · 경계 SGIS</div>`;
  }

  // ------------------------------------------------------------------ 렌더링: 대응 제안(UC-PROP-01·02) · 근거(UC-PROP-03)
  const citeHTML = (text, blockId) =>
    esc(text).replace(
      /\[(\d+)\]/g,
      (m, k) =>
        `<span class="cite" data-b="${blockId}" data-k="${k}">${k}</span>`,
    );
  const badges = (status) =>
    status
      .filter((s) => s !== "(없음)")
      .map((s) => `<span class="badge b-${s}">${esc(s)}</span>`)
      .join("");
  function renderProposal() {
    const st = IS(),
      run = st.viewRun,
      isCurrent = run === st.currentRun,
      closed = inc().status === "종료";
    $("#prop-meta").innerHTML = run
      ? `<b>${run.id}</b> · 생성 ${hhmm(run.createdAt)}(${esc(run.reason)}) · 기준 실측 화선 <b>${run.perim ? "v" + run.perim.version : "없음(발화점)"}</b> · 공식 ${esc(run.snapshot.official_stage)} · 판정 <b>${esc(run.R.recStage)}</b>${isCurrent ? "" : ' <span class="badge b-없음">이전 버전</span> <a href="#" id="prop-latest">최신 버전으로</a>'}${closed ? ' <span class="badge b-종료">조회 전용</span>' : ""}`
      : "";
    const pl = $("#prop-latest");
    if (pl)
      pl.onclick = (e) => {
        e.preventDefault();
        st.viewRun = st.currentRun;
        renderAll();
      };
    const banner = $("#stage-banner");
    if (run && run.R.stageUp) {
      banner.classList.add("on");
      banner.innerHTML = `<b>격상 검토 권고</b> — 4요소 중 ${esc(josa(run.R.stageDrivers.join("·"), "이", "가"))} ${esc(run.R.recStage)} 기준입니다. 산림청장과 협의하십시오.${run.R.nextHolder ? ` 격상 시 지휘권자는 <b>${esc(run.R.nextHolder)}</b>, 주민대피 명령권은 시장·군수·구청장에게 남습니다.` : ""}${tip("판단기준 4요소(예상 피해면적·평균풍속·예상 진화시간·시설피해, 표준매뉴얼 p.73) 중 가장 높은 단계로 판정합니다. 예상 진화시간은 상황 정정으로 입력한 값이며 없으면 제외합니다. 구간값은 시행령 별표 기준을 2026 체계에 대응시킨 목업 근사값이고, 발령은 산림청장이 통합지휘본부와 협의해 결정하며 이 화면은 권고만 합니다.", "l")}`;
    } else banner.classList.remove("on");
    const box = $("#cards");
    if (!run) {
      box.innerHTML = `<div class="muted" style="padding:18px 6px;text-align:center">확산 예측을 실행하면 제안이 생성됩니다.</div>`;
      $("#prop-summary").innerHTML = "";
      return;
    }
    const prevRun = st.runs[st.runs.indexOf(run) - 1] || null;
    const all = run.blocks.filter((b) => b.axis === state.axis);
    const fired = all.filter((b) => b.status[0] !== "(없음)");
    const active = fired.filter(
      (b) => state.filter === "all" || b.status.includes(state.filter),
    );
    const card = (b) => {
      const changed = prevRun && run.changed.includes(b.id);
      const evid =
        b.evidence
          .map((e) => {
            const c = S.evidence[e.key];
            return `<span class="ev"><span class="cite" data-b="${b.id}" data-k="${e.k}">${e.k}</span> ${esc(c.doc)} ${esc(c.page)} ${esc(c.section)}</span>`;
          })
          .join("") || "—";
      return `<div class="card axis-${b.axis}" data-id="${b.id}">
        <div class="head"><span class="arrow">▶</span><span class="nm">${esc(b.name)}</span>${changed ? `<span class="chg-tag" data-chg="${b.id}" title="직전 버전 대비 변경 내용 보기">변경</span>` : ""}<span class="st">${badges(b.status)}</span></div>
        <div class="sum">
          <div class="text">${citeHTML(b.text, b.id)}</div>
          ${b.withheld.map((w) => `<div class="withheld"><b>${esc(w.slot)}</b> — ${NO_EVIDENCE}</div>`).join("")}
        </div>
        <div class="body">
          <div class="detail">
            ${b.finding ? `<div class="row"><span class="k">판정 이유</span><span class="v">${esc(b.finding)}</span></div>` : ""}
            ${b.targets.length ? `<div class="row"><span class="k">대상</span><span class="v">${esc(b.targets.join(", "))}</span></div>` : ""}
            <div class="row"><span class="k">권한</span><span class="v">${esc(b.authority)}</span></div>
            <div class="row"><span class="k">근거</span><span class="v">${evid}</span></div>
          </div>
          ${canOperate() ? `<div class="actions"><button class="ask-btn" data-id="${b.id}">이 항목 질문</button></div>` : ""}
        </div></div>`;
    };
    box.innerHTML =
      active.map(card).join("") +
      (active.length
        ? ""
        : `<div class="muted" style="padding:14px 6px;text-align:center">해당하는 항목이 없습니다.</div>`);
    $$("#cards .card .head, #cards .card .sum").forEach((h) =>
      h.addEventListener("click", () =>
        h.closest(".card").classList.toggle("open"),
      ),
    );
    $$("#cards .chg-tag").forEach((t) =>
      t.addEventListener("click", (e) => {
        e.stopPropagation();
        showItemDiff(prevRun, run, t.dataset.chg);
      }),
    );
    $$("#cards .ask-btn").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        state.chatCtx = b.dataset.id;
        openChatPopup();
      }),
    );
    $$("#cards .cite").forEach((c) =>
      c.addEventListener("click", (e) => {
        e.stopPropagation();
        openEvidence(run, c.dataset.b, Number(c.dataset.k));
      }),
    );
    const s = run.summary;
    $("#prop-summary").innerHTML =
      ["즉시", "대기", "협의", "요청"]
        .map((k) => `<span class="badge b-${k}">${k} ${s[k]}</span>`)
        .join("") +
      `<span style="margin-left:auto">${state.axis} 7항목 중 발동 ${fired.length}</span>`;
  }
  function focusCard(id, open) {
    const st = IS(),
      b = st.viewRun && st.viewRun.blocks.find((x) => x.id === id);
    if (!b) return;
    if (b.axis !== state.axis) {
      state.axis = b.axis;
      $$(".ptab").forEach((t) =>
        t.classList.toggle("on", t.dataset.axis === state.axis),
      );
      state.filter = "all";
      $$(".pfilter").forEach((f) =>
        f.classList.toggle("on", f.dataset.f === "all"),
      );
      renderProposal();
    }
    const el = document.querySelector(`#cards .card[data-id="${id}"]`);
    if (!el) return;
    if (open) el.classList.add("open");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("hi");
    setTimeout(() => el.classList.remove("hi"), 1800);
  }
  function openEvidence(run, blockId, k) {
    const b = run.blocks.find((x) => x.id === blockId);
    const ev = b.evidence.find((e) => e.k === k);
    if (!ev) return;
    const sentences = b.text.split(/(?<=다\.)\s*/).filter(Boolean);
    const sent = sentences.find((s) => s.includes(`[${k}]`)) || b.text;
    $("#ev-title").textContent = `근거 — ${b.name}`;
    $("#ev-body").innerHTML =
      `<div class="ev-sentence">${citeHTML(sent, b.id)}</div>` +
      b.evidence
        .map((e) => {
          const c = S.evidence[e.key];
          return `<div class="ev-chunk" style="${e.k === k ? "border-color:#e0a325;background:#fffbe6" : ""}"><div class="meta">[${e.k}] ${esc(c.doc)} ${esc(c.page)} · ${esc(c.section)}</div><div>${e.k === k ? `<mark>${esc(c.text)}</mark>` : esc(c.text)}</div></div>`;
        })
        .join("") +
      `<div class="small muted">원문 열람은 시연에서 제공하지 않습니다(표준매뉴얼 비공개). 위 텍스트는 쪽수 기준 요약입니다.</div>`;
    $("#evidence-drawer").classList.add("on");
  }

  // ------------------------------------------------------------------ 렌더링: 제안 이력(UC-PROP-04) · 이벤트 로그
  function renderHistory() {
    const st = IS();
    const runs = st.runs.slice().reverse();
    $("#hist-runs").innerHTML = runs.length
      ? `<table class="grid"><thead><tr><th>버전</th><th>생성</th><th>기준 화선</th><th>생성 계기</th><th title="즉시/대기/협의/요청">즉/대/협/요</th><th>변경</th><th></th></tr></thead><tbody>${runs.map((r) => `<tr class="${r === st.viewRun ? "sel" : ""}"><td style="text-align:center;white-space:nowrap"><b>${r.id}</b>${r === st.currentRun ? '<br><span class="small muted">최신</span>' : ""}</td><td class="num">${hhmm(r.createdAt)}</td><td style="text-align:center">${r.perim ? "v" + r.perim.version : '<span class="small muted">발화점</span>'}</td><td class="small">${esc(r.reason)}</td><td class="num" style="text-align:center">${r.summary["즉시"]}/${r.summary["대기"]}/${r.summary["협의"]}/${r.summary["요청"]}</td><td style="text-align:center">${r.seq > 1 ? `${r.changed.length}건` : "—"}</td><td style="white-space:nowrap"><button data-view="${r.id}">보기</button> <button data-diff="${r.id}">비교</button></td></tr>`).join("")}</tbody></table>`
      : `<div class="muted small" style="padding:6px">아직 생성된 제안서가 없습니다.</div>`;
    $$("#hist-runs [data-view]").forEach(
      (b) =>
        (b.onclick = () => {
          st.viewRun = st.runs.find((r) => r.id === b.dataset.view);
          renderAll();
          showTab("proposal");
        }),
    );
    $$("#hist-runs [data-diff]").forEach(
      (b) =>
        (b.onclick = () => {
          const r = st.runs.find((x) => x.id === b.dataset.diff),
            prev = st.runs[st.runs.indexOf(r) - 1];
          if (!prev) {
            toast("비교할 이전 버전이 없습니다.");
            return;
          }
          showDiff(prev, r);
        }),
    );
    const ev = state.events
      .filter((e) => !e.inc || e.inc === state.incId)
      .slice()
      .reverse();
    $("#hist-events").innerHTML = ev.length
      ? `<table class="grid"><thead><tr><th style="width:62px">시각</th><th style="width:62px">구분</th><th>내용</th><th style="width:58px">사용자</th></tr></thead><tbody>${ev.map((e) => `<tr class="sys"><td class="num">${esc(e.t)}</td><td style="text-align:center;white-space:nowrap">${esc(e.kind)}</td><td>${esc(e.text)}</td><td class="small" style="text-align:center">${esc(e.user || "—")}</td></tr>`).join("")}</tbody></table>`
      : `<div class="muted small" style="padding:6px">기록된 이벤트가 없습니다.</div>`;
  }
  const diffCol = (title, b) =>
    `<div class="col"><h4>${esc(title)}</h4>${b && b.status[0] !== "(없음)" ? `${badges(b.status)}<div style="margin-top:4px">${esc(b.text)}</div>` : '<div class="muted">발동하지 않음(제안서에 없음)</div>'}</div>`;
  // 「제안 변경사항」 창: 직전 버전 대비 바뀐 항목 전체(이전 문장 → 이후 문장)
  function showDiff(prev, run) {
    const rows = run.changed
      .map((id) => {
        const a = prev.blocks.find((b) => b.id === id),
          b = run.blocks.find((x) => x.id === id);
        return `<div class="chg"><b>${esc(b.name)}</b><div class="diff" style="margin-top:4px">${diffCol(prev.id + " (이전)", a)}${diffCol(run.id + " (이후)", b)}</div></div>`;
      })
      .join("");
    openModal(
      `제안 변경사항 — ${prev.id} → ${run.id} (${esc(run.reason)})`,
      rows || `<div class="muted">바뀐 항목이 없습니다.</div>`,
      [{ label: "닫기" }],
    );
  }
  // '변경' 태그 팝업: 그 항목의 직전 버전 대비 변경 내용
  function showItemDiff(prev, run, id) {
    if (!prev) {
      toast("비교할 이전 버전이 없습니다.");
      return;
    }
    const a = prev.blocks.find((b) => b.id === id),
      b = run.blocks.find((x) => x.id === id);
    openModal(
      `변경 내용 — ${b.name}`,
      `<div class="diff">${diffCol(prev.id + " (이전)", a)}${diffCol(run.id + " (이후)", b)}</div>`,
      [{ label: "닫기" }],
    );
  }

  // ------------------------------------------------------------------ AI 어시스턴트: 질의(UC-QA-01) · 정정(UC-QA-02)
  // 빠른 질문 6개(ChatRouter.quick_questions). 상황 변화는 「상황 정정」으로 입력한다
  const QUICK = [
    "대피 순서 이유",
    "헬기 운용 가능 여부",
    "격상 기준",
    "대피소 수용 초과 시 대안",
    "추가 투입 헬기 대수",
    "현재 위험도",
  ];
  function setCorrMode(on) {
    state.corrMode = on;
    $("#btn-corr").classList.toggle("mode-on", on);
    $("#chat-input").placeholder = on
      ? "상황 변화 입력 (예: 박곡리 대피 완료, 헬기 6대 투입)"
      : "질문 입력 (상황 변화는 「상황 정정」)";
  }
  function openChat() {
    const run = IS().viewRun;
    const b = run && run.blocks.find((x) => x.id === state.chatCtx);
    $("#chat-ctx").innerHTML = b
      ? `항목: <b>${esc(b.name)}</b> — 제안·근거·상황값을 붙여 질문합니다 <a href="#" id="chat-ctx-clear">해제</a>`
      : "항목 미지정 — 대응제안 항목의 「이 항목 질문」으로 항목을 붙일 수 있습니다";
    const cl = $("#chat-ctx-clear");
    if (cl)
      cl.onclick = (e) => {
        e.preventDefault();
        state.chatCtx = null;
        openChat();
      };
    $("#chat-quick").innerHTML = QUICK.map((q) => `<button>${q}</button>`).join(
      "",
    );
    $$("#chat-quick button").forEach(
      (q) =>
        (q.onclick = () => {
          setCorrMode(false);
          $("#chat-input").value = q.textContent;
          sendChat();
        }),
    );
    if (!$("#chat-log").children.length)
      botSay(
        "현재 상황·대응 제안·근거를 질문하거나 빠른 질문을 누르십시오. 현장에서 바뀐 사실(예: 박곡리 대피 완료, 헬기 6대 투입)은 「상황 정정」으로 입력하면 확인 후 저장하고 제안서를 다시 만듭니다. 답변은 검색된 표준매뉴얼 근거 안에서만 하며, 근거가 부족한 내용은 표시하지 않고 이벤트 로그에 기록합니다.",
      );
    updateChatBusy();
  }
  function addMsg(cls, html) {
    const d = document.createElement("div");
    d.className = `msg ${cls}`;
    d.innerHTML = html;
    $("#chat-log").appendChild(d);
    $("#chat-log").scrollTop = 1e6;
    return d;
  }
  let chatPending = false;
  let chatTypingCount = 0;

  function updateChatBusy() {
    const busy = chatPending || chatTypingCount > 0;

    const sendButton = $("#btn-chat-send");
    const input = $("#chat-input");
    const correctionButton = $("#btn-corr");
    const status = $("#chat-status");

    if (sendButton) {
      sendButton.disabled = busy;
      sendButton.textContent = "전송";
    }

    if (input) {
      if (busy) {
        // 생성이 시작될 때 기존 안내 문구를 보관
        if (input.dataset.idlePlaceholder === undefined) {
          input.dataset.idlePlaceholder = input.placeholder;
        }

        input.placeholder = "답변 생성 중…";
      } else if (input.dataset.idlePlaceholder !== undefined) {
        input.placeholder = input.dataset.idlePlaceholder;
        delete input.dataset.idlePlaceholder;
      }

      input.disabled = busy;
      input.setAttribute("aria-busy", String(busy));
    }

    if (correctionButton) {
      correctionButton.disabled = busy;
    }

    if (status) {
      const message = busy ? "답변 생성 중" : "";

      if (status.textContent !== message) {
        status.textContent = message;
      }
    }

    $$("#chat-quick button").forEach((button) => {
      button.disabled = busy;
    });
  }
  function botSay(text, blockId) {
    chatTypingCount += 1;
    updateChatBusy();

    const d = addMsg("bot", "");
    let i = 0;

    const html = blockId ? citeHTML(text, blockId) : esc(text);

    const iv = setInterval(() => {
      i += 3;
      d.textContent = text.slice(0, i);
      $("#chat-log").scrollTop = 1e6;

      if (i >= text.length) {
        clearInterval(iv);

        try {
          d.innerHTML = html;

          d.querySelectorAll(".cite").forEach((c) => {
            c.addEventListener("click", () => {
              showTab("proposal");
              focusCard(c.dataset.b, true);
              openEvidence(IS().viewRun, c.dataset.b, Number(c.dataset.k));
            });
          });
        } finally {
          chatTypingCount -= 1;
          updateChatBusy();
        }
      }
    }, 12);
  }
  function sendChat() {
    // Enter나 빠른 질문으로도 중복 전송되지 않도록 차단
    if (chatPending || chatTypingCount > 0) return;

    const q = $("#chat-input").value.trim();
    if (!q) return;

    const correctionMode = state.corrMode;

    $("#chat-input").value = "";
    addMsg("user", esc(q));

    chatPending = true;
    updateChatBusy();

    setTimeout(() => {
      try {
        const corr = detectCorrection(q);

        if (corr) {
          proposeCorrection(corr, q);
          return;
        }

        if (correctionMode) {
          botSay(
            "입력에서 정정할 대상(마을명·자원 종류 등)이나 바뀐 값을 해석하지 못했습니다. " +
              "대상을 다시 입력해 주십시오. " +
              "예: 박곡리 대피 완료, 헬기 6대 투입, 예상 진화시간 12시간.",
          );
          return;
        }

        answer(q);
      } finally {
        chatPending = false;
        updateChatBusy();
      }
    }, 350);
  }
  function answer(q) {
    const st = IS(),
      run = st.viewRun,
      I = inc(),
      rs = rsView();
    if (/위험도|위험 점수|위험 등급/.test(q)) {
      if (I.status === "종료") {
        botSay("종료된 산불은 위험도 숫자를 표시하지 않습니다.");
        return;
      }

      if (!st.predicted) {
        botSay(
          "위험도는 예측 실행 후 표시됩니다. 확산예측 탭에서 예측을 실행해 주세요.",
        );
        return;
      }

      if (st.riskStatus === "failed") {
        botSay(
          "위험도 계산 실패 상태입니다. 다음 예측을 실행하면 다시 시도합니다.",
        );
        return;
      }

      const rk = st.latestRisk;

      if (!rk) {
        botSay("현재 표시할 위험도 결과가 없습니다.");
        return;
      }

      const factorText = rk.factors
        .map(
          (f) =>
            `${f.name} ${f.score.toFixed(1)}/5` +
            `(가중치 ${f.weight.toFixed(3)})`,
        )
        .join(", ");

      const computedAt = rk.computedAt ? ymdhm(rk.computedAt) : "미확인";

      const mergedIds = rk.mergedIds || [];

      const mergedNames = mergedIds.map((id) => {
        const target = S.incidents.find((item) => item.id === id);
        return target ? target.name : id;
      });

      const mergedText =
        mergedIds.length > 1
          ? ` 병합 계산 결과이며, 대상 산불은 ${mergedNames.join(" · ")}입니다.`
          : "";

      const missingText = rk.missing?.length
        ? ` 결측 입력: ${rk.missing.join(", ")}.`
        : "";

      botSay(
        `산불 위험도 R은 ${rk.score.toFixed(2)}입니다(1.00~5.00). ` +
          `기준 예측 ${rk.predictionId}회 · 계산 시각 ${computedAt}. ` +
          `요인별 점수는 ${factorText}입니다.` +
          mergedText +
          missingText +
          " 현재 목업은 4요인 시연값을 사용합니다.",
      );

      return;
    }
    if (!run) {
      botSay("아직 대응 제안이 없습니다. 예측을 실행하면 답할 수 있습니다.");
      return;
    }
    const R = run.R,
      ctx = state.chatCtx,
      es = I.evacuation_state;
    const vill = S.villages.find((v) => q.includes(v.name));
    const T = [
      [
        /왜|먼저|순서|우선/,
        () => {
          const first = R.ordered[0];
          const v = (vill && R.villages.find((x) => x.id === vill.id)) || first;
          if (!v || !v.arrival)
            return "확산 범위에 드는 마을이 없어 대피 순서를 정할 항목이 없습니다.";
          const rank = R.ordered.findIndex((x) => x.id === v.id) + 1;
          return `${eun(v.name)} 화선 도달 예상이 ${v.arrivalTime}로 ${rank === 1 ? "가장 이르고" : `${rank}번째이며`}, 고령자 ${v.elderly}명이 있어 안전취약계층 우선 대피 원칙이 적용됩니다 [1]. 대피명령은 마을 단위로 내리고 화선 도달 5시간 이내 마을은 즉시 실행합니다 [2].`;
        },
        "E2",
      ],
      [
        /대피소|수용|초과|분산/,
        () => {
          const ov = R.overflow;
          const as = R.assignments
            .map(
              (a) =>
                `${a.village.name}→${a.shelter.name}(${a.shelter.load}/${a.shelter.capacity})`,
            )
            .join(", ");
          return `현재 배정은 ${as || "없음"}입니다 [1]. ${ov.length ? `${eun(joinKo(ov.map((s) => s.name)))} 수용 인원을 초과하므로 인접 대피소로 분산해야 합니다 [1].` : "수용 초과 대피소는 없습니다."} 8시간 확산 범위 안 대피소는 제외합니다 [2].`;
        },
        "E4",
      ],
      [
        /운용|가능 여부|띄울|뜰 수/,
        () =>
          `현재 풍속 ${state.wind.ms} m/s(${dirName(state.wind.dir)}풍)${R.heliOkNow ? "로 헬기 운용이 가능하므로 가용 진화헬기를 집중 투입합니다" : "에서는 헬기 운용이 제한됩니다"} [1]. ${R.maxWind.t} 전후 풍속이 ${R.maxWind.wind_ms} m/s로 강해져 헬기 운용이 어려우면 지상진화에 집중하고, 강풍이 잦아들면 헬기를 다시 투입합니다 [2].`,
        "S4",
      ],
      [
        /헬기|몇 대|대수|추가 투입/,
        () =>
          `가용 진화헬기를 집중 투입하라는 원칙은 있으나 [2], 추가 투입 헬기 대수는 ${NO_EVIDENCE} 현재 투입 ${rs.heli_deployed}대, 대기 ${rs.heli_available}대이며, 풍속 ${state.wind.ms} m/s에서는 운용이 가능합니다.`,
        "S3",
        "추가 투입 헬기 대수",
      ],
      [
        /격상|단계|기준/,
        () =>
          `대응단계 판단기준은 피해면적·평균풍속·예상 진화시간·시설피해 4요소이며 하나라도 상위 기준을 충족하면 상위 단계를 검토합니다 [1]. 현재 4요소는 ${R.stageFactors.map((f) => `${f.name} ${f.val}(${f.stage || "판정 제외"})`).join(", ")}이고, 가장 높은 단계인 ${R.recStage}로 판정합니다. 발령은 산림청장이 통합지휘본부와 협의해 하므로 이 화면은 격상 검토를 권고할 뿐입니다 [2].`,
        "S1",
      ],
      [
        /야간|일몰|밤|사전대피/,
        () =>
          `일몰은 ${R.sunset}이고 ${R.nightVillages.length ? `${eun(joinKo(R.nightVillages.map((v) => `${v.name}(${v.arrivalTime})`)))} 화선 도달 예상 시각이 일몰 이후이므로 일몰 전 사전대피 대상입니다 [1].` : "화선 도달 예상 시각이 일몰 이후인 마을은 없습니다."} 야간에는 풍속이 잦아드는 시간대에 집중 진화를 합니다.`,
        "E2",
      ],
      [
        /송전|한전|전류|고압/,
        () =>
          R.powerIn
            ? `송전선이 ${timeAt(R.powerIn)} 무렵 확산 범위에 들므로 한전에 전류 차단과 우회선로 확보를 요청해야 합니다 [2]. 요청 대상은 한전이며 통합지휘본부에 협력관 파견을 받습니다.`
            : "8시간 확산 범위 안에 송전선이 없어 한전 요청 항목은 발동하지 않았습니다.",
        "S5",
      ],
      [
        /재난문자|문자|방송|CBS|송출/,
        () =>
          `긴급재난문자와 자막방송은 산불 발생, 대피 권고, 대피 명령 시 단계별로 송출합니다 [1]. 현재 대피명령 ${es.order_issued ? "발령 상태이므로 대피 명령 단계로" : "미발령이므로 명령과 동시에 명령 단계로"} ${joinKo(R.emdIn8)}에 송출하십시오. 송출 이력은 ${es.cbs_sent.length ? es.cbs_sent.join(", ") : "없음"}입니다.`,
        "E6",
      ],
      [
        /경찰|교통|통제|도로|진입로/,
        () =>
          `대피로와 진화차량 진입로가 겹치는 구간이 있어 경찰에 교통통제와 주민대피 지원을 요청해야 합니다 [1]. ${R.routeInFire ? `겹침 구간은 ${timeAt(R.routeInFire)} 무렵 확산 범위에 듭니다.` : ""}`,
        "E5",
      ],
      [
        /취약|요양|장애|시설/,
        () =>
          R.careIn.length
            ? `${josa(joinKo(R.careIn.map((f) => `${f.name}(${timeAt(f.arrival)}, ${f.capacity}명)`)), "이", "가")} 확산 범위에 들어 위험구역에 포함하고 별도 이송을 지시해야 합니다 [1].`
            : "8시간 확산 범위 안에 취약시설이 없습니다.",
        "E3",
      ],
      [
        /자원|인력|소방차|차량|투입 현황/,
        () =>
          `현재 투입 자원은 헬기 ${rs.heli_deployed}대, 지상인력 ${rs.ground_crew_deployed}명, 소방차 ${rs.fire_trucks_deployed}대이고 대기 자원은 헬기 ${rs.heli_available}대, 차량 ${rs.trucks_available}대입니다. 확산 정도에 따라 진화자원을 단계적으로 투입하고 인접 시·군 자원을 동원합니다 [2].`,
        "S3",
      ],
      [
        /현재 상황|상황|피해면적/,
        () =>
          `${I.name}은 ${I.status} 상태이며 공식 단계 ${I.official_stage}, 위기경보 ${I.alert_level}입니다. 실측 피해면적 ${R.areaNow ? fmt1(R.areaNow) + " ha" : "미입력"}(실측 화선 ${perimTag(curPerim(I))}), 5시간 후 예상 ${fmt0(R.areaP5)} ha이고 위험구역 마을은 ${vn(R.immediate)}, 잠재 위험구역 마을은 ${vn(R.standby)}입니다 [1].`,
        "E1",
      ],
      [
        /근거|출처|어디|매뉴얼/,
        () =>
          "모든 제안 문장은 표준매뉴얼(2026.6 일부개정) 본문 쪽수를 번호로 인용합니다. 청크에서 확인되지 않는 내용은 화면에 내보내지 않고 해당 칸에 「근거가 부족하여 표시하지 않았습니다」로 알리며, 이벤트 로그에 근거 부족으로 기록합니다. 문장 안의 번호를 누르면 요약 청크를 볼 수 있습니다.",
        null,
      ],
    ];
    for (const [re, fn, bid, gap] of T)
      if (re.test(q)) {
        const b = bid || ctx;
        botSay(fn(), b && run.blocks.find((x) => x.id === b) ? b : null);
        if (gap)
          addEvent(
            "근거 부족",
            `AI 어시스턴트 답변 — ${gap} 비표시(청크에 산정 기준 없음)`,
          );
        return;
      }
    if (ctx) {
      const b = run.blocks.find((x) => x.id === ctx);
      botSay(
        `${b.name} 항목의 판정 이유는 "${b.finding}"이며 제안은 다음과 같습니다. ${b.text} 질문하신 내용에 대한 답변은 ${NO_EVIDENCE}`,
        b.id,
      );
      addEvent(
        "근거 부족",
        `AI 어시스턴트 답변 — ${b.name} 질문 「${q.slice(0, 30)}」 비표시(관련 청크 없음)`,
      );
      return;
    }
    addEvent(
      "근거 부족",
      `AI 어시스턴트 답변 — 질문 「${q.slice(0, 30)}」 비표시(관련 청크 없음)`,
    );
    botSay(
      `질문과 관련된 매뉴얼 근거를 찾지 못해 답변은 ${NO_EVIDENCE} 추측으로 답하지 않습니다. 대응제안 항목의 「이 항목 질문」으로 항목을 지정해 다시 질문하거나, 상황 변화는 「상황 정정」으로 입력해 주십시오.`,
    );
  }
  function detectCorrection(q) {
    const vill = S.villages.filter((v) => q.includes(v.name));
    if (vill.length && /대피\s*(완료|끝)|완료했|다 나왔/.test(q))
      return { type: "completed", villages: vill.map((v) => v.name) };
    if (vill.length && /부상|다쳤|고립|갇/.test(q))
      return { type: "injury", villages: vill.map((v) => v.name) };
    let m;
    if ((m = q.match(/헬기\D{0,8}(\d+)\s*대/)) && /투입|추가|도착|운용/.test(q))
      return { type: "heli", n: Number(m[1]) };
    if (
      (m = q.match(/(소방차|차량|진화차)\D{0,8}(\d+)\s*대/)) &&
      /투입|추가|도착|배치/.test(q)
    )
      return { type: "truck", n: Number(m[2]) };
    if (
      (m = q.match(/(인력|진화대|진화조)\D{0,8}(\d+)\s*(명|개\s*조|조)/)) &&
      /투입|추가|도착|배치/.test(q)
    )
      return { type: "crew", n: Number(m[2]), unit: m[3] };
    if ((m = q.match(/예상\s*진화\s*시간\D{0,6}(\d{1,3})\s*시간/)))
      return { type: "eta", n: Number(m[1]) };
    if (/대피\s*명령.{0,6}(발령|내렸|했)/.test(q)) return { type: "order" };
    if (/(재난\s*문자|CBS).{0,10}(송출|발송|보냈)/.test(q)) {
      const emd = q.match(/([가-힣]+[읍면동])/g) || [];
      return { type: "cbs", targets: emd.length ? emd : ["안평면"] };
    }
    const st = STAGES.find((s) => q.includes(s));
    if (st && /발령|격상|됐|되었/.test(q)) return { type: "stage", stage: st };
    const al = ["관심", "주의", "경계", "심각"].find((a) => q.includes(a));
    if (al && /위기\s*경보/.test(q)) return { type: "alert", level: al };
    return null;
  }
  const corrLabel = (c) =>
    c.type === "completed"
      ? c.villages.join("·") + " 대피 완료"
      : c.type === "injury"
        ? c.villages.join("·") + " 부상·고립 보고"
        : c.type === "heli"
          ? "헬기 투입 " + c.n + "대"
          : c.type === "truck"
            ? "소방차 투입 " + c.n + "대"
            : c.type === "crew"
              ? "진화인력 투입 " + c.n + c.unit
              : c.type === "eta"
                ? "예상 진화시간 " + c.n + "시간"
                : c.type === "order"
                  ? "대피명령 발령"
                  : c.type === "cbs"
                    ? "재난문자 송출 " + c.targets.join("·")
                    : c.type === "stage"
                      ? "공식 단계 " + c.stage
                      : "위기경보 " + c.level;
  function proposeCorrection(c, q) {
    const I = inc(),
      es = I.evacuation_state,
      rs = rsView(),
      rows = [];
    if (I.status === "종료") {
      botSay("종료된 산불에는 상황 정정을 적용할 수 없습니다.");
      return;
    }
    if (!IS().predicted) {
      botSay(
        "아직 예측·제안이 없어 정정할 대상이 없습니다. 먼저 확산 예측을 실행해 주십시오.",
      );
      return;
    }
    const evacState = (n) =>
      es.completed_villages.includes(n)
        ? "대피 완료"
        : es.order_issued
          ? "대피 중"
          : "대피 대상";
    if (c.type === "completed")
      c.villages.forEach((n) =>
        rows.push([n, "대피 상태", evacState(n), "대피 완료"]),
      );
    if (c.type === "injury")
      c.villages.forEach((n) =>
        rows.push([
          n,
          "부상·고립",
          es.injuries.includes(n) ? "보고됨" : "없음",
          "보고됨",
        ]),
      );
    if (c.type === "heli")
      rows.push(["헬기", "투입 수(대)", rs.heli_deployed, c.n]);
    if (c.type === "truck")
      rows.push(["소방차", "투입 수(대)", rs.fire_trucks_deployed, c.n]);
    if (c.type === "crew")
      rows.push([
        "지상 진화인력",
        "투입",
        `${rs.ground_crew_deployed}명`,
        `${c.n}${c.unit}`,
      ]);
    if (c.type === "eta")
      rows.push([
        I.name,
        "예상 진화시간",
        I.field_report.expected_suppression_hours == null
          ? "미입력"
          : I.field_report.expected_suppression_hours + "시간",
        c.n + "시간",
      ]);
    if (c.type === "order")
      rows.push([
        "위험구역 마을",
        "대피명령",
        es.order_issued ? "발령" : "미발령",
        "발령",
      ]);
    if (c.type === "cbs")
      rows.push([
        c.targets.join("·"),
        "재난문자 송출",
        es.cbs_sent.join(", ") || "없음",
        [...new Set([...es.cbs_sent, ...c.targets])].join(", "),
      ]);
    if (c.type === "stage")
      rows.push([I.name, "공식 대응단계", I.official_stage, c.stage]);
    if (c.type === "alert")
      rows.push([I.name, "위기경보", I.alert_level, c.level]);
    const R = IS().viewRun && IS().viewRun.R;
    // E1: 대상이 데이터에 없거나 정정할 수 없는 대상이면 다시 입력받는다
    if (c.type === "completed" && R) {
      const notTarget = c.villages.filter(
        (n) => !R.ordered.find((v) => v.name === n),
      );
      if (notTarget.length) {
        botSay(
          `${eun(joinKo(notTarget))} 대피 대상(위험·잠재 위험구역) 마을이 아니어서 "대피 완료"로 정정할 수 없습니다. 대상을 다시 입력해 주십시오.`,
        );
        return;
      }
    }
    // E3: 가용 범위를 넘는 값은 기록하지 않는다
    const crewMax = S.resources.filter(
      (r) => r.type === "인력" && r.status !== "정비",
    );
    if (c.type === "heli" && c.n > rs.heli_deployed + rs.heli_available) {
      botSay(
        `가용 범위 초과, 기록 불가 — 헬기는 투입 ${rs.heli_deployed}대·대기 ${rs.heli_available}대뿐입니다. 아무것도 저장하지 않았습니다.`,
      );
      return;
    }
    if (
      c.type === "truck" &&
      c.n > rs.fire_trucks_deployed + rs.trucks_available
    ) {
      botSay(
        `가용 범위 초과, 기록 불가 — 소방차는 투입 ${rs.fire_trucks_deployed}대·대기 ${rs.trucks_available}대뿐입니다. 아무것도 저장하지 않았습니다.`,
      );
      return;
    }
    if (
      c.type === "crew" &&
      c.n >
        (/조/.test(c.unit)
          ? crewMax.length
          : crewMax.reduce((a, r) => a + (Number(r.qty) || 0), 0))
    ) {
      botSay(
        `가용 범위 초과, 기록 불가 — 지상 진화인력은 ${crewMax.length}개 조 ${crewMax.reduce((a, r) => a + (Number(r.qty) || 0), 0)}명뿐입니다. 아무것도 저장하지 않았습니다.`,
      );
      return;
    }
    addMsg("sys", "상황 정정으로 판정 — 정정 확인 카드를 엽니다");
    openModal(
      "상황 정정 확인",
      `<div class="small muted" style="margin-bottom:8px">입력: “${esc(q)}”</div><table class="grid"><thead><tr><th>대상</th><th>항목</th><th>이전</th><th>변경</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(String(r[0]))}</td><td>${esc(r[1])}</td><td>${esc(String(r[2]))}</td><td><b>${esc(String(r[3]))}</b></td></tr>`).join("")}</tbody></table><div class="small muted" style="margin-top:8px">확인하면 바뀐 상황 값을 저장하고 이벤트 로그에 기록한 뒤, 예측(P1~P8)은 그대로 둔 채 규칙 판정과 대응 제안만 다시 만들어 새 버전을 저장합니다. 확인 전에는 아무것도 저장하지 않습니다.</div>`,
      [
        {
          label: "취소",
          onClick: () => {
            botSay("정정을 취소했습니다. 아무것도 저장하지 않았습니다.");
          },
        },
        {
          label: "확인 · 저장 후 재생성",
          cls: "primary",
          onClick: () => {
            applyCorrection(c);
          },
        },
      ],
    );
  }
  function applyCorrection(c) {
    const I = inc(),
      es = I.evacuation_state;
    if (c.type === "completed")
      es.completed_villages = [
        ...new Set([...es.completed_villages, ...c.villages]),
      ];
    if (c.type === "injury")
      es.injuries = [...new Set([...es.injuries, ...c.villages])];
    if (c.type === "heli") setDeployed("헬기", c.n);
    if (c.type === "truck") setDeployed("차량", c.n);
    if (c.type === "crew") {
      if (/조/.test(c.unit)) setDeployed("인력", c.n);
      else {
        const units = S.resources.filter(
          (r) => r.type === "인력" && r.status !== "정비",
        );
        units.forEach((r) => (r.status = "대기"));
        let sum = 0;
        for (const r of units) {
          if (sum >= c.n) break;
          r.status = "투입";
          sum += Number(r.qty) || 0;
        }
        rebuildCrewMarkers();
      }
    }
    if (c.type === "eta") I.field_report.expected_suppression_hours = c.n;
    if (c.type === "order") es.order_issued = true;
    if (c.type === "cbs")
      es.cbs_sent = [...new Set([...es.cbs_sent, ...c.targets])];
    if (c.type === "stage") I.official_stage = c.stage;
    if (c.type === "alert") I.alert_level = c.level;
    addEvent("정정", corrLabel(c));
    setCorrMode(false);
    const prev = IS().currentRun;
    const run = generateProposal("상황 정정");
    botSay(
      `상황 정정을 저장했습니다. 제안서 ${run.id} 생성(예측은 그대로) — 바뀐 항목: ${run.changed.length ? run.changed.map((id) => (run.blocks.find((b) => b.id === id) || {}).name).join(", ") : "없음"}. 대응 제안 화면에서 '변경' 태그로 확인할 수 있습니다.`,
    );
    if (prev) showDiff(prev, run);
    if (c.type === "stage" && stageIdx(c.stage) >= 2)
      toast(
        "공식 단계가 2단계 이상이면 지휘권이 시·도지사로 넘어가 이 화면은 격상·인계 안내만 유효합니다.",
        4000,
      );
  }

  // ------------------------------------------------------------------ 상황 보고자 (UC-REPORT-01 산불 상황 보고)
  // 최초 보고: 발화 위치·발생 일시·신고 내용·접수 시각·기관별 접수 기록 → 산불을 '접수'로 생성. 실측 화선이 처음 저장되면 '진행 중'
  // 1시간 주기 보고(A1): 직전 실측 화선을 불러와 수정 후 새 버전(v2, v3 …)으로 제출. 정정(A2): 수정본을 다시 제출하고 이전 버전은 '정정됨'으로 보존
  const repInc = () =>
    state.rep.editingId
      ? S.incidents.find((i) => i.id === state.rep.editingId)
      : null;
  function renderReporter() {
    const rp = state.rep,
      I = repInc(),
      closed = I && I.status === "종료";
    $("#rep-mode").innerHTML = listModeHTML(rp.listMode, "rlm");
    $$("#rep-mode [data-rlm]").forEach(
      (b) =>
        (b.onclick = () => {
          rp.listMode = b.dataset.rlm;
          renderReporter();
        }),
    );
    $("#rep-list").innerHTML = incidentListHTML(rp.listMode, rp.editingId);
    $$("#rep-list tr.clickable").forEach(
      (tr) =>
        (tr.onclick = () => {
          loadRepForm(tr.dataset.inc);
          selectIncident(tr.dataset.inc, true);
        }),
    );
    $("#rep-form-title").innerHTML = I
      ? `발화 정보 — ${esc(I.name)} ${stBadge(I.status)}`
      : "발화 정보 — 새 산불 보고";
    $("#rep-perim").disabled = !I || closed;
    $("#rep-save").disabled = !!closed;
    $("#rep-closed-note").style.display = closed ? "" : "none";
    $("#rep-intake").innerHTML = rp.intake.length
      ? `<table class="grid"><thead><tr><th>접수 기관</th><th style="width:52px">시각</th><th>접수 경로</th><th style="width:26px"></th></tr></thead><tbody>${rp.intake.map((r, i) => `<tr><td>${esc(r.org)}</td><td class="num">${esc(r.at)}</td><td>${esc(r.channel || "—")}</td><td style="text-align:center">${closed ? "" : `<button class="ik-del" data-i="${i}" title="삭제" style="padding:0 5px">✕</button>`}</td></tr>`).join("")}</tbody></table>`
      : '<div class="muted small">접수 기록 없음</div>';
    $$("#rep-intake .ik-del").forEach(
      (b) =>
        (b.onclick = () => {
          rp.intake.splice(Number(b.dataset.i), 1);
          renderReporter();
        }),
    );
    const cp = I ? curPerim(I) : null,
      all = I ? I.perimeters || [] : [];
    $("#rep-perim-cur").innerHTML = cp
      ? `현재 <b>${perimTag(cp)}</b> · ${fmt1(ringAreaHa(cp.ring))} ha · ${fmtIso(cp.at)} ${esc(cp.by || "")} (${esc(cp.source || "")})${
          all.length > 1
            ? `<br><span class="muted">이전 버전: ${all
                .filter((p) => p !== cp)
                .map(
                  (p) =>
                    `v${p.version} ${fmt1(ringAreaHa(p.ring))} ha ${fmtHM(p.at)}${p.status === "정정됨" ? "(정정됨)" : ""}`,
                )
                .join(" · ")}</span>`
            : ""
        }`
      : `<span class="muted">${I ? "보고된 실측 화선 없음 — 첫 화선을 저장하면 '진행 중'으로 바뀝니다" : "새 산불 — 화선이 있으면 함께 그려 제출합니다"}</span>`;
    $("#rep-perim-mode").innerHTML =
      cp && rp.ring && !rp.drawMode
        ? `제출 방식 <label><input type="radio" name="pmode" value="new" ${rp.perimMode === "new" ? "checked" : ""}> 새 버전으로 보고(v${Math.max(...all.map((p) => p.version)) + 1})</label> <label><input type="radio" name="pmode" value="correct" ${rp.perimMode === "correct" ? "checked" : ""}> ${perimTag(cp)} 정정(이전 버전은 '정정됨'으로 보존)</label>`
        : "";
    $$('#rep-perim-mode input[name="pmode"]').forEach(
      (r) =>
        (r.onchange = () => {
          rp.perimMode = r.value;
        }),
    );
    $("#rep-poly-info").innerHTML = rp.drawMode
      ? `그리는 중 — 꼭짓점 ${rp.pts.length}개 (3개 이상이면 「그리기 완료」)`
      : rp.ring
        ? `제출할 화선: 꼭짓점 <b>${rp.ring.length - 1}개</b> · 면적 <b>${fmt1(ringAreaHa(rp.ring))} ha</b> <span class="small muted">(${esc(rp.ringSource || "")})</span>`
        : "제출할 새 화선 없음";
    $("#rep-draw-done").disabled = !(rp.drawMode && rp.pts.length >= 3);
    $("#rep-draw").classList.toggle("mode-on", rp.drawMode);
    $("#rep-pick").classList.toggle("mode-on", rp.pickMode);
    [
      "#rep-draw",
      "#rep-draw-clear",
      "#rep-geojson",
      "#rep-pick",
      "#ik-add",
    ].forEach((id) => ($(id).disabled = !!closed));
    const hint = $("#draw-hint");
    hint.classList.toggle("on", rp.drawMode || rp.pickMode);
    hint.textContent = rp.drawMode
      ? "지도를 눌러 실측 화선 폴리곤의 꼭짓점을 차례로 찍으십시오. 끝나면 「그리기 완료」 (Esc 취소)"
      : "지도를 눌러 발화 위치를 지정하십시오 (Esc 취소)";
    drawPreview();
  }
  function loadRepForm(id) {
    const rp = state.rep;
    rp.editingId = id;
    rp.pickMode = false;
    rp.drawMode = false;
    rp.pts = [];
    rp.ring = null;
    rp.ringSource = null;
    rp.perimMode = "new";
    const I = id ? S.incidents.find((i) => i.id === id) : null;
    $("#rep-name").value = I ? I.name : "";
    $("#rep-addr").value = I ? I.addr : "경북 의성군 ";
    $("#rep-lng").value = I ? I.ignition[0] : "";
    $("#rep-lat").value = I ? I.ignition[1] : "";
    $("#rep-start").value = I
      ? I.start_time
        ? isoLocal(new Date(I.start_time))
        : ""
      : isoLocal(nowSim());
    $("#rep-report").value =
      I && I.report_time
        ? isoLocal(new Date(I.report_time))
        : isoLocal(nowSim());
    $("#rep-text").value = I ? I.report_text : "";
    rp.intake = I ? clone(I.intake || []) : [];
    $$("#rep-panel .invalid").forEach((el) => el.classList.remove("invalid"));
    if (map && state.markers["pick"]) {
      const el = state.markers["pick"].getElement();
      if (I) {
        state.markers["pick"].setLngLat(I.ignition);
        el.style.display = "";
      } else el.style.display = "none";
    }
    renderReporter();
  }
  // 「실측 화선 보고」(A1): 직전 실측 화선을 불러와 수정·제출. 지도에서 다시 그리거나 GeoJSON으로 바꿀 수 있다
  function startPerimReport() {
    const rp = state.rep,
      I = repInc();
    if (!I || I.status === "종료") return;
    const cp = curPerim(I);
    rp.perimMode = "new";
    rp.drawMode = false;
    rp.pts = [];
    if (cp) {
      rp.ring = clone(cp.ring);
      rp.ringSource = `${perimTag(cp)} 불러옴`;
      toast(
        `직전 실측 화선 ${perimTag(cp)}을 불러왔습니다. 다시 그리거나 GeoJSON으로 수정한 뒤 저장하면 새 버전으로 제출됩니다.`,
        4200,
      );
    } else {
      rp.ring = null;
      rp.drawMode = true;
      toast("보고된 화선이 없습니다. 지도에서 실측 화선을 그리십시오.");
    }
    renderReporter();
  }
  function drawPreview() {
    if (!map || !map.getSource("draw")) return;
    const rp = state.rep,
      feats = [];
    if (rp.drawMode) {
      rp.pts.forEach((p) => feats.push(pt(p)));
      if (rp.pts.length >= 2) feats.push(line(rp.pts));
      if (rp.pts.length >= 3) feats.push(poly([...rp.pts, rp.pts[0]]));
    } else if (rp.ring && state.role === "reporter") feats.push(poly(rp.ring));
    map.getSource("draw").setData(fc(feats));
  }
  function onMapClick(lngLat) {
    const rp = state.rep;
    if (state.role !== "reporter") return;
    if (rp.pickMode) {
      $("#rep-lng").value = lngLat[0].toFixed(5);
      $("#rep-lat").value = lngLat[1].toFixed(5);
      state.markers["pick"].setLngLat(lngLat);
      state.markers["pick"].getElement().style.display = "";
      rp.pickMode = false;
      renderReporter();
      toast("발화 위치를 지정했습니다.");
      return;
    }
    if (rp.drawMode) {
      rp.pts.push(lngLat);
      renderReporter();
    }
  }
  function finishDraw() {
    const rp = state.rep;
    if (rp.pts.length < 3) return;
    rp.ring = [...rp.pts, rp.pts[0]];
    rp.ringSource = "지도 그리기";
    rp.drawMode = false;
    rp.pts = [];
    renderReporter();
    toast(
      `화선 그리기 완료 · 꼭짓점 ${rp.ring.length - 1}개 · ${fmt1(ringAreaHa(rp.ring))} ha`,
    );
  }
  function cancelModes() {
    const rp = state.rep;
    if (rp.drawMode || rp.pickMode) {
      rp.drawMode = false;
      rp.pickMode = false;
      rp.pts = [];
      renderReporter();
    }
  }
  function openGeoJsonModal() {
    openModal(
      "GeoJSON 폴리곤 붙여넣기",
      `<div class="small muted" style="margin-bottom:6px">Polygon 또는 Feature/FeatureCollection(첫 Polygon)의 [경도, 위도] 좌표를 붙여 넣으십시오.</div><textarea id="gj-text" style="width:100%;min-height:160px;font-family:monospace;font-size:11px">${esc(
        JSON.stringify({
          type: "Polygon",
          coordinates: [
            state.rep.ring || [
              [128.6025, 36.3655],
              [128.6045, 36.3665],
              [128.603, 36.368],
              [128.601, 36.3668],
              [128.6025, 36.3655],
            ],
          ],
        }),
      )}</textarea>`,
      [
        { label: "취소" },
        {
          label: "적용",
          cls: "primary",
          onClick: () => {
            try {
              let g = JSON.parse($("#gj-text").value);
              if (g.type === "FeatureCollection")
                g = (
                  g.features.find(
                    (f) => f.geometry && f.geometry.type === "Polygon",
                  ) || {}
                ).geometry;
              if (g && g.type === "Feature") g = g.geometry;
              if (
                !g ||
                g.type !== "Polygon" ||
                !Array.isArray(g.coordinates) ||
                g.coordinates[0].length < 4
              )
                throw new Error("Polygon 좌표가 아닙니다.");
              const ring = g.coordinates[0].map((c) => [
                Number(c[0]),
                Number(c[1]),
              ]);
              if (ring.some((c) => !isFinite(c[0]) || !isFinite(c[1])))
                throw new Error("좌표 값 오류");
              if (
                ring[0][0] !== ring[ring.length - 1][0] ||
                ring[0][1] !== ring[ring.length - 1][1]
              )
                ring.push(ring[0]);
              state.rep.ring = ring;
              state.rep.ringSource = "GeoJSON";
              state.rep.drawMode = false;
              renderReporter();
              toast(`GeoJSON 적용 · ${fmt1(ringAreaHa(ring))} ha`);
            } catch (e) {
              toast("GeoJSON 해석 실패: " + e.message);
              return false;
            }
          },
        },
      ],
    );
  }
  function addIntakeRow() {
    const org = $("#ik-org").value.trim(),
      at = $("#ik-at").value,
      ch = $("#ik-ch").value.trim();
    $("#ik-org").classList.toggle("invalid", !org);
    $("#ik-at").classList.toggle("invalid", !at);
    if (!org || !at) {
      toast("접수 기관과 접수 시각을 입력하십시오.");
      return;
    }
    state.rep.intake.push({ org, at, channel: ch || "" });
    $("#ik-org").value = "";
    $("#ik-ch").value = "";
    renderReporter();
  }
  function saveReport() {
    const rp = state.rep;
    let I = repInc();
    // E2: 종료 처리된 산불에는 보고를 받지 않는다
    if (I && I.status === "종료") {
      toast("종료된 산불은 수정할 수 없습니다.");
      return;
    }
    if (rp.drawMode) {
      toast("그리기를 끝내거나(「그리기 완료」) 취소한 뒤 저장하십시오.");
      return;
    }
    const name = $("#rep-name").value.trim(),
      addr = $("#rep-addr").value.trim(),
      lng = Number($("#rep-lng").value),
      lat = Number($("#rep-lat").value);
    const start = $("#rep-start").value,
      report = $("#rep-report").value,
      text = $("#rep-text").value.trim();
    // E1: 필수 값·국내 좌표 범위·폴리곤 검사, 잘못된 항목 표시
    const bad = [];
    const mark = (id, ok, label) => {
      $(id).classList.toggle("invalid", !ok);
      if (!ok) bad.push(label);
    };
    mark("#rep-name", !!name, "산불명");
    mark("#rep-addr", !!addr && addr !== "경북 의성군", "발생 장소");
    const coordOk =
      $("#rep-lng").value !== "" &&
      $("#rep-lat").value !== "" &&
      isFinite(lng) &&
      isFinite(lat) &&
      lng >= 124 &&
      lng <= 132 &&
      lat >= 33 &&
      lat <= 39;
    mark("#rep-lng", coordOk, "발화 위치(국내 좌표)");
    $("#rep-lat").classList.toggle("invalid", !coordOk);
    mark("#rep-report", !!report, "신고 접수 일시");
    const startOk = !start || !report || new Date(start) <= new Date(report);
    mark("#rep-start", startOk, "발생 일시(신고 접수 이후일 수 없음)");
    if (rp.ring && (rp.ring.length < 4 || ringAreaHa(rp.ring) <= 0))
      bad.push("실측 화선(꼭짓점 3개 이상)");
    if (bad.length) {
      toast(`제출할 수 없습니다 — 확인할 항목: ${bad.join(", ")}`, 3600);
      return;
    }
    const isNew = !I;
    if (isNew) {
      const d = new Date(report);
      const key = `F-${d.getFullYear()}-${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
      const seq = S.incidents.filter((i) => i.id.startsWith(key)).length + 1;
      I = {
        id: `${key}-${pad2(seq)}`,
        status: "접수",
        real: false,
        intake: [],
        perimeters: [],
        official_stage: "초기대응",
        alert_level: "관심",
        reported_by: state.user,
        field_report: { expected_suppression_hours: null },
        evacuation_state: {
          order_issued: false,
          cbs_sent: [],
          completed_villages: [],
          injuries: [],
        },
        ended_at: null,
        ended_by: null,
      };
      S.incidents.unshift(I);
    }
    const moved = isNew || I.ignition[0] !== lng || I.ignition[1] !== lat;
    Object.assign(I, {
      name,
      addr,
      ignition: [lng, lat],
      start_time: start ? new Date(start).toISOString() : null,
      report_time: new Date(report).toISOString(),
      report_text: text || I.report_text || "—",
      intake: clone(rp.intake),
    });
    let perimNote = "",
      statusNote = "";
    if (rp.ring) {
      I.perimeters = I.perimeters || [];
      const cp = curPerim(I),
        nextV = I.perimeters.reduce((m, p) => Math.max(m, p.version), 0) + 1;
      const corrected = cp && rp.perimMode === "correct";
      if (corrected) cp.status = "정정됨";
      const source = /GeoJSON/.test(rp.ringSource || "")
        ? "GeoJSON"
        : /불러옴/.test(rp.ringSource || "") && cp
          ? cp.source
          : "지도 그리기";
      I.perimeters.push({
        version: nextV,
        status: "유효",
        at: nowSim().toISOString(),
        by: state.user,
        source,
        real: false,
        ring: clone(rp.ring),
      });
      perimNote = ` · 실측 화선 v${nextV} ${fmt1(ringAreaHa(rp.ring))} ha${corrected ? `(${perimTag(cp)} 정정)` : ""}`;
      if (I.status === "접수") {
        I.status = "진행 중";
        statusNote = " · 접수 → 진행 중";
      }
    }
    const st = IS(I.id),
      stale = st.predicted && (moved || !!rp.ring);
    if (stale) st.stale = true;
    rp.editingId = I.id;
    const prevInc = state.incId;
    state.incId = I.id;
    addEvent(
      "입력",
      `${isNew ? "산불 최초 보고" : "발화 정보 갱신"} — ${I.name}${perimNote}${statusNote}`,
    );
    state.incId = prevInc;
    selectIncident(I.id, true);
    loadRepForm(I.id);
    toast(
      `${isNew ? "산불을 '접수' 상태로 보고했습니다" : "저장했습니다"}${perimNote}${statusNote}${stale ? " · 통합지휘권자의 재예측이 필요합니다" : ""}`,
      4200,
    );
  }

  // ------------------------------------------------------------------ 전산 관리자 (UC-ADMIN-01 계정·권한 관리 · UC-ADMIN-02 진화자원 데이터 관리)
  // 계정 발급은 이름·소속·권한만 입력하고 아이디·초기 비밀번호는 시스템이 만든다(시연용 프로토타입의 편의 방식).
  // 발급·변경할 수 있는 권한은 조작·열람·보고이며, 관리 권한 계정은 설치 시 사전 발급한다.
  const ISSUABLE = ["commander", "viewer", "reporter"];
  const ID_PREFIX = { commander: "cmd", viewer: "view", reporter: "rep" };
  const roleText = (r) => `${PERM_LABEL[r]}(${ROLE_LABEL[r]})`;
  const genPw = () => {
    const c = "abcdefghjkmnpqrstuvwxyz23456789";
    let s = "";
    for (let i = 0; i < 8; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
  };
  const nextId = (role) => {
    const p = ID_PREFIX[role];
    let n = 1;
    while (S.accounts.find((a) => a.id === `${p}${pad2(n)}`)) n++;
    return `${p}${pad2(n)}`;
  };
  const today = () => ymd(new Date()).replace(/\./g, "-");
  function showIssued(title, a, pw) {
    openModal(
      title,
      `<table class="grid"><tr><td class="k">아이디</td><td><b>${esc(a.id)}</b></td></tr><tr><td class="k">초기 비밀번호</td><td><b class="num">${esc(pw)}</b></td></tr><tr><td class="k">이름·소속</td><td>${esc(a.name)} · ${esc(a.org || "—")}</td></tr><tr><td class="k">권한</td><td>${roleText(a.role)}</td></tr></table><div class="small muted" style="margin-top:8px">아이디·초기 비밀번호는 시스템이 만들었습니다. 시연용 프로토타입이라 화면에 그대로 표시합니다.</div>`,
      [{ label: "닫기" }],
    );
  }
  function renderAdmin() {
    $("#admin-user").innerHTML =
      `<b>${esc(state.user)}</b> · ${ROLE_LABEL.admin}(${PERM_LABEL.admin})`;
    const roleOpts = (sel) =>
      ISSUABLE.map(
        (k) =>
          `<option value="${k}" ${k === sel ? "selected" : ""}>${roleText(k)}</option>`,
      ).join("");
    const cnt = (f) => S.accounts.filter(f).length;
    $("#admin-accounts").innerHTML =
      `<div class="tot"><span>발급 <b>${cnt((a) => a.status === "발급")}</b></span><span>회수 <b>${cnt((a) => a.status === "회수")}</b></span><span>잠금 <b>${cnt((a) => a.locked)}</b></span>${ISSUABLE.map((r) => `<span>${PERM_LABEL[r]} 권한 <b>${cnt((a) => a.role === r && a.status === "발급")}</b></span>`).join("")}</div>
      <table class="grid"><thead><tr><th>아이디</th><th>이름</th><th>소속</th><th>권한</th><th>상태</th><th>발급일</th><th style="width:196px">관리</th></tr></thead><tbody>${S.accounts.map((a) => `<tr><td><b>${esc(a.id)}</b></td><td>${esc(a.name)}</td><td class="small">${esc(a.org || "—")}</td><td>${a.role === "admin" ? `<span class="small">${roleText("admin")}</span>` : `<select data-role="${a.id}">${roleOpts(a.role)}</select>`}</td><td style="text-align:center"><span class="badge b-${a.status}">${a.status}</span>${a.locked ? ' <span class="badge b-즉시">잠금</span>' : a.failed ? ` <span class="small muted">실패 ${a.failed}회</span>` : ""}</td><td class="num small">${a.issued}</td><td class="actions">${a.status === "발급" && a.id !== state.user ? `<button data-revoke="${a.id}">회수</button> ` : ""}<button data-reissue="${a.id}">재발급</button> ${a.locked || a.failed ? `<button data-unlock="${a.id}">잠금 해제</button> ` : ""}<button data-del="${a.id}">삭제</button></td></tr>`).join("")}</tbody></table>
      <div class="form"><label>이름 *<input id="ac-name" placeholder="예: 통합지휘권자 2"></label><label>소속 *<input id="ac-org" placeholder="예: 의성군"></label><label>권한 *<select id="ac-role"><option value="">선택</option>${roleOpts("")}</select></label><button id="ac-add" class="primary">계정 발급</button></div>`;
    // A1: 권한 변경은 저장 즉시 적용(로그인 중인 세션 포함)
    $$("#admin-accounts [data-role]").forEach(
      (s) =>
        (s.onchange = () => {
          const a = S.accounts.find((x) => x.id === s.dataset.role);
          const before = roleText(a.role);
          a.role = s.value;
          addEvent(
            "관리",
            `계정 권한 변경 — ${a.id}: ${before} → ${roleText(a.role)}`,
          );
          toast(
            `${a.id} 권한을 ${roleText(a.role)}(으)로 바꿨습니다. 즉시 적용됩니다.`,
          );
          renderAdmin();
        }),
    );
    $$("#admin-accounts [data-revoke]").forEach(
      (b) =>
        (b.onclick = () => {
          const a = S.accounts.find((x) => x.id === b.dataset.revoke);
          a.status = "회수";
          addEvent("관리", `계정 회수 — ${a.id}(${ROLE_LABEL[a.role]})`);
          toast(`${a.id} 계정을 회수했습니다. 이후 로그인이 막힙니다.`);
          renderAdmin();
        }),
    );
    // A2: 재발급 — 초기 비밀번호를 다시 발급(회수된 계정은 다시 발급 상태로)
    $$("#admin-accounts [data-reissue]").forEach(
      (b) =>
        (b.onclick = () => {
          const a = S.accounts.find((x) => x.id === b.dataset.reissue);
          const pw = genPw();
          a.pw = pw;
          const wasRevoked = a.status === "회수";
          a.status = "발급";
          a.issued = today();
          addEvent(
            "관리",
            `계정 재발급 — ${a.id}(초기 비밀번호 재발급${wasRevoked ? ", 회수 해제" : ""})`,
          );
          renderAdmin();
          showIssued("초기 비밀번호 재발급", a, pw);
        }),
    );
    // A3: 잠금 해제 — 실패 횟수 0으로 초기화
    $$("#admin-accounts [data-unlock]").forEach(
      (b) =>
        (b.onclick = () => {
          const a = S.accounts.find((x) => x.id === b.dataset.unlock);
          a.locked = false;
          a.failed = 0;
          addEvent("관리", `계정 잠금 해제 — ${a.id}(실패 횟수 0으로 초기화)`);
          renderAdmin();
          toast(`${a.id} 잠금을 해제했습니다.`);
        }),
    );
    // A4: 삭제 — 로그인 중인 자기 계정은 삭제 불가
    $$("#admin-accounts [data-del]").forEach(
      (b) =>
        (b.onclick = () => {
          const a = S.accounts.find((x) => x.id === b.dataset.del);
          if (a.id === state.user) {
            toast("로그인 중인 자기 계정은 삭제할 수 없습니다.");
            return;
          }
          S.accounts.splice(S.accounts.indexOf(a), 1);
          addEvent("관리", `계정 삭제 — ${a.id}(${ROLE_LABEL[a.role]})`);
          renderAdmin();
        }),
    );
    $("#ac-add").onclick = () => {
      const name = $("#ac-name").value.trim(),
        org = $("#ac-org").value.trim(),
        role = $("#ac-role").value,
        miss = [];
      [
        ["#ac-name", name, "이름"],
        ["#ac-org", org, "소속"],
        ["#ac-role", role, "권한"],
      ].forEach(([id, v, l]) => {
        $(id).classList.toggle("invalid", !v);
        if (!v) miss.push(l);
      });
      if (miss.length) {
        toast(`빈 칸이 있어 발급할 수 없습니다: ${miss.join(", ")}`);
        return;
      }
      const id = nextId(role),
        pw = genPw(),
        a = { id, pw, name, org, role, status: "발급", issued: today() };
      S.accounts.push(a);
      addEvent(
        "관리",
        `계정 발급 — ${id}(${ROLE_LABEL[role]}, ${name}·${org})`,
      );
      renderAdmin();
      showIssued("계정 발급 완료", a, pw);
    };

    const by = resSummary();
    $("#admin-resources").innerHTML =
      `<div class="tot">${RTYPES.map((t) => `<span>${t} 보유 <b>${by[t].보유}</b> · 투입 ${by[t].투입} · 대기 ${by[t].대기} · 정비 ${by[t].정비}</span>`).join("")}</div>
      <div style="max-height:46vh;overflow:auto"><table class="grid"><thead><tr><th>구분 *</th><th>명칭(호출부호) *</th><th>소속 *</th><th>수량 *</th><th>배치 위치</th><th>상태</th><th style="width:92px">관리</th></tr></thead><tbody>${S.resources.map((r) => `<tr><td><select data-rtype="${r.id}">${RTYPES.map((t) => `<option ${t === r.type ? "selected" : ""}>${t}</option>`).join("")}</select></td><td><input data-rname="${r.id}" value="${esc(r.name)}" style="width:128px"></td><td><input data-rorg="${r.id}" value="${esc(r.org)}" style="width:118px"></td><td><input data-rqty="${r.id}" type="number" min="1" value="${r.qty}" style="width:50px" ${r.type !== "인력" ? "disabled" : ""}></td><td><input data-rbase="${r.id}" value="${esc(r.base || "")}" style="width:120px"></td><td><select data-rstatus="${r.id}">${["투입", "대기", "정비"].map((s) => `<option ${s === r.status ? "selected" : ""}>${s}</option>`).join("")}</select></td><td class="actions"><button data-rsave="${r.id}">저장</button> <button data-rdel="${r.id}">삭제</button></td></tr>`).join("")}</tbody></table></div>
      <div class="form"><label>구분 *<select id="rs-type">${RTYPES.map((t) => `<option>${t}</option>`).join("")}</select></label><label>명칭(호출부호) *<input id="rs-name" placeholder="예: 산림 101호, KFS-H05"></label><label>소속 *<input id="rs-org" placeholder="예: 산림항공본부"></label><label>수량 *<input id="rs-qty" type="number" min="1" value="1" title="인력은 명, 헬기·차량은 1"></label><label>배치 위치<input id="rs-base" placeholder="예: 안동 산림항공관리소"></label><label>상태<select id="rs-status"><option>대기</option><option>투입</option><option>정비</option></select></label><button id="rs-add" class="primary">자원 등록</button></div>`;
    // 필수 값(구분·명칭(호출부호)·소속·수량) 검사 — 빠지면 저장을 막고 빠진 칸을 표시(E1)
    const checkRes = (fields) => {
      const miss = [];
      fields.forEach(([el, ok, l]) => {
        el.classList.toggle("invalid", !ok);
        if (!ok) miss.push(l);
      });
      if (miss.length)
        toast(`필수 값이 빠져 저장할 수 없습니다: ${miss.join(", ")}`);
      return !miss.length;
    };
    $("#rs-type").onchange = () => {
      const p = $("#rs-type").value === "인력";
      $("#rs-qty").disabled = !p;
      if (!p) $("#rs-qty").value = 1;
    };
    $("#rs-type").onchange();
    $$("#admin-resources [data-rtype]").forEach(
      (s) =>
        (s.onchange = () => {
          const q = $(`[data-rqty="${s.dataset.rtype}"]`);
          q.disabled = s.value !== "인력";
          if (s.value !== "인력") q.value = 1;
        }),
    );
    $$("#admin-resources [data-rsave]").forEach(
      (b) =>
        (b.onclick = () => {
          const id = b.dataset.rsave,
            r = S.resources.find((x) => x.id === id),
            el = (k) => $(`[data-${k}="${id}"]`);
          const type = el("rtype").value,
            name = el("rname").value.trim(),
            org = el("rorg").value.trim(),
            qty = Number(el("rqty").value);
          if (
            !checkRes([
              [el("rname"), !!name, "명칭(호출부호)"],
              [el("rorg"), !!org, "소속"],
              [el("rqty"), Number.isInteger(qty) && qty >= 1, "수량"],
            ])
          )
            return;
          Object.assign(r, {
            type,
            name,
            org,
            qty: type === "인력" ? qty : 1,
            base: el("rbase").value.trim(),
            status: el("rstatus").value,
          });
          if (r.type === "인력" && r.status === "투입" && !r.pos)
            r.pos = [inc().ignition[0] + 0.004, inc().ignition[1] + 0.003];
          addEvent(
            "관리",
            `진화자원 수정 — ${r.type} ${r.name}(${r.org}, ${r.type === "인력" ? r.qty + "명" : "1대"}, ${r.status})`,
          );
          renderAdmin();
          toast(`${r.name} 저장`);
        }),
    );
    $$("#admin-resources [data-rdel]").forEach(
      (b) =>
        (b.onclick = () => {
          const r = S.resources.find((x) => x.id === b.dataset.rdel);
          if (r.status === "투입") {
            toast("산불에 투입 중인 자원은 삭제할 수 없습니다.");
            return;
          }
          S.resources.splice(S.resources.indexOf(r), 1);
          addEvent("관리", `진화자원 삭제 — ${r.type} ${r.name}(${r.org})`);
          renderAdmin();
        }),
    );
    $("#rs-add").onclick = () => {
      const type = $("#rs-type").value,
        name = $("#rs-name").value.trim(),
        org = $("#rs-org").value.trim(),
        qty = Number($("#rs-qty").value);
      if (
        !checkRes([
          [$("#rs-name"), !!name, "명칭(호출부호)"],
          [$("#rs-org"), !!org, "소속"],
          [$("#rs-qty"), Number.isInteger(qty) && qty >= 1, "수량"],
        ])
      )
        return;
      const r = {
        id: "r" + Date.now().toString(36),
        type,
        name,
        org,
        base: $("#rs-base").value.trim(),
        qty: type === "인력" ? qty : 1,
        status: $("#rs-status").value,
      };
      S.resources.push(r);
      addEvent(
        "관리",
        `진화자원 등록 — ${r.type} ${r.name}(${r.org}, ${r.type === "인력" ? r.qty + "명" : "1대"}, ${r.status})`,
      );
      renderAdmin();
      toast(`${name} 등록`);
    };
  }

  // ------------------------------------------------------------------ 역할 · 로그인 (UC-AUTH-01)
  function applyRole() {
    const r = state.role;
    $$(".commander-only").forEach((el) =>
      el.classList.toggle("role-hide", r !== "commander"),
    );
    $$(".cv-only").forEach((el) =>
      el.classList.toggle("role-hide", !(r === "commander" || r === "viewer")),
    );
    showPanel("#rep-panel", r === "reporter");
    showPanel("#info-panel", r === "commander" || r === "viewer");
    showPanel("#chat-panel", false);
    $("#chat-fab").style.display = "";
    $("#admin-screen").classList.toggle("on", r === "admin");
    document.body.classList.toggle("reporter", r === "reporter");
  }
  // 사용자 구분을 바꾸면 그 구분의 시연 계정(발급 상태 첫 계정)을 자동으로 채운다(목업 편의)
  function fillDemoAccount() {
    const role = $("#login-role").value;
    const acc =
      S.accounts.find((a) => a.role === role && a.status === "발급") ||
      S.accounts.find((a) => a.role === role);
    if (acc) {
      $("#login-id").value = acc.id;
      $("#login-pw").value = acc.pw || "";
    }
  }
  // 로그인 세션을 탭에 저장하고 새로고침 시 복원한다.
  // 발표용 목업에는 시간에 따른 자동 만료를 적용하지 않는다.
  const LOCK_AFTER = 5,
    TOKEN_KEY = "wf-mock-token";
  const LOCK_MSG = "계정이 잠겼습니다. 전산 관리자에게 문의하십시오.";
  const saveToken = () => {
    try {
      sessionStorage.setItem(
        TOKEN_KEY,
        JSON.stringify({
          user: state.user,
          role: state.role,
        }),
      );
    } catch (e) {
      /* 저장소를 못 쓰면 토큰 복원만 생략 */
    }
  };
  const clearToken = () => {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      /* 무시 */
    }
  };
  function login() {
    const id = $("#login-id").value.trim(),
      pw = $("#login-pw").value,
      role = $("#login-role").value,
      err = $("#login-err");
    const fail = (msg) => {
      err.textContent = msg;
      toast(msg, 2800);
    };
    err.textContent = "";
    if (!id) {
      fail("아이디를 입력하십시오.");
      return;
    }
    const acc = S.accounts.find((a) => a.id === id);
    if (acc && acc.locked) {
      fail(LOCK_MSG);
      return;
    }
    if (!acc || (acc.pw || "") !== pw || acc.role !== role) {
      if (acc) {
        acc.failed = (acc.failed || 0) + 1;
        if (acc.failed >= LOCK_AFTER) {
          acc.locked = true;
          addEvent(
            "시스템",
            `${acc.id} 계정 잠금(로그인 ${LOCK_AFTER}회 연속 실패)`,
          );
          fail(LOCK_MSG);
          return;
        }
      }
      fail("아이디 또는 비밀번호가 올바르지 않습니다.");
      return;
    }
    if (acc.status === "회수") {
      fail("회수된 계정입니다. 전산 관리자에게 문의하십시오.");
      return;
    }
    enterSession(acc);
    addEvent("시스템", `${acc.id} 로그인(${ROLE_LABEL[acc.role]})`);
    if (state.role === "reporter")
      toast(
        "산불 목록에서 산불을 고르거나 「새 산불 보고」로 발화 정보를 입력하십시오.",
        3600,
      );
    else if (state.role === "commander" && !IS().predicted)
      toast(
        "「확산예측」에서 「확산 예측 실행」을 누르면 예측과 진화·대피 대응 제안서가 생성됩니다.",
        4200,
      );
  }
  // 권한별 첫 화면: 통합지휘권자·열람자 = 진행 중 산불의 통합 상황도, 상황 보고자 = 상황 입력 화면, 전산 관리자 = 계정·진화자원 데이터 관리
  function enterSession(acc) {
    acc.failed = 0;
    state.user = acc.id;
    state.role = acc.role;
    state.loginAt = state.loginAt || Date.now();
    saveToken();
    $("#login-overlay").style.display = "none";
    $("#chat-log").innerHTML = "";
    state.chatCtx = null;
    setCorrMode(false);
    if (!map) initMap();
    applyRole();
    if (state.role === "admin") {
      renderAdmin();
      return;
    }
    rebuildCrewMarkers();
    renderAll();
    setT(IS().t);
    if (state.role === "reporter") loadRepForm(state.incId);
    showTab("status");
  }
  function resumeSession() {
    let t = null;
    try {
      t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || "null");
    } catch (e) {
      t = null;
    }
    if (!t || !t.user) {
      clearToken();
      return;
    }
    const acc = S.accounts.find((a) => a.id === t.user);
    if (!acc || acc.status !== "발급" || acc.locked) {
      clearToken();
      return;
    }
    enterSession(acc);
    toast("유효한 세션 토큰이 있어 로그인 없이 진입했습니다.", 3000);
  }
  // A2: 로그아웃하면 세션 토큰을 폐기하고 로그인 화면으로 돌아간다
  function logout(reason) {
    pause();
    cancelModes();
    addEvent(
      "시스템",
      reason
        ? `${state.user} 자동 로그아웃(${reason})`
        : `${state.user} 로그아웃`,
    );
    clearToken();
    state.role = null;
    $("#admin-screen").classList.remove("on");
    $("#login-overlay").style.display = "";
    $("#login-err").textContent = "";
    if (reason) {
      $("#login-err").textContent =
        `${reason}으로 로그아웃되었습니다. 다시 로그인하십시오.`;
      toast(`${reason}으로 로그아웃되었습니다.`, 4000);
    }
  }
  function renderAll() {
    if (!state.role || state.role === "admin") return;
    renderHeader();
    if (state.role === "reporter") {
      renderReporter();
      return;
    }
    renderStatus();
    renderPredict();
    renderRisk();
    renderResources();
    renderProposal();
    renderHistory();
  }

  // ------------------------------------------------------------------ 바인딩
  function bind() {
    $("#login-btn").onclick = login;
    ["#login-pw", "#login-id"].forEach((id) =>
      $(id).addEventListener("keydown", (e) => e.key === "Enter" && login()),
    );
    $("#login-role").addEventListener("change", fillDemoAccount);
    // 서버 현재 시각(KST). 브라우저 시간대와 무관하게 Asia/Seoul로 표시
    const kstFmt = new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const kstNow = () => {
      const p = {};
      kstFmt.formatToParts(new Date()).forEach((x) => (p[x.type] = x.value));
      return `${p.year}.${p.month}.${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`;
    };
    const tickClock = () => {
      const t = kstNow();
      ["#lg-clock", "#hdr-clock", "#admin-clock"].forEach((id) => {
        const el = $(id);
        if (el) el.textContent = t;
      });
    };
    tickClock();
    setInterval(tickClock, 1000);
    $("#btn-logout").onclick = () => logout();
    $("#admin-logout").onclick = () => logout();
    $("#chat-fab").onclick = openChatPopup;
    $("#chat-close").onclick = () => {
      showPanel("#chat-panel", false);
      $("#chat-fab").style.display = "";
    };
    $$(".menu-btn").forEach((b) => (b.onclick = () => showTab(b.dataset.menu)));
    $("#btn-resources").onclick = () => {
      showPanel("#left-panel");
      $("#btn-resources").classList.toggle(
        "on",
        $("#left-panel").classList.contains("on"),
      );
    };
    $("#lp-close").onclick = () => {
      showPanel("#left-panel", false);
      $("#btn-resources").classList.remove("on");
    };
    $$(".lyr-btn").forEach(
      (b) =>
        (b.onclick = () => {
          b.classList.toggle("off");
          applyLayerVisibility();
        }),
    );
    $$(".ip-tab").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
    $("#ip-close").onclick = () => {
      showPanel("#info-panel", false);
      $$(".menu-btn").forEach((m) => m.classList.remove("on"));
    };
    $("#ip-fit").onclick = () =>
      map && map.flyTo({ center: inc().ignition, zoom: 12.5, duration: 800 });
    $$(".vtab").forEach(
      (v) =>
        (v.onclick = () => {
          if (v.dataset.v === "fire")
            showPanel(state.role === "reporter" ? "#rep-panel" : "#info-panel");
          else showPanel("#legend-panel");
        }),
    );
    $("#lg-close").onclick = () => showPanel("#legend-panel", false);
    $("#ts-zoom-in").onclick = () => map && map.zoomIn();
    $("#ts-zoom-out").onclick = () => map && map.zoomOut();
    $("#ts-zoom").oninput = (e) => map && map.setZoom(Number(e.target.value));
    $("#ts-fit").onclick = () => map && fitAll();
    $("#compass").onclick = () => map && map.easeTo({ bearing: 0, pitch: 0 });
    $("#ts-sat").onclick = () => {
      state.sat = !state.sat;
      applySat();
    };
    $("#btn-play").onclick = play;
    $("#btn-stop").onclick = () => {
      pause();
      setT(0);
    };
    $("#time-slider").oninput = (e) => {
      pause();
      setT(Number(e.target.value));
    };
    $("#btn-predict").onclick = () => runPrediction();
    $$(".ptab").forEach(
      (b) =>
        (b.onclick = () => {
          state.axis = b.dataset.axis;
          $$(".ptab").forEach((x) => x.classList.toggle("on", x === b));
          renderProposal();
        }),
    );
    $$(".pfilter").forEach(
      (b) =>
        (b.onclick = () => {
          state.filter = b.dataset.f;
          $$(".pfilter").forEach((x) => x.classList.toggle("on", x === b));
          renderProposal();
        }),
    );
    $("#btn-ev-close").onclick = () =>
      $("#evidence-drawer").classList.remove("on");
    $("#chat-form").onsubmit = (e) => {
      e.preventDefault();
      sendChat();
    };
    $("#btn-corr").onclick = () => {
      setCorrMode(!state.corrMode);
      $("#chat-input").focus();
    };
    // 상황 보고자
    $("#rep-new").onclick = () => {
      loadRepForm(null);
      toast(
        "새 산불의 발화 위치·일시·신고 내용·접수 기록을 입력하십시오. 화선이 있으면 함께 그려 제출합니다.",
      );
    };
    $("#rep-perim").onclick = startPerimReport;
    $("#ik-add").onclick = addIntakeRow;
    $("#rep-pick").onclick = () => {
      state.rep.pickMode = !state.rep.pickMode;
      state.rep.drawMode = false;
      renderReporter();
    };
    $("#rep-draw").onclick = () => {
      state.rep.drawMode = !state.rep.drawMode;
      state.rep.pickMode = false;
      state.rep.pts = [];
      renderReporter();
    };
    $("#rep-draw-done").onclick = finishDraw;
    $("#rep-draw-clear").onclick = () => {
      state.rep.ring = null;
      state.rep.ringSource = null;
      state.rep.pts = [];
      state.rep.drawMode = false;
      renderReporter();
    };
    $("#rep-geojson").onclick = openGeoJsonModal;
    $("#rep-save").onclick = saveReport;
    ["#rep-lng", "#rep-lat"].forEach(
      (id) =>
        ($(id).oninput = () => {
          const lng = Number($("#rep-lng").value),
            lat = Number($("#rep-lat").value);
          if (map && isFinite(lng) && isFinite(lat) && lng && lat) {
            state.markers["pick"].setLngLat([lng, lat]);
            state.markers["pick"].getElement().style.display = "";
          }
        }),
    );
    $("#modal-bg").addEventListener("click", (e) => {
      if (e.target.id === "modal-bg") closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeModal();
        $("#evidence-drawer").classList.remove("on");
        cancelModes();
      }
    });
    [
      "#info-panel",
      "#left-panel",
      "#legend-panel",
      "#chat-panel",
      "#rep-panel",
    ].forEach((id) => makeDraggable($(id)));
  }

  // 마커 스타일 (위성영상 위 가독성: 흰 라벨)
  const css = document.createElement("style");
  css.textContent = `
    .mk { display:flex; flex-direction:column; align-items:center; cursor:pointer; pointer-events:auto; }
    .mk .ico { width:22px; height:22px; border-radius:50%; display:flex; align-items:center; justify-content:center; box-shadow:0 1px 3px rgba(0,0,0,.6); border:1.5px solid #fff; }
    .mk .ico svg { width:13px; height:13px; stroke:#fff; fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
    .mk.crew .ico svg { stroke:#333; }
    .mk .lb { margin-top:1px; font-size:11px; font-weight:700; color:#fff; text-shadow:0 0 3px #000, 0 0 3px #000, 0 1px 2px #000; white-space:nowrap; line-height:1.3; text-align:center; }
    body:not(.satmap) .mk .lb { color:#111; text-shadow:0 0 3px #fff, 0 0 3px #fff; }
    .mk .lb small { display:none; font-size:9.5px; font-weight:500; }
    .mk:hover .lb small { display:block; }
    .mk.village.burned .ico { background:#e5341a !important; box-shadow:0 0 0 3px rgba(255,59,26,.35), 0 1px 3px rgba(0,0,0,.6); } .mk.village.burned .lb { color:#ffb3a3; }
    .mk.shelter.unsafe .ico { background:#ef4444 !important; }
    .mk.crew .ico { width:18px; height:18px; } .mk.crew .lb { display:none; } .mk.crew:hover .lb { display:block; }
    .mk.water .lb { display:none; } .mk.water:hover .lb { display:block; }
    .mk.f0 .ico { width:26px; height:26px; box-shadow:0 0 0 6px rgba(255,42,0,.3), 0 1px 4px rgba(0,0,0,.6); } .mk.f0 .ico svg { width:15px; height:15px; } .mk.f0 .lb { color:#ffd0c4; font-size:12px; }
    .mk.pick .ico { width:26px; height:26px; box-shadow:0 0 0 6px rgba(255,106,0,.35), 0 1px 4px rgba(0,0,0,.6); } .mk.pick .lb { color:#ffd9b3; }
    .mk.emd { font-size:11px; font-weight:700; color:#fff; letter-spacing:.06em; opacity:.85; pointer-events:none; text-shadow:0 0 3px #000, 0 0 3px #000; }
    body:not(.satmap) .mk.emd { color:#334155; text-shadow:0 0 3px #fff, 0 0 3px #fff; }
    body.reporter .mk.village .lb, body.reporter .mk.shelter .lb { font-size:10px; }
    .maplibregl-marker { z-index:2; } .mk.f0, .mk.pick { z-index:5; }
    .seg { display:inline-flex; } .seg button { font-size:11px; padding:0 7px; border-radius:0; } .seg button + button { border-left:0; } .seg button.on { background:#444; color:#fff; border-color:#222; }
    .invalid { border-color:#d0342c !important; background:#fff1f0 !important; }`;
  document.head.appendChild(css);

  // ------------------------------------------------------------------ 시작
  state.houses = genHouses();
  bind();
  renderLegend();
  $("#ip-clock").textContent = `${ymd(T0)} ${hhmm(T0)}`;
  document.body.classList.add("satmap");
  function fitPanelsToStage() {
    const stage = $("#stage");
    if (!stage) return;

    $$("#stage .fpanel.on").forEach((panel) => {
      const stageRect = stage.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();

      // 이동한 창의 가로 위치를 화면 안으로 보정
      if (panel.style.left) {
        const maxLeft = Math.max(8, stage.clientWidth - panel.offsetWidth - 8);

        const left = panelRect.left - stageRect.left;

        panel.style.left = Math.max(8, Math.min(left, maxLeft)) + "px";
      }

      // 이동한 창의 세로 위치를 화면 안으로 보정
      if (panel.style.top) {
        const maxTop = Math.max(8, stage.clientHeight - panel.offsetHeight - 8);

        const top = panelRect.top - stageRect.top;

        panel.style.top = Math.max(8, Math.min(top, maxTop)) + "px";
      }
    });
  }

  function syncAppLayout() {
    // 실제 상단 높이만큼 지도 영역의 높이 조정
    const headerHeight =
      $("#top1").getBoundingClientRect().height +
      $("#top2").getBoundingClientRect().height;

    document.documentElement.style.setProperty(
      "--app-header-height",
      `${headerHeight}px`,
    );

    requestAnimationFrame(() => {
      if (map) map.resize();
      fitPanelsToStage();
    });
  }

  const headerResizeObserver = new ResizeObserver(syncAppLayout);

  headerResizeObserver.observe($("#top1"));
  headerResizeObserver.observe($("#top2"));

  window.addEventListener("resize", syncAppLayout);
  syncAppLayout();
  function setupTooltips() {
    const tip = document.createElement("div");
    tip.id = "app-tooltip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.appendChild(tip);

    let active = null;
    let pinned = false;

    function closeTip() {
      if (active) active.removeAttribute("aria-describedby");
      active = null;
      pinned = false;
      tip.hidden = true;
    }

    function openTip(icon, pin = false) {
      if (active && active !== icon) {
        active.removeAttribute("aria-describedby");
      }

      active = icon;
      pinned = pin;
      tip.textContent = icon.dataset.tip;
      tip.hidden = false;
      icon.setAttribute("aria-describedby", tip.id);

      const rect = icon.getBoundingClientRect();
      const width = tip.offsetWidth;
      const height = tip.offsetHeight;
      const margin = 12;
      const gap = 8;

      const maxLeft = Math.max(margin, window.innerWidth - width - margin);

      const left = Math.max(
        margin,
        Math.min(rect.left + rect.width / 2 - width / 2, maxLeft),
      );

      let top = icon.classList.contains("b")
        ? rect.bottom + gap
        : rect.top - height - gap;

      if (top < margin) {
        top = rect.bottom + gap;
      }

      const maxTop = Math.max(margin, window.innerHeight - height - margin);

      top = Math.max(margin, Math.min(top, maxTop));

      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    }

    // 동적으로 추가되는 아이콘도 키보드로 조작 가능하게 설정
    function prepareIcons() {
      document.querySelectorAll(".info[data-tip]").forEach((icon) => {
        if (!icon.hasAttribute("tabindex")) {
          icon.tabIndex = 0;
          icon.setAttribute("role", "button");
          icon.setAttribute("aria-label", "도움말");
        }
      });
    }

    prepareIcons();

    const observer = new MutationObserver(prepareIcons);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    document.addEventListener("pointerover", (event) => {
      const icon = event.target.closest(".info[data-tip]");
      if (icon && !pinned) openTip(icon);
    });

    document.addEventListener("pointerout", (event) => {
      if (pinned || !active) return;

      const next = event.relatedTarget;

      if (next && (active.contains(next) || tip.contains(next))) {
        return;
      }

      if (active.contains(event.target) || tip.contains(event.target)) {
        closeTip();
      }
    });

    document.addEventListener("click", (event) => {
      const icon = event.target.closest(".info[data-tip]");

      if (icon) {
        if (active === icon && pinned) closeTip();
        else openTip(icon, true);
      } else if (!tip.contains(event.target)) {
        closeTip();
      }
    });

    document.addEventListener("focusin", (event) => {
      const icon = event.target.closest(".info[data-tip]");
      if (icon && !pinned) openTip(icon);
    });

    document.addEventListener("focusout", (event) => {
      if (!pinned && event.target === active) closeTip();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeTip();
        return;
      }

      const icon = event.target.closest(".info[data-tip]");

      if (icon && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();

        if (active === icon && pinned) closeTip();
        else openTip(icon, true);
      }
    });

    // 패널 이동·스크롤 후 이전 위치에 남지 않도록 닫기
    document.addEventListener("pointerdown", (event) => {
      if (
        !event.target.closest(".info[data-tip]") &&
        !tip.contains(event.target)
      ) {
        closeTip();
      }
    });

    document.addEventListener(
      "scroll",
      (event) => {
        if (event.target !== tip) closeTip();
      },
      true,
    );

    window.addEventListener("resize", closeTip);
  }

  setupTooltips();
  window.__mock = {
    state,
    S,
    get map() {
      return map;
    },
    ringAreaHa,
    firePolygon,
    runPrediction,
    generateProposal,
    computeRisk,
    riskOf,
    curPerim,
    IS,
    inc,
    events: state.events,
  };
  resumeSession();
})();

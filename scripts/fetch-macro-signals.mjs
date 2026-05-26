/**
 * fetch-macro-signals.mjs — 비예정 매크로 트리거 수집기 (Layer 1)
 *
 * 목적: FOMC/CPI 같은 "캘린더 이벤트"가 아닌, 시점이 정해지지 않은
 *      거시 지표(달러·금리·변동성·원자재·환율·크립토 구조) 의 임계값 돌파를
 *      자동으로 감지해서 콘텐츠 트리거로 노출.
 *
 * 데이터 소스:
 *   - Yahoo Finance v8 chart API : DXY, US10Y, VIX, Gold, WTI, USDJPY
 *   - Binance Futures            : BTC 펀딩률, OI 24h 변동
 *   - DefiLlama                  : 스테이블코인 총 시총 (7일 델타)
 *
 * 출력: macro-signals.json
 *   { updatedAt, signals: [...], summary: { alert, watch, normal } }
 *
 * 신호 레벨:
 *   ALERT  → 즉시 콘텐츠 기회 (트리거 발동)
 *   WATCH  → 주의 관찰 (임계값 근접)
 *   NORMAL → 평상 범위
 */

import https from 'https';
import { writeFileSync, readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// ────────────────────────────────────────────────────────────────
// HTTP 유틸
// ────────────────────────────────────────────────────────────────
function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BTC-MacroSignals/1.0)',
        'Accept': 'application/json, text/plain, */*',
        ...opts.headers,
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location, opts).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse: ' + e.message)); }
      });
    });
    req.setTimeout(opts.timeout || 15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ────────────────────────────────────────────────────────────────
// Yahoo Finance — 일봉 시계열 fetch (10일 범위)
// ────────────────────────────────────────────────────────────────
async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=15d`;
  const data = await fetchJson(url);
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error(`Yahoo: empty result for ${symbol}`);
  const meta = r.meta;
  const closesRaw = r.indicators?.quote?.[0]?.close || [];
  const closes = closesRaw.filter(v => v !== null && v !== undefined);
  if (closes.length < 2) throw new Error(`Yahoo: insufficient data for ${symbol}`);

  const price = meta.regularMarketPrice ?? closes[closes.length - 1];
  // chartPreviousClose 는 "오늘 시점 직전 종가" — Yahoo가 동일 봉을 closes에 포함시키는 경우가 있어 보정
  const prevClose = closes.length >= 2 ? closes[closes.length - 2] : meta.chartPreviousClose;
  const weekAgoClose = closes.length >= 6 ? closes[closes.length - 6] : closes[0];

  return {
    price,
    prevClose,
    weekAgoClose,
    dailyChangePct: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
    weeklyChangePct: weekAgoClose ? ((price - weekAgoClose) / weekAgoClose) * 100 : 0,
    closes,
  };
}

// ────────────────────────────────────────────────────────────────
// Binance Futures — BTC 펀딩률 + OI 24h 변동
// ────────────────────────────────────────────────────────────────
async function fetchBinanceFunding() {
  const d = await fetchJson('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
  // lastFundingRate: 직전 결제 펀딩률 (8h, decimal). 0.0001 = 0.01%
  const rate = parseFloat(d.lastFundingRate);
  const ratePct = rate * 100;
  const annualPct = ratePct * 3 * 365; // 8h × 3회/일 × 365
  return { rate, ratePct, annualPct, time: parseInt(d.time) };
}

async function fetchBinanceOI() {
  // 1h 봉 25개 → 가장 오래된 것과 최신 비교 = 24h 변동
  const hist = await fetchJson(
    'https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=1h&limit=25'
  );
  if (!Array.isArray(hist) || hist.length < 24) throw new Error('Binance OI history too short');
  const latest = parseFloat(hist[hist.length - 1].sumOpenInterest);
  const dayAgo = parseFloat(hist[0].sumOpenInterest);
  const latestUsd = parseFloat(hist[hist.length - 1].sumOpenInterestValue);
  return {
    latestBTC: latest,
    dayAgoBTC: dayAgo,
    latestUsd,
    changePct24h: ((latest - dayAgo) / dayAgo) * 100,
  };
}

// ────────────────────────────────────────────────────────────────
// DefiLlama — 스테이블코인 총 시총 (7일 델타)
// ────────────────────────────────────────────────────────────────
async function fetchStablecoinMcap() {
  const data = await fetchJson('https://stablecoins.llama.fi/stablecoincharts/all');
  if (!Array.isArray(data) || data.length < 8) throw new Error('Stablecoin chart too short');
  const pick = (row) => parseFloat(
    row.totalCirculatingUSD?.peggedUSD ?? row.totalCirculating?.peggedUSD ?? 0
  );
  const latest  = pick(data[data.length - 1]);
  const dayAgo  = pick(data[data.length - 2]);
  const weekAgo = pick(data[data.length - 8]);
  return {
    latest, dayAgo, weekAgo,
    deltaUSD24h: latest - dayAgo,
    deltaUSD7d:  latest - weekAgo,
    changePct24h: ((latest - dayAgo) / dayAgo) * 100,
    changePct7d:  ((latest - weekAgo) / weekAgo) * 100,
  };
}

// ────────────────────────────────────────────────────────────────
// Indicator 정의 + 임계값
// ────────────────────────────────────────────────────────────────
// 임계값 calibration 메모:
//   - daily.watch / daily.alert 는 일중 절대 변동률 (%) 기준
//   - levels 는 시장이 "라운드 넘버" 로 인식하는 심리적 가격대
//   - abs.alert 는 절대값 기준 (펀딩률 등 부호 자체가 신호)
// 초기 임계값은 보수적으로 잡고, 추후 learnings/macro-triggers.md 로 calibrate
const INDICATORS = [
  {
    id: 'dxy',
    label: 'DXY (달러 인덱스)',
    yahoo: 'DX-Y.NYB',
    category: 'fx',
    categoryLabel: '환율/금리',
    unit: '',
    decimals: 2,
    thresholds: {
      daily: { watch: 0.6, alert: 1.0 },
      levels: [100, 105, 108, 110],
    },
    interpretation: {
      high: '달러 강세 심화 → 위험자산 + BTC 하방 압력. 글로벌 유동성 위축 시그널.',
      low:  '달러 약세 진행 → 위험자산 선호 회복 + BTC 상승 동인.',
    },
    contentAngle: 'DXY가 임계 라운드 넘버를 돌파/이탈하면 "달러 vs BTC" 구도 콘텐츠로 즉시 배포 가능. 방향 베팅이 아닌 상관관계 구조 설명.',
  },
  {
    id: 'us10y',
    label: '미국 10년 국채 금리',
    yahoo: '^TNX',
    category: 'fx',
    categoryLabel: '환율/금리',
    unit: '%',
    decimals: 2,
    thresholds: {
      daily: { watch: 2.5, alert: 4.0 },
      levels: [4.0, 4.5, 5.0],
    },
    interpretation: {
      high: '실질금리 상승 → 무이자 자산(금·BTC) 기회비용 증가 → 위험자산 압박.',
      low:  '금리 하락 → 듀레이션 자산 + 위험자산 동반 상승 환경 조성.',
    },
    contentAngle: '10년물이 4% / 4.5% / 5% 라인을 돌파/이탈하면 매크로 변곡점. "금리 vs 위험자산" 흐름 설명용 콘텐츠.',
  },
  {
    id: 'vix',
    label: 'VIX (변동성 지수)',
    yahoo: '^VIX',
    category: 'volatility',
    categoryLabel: '변동성',
    unit: '',
    decimals: 2,
    thresholds: {
      daily: { watch: 10, alert: 20 },
      levels: [15, 20, 25, 30],
    },
    interpretation: {
      high: 'S&P 옵션 변동성 급등 → 위험 회피 모드 → BTC 단기 상관 상승 가능.',
      low:  '저변동성 환경 → 위험자산 누적 + 캐리 트레이드 활성화.',
    },
    contentAngle: 'VIX 20+ 진입은 "변동성 환경" 전환점. Aark의 변동성 거래 도구로서의 핵심 가치 제안 시점.',
  },
  {
    id: 'gold',
    label: '금 (Gold Futures)',
    yahoo: 'GC=F',
    category: 'commodity',
    categoryLabel: '원자재',
    unit: '$',
    decimals: 1,
    thresholds: {
      daily: { watch: 1.2, alert: 2.0 },
      levels: [3000, 3500, 4000],
    },
    interpretation: {
      high: '금 상승 → 안전자산 선호 + 달러 회피 + 디지털 골드(BTC) 내러티브 강화.',
      low:  '금 하락 → 위험자산 선호 회복 시그널 또는 강달러 환경.',
    },
    contentAngle: '금과 BTC의 30일 상관계수 추적. 디커플링/커플링 변화는 "BTC = 디지털 금" 논제 검증 콘텐츠로 활용.',
  },
  {
    id: 'wti',
    label: 'WTI 원유',
    yahoo: 'CL=F',
    category: 'commodity',
    categoryLabel: '원자재',
    unit: '$',
    decimals: 2,
    thresholds: {
      daily: { watch: 2.5, alert: 4.0 },
      levels: [60, 70, 80, 90, 100],
    },
    interpretation: {
      high: '유가 급등 → 인플레 재가속 우려 → 금리 인하 지연 → 위험자산 압박.',
      low:  '유가 하락 → 인플레 완화 → 비둘기 통화정책 기대 + 위험자산 우호.',
    },
    contentAngle: '지정학(중동·러시아) 헤드라인 동반 시 효과 증폭. "에너지 → 인플레 → 금리 → BTC" 경로 콘텐츠.',
  },
  {
    id: 'usdjpy',
    label: 'USD/JPY (엔/달러)',
    yahoo: 'JPY=X',
    category: 'fx',
    categoryLabel: '환율/금리',
    unit: '',
    decimals: 2,
    thresholds: {
      daily: { watch: 0.8, alert: 1.5 },
      levels: [150, 155, 160],
    },
    interpretation: {
      high: '엔화 약세 심화 → BOJ 개입 + 글로벌 캐리 트레이드 청산 리스크 → 위험자산 충격 가능.',
      low:  '엔화 강세 전환 → 캐리 트레이드 언와인드 진행 → 단기 디레버리징 압력.',
    },
    contentAngle: '2024년 8월 5일 캐리 청산 사태 참조. 150 이상부터 BOJ 개입·캐리 청산 시나리오 콘텐츠 준비.',
  },
  {
    id: 'btc_funding',
    label: 'BTC 펀딩률 (Binance Perp)',
    binance: 'funding',
    category: 'crypto',
    categoryLabel: '크립토 구조',
    unit: '%',
    decimals: 4,
    thresholds: {
      // 8h 펀딩률 절대값 (%)
      abs: { watch: 0.01, alert: 0.025 }, // 0.01% / 0.025% per 8h
      annualAbs: { watch: 11, alert: 27 }, // 환산 연이율 (%)
    },
    interpretation: {
      high: '펀딩률 과열 → 롱 과열 + 청산 압박 누적 → 단기 조정 트리거 가능.',
      low:  '펀딩률 마이너스 → 숏 과열 + 숏 스퀴즈 + 역청산 가능 환경.',
    },
    contentAngle: '펀딩률 극단값(연환산 ±30%+)은 포지셔닝 쏠림 = 변동성 압력 누적 시그널. Aark "no funding fee" 차별점 콘텐츠 적기.',
  },
  {
    id: 'btc_oi',
    label: 'BTC 미결제약정 24h 변동',
    binance: 'oi',
    category: 'crypto',
    categoryLabel: '크립토 구조',
    unit: '%',
    decimals: 2,
    thresholds: {
      daily: { watch: 5, alert: 10 },
    },
    interpretation: {
      high: 'OI 급증 → 신규 레버리지 유입 → 변동성 증폭 환경.',
      low:  'OI 급감 → 디레버리징 진행 → 청산 후 안정 또는 추가 하락 분기점.',
    },
    contentAngle: 'OI 급변은 변동성 사이클의 시작 또는 끝. 일중 ±10% 변동은 콘텐츠 트리거.',
  },
  {
    id: 'stablecoin_mcap',
    label: '스테이블코인 총 시총 (7일 델타)',
    defillama: true,
    category: 'crypto',
    categoryLabel: '크립토 구조',
    unit: '$B',
    decimals: 2,
    thresholds: {
      // 7일 변동 절대 USD 기준 ($B)
      absUSD7d: { watch: 2e9, alert: 5e9 },
    },
    interpretation: {
      high: '스테이블코인 발행 증가 → 크립토 신규 유동성 유입 → BTC 매수 잠재력.',
      low:  '스테이블코인 시총 감소 → 시장 자금 이탈 → 위험 회피 신호.',
    },
    contentAngle: '주간 ±$5B 변동은 의미있는 자금 흐름. ETF 플로우와 함께 분석 시 신뢰도 상승.',
  },
];

// ────────────────────────────────────────────────────────────────
// 임계값 평가 — 시장 데이터를 INDICATORS 정의에 맞춰 NORMAL/WATCH/ALERT로 분류
// ────────────────────────────────────────────────────────────────
function classify(ind, m) {
  const reasons = [];
  let level = 'NORMAL';
  const bump = (l) => {
    if (l === 'ALERT' || (l === 'WATCH' && level === 'NORMAL')) level = l;
  };

  // 일중 변동률
  if (ind.thresholds.daily && m.dailyChangePct !== undefined && m.dailyChangePct !== null) {
    const abs = Math.abs(m.dailyChangePct);
    if (abs >= ind.thresholds.daily.alert) {
      bump('ALERT');
      reasons.push(`일중 ${m.dailyChangePct >= 0 ? '+' : ''}${m.dailyChangePct.toFixed(2)}% 변동 (ALERT ${ind.thresholds.daily.alert}%↑)`);
    } else if (abs >= ind.thresholds.daily.watch) {
      bump('WATCH');
      reasons.push(`일중 ${m.dailyChangePct >= 0 ? '+' : ''}${m.dailyChangePct.toFixed(2)}% 변동 (WATCH ${ind.thresholds.daily.watch}%↑)`);
    }
  }

  // 라운드 넘버 돌파/이탈
  if (ind.thresholds.levels && m.price !== undefined && m.prevClose !== undefined) {
    for (const lv of ind.thresholds.levels) {
      const crossedUp   = m.price >= lv && m.prevClose < lv;
      const crossedDown = m.price <  lv && m.prevClose >= lv;
      if (crossedUp || crossedDown) {
        bump('ALERT');
        reasons.push(`${lv}${ind.unit || ''} ${crossedUp ? '상향 돌파' : '하향 이탈'}`);
      }
    }
  }

  // 절대값 임계 (펀딩률 등)
  if (ind.thresholds.abs && m.absValue !== undefined) {
    const abs = Math.abs(m.absValue);
    if (abs >= ind.thresholds.abs.alert) {
      bump('ALERT');
      reasons.push(`절대값 ${m.absValue >= 0 ? '+' : ''}${m.absValue.toFixed(4)}% (ALERT ±${ind.thresholds.abs.alert}%)`);
    } else if (abs >= ind.thresholds.abs.watch) {
      bump('WATCH');
      reasons.push(`절대값 ${m.absValue >= 0 ? '+' : ''}${m.absValue.toFixed(4)}% (WATCH ±${ind.thresholds.abs.watch}%)`);
    }
  }

  // 7일 절대 USD 변동 (스테이블코인)
  if (ind.thresholds.absUSD7d && m.deltaUSD7d !== undefined) {
    const abs = Math.abs(m.deltaUSD7d);
    if (abs >= ind.thresholds.absUSD7d.alert) {
      bump('ALERT');
      reasons.push(`7일 ${(m.deltaUSD7d / 1e9).toFixed(2)}B$ 변동 (ALERT ±$${(ind.thresholds.absUSD7d.alert/1e9).toFixed(1)}B)`);
    } else if (abs >= ind.thresholds.absUSD7d.watch) {
      bump('WATCH');
      reasons.push(`7일 ${(m.deltaUSD7d / 1e9).toFixed(2)}B$ 변동 (WATCH ±$${(ind.thresholds.absUSD7d.watch/1e9).toFixed(1)}B)`);
    }
  }

  return { level, reasons };
}

// ────────────────────────────────────────────────────────────────
// 메인
// ────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== fetch-macro-signals.mjs ===\n');
  const out = [];
  const errors = [];

  // 1. Yahoo Finance 인디케이터 병렬 fetch
  const yahooInds = INDICATORS.filter(i => i.yahoo);
  const yahooResults = await Promise.allSettled(
    yahooInds.map(i => fetchYahoo(i.yahoo))
  );

  for (let i = 0; i < yahooInds.length; i++) {
    const ind = yahooInds[i];
    const res = yahooResults[i];
    if (res.status !== 'fulfilled') {
      console.error(`  ✗ ${ind.id} (${ind.yahoo}): ${res.reason?.message || res.reason}`);
      errors.push({ id: ind.id, error: String(res.reason?.message || res.reason) });
      continue;
    }
    const m = res.value;
    const { level, reasons } = classify(ind, m);
    console.log(`  ✓ ${ind.id}: ${m.price.toFixed(ind.decimals)} (${m.dailyChangePct >= 0 ? '+' : ''}${m.dailyChangePct.toFixed(2)}%) [${level}]`);

    out.push({
      id: ind.id,
      label: ind.label,
      category: ind.category,
      categoryLabel: ind.categoryLabel,
      source: 'Yahoo Finance',
      sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(ind.yahoo)}`,
      unit: ind.unit,
      decimals: ind.decimals,
      price: m.price,
      prevClose: m.prevClose,
      dailyChangePct:  m.dailyChangePct,
      weeklyChangePct: m.weeklyChangePct,
      level,
      reasons,
      thresholds: ind.thresholds,
      interpretation: ind.interpretation,
      contentAngle: ind.contentAngle,
    });
  }

  // 2. Binance 펀딩률
  const fundingInd = INDICATORS.find(i => i.id === 'btc_funding');
  try {
    const f = await fetchBinanceFunding();
    const { level, reasons } = classify(fundingInd, { absValue: f.ratePct });
    console.log(`  ✓ btc_funding: ${f.ratePct.toFixed(4)}% / 8h (연환산 ${f.annualPct.toFixed(1)}%) [${level}]`);
    out.push({
      id: fundingInd.id,
      label: fundingInd.label,
      category: fundingInd.category,
      categoryLabel: fundingInd.categoryLabel,
      source: 'Binance Futures',
      sourceUrl: 'https://www.binance.com/en/futures/funding-history/perpetual/real-time-funding-rate',
      unit: fundingInd.unit,
      decimals: fundingInd.decimals,
      price: f.ratePct,        // 8h 펀딩률(%)
      annualPct: f.annualPct,  // 연이율 환산
      level,
      reasons,
      thresholds: fundingInd.thresholds,
      interpretation: fundingInd.interpretation,
      contentAngle: fundingInd.contentAngle,
    });
  } catch (e) {
    console.error(`  ✗ btc_funding: ${e.message}`);
    errors.push({ id: 'btc_funding', error: e.message });
  }

  // 3. Binance OI 24h
  const oiInd = INDICATORS.find(i => i.id === 'btc_oi');
  try {
    const oi = await fetchBinanceOI();
    const { level, reasons } = classify(oiInd, { dailyChangePct: oi.changePct24h });
    console.log(`  ✓ btc_oi: ${oi.latestBTC.toFixed(0)} BTC (24h ${oi.changePct24h >= 0 ? '+' : ''}${oi.changePct24h.toFixed(2)}%) [${level}]`);
    out.push({
      id: oiInd.id,
      label: oiInd.label,
      category: oiInd.category,
      categoryLabel: oiInd.categoryLabel,
      source: 'Binance Futures',
      sourceUrl: 'https://www.binance.com/en/futures/funding-history/perpetual/open-interest',
      unit: oiInd.unit,
      decimals: oiInd.decimals,
      price: oi.changePct24h,
      latestBTC: oi.latestBTC,
      latestUsd: oi.latestUsd,
      dailyChangePct: oi.changePct24h,
      level,
      reasons,
      thresholds: oiInd.thresholds,
      interpretation: oiInd.interpretation,
      contentAngle: oiInd.contentAngle,
    });
  } catch (e) {
    console.error(`  ✗ btc_oi: ${e.message}`);
    errors.push({ id: 'btc_oi', error: e.message });
  }

  // 4. DefiLlama Stablecoin
  const stInd = INDICATORS.find(i => i.id === 'stablecoin_mcap');
  try {
    const s = await fetchStablecoinMcap();
    const { level, reasons } = classify(stInd, { deltaUSD7d: s.deltaUSD7d });
    console.log(`  ✓ stablecoin_mcap: $${(s.latest / 1e9).toFixed(2)}B (7일 ${s.deltaUSD7d >= 0 ? '+' : ''}$${(s.deltaUSD7d / 1e9).toFixed(2)}B) [${level}]`);
    out.push({
      id: stInd.id,
      label: stInd.label,
      category: stInd.category,
      categoryLabel: stInd.categoryLabel,
      source: 'DefiLlama',
      sourceUrl: 'https://defillama.com/stablecoins',
      unit: stInd.unit,
      decimals: stInd.decimals,
      price: s.latest / 1e9,         // $B 단위
      deltaUSD24h: s.deltaUSD24h,
      deltaUSD7d:  s.deltaUSD7d,
      dailyChangePct: s.changePct24h,
      weeklyChangePct: s.changePct7d,
      level,
      reasons,
      thresholds: stInd.thresholds,
      interpretation: stInd.interpretation,
      contentAngle: stInd.contentAngle,
    });
  } catch (e) {
    console.error(`  ✗ stablecoin_mcap: ${e.message}`);
    errors.push({ id: 'stablecoin_mcap', error: e.message });
  }

  // 정렬: ALERT → WATCH → NORMAL, 같은 레벨 내에서는 |일중변동률| 큰 순
  const levelOrder = { ALERT: 0, WATCH: 1, NORMAL: 2 };
  out.sort((a, b) => {
    if (levelOrder[a.level] !== levelOrder[b.level]) return levelOrder[a.level] - levelOrder[b.level];
    return Math.abs(b.dailyChangePct || 0) - Math.abs(a.dailyChangePct || 0);
  });

  const summary = {
    alert:  out.filter(s => s.level === 'ALERT').length,
    watch:  out.filter(s => s.level === 'WATCH').length,
    normal: out.filter(s => s.level === 'NORMAL').length,
    total:  out.length,
    errorCount: errors.length,
  };

  const payload = {
    updatedAt: new Date().toISOString(),
    summary,
    signals: out,
    errors,
  };

  writeFileSync('macro-signals.json', JSON.stringify(payload, null, 2));
  console.log(`\n✅ Saved ${out.length} signals → macro-signals.json`);
  console.log(`   ALERT: ${summary.alert} | WATCH: ${summary.watch} | NORMAL: ${summary.normal} | errors: ${errors.length}`);

  // ── 이벤트 로그 누적 (칼리브레이션용) ──
  appendEventLog(out);
}

// ────────────────────────────────────────────────────────────────
// 이벤트 로그 누적 — Week 1 관찰 단계에서 시그널 빈도/패턴 데이터 누적
//   - ALERT/WATCH 만 기록 (NORMAL 제외 — 노이즈 방지)
//   - 같은 (id, level) 페어가 4시간 이내 재발생하면 dedup (한 사건당 1행)
//   - JSONL 포맷, append-only, 영구 누적
//   - 출력: logs/macro-signals-events.jsonl
// ────────────────────────────────────────────────────────────────
function appendEventLog(signals) {
  const logPath = 'logs/macro-signals-events.jsonl';
  const DEDUP_WINDOW_MS = 4 * 3600 * 1000; // 4시간
  const nowMs = Date.now();

  // 1. 기존 로그 tail 읽어서 (id, level) → 가장 최근 ts 맵 구성
  const recentByKey = {};
  if (existsSync(logPath)) {
    try {
      const lines = readFileSync(logPath, 'utf8').trim().split('\n').slice(-500);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (!e.id || !e.level) continue;
          const key = `${e.id}::${e.level}`;
          const t = new Date(e.ts).getTime();
          if (!Number.isFinite(t)) continue;
          if (!recentByKey[key] || t > recentByKey[key]) recentByKey[key] = t;
        } catch (_) { /* skip malformed line */ }
      }
    } catch (e) {
      console.warn(`  ⚠ 로그 tail 읽기 실패: ${e.message} — append만 진행`);
    }
  } else {
    // logs 디렉토리 보장
    try { mkdirSync(dirname(logPath), { recursive: true }); } catch (_) {}
  }

  // 2. ALERT/WATCH 만 + dedup 통과한 이벤트 append
  const toAppend = [];
  for (const s of signals) {
    if (s.level === 'NORMAL') continue;
    const key = `${s.id}::${s.level}`;
    const lastTs = recentByKey[key];
    if (lastTs && (nowMs - lastTs) < DEDUP_WINDOW_MS) continue;

    toAppend.push({
      ts:              new Date().toISOString(),
      id:              s.id,
      label:           s.label,
      category:        s.category,
      level:           s.level,
      price:           s.price,
      dailyChangePct:  s.dailyChangePct,
      weeklyChangePct: s.weeklyChangePct,
      reasons:         s.reasons || [],
      // 칼리브레이션용 빈 필드 (사람이 채움)
      label_outcome:   null,    // "signal" | "noise" | "missed-context" | null
      content_link:    null,    // 콘텐츠化 했을 경우 URL/path
      note:            null,    // 자유 메모
    });
  }

  if (toAppend.length === 0) {
    console.log(`📒 이벤트 로그: 새 항목 없음 (4h dedup 윈도우)`);
    return;
  }

  try {
    const block = toAppend.map(e => JSON.stringify(e)).join('\n') + '\n';
    appendFileSync(logPath, block);
    console.log(`📒 이벤트 로그: ${toAppend.length}건 신규 append → ${logPath}`);
    for (const e of toAppend) {
      console.log(`   + ${e.ts.slice(0,16)} ${e.id} [${e.level}] ${e.reasons.join(' / ')}`);
    }
  } catch (e) {
    console.error(`  ✗ 이벤트 로그 append 실패: ${e.message}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

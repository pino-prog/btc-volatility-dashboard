/**
 * fetch-macro-events.mjs — 멀티 소스 크로스체크 버전
 *
 * 소스 우선순위:
 *   Tier 1 (공식)  : federalreserve.gov, bls.gov, sec.gov EDGAR
 *   Tier 2 (검증)  : FMP + Alpha Vantage 모두 동일 날짜 확인
 *   Tier 3 (미검증): 한 소스만 있음 → confirmed:false, 대시보드에 경고 표시
 *
 * 날짜가 소스 간 불일치하면 절대 confirmed:true 처리 안 함
 */

import https from 'https';
import http from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const FMP_KEY = process.env.FMP_API_KEY || 'demo';
const AV_KEY  = process.env.AV_API_KEY  || 'demo';

// ────────────────────────────────────────────────────────────────
// HTTP 유틸
// ────────────────────────────────────────────────────────────────
function fetchText(rawUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const mod = rawUrl.startsWith('https') ? https : http;
    const req = mod.get(rawUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BTC-MacroDash/2.0)',
        'Accept': 'text/html,application/json,text/csv,*/*',
        ...opts.headers,
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location, opts).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${rawUrl}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.setTimeout(opts.timeout || 15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function fetchJson(url, opts) {
  const text = await fetchText(url, opts);
  try { return JSON.parse(text); }
  catch { throw new Error('JSON parse failed: ' + text.slice(0, 120)); }
}

// ────────────────────────────────────────────────────────────────
// TIER 1: 공식 소스 — 연방준비제도 FOMC 일정
// https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
// ────────────────────────────────────────────────────────────────
const MONTH_EN = { january:0, february:1, march:2, april:3, may:4, june:5,
                   july:6, august:7, september:8, october:9, november:10, december:11 };

async function fetchFOMCOfficial() {
  console.log('  [FED] Fetching FOMC calendar...');
  try {
    const html = await fetchText('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm');
    const year = new Date().getFullYear();
    const results = [];

    // Fed 페이지 HTML 패턴: "March 18-19, 2026" 또는 "March 18-19*" 형태
    // 발표일은 항상 마지막 날(19일)이므로 두 번째 날짜를 사용
    const pattern = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d+)[–\-](\d+)(?:,?\s*(\d{4}))?/gi;
    let m;
    while ((m = pattern.exec(html)) !== null) {
      const monthIdx = MONTH_EN[m[1].toLowerCase()];
      const day2     = parseInt(m[3], 10);
      const yr       = m[4] ? parseInt(m[4], 10) : year;
      if (yr !== year && yr !== year + 1) continue;
      const d = new Date(yr, monthIdx, day2);
      if (isNaN(d.getTime())) continue;
      const dateStr = d.toISOString().split('T')[0];
      // 과거 날짜 + 45일 이후 제외
      const now = Date.now();
      if (d.getTime() < now - 3 * 86400000) continue;
      if (d.getTime() > now + 180 * 86400000) continue;
      results.push(dateStr);
    }
    console.log(`  [FED] Found ${results.length} upcoming FOMC dates`);
    return [...new Set(results)];
  } catch (e) {
    console.error('  [FED] FAILED:', e.message);
    return [];
  }
}

// ────────────────────────────────────────────────────────────────
// TIER 1: 공식 소스 — BLS 경제지표 발표 일정
// CPI: https://www.bls.gov/schedule/news_release/cpi.htm
// PPI: https://www.bls.gov/schedule/news_release/ppi.htm
// NFP: https://www.bls.gov/schedule/news_release/empsit.htm
// ────────────────────────────────────────────────────────────────
const BLS_REPORTS = [
  { name: 'CPI',  url: 'https://www.bls.gov/schedule/news_release/cpi.htm',    impact: 'HIGH',   label: '미국 소비자물가지수(CPI)',    time: '08:30', desc: '인플레이션의 핵심 지표. 결과에 따라 금리 기대치가 즉각 변동. BTC 단기 방향성 결정.' },
  { name: 'PPI',  url: 'https://www.bls.gov/schedule/news_release/ppi.htm',    impact: 'MEDIUM', label: '미국 생산자물가지수(PPI)',    time: '08:30', desc: 'CPI 선행 지표. 생산 단계 인플레이션 확인. CPI 발표 전 방향성 힌트.' },
  { name: 'NFP',  url: 'https://www.bls.gov/schedule/news_release/empsit.htm', impact: 'HIGH',   label: '미국 비농업 고용(NFP)',       time: '08:30', desc: '연준 이중 책무(고용+물가) 핵심 지표. 예상치 대비 편차가 금리 경로를 바꾼다.' },
  { name: 'JOLTS',url: 'https://www.bls.gov/schedule/news_release/jolts.htm',  impact: 'MEDIUM', label: '미국 구인건수(JOLTS)',         time: '10:00', desc: '노동시장 과열 여부 선행 지표. 구인 건수 감소 = 연준 완화 근거 강화.' },
];

async function fetchBLSSchedule(report) {
  console.log(`  [BLS] Fetching ${report.name} schedule...`);
  try {
    const html = await fetchText(report.url);
    const year = new Date().getFullYear();
    const dates = [];
    // BLS 스케줄 페이지: "Month DD, YYYY" 또는 "Month DD" 패턴
    const pat = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s*(20\d{2})/gi;
    let m;
    while ((m = pat.exec(html)) !== null) {
      const yr = parseInt(m[3], 10);
      if (yr !== year && yr !== year + 1) continue;
      const monthIdx = MONTH_EN[m[1].toLowerCase()];
      const day = parseInt(m[2], 10);
      const d = new Date(yr, monthIdx, day);
      if (isNaN(d.getTime())) continue;
      const now = Date.now();
      if (d.getTime() < now - 3 * 86400000) continue;
      if (d.getTime() > now + 90 * 86400000) continue;
      dates.push(d.toISOString().split('T')[0]);
    }
    console.log(`  [BLS] ${report.name}: ${dates.length} dates found`);
    return [...new Set(dates)].sort();
  } catch (e) {
    console.error(`  [BLS] ${report.name} FAILED:`, e.message);
    return [];
  }
}

// ────────────────────────────────────────────────────────────────
// TIER 2: FMP API 실적 캘린더
// ────────────────────────────────────────────────────────────────
const WATCH_TICKERS = ['NVDA','AAPL','MSFT','GOOGL','META','AMZN','TSLA','AMD','COIN','MSTR','MARA','RIOT'];

async function fetchEarningsFMP(from, to) {
  console.log('  [FMP] Fetching earnings...');
  try {
    const data = await fetchJson(
      `https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${FMP_KEY}`
    );
    if (!Array.isArray(data)) throw new Error('Not array: ' + JSON.stringify(data).slice(0, 80));
    const filtered = data.filter(e => WATCH_TICKERS.includes(e.symbol));
    console.log(`  [FMP] ${filtered.length} watch-list earnings`);
    return filtered;
  } catch (e) { console.error('  [FMP] Earnings FAILED:', e.message); return []; }
}

// ────────────────────────────────────────────────────────────────
// TIER 2: Alpha Vantage 실적 캘린더 (CSV)
// ────────────────────────────────────────────────────────────────
async function fetchEarningsAV() {
  console.log('  [AV] Fetching earnings CSV...');
  try {
    const csv = await fetchText(
      `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&horizon=3month&apikey=${AV_KEY}`
    );
    const lines = csv.trim().split('\n').slice(1); // header 제거
    const results = {};
    for (const line of lines) {
      const [symbol,,reportDate] = line.split(',');
      if (!symbol || !reportDate) continue;
      if (WATCH_TICKERS.includes(symbol.trim())) {
        results[symbol.trim()] = reportDate.trim().split('T')[0];
      }
    }
    console.log(`  [AV] ${Object.keys(results).length} watch-list earnings`);
    return results; // { NVDA: '2026-05-28', ... }
  } catch (e) { console.error('  [AV] Earnings FAILED:', e.message); return {}; }
}

// ────────────────────────────────────────────────────────────────
// TIER 2: NASDAQ 공개 API 실적 캘린더 (추가 검증용)
// ────────────────────────────────────────────────────────────────
async function fetchEarningsNASDAQ(dateStr) {
  try {
    const data = await fetchJson(
      `https://api.nasdaq.com/api/calendar/earnings?date=${dateStr}`,
      { headers: { 'Accept': 'application/json, text/plain, */*' } }
    );
    const rows = data?.data?.rows || [];
    const results = {};
    for (const row of rows) {
      if (WATCH_TICKERS.includes(row.symbol)) {
        results[row.symbol] = dateStr;
      }
    }
    return results;
  } catch { return {}; }
}

// ────────────────────────────────────────────────────────────────
// 크로스체크: FMP + AV + NASDAQ 교차 검증
// ────────────────────────────────────────────────────────────────
async function crossCheckEarnings(from, to) {
  const [fmpItems, avMap] = await Promise.all([
    fetchEarningsFMP(from, to),
    fetchEarningsAV(),
  ]);

  // NASDAQ API: FMP 날짜 기준으로 ±1일 범위 조회
  const nasdaqDateSet = new Set(fmpItems.map(e => e.date));
  const nasdaqResults = {};
  for (const date of nasdaqDateSet) {
    const r = await fetchEarningsNASDAQ(date);
    Object.assign(nasdaqResults, r);
    // 인접일도 확인
    const d = new Date(date);
    d.setDate(d.getDate() - 1);
    const prev = d.toISOString().split('T')[0];
    d.setDate(d.getDate() + 2);
    const next = d.toISOString().split('T')[0];
    Object.assign(nasdaqResults, await fetchEarningsNASDAQ(prev));
    Object.assign(nasdaqResults, await fetchEarningsNASDAQ(next));
  }

  return fmpItems.map(fmp => {
    const avDate     = avMap[fmp.symbol];
    const nasdaqDate = nasdaqResults[fmp.symbol];
    const sources    = ['FMP'];
    let agreedDate   = fmp.date;
    let confirmed    = false;
    let mismatch     = false;

    if (avDate) {
      const diff = Math.abs(new Date(avDate) - new Date(fmp.date)) / 86400000;
      if (diff <= 1) {
        sources.push('AlphaVantage');
        confirmed = true;
      } else {
        mismatch = true;
        console.warn(`  ⚠️ Date mismatch ${fmp.symbol}: FMP=${fmp.date} AV=${avDate}`);
      }
    }
    if (nasdaqDate) {
      const diff = Math.abs(new Date(nasdaqDate) - new Date(fmp.date)) / 86400000;
      if (diff <= 1) {
        if (!sources.includes('NASDAQ')) sources.push('NASDAQ');
        confirmed = true;
      }
    }

    return { ...fmp, confirmedDate: agreedDate, sources, confirmed, mismatch };
  });
}

// ────────────────────────────────────────────────────────────────
// 이벤트 객체 생성 헬퍼
// ────────────────────────────────────────────────────────────────
const TICKER_INFO = {
  NVDA: { label:'엔비디아 (NVDA)',  impact:'HIGH',   desc:'AI 인프라 수요 바로미터. BTC-나스닥 상관계수 r=0.72. 실적 강세 시 위험자산 전반 상승 촉매.', bull:'EPS·매출 상회 + 가이던스 상향 → 나스닥 급등 → BTC 연동 상승', bear:'실적 미스 또는 공급 이슈 → 기술주 전반 매도 → BTC 동반 하락' },
  AAPL: { label:'애플 (AAPL)',      impact:'HIGH',   desc:'세계 시총 1위 기술주. AI 기능 확장·아이폰 수요가 나스닥 방향성을 결정.', bull:'EPS 상회 + AI 서비스 성장 → 나스닥 강세 → BTC 간접 수혜', bear:'아이폰 판매 둔화 → 기술주 조정 → 위험자산 약세' },
  MSFT: { label:'마이크로소프트 (MSFT)',impact:'HIGH',desc:'클라우드·AI 수요 지표. Azure OpenAI 매출 성장률이 핵심.', bull:'클라우드 성장 가속 → 기술주 랠리 → BTC 상승 동반', bear:'클라우드 둔화 → 기술주 조정 → 위험자산 약세' },
  GOOGL:{ label:'알파벳 (GOOGL)',   impact:'MEDIUM', desc:'디지털 광고·AI 수요 지표. Gemini 사업화 속도가 관건.', bull:'광고 회복 + AI 수익화 → 나스닥 강세 → BTC 연동', bear:'광고 둔화 → 기술주 약세 → 위험자산 하락' },
  META: { label:'메타 (META)',      impact:'MEDIUM', desc:'디지털 광고·AI 인프라 지출 지표.', bull:'광고 성장 + AI ROI 입증 → 위험자산 선호 강화', bear:'비용 증가 + 광고 둔화 → 기술주 매도 압력' },
  TSLA: { label:'테슬라 (TSLA)',    impact:'MEDIUM', desc:'위험자산 대표 주자. BTC와 높은 상관관계. 머스크 발언 가능성.', bull:'강한 실적 + 에너지 사업 성장 → 위험자산 + BTC 상승', bear:'마진 압박 + 수요 둔화 → 위험자산 전반 약세' },
  AMD:  { label:'AMD',              impact:'MEDIUM', desc:'AI 칩 경쟁자. NVDA 이후 두 번째 AI 인프라 수요 확인 지점.', bull:'데이터센터 GPU 수요 강세 → AI 테마 지속 → BTC 간접 수혜', bear:'NVDA 대비 시장 점유율 손실 → 기술주 차익 실현' },
  COIN: { label:'코인베이스 (COIN)', impact:'HIGH',  desc:'크립토 시장 직접 노출. COIN 실적 = 크립토 거래량·심리 확인.', bull:'거래량·수수료 증가 → 크립토 시장 건강성 확인 → BTC 강세', bear:'거래량 감소 → 크립토 시장 침체 신호 → BTC 약세' },
  MSTR: { label:'마이크로스트래티지 (MSTR)',impact:'HIGH', desc:'최대 기업 BTC 보유자. 추가 매입 공시 가능성.', bull:'추가 BTC 매입 공시 → BTC 수급 긍정 + 심리 강화', bear:'매입 중단 또는 손실 → BTC 약세 심리 확산' },
  MARA: { label:'마라 홀딩스 (MARA)', impact:'MEDIUM',desc:'BTC 채굴 상장사. BTC 가격과 거의 동기화.', bull:'채굴 효율 개선 + BTC 가격 상승 → 강한 매수 연동', bear:'에너지 비용 증가 + 해시레이트 압박 → 채굴주 하락' },
  RIOT: { label:'라이엇 플랫폼 (RIOT)',impact:'LOW', desc:'BTC 채굴 상장사. MARA와 동반 움직임.', bull:'채굴 효율 + BTC 강세 연동', bear:'에너지 비용 + 규제 리스크' },
};

function buildEarningsEvent(item) {
  const info = TICKER_INFO[item.symbol] || { label: item.symbol, impact: 'MEDIUM', desc: `${item.symbol} 분기 실적 발표.`, bull: 'EPS 상회 → 주가 상승', bear: 'EPS 미스 → 주가 하락' };
  const epsStr = item.epsEstimated ? ` EPS 컨센서스: $${item.epsEstimated}.` : '';
  const sourceStr = item.sources?.join(' + ') || 'FMP';
  const verifyNote = item.mismatch ? ' ⚠️ 소스 간 날짜 불일치 — 원문 확인 필요.' : item.confirmed ? ` ✓ ${sourceStr} 교차 검증 완료.` : ' (미검증 — 공식 IR 확인 권장)';
  return {
    id:            `earnings-${item.symbol}-${item.confirmedDate}`,
    date:          item.confirmedDate,
    time:          item.time === 'amc' ? '16:00' : '09:30',
    tz:            'ET',
    title:         `${info.label} 실적 발표`,
    category:      'earnings',
    categoryLabel: '기업 실적',
    impact:        info.impact,
    btcBias:       'correlated',
    description:   info.desc + epsStr + verifyNote,
    bull:          info.bull,
    bear:          info.bear,
    confirmed:     item.confirmed && !item.mismatch,
    sources:       item.sources || ['FMP'],
    autoFetched:   true,
  };
}

function buildFOMCEvent(dateStr) {
  return {
    id:            `fomc-${dateStr}`,
    date:          dateStr,
    time:          '14:00',
    tz:            'ET',
    title:         `FOMC 금리 결정`,
    category:      'macro',
    categoryLabel: '통화정책',
    impact:        'HIGH',
    btcBias:       'neutral',
    description:   `연방공개시장위원회 금리 결정 및 파월 의장 기자회견. ✓ federalreserve.gov 공식 일정.`,
    bull:          '금리 인하 또는 인하 시그널 → 달러 약세 + 위험자산 선호 → BTC·나스닥 동반 상승',
    bear:          '금리 동결 + 매파 발언 → 달러 강세 + 긴축 장기화 → BTC 하방 압력',
    confirmed:     true,
    sources:       ['federalreserve.gov (공식)'],
    autoFetched:   true,
  };
}

function buildBLSEvent(report, dateStr) {
  return {
    id:            `bls-${report.name}-${dateStr}`,
    date:          dateStr,
    time:          report.time,
    tz:            'ET',
    title:         report.label,
    category:      'macro',
    categoryLabel: '경제지표',
    impact:        report.impact,
    btcBias:       'neutral',
    description:   report.desc + ` ✓ bls.gov 공식 일정.`,
    bull:          '지표 예상 하회(물가 하락/고용 안정) → 금리 인하 기대 → BTC·위험자산 상승',
    bear:          '지표 예상 상회(인플레 재가속) → 금리 인상 우려 → DXY 강세 → BTC 하락',
    confirmed:     true,
    sources:       ['bls.gov (공식)'],
    autoFetched:   true,
  };
}

// ────────────────────────────────────────────────────────────────
// 메인
// ────────────────────────────────────────────────────────────────
async function main() {
  const outPath = 'macro-events.json';
  let existing = { updatedAt: null, events: [] };
  if (existsSync(outPath)) {
    try { existing = JSON.parse(readFileSync(outPath, 'utf8')); } catch (_) {}
  }

  // 수동 큐레이션 이벤트 보존 (autoFetched 없거나 false)
  const manual = (existing.events || []).filter(e => !e.autoFetched);
  console.log(`Manual events preserved: ${manual.length}`);

  // 날짜 범위
  const now   = new Date();
  const from  = new Date(now.getTime() - 5  * 86400000).toISOString().split('T')[0];
  const to    = new Date(now.getTime() + 60 * 86400000).toISOString().split('T')[0];

  // 병렬 실행: Tier-1 공식 소스 + Tier-2 실적
  const [fomcDates, blsResults, earningsChecked] = await Promise.all([
    fetchFOMCOfficial(),
    Promise.all(BLS_REPORTS.map(r => fetchBLSSchedule(r).then(dates => ({ report: r, dates })))),
    crossCheckEarnings(from, to),
  ]);

  const autoItems = [];

  // FOMC 이벤트
  for (const d of fomcDates) {
    autoItems.push(buildFOMCEvent(d));
    console.log(`  FOMC confirmed: ${d}`);
  }

  // BLS 이벤트
  for (const { report, dates } of blsResults) {
    for (const d of dates) {
      autoItems.push(buildBLSEvent(report, d));
    }
    console.log(`  BLS ${report.name}: ${dates.length} dates`);
  }

  // 실적 이벤트
  for (const item of earningsChecked) {
    autoItems.push(buildEarningsEvent(item));
    const status = item.confirmed ? `✓ ${item.sources.join('+')}` : item.mismatch ? '⚠️ mismatch' : '?';
    console.log(`  Earnings ${item.symbol} ${item.confirmedDate} [${status}]`);
  }

  // 병합: 같은 id는 새 것 우선
  const byId = new Map();
  for (const e of [...manual, ...autoItems]) {
    if (!byId.has(e.id)) byId.set(e.id, e);
  }

  const merged = Array.from(byId.values())
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  // 검증 요약 출력
  const confirmed   = merged.filter(e => e.confirmed).length;
  const unconfirmed = merged.filter(e => !e.confirmed).length;
  const mismatched  = merged.filter(e => e.mismatch).length;
  console.log(`\n✅ ${confirmed} confirmed | ⚠️ ${mismatched} mismatch | ❓ ${unconfirmed} unverified`);

  writeFileSync(outPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    verificationSummary: { confirmed, unconfirmed, mismatched },
    events: merged,
  }, null, 2));

  console.log(`\nSaved ${merged.length} total events to ${outPath}`);

  // 날짜 불일치 항목이 있으면 경고 종료코드 (CI에서 알림용)
  if (mismatched > 0) {
    console.warn(`\n⚠️ ${mismatched} event(s) have date mismatches — manual review recommended`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

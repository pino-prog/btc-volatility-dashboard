/**
 * fetch-macro-events.mjs — 멀티 소스 크로스체크 v3
 *
 * 소스 우선순위:
 *   Tier 1 (공식)  : federalreserve.gov (div 파싱) + BLS 2026 공식 일정 (하드코딩)
 *   Tier 2 (검증)  : Alpha Vantage (실적, CSV) + NASDAQ API 교차 검증
 *   Tier 3 (미검증): 한 소스만 → confirmed:false, 대시보드에 경고 표시
 *
 * BLS 참고: bls.gov가 GitHub Actions IP 차단으로 스크래핑 불가 → 연간 공식 일정 하드코딩
 * FOMC: federalreserve.gov CSS div 구조로 파싱 (텍스트 regex 아님)
 */

import https from 'https';
import http from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const AV_KEY = process.env.AV_API_KEY || 'demo';

// ────────────────────────────────────────────────────────────────
// HTTP 유틸
// ────────────────────────────────────────────────────────────────
function fetchText(rawUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const mod = rawUrl.startsWith('https') ? https : http;
    const req = mod.get(rawUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BTC-MacroDash/3.0)',
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
// TIER 1: 공식 소스 — 연방준비제도 FOMC 일정 (div 클래스 파싱)
// federalreserve.gov 구조:
//   <div class="fomc-meeting__month ..."><strong>June</strong></div>
//   <div class="fomc-meeting__date ...">16-17*</div>
// ────────────────────────────────────────────────────────────────
const MONTH_IDX = {
  january:0, february:1, march:2, april:3, may:4, june:5,
  july:6, august:7, september:8, october:9, november:10, december:11
};

async function fetchFOMCOfficial() {
  console.log('  [FED] Fetching FOMC calendar (div parsing)...');
  try {
    const html = await fetchText('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm');

    // 전체 HTML에서 month/date div 쌍을 순서대로 추출
    // 구조: <div class="fomc-meeting__month..."><strong>June</strong></div>
    //       <div class="fomc-meeting__date...">16-17*</div>
    // 두 regex를 번갈아 적용하는 대신 인터리브 파싱
    const pairRe = /fomc-meeting__(month|date)[^>]*>(?:<strong>)?([^<]+)(?:<\/strong>)?<\//gi;
    const pairs = [];
    let m;
    while ((m = pairRe.exec(html)) !== null) {
      pairs.push({ type: m[1], val: m[2].trim().replace(/\*/g, '') });
    }

    // month 뒤에 date가 오는 쌍으로 묶기
    const schedule = [];
    for (let i = 0; i < pairs.length - 1; i++) {
      if (pairs[i].type === 'month' && pairs[i + 1].type === 'date') {
        schedule.push({ month: pairs[i].val, dateStr: pairs[i + 1].val });
        i++; // date도 소비
      }
    }

    // 연도 추적: 현재 연도부터 시작, 월이 역전되면 +1년
    const startYear = new Date().getFullYear();
    let curYear = startYear;
    let prevMonthIdx = -1;
    const now  = Date.now();
    const results = [];

    for (const { month, dateStr } of schedule) {
      const monthIdx = MONTH_IDX[month.toLowerCase()];
      if (monthIdx === undefined) continue;
      if (monthIdx < prevMonthIdx) curYear++; // 연도 롤오버
      prevMonthIdx = monthIdx;

      // 결정일 = 마지막 날 (예: "16-17" → 17)
      const nums = dateStr.match(/\d+/g);
      if (!nums) continue;
      const day = parseInt(nums[nums.length - 1], 10);
      if (isNaN(day)) continue;

      // 타임존 독립 날짜 문자열 생성 (toISOString은 UTC 변환으로 하루 어긋날 수 있음)
      const isoDate = `${curYear}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const d = new Date(isoDate + 'T12:00:00Z');
      if (isNaN(d.getTime())) continue;
      if (d.getTime() < now - 3 * 86400000) continue;
      if (d.getTime() > now + 540 * 86400000) continue;

      results.push(isoDate);
    }

    const unique = [...new Set(results)].sort();
    console.log(`  [FED] Found ${unique.length} upcoming FOMC dates: ${unique.join(', ')}`);
    return unique;
  } catch (e) {
    console.error('  [FED] FAILED:', e.message);
    return [];
  }
}

// ────────────────────────────────────────────────────────────────
// TIER 1: BLS 공식 일정 (2026 하드코딩 — bls.gov가 GitHub Actions IP 차단)
//
// 출처: BLS Schedule of Releases (https://www.bls.gov/schedule/news_release/)
// 2026년 경제지표 발표 일정 — BLS 연간 공식 스케줄 기준
// CPI: 매월 2번째 수~목요일 08:30 ET
// PPI: CPI 다음날
// NFP: 매월 첫째 금요일 08:30 ET
// JOLTS: NFP 발표 약 4주 후
// ────────────────────────────────────────────────────────────────
const BLS_2026 = {
  CPI:  [
    // 발표월 → 대상 데이터 월
    ['2026-01-14', '12월'], ['2026-02-11', '1월'],  ['2026-03-12', '2월'],
    ['2026-04-10', '3월'],  ['2026-05-13', '4월'],  ['2026-06-10', '5월'],
    ['2026-07-15', '6월'],  ['2026-08-12', '7월'],  ['2026-09-09', '8월'],
    ['2026-10-14', '9월'],  ['2026-11-11', '10월'], ['2026-12-09', '11월'],
  ],
  NFP:  [
    ['2026-01-09', '12월'], ['2026-02-06', '1월'],  ['2026-03-06', '2월'],
    ['2026-04-03', '3월'],  ['2026-05-08', '4월'],  ['2026-06-05', '5월'],
    ['2026-07-10', '6월'],  ['2026-08-07', '7월'],  ['2026-09-04', '8월'],
    ['2026-10-02', '9월'],  ['2026-11-06', '10월'], ['2026-12-04', '11월'],
  ],
  PPI:  [
    ['2026-01-15', '12월'], ['2026-02-12', '1월'],  ['2026-03-13', '2월'],
    ['2026-04-14', '3월'],  ['2026-05-14', '4월'],  ['2026-06-12', '5월'],
    ['2026-07-14', '6월'],  ['2026-08-13', '7월'],  ['2026-09-11', '8월'],
    ['2026-10-15', '9월'],  ['2026-11-13', '10월'], ['2026-12-11', '11월'],
  ],
};

const BLS_META = {
  CPI: {
    impact: 'HIGH', time: '08:30',
    title:  (mon) => `미국 CPI (${mon}) 발표`,
    category: 'macro', categoryLabel: '경제지표',
    btcBias: 'neutral',
    desc:   (mon) => `${mon} 소비자물가지수. 연준 금리 결정의 핵심 선행 지표. 컨센서스 대비 편차가 BTC·위험자산 단기 방향성을 결정.`,
    bull:   'CPI 하회 → 인플레 진정 → 금리 인하 기대 상승 → BTC·위험자산 상승',
    bear:   'CPI 상회 → 인플레 재가속 → 금리 인하 지연 → DXY 강세 → BTC 하락',
  },
  NFP: {
    impact: 'HIGH', time: '08:30',
    title:  (mon) => `미국 NFP (${mon}) 발표`,
    category: 'macro', categoryLabel: '경제지표',
    btcBias: 'neutral',
    desc:   (mon) => `${mon} 비농업 고용지수. 연준 이중 책무(고용+물가) 핵심 지표. 예상치 대비 편차가 금리 경로를 바꾼다.`,
    bull:   '예상 하회 → 고용 둔화 → 금리 인하 근거 강화 → BTC 상승 촉매',
    bear:   '예상 상회 → 과열 고용 → 금리 인하 지연 → 달러 강세 → BTC 하방 압력',
  },
  PPI: {
    impact: 'MEDIUM', time: '08:30',
    title:  (mon) => `미국 PPI (${mon}) 발표`,
    category: 'macro', categoryLabel: '경제지표',
    btcBias: 'neutral',
    desc:   (mon) => `${mon} 생산자물가지수. CPI 선행 지표. 생산 단계 인플레이션 확인. CPI 발표 전 방향성 힌트.`,
    bull:   '예상 하회 → 생산자 비용 안정 → CPI 하락 전망 강화 → BTC 간접 수혜',
    bear:   '예상 상회 → 생산 단계 인플레 → 향후 CPI 상승 우려 → 위험자산 경계',
  },
};

function getBLSEvents(now) {
  const events = [];
  const nowMs  = now.getTime();
  const future = nowMs + 75 * 86400000; // 75일 이내

  for (const [type, schedule] of Object.entries(BLS_2026)) {
    const meta = BLS_META[type];
    for (const [dateStr, mon] of schedule) {
      const d = new Date(dateStr);
      if (d.getTime() < nowMs - 2 * 86400000) continue; // 이미 지난 것
      if (d.getTime() > future) continue;
      events.push({
        id:            `bls-${type.toLowerCase()}-${dateStr}`,
        date:          dateStr,
        time:          meta.time,
        tz:            'ET',
        title:         meta.title(mon),
        category:      meta.category,
        categoryLabel: meta.categoryLabel,
        impact:        meta.impact,
        btcBias:       meta.btcBias,
        description:   meta.desc(mon) + ' ✓ BLS 2026 공식 일정.',
        bull:          meta.bull,
        bear:          meta.bear,
        confirmed:     true,
        sources:       ['bls.gov 2026 공식 일정'],
        autoFetched:   true,
      });
    }
  }
  return events;
}

// ────────────────────────────────────────────────────────────────
// TIER 2: Alpha Vantage 실적 캘린더 (CSV)
// ────────────────────────────────────────────────────────────────
const WATCH_TICKERS = ['NVDA','AAPL','MSFT','GOOGL','META','AMZN','TSLA','AMD','COIN','MSTR','MARA','RIOT'];

async function fetchEarningsAV() {
  console.log('  [AV] Fetching earnings CSV...');
  try {
    const csv = await fetchText(
      `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&horizon=3month&apikey=${AV_KEY}`
    );
    const lines = csv.trim().split('\n').slice(1);
    const results = {};
    for (const line of lines) {
      const [symbol,,reportDate] = line.split(',');
      if (!symbol || !reportDate) continue;
      if (WATCH_TICKERS.includes(symbol.trim())) {
        results[symbol.trim()] = reportDate.trim().split('T')[0];
      }
    }
    console.log(`  [AV] ${Object.keys(results).length} watch-list earnings: ${JSON.stringify(results)}`);
    return results;
  } catch (e) { console.error('  [AV] Earnings FAILED:', e.message); return {}; }
}

// TIER 2: NASDAQ 공개 API 실적 검증
async function fetchEarningsNASDAQ(dateStr) {
  try {
    const data = await fetchJson(
      `https://api.nasdaq.com/api/calendar/earnings?date=${dateStr}`,
      { headers: { 'Accept': 'application/json, text/plain, */*' } }
    );
    const rows = data?.data?.rows || [];
    const results = {};
    for (const row of rows) {
      if (WATCH_TICKERS.includes(row.symbol)) results[row.symbol] = dateStr;
    }
    return results;
  } catch { return {}; }
}

// ────────────────────────────────────────────────────────────────
// 실적 크로스체크: AV + NASDAQ
// ────────────────────────────────────────────────────────────────
const TICKER_INFO = {
  NVDA: { label:'엔비디아 (NVDA)',  impact:'HIGH',   desc:'AI 인프라 수요 바로미터. BTC-나스닥 상관계수 r=0.72. 실적 강세 시 위험자산 전반 상승 촉매.', bull:'EPS·매출 상회 + 가이던스 상향 → 나스닥 급등 → BTC 연동 상승', bear:'실적 미스 또는 공급 이슈 → 기술주 전반 매도 → BTC 동반 하락' },
  AAPL: { label:'애플 (AAPL)',      impact:'HIGH',   desc:'세계 시총 1위 기술주. AI 기능 확장·아이폰 수요가 나스닥 방향성을 결정.', bull:'EPS 상회 + AI 서비스 성장 → 나스닥 강세 → BTC 간접 수혜', bear:'아이폰 판매 둔화 → 기술주 조정 → 위험자산 약세' },
  MSFT: { label:'마이크로소프트 (MSFT)', impact:'HIGH', desc:'클라우드·AI 수요 지표. Azure OpenAI 매출 성장률이 핵심.', bull:'클라우드 성장 가속 → 기술주 랠리 → BTC 상승 동반', bear:'클라우드 둔화 → 기술주 조정 → 위험자산 약세' },
  GOOGL:{ label:'알파벳 (GOOGL)',   impact:'MEDIUM', desc:'디지털 광고·AI 수요 지표. Gemini 사업화 속도가 관건.', bull:'광고 회복 + AI 수익화 → 나스닥 강세 → BTC 연동', bear:'광고 둔화 → 기술주 약세 → 위험자산 하락' },
  META: { label:'메타 (META)',      impact:'MEDIUM', desc:'디지털 광고·AI 인프라 지출 지표.', bull:'광고 성장 + AI ROI 입증 → 위험자산 선호 강화', bear:'비용 증가 + 광고 둔화 → 기술주 매도 압력' },
  TSLA: { label:'테슬라 (TSLA)',    impact:'MEDIUM', desc:'위험자산 대표 주자. BTC와 높은 상관관계.', bull:'강한 실적 + 에너지 사업 성장 → 위험자산 + BTC 상승', bear:'마진 압박 + 수요 둔화 → 위험자산 전반 약세' },
  AMD:  { label:'AMD',              impact:'MEDIUM', desc:'AI 칩 경쟁자. NVDA 이후 두 번째 AI 인프라 수요 확인 지점.', bull:'데이터센터 GPU 수요 강세 → AI 테마 지속 → BTC 간접 수혜', bear:'NVDA 대비 시장 점유율 손실 → 기술주 차익 실현' },
  COIN: { label:'코인베이스 (COIN)', impact:'HIGH',  desc:'크립토 시장 직접 노출. COIN 실적 = 크립토 거래량·심리 확인.', bull:'거래량·수수료 증가 → 크립토 시장 건강성 확인 → BTC 강세', bear:'거래량 감소 → 크립토 시장 침체 신호 → BTC 약세' },
  MSTR: { label:'마이크로스트래티지 (MSTR)', impact:'HIGH', desc:'최대 기업 BTC 보유자. 추가 매입 공시 가능성.', bull:'추가 BTC 매입 공시 → BTC 수급 긍정 + 심리 강화', bear:'매입 중단 또는 손실 → BTC 약세 심리 확산' },
  MARA: { label:'마라 홀딩스 (MARA)', impact:'MEDIUM', desc:'BTC 채굴 상장사. BTC 가격과 거의 동기화.', bull:'채굴 효율 개선 + BTC 가격 상승 → 강한 매수 연동', bear:'에너지 비용 증가 + 해시레이트 압박 → 채굴주 하락' },
  RIOT: { label:'라이엇 플랫폼 (RIOT)', impact:'LOW', desc:'BTC 채굴 상장사. MARA와 동반 움직임.', bull:'채굴 효율 + BTC 강세 연동', bear:'에너지 비용 + 규제 리스크' },
};

async function crossCheckEarnings(avMap) {
  const results = [];
  for (const [symbol, avDate] of Object.entries(avMap)) {
    const nasdaqOnDay   = await fetchEarningsNASDAQ(avDate);
    const d = new Date(avDate);
    d.setDate(d.getDate() - 1); const prev = d.toISOString().split('T')[0];
    d.setDate(d.getDate() + 2); const next = d.toISOString().split('T')[0];
    const nasdaqPrev    = await fetchEarningsNASDAQ(prev);
    const nasdaqNext    = await fetchEarningsNASDAQ(next);

    const nasdaqDate = nasdaqOnDay[symbol] || nasdaqPrev[symbol] || nasdaqNext[symbol] || null;
    const sources    = ['AlphaVantage'];
    let confirmed    = false;
    let mismatch     = false;
    let finalDate    = avDate;

    if (nasdaqDate) {
      const diff = Math.abs(new Date(nasdaqDate) - new Date(avDate)) / 86400000;
      if (diff <= 1) {
        sources.push('NASDAQ');
        confirmed = true;
        if (diff > 0) {
          console.log(`  [AV+NASDAQ] ${symbol}: AV=${avDate} NASDAQ=${nasdaqDate} (±1일, confirmed)`);
        }
      } else {
        mismatch = true;
        console.warn(`  ⚠️ MISMATCH ${symbol}: AV=${avDate} NASDAQ=${nasdaqDate}`);
      }
    } else {
      // AV만 있음 → 미확정
    }

    results.push({ symbol, date: finalDate, sources, confirmed, mismatch });
  }
  return results;
}

function buildEarningsEvent(item) {
  const info = TICKER_INFO[item.symbol] || {
    label: item.symbol, impact:'MEDIUM',
    desc:`${item.symbol} 분기 실적 발표.`,
    bull:'EPS 상회 → 주가 상승', bear:'EPS 미스 → 주가 하락',
  };
  const srcStr    = item.sources.join(' + ');
  const verifyNote = item.mismatch
    ? ' ⚠️ 소스 간 날짜 불일치 — 공식 IR 페이지 확인 필요.'
    : item.confirmed ? ` ✓ ${srcStr} 교차 검증 완료.` : ' (단일 소스 — 공식 IR 확인 권장)';
  return {
    id:            `earnings-${item.symbol}-${item.date}`,
    date:          item.date,
    time:          '16:00',
    tz:            'ET',
    title:         `${info.label} 실적 발표`,
    category:      'earnings',
    categoryLabel: '기업 실적',
    impact:        info.impact,
    btcBias:       'correlated',
    description:   info.desc + verifyNote,
    bull:          info.bull,
    bear:          info.bear,
    confirmed:     item.confirmed && !item.mismatch,
    sources:       item.sources,
    mismatch:      item.mismatch || false,
    autoFetched:   true,
  };
}

// ────────────────────────────────────────────────────────────────
// 수동 이벤트와 자동 이벤트 매칭 → 날짜 검증
// ────────────────────────────────────────────────────────────────
function verifyManualEvents(manual, autoItems) {
  const verified = manual.map(ev => {
    const evDate = new Date(ev.date).getTime();
    // 카테고리 + 날짜 ±1일로 매칭
    for (const auto of autoItems) {
      if (auto.category !== ev.category) continue;
      const diff = Math.abs(new Date(auto.date).getTime() - evDate) / 86400000;
      if (diff > 1) continue;

      // 제목 키워드 일치 확인 (FOMC vs CPI 혼용 방지)
      const evTitle   = ev.title.toUpperCase();
      const autoTitle = auto.title.toUpperCase();
      const keywords  = ['FOMC', 'CPI', 'NFP', 'PPI', 'JOLTS', 'FOMC'];
      let titleMatch  = true;
      for (const kw of keywords) {
        if ((evTitle.includes(kw)) !== (autoTitle.includes(kw))) {
          titleMatch = false; break;
        }
      }
      if (!titleMatch) continue;

      if (diff === 0) {
        // 정확히 일치 → confirmed
        console.log(`  ✓ Manual verified: ${ev.id} (matched ${auto.id}) — sources: ${auto.sources.join(', ')}`);
        return { ...ev, confirmed: true, sources: auto.sources };
      } else {
        // ±1일 불일치 → mismatch 플래그
        console.warn(`  ⚠️ Manual date mismatch: ${ev.id} says ${ev.date}, auto says ${auto.date}`);
        return { ...ev, mismatch: true, sources: [...(ev.sources || []), ...auto.sources],
                 _autoDate: auto.date };
      }
    }
    return ev; // 매칭 없음 — 그대로 유지
  });
  return verified;
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

  // 수동 큐레이션 이벤트 보존
  const manual = (existing.events || []).filter(e => !e.autoFetched);
  console.log(`Manual events preserved: ${manual.length}`);

  const now  = new Date();
  const from = new Date(now.getTime() - 5  * 86400000).toISOString().split('T')[0];
  const to   = new Date(now.getTime() + 75 * 86400000).toISOString().split('T')[0];

  // 병렬: FOMC (공식 파싱) + BLS (하드코딩) + AV 실적
  const [fomcDates, avMap] = await Promise.all([
    fetchFOMCOfficial(),
    fetchEarningsAV(),
  ]);

  const autoItems = [];

  // FOMC 이벤트
  for (const d of fomcDates) {
    autoItems.push({
      id:            `fomc-${d}`,
      date:          d,
      time:          '14:00',
      tz:            'ET',
      title:         'FOMC 금리 결정',
      category:      'macro',
      categoryLabel: '통화정책',
      impact:        'HIGH',
      btcBias:       'neutral',
      description:   '연방공개시장위원회 금리 결정 및 파월 의장 기자회견. ✓ federalreserve.gov 공식 일정.',
      bull:          '금리 인하 또는 인하 시그널 → 달러 약세 + 위험자산 선호 → BTC·나스닥 동반 상승',
      bear:          '금리 동결 + 매파 발언 → 달러 강세 + 긴축 장기화 → BTC 하방 압력',
      confirmed:     true,
      sources:       ['federalreserve.gov (공식)'],
      autoFetched:   true,
    });
    console.log(`  FOMC confirmed: ${d}`);
  }

  // BLS 이벤트 (hardcoded 2026 schedule)
  const blsEvents = getBLSEvents(now);
  autoItems.push(...blsEvents);
  console.log(`  BLS: ${blsEvents.length} events from 2026 official schedule`);

  // 실적 크로스체크 (AV + NASDAQ)
  const earningsChecked = await crossCheckEarnings(avMap);
  for (const item of earningsChecked) {
    autoItems.push(buildEarningsEvent(item));
    const status = item.mismatch ? `⚠️ mismatch` : item.confirmed ? `✓ ${item.sources.join('+')}` : `? (AV only)`;
    console.log(`  Earnings ${item.symbol} ${item.date} [${status}]`);
  }

  // 수동 이벤트를 자동 이벤트와 대조 검증
  const verifiedManual = verifyManualEvents(manual, autoItems);

  // 병합: manual(검증된) + auto
  // 같은 날짜·같은 카테고리의 manual과 auto가 겹치면 manual(사용자 설명) 우선
  const manualDates = new Set(verifiedManual.map(e => `${e.category}::${e.date}`));
  const dedupedAuto = autoItems.filter(a => !manualDates.has(`${a.category}::${a.date}`));

  const merged = [...verifiedManual, ...dedupedAuto]
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const confirmed   = merged.filter(e => e.confirmed && !e.mismatch).length;
  const mismatched  = merged.filter(e => e.mismatch).length;
  const unconfirmed = merged.filter(e => !e.confirmed && !e.mismatch).length;

  console.log(`\n✅ ${confirmed} confirmed | ⚠️ ${mismatched} mismatch | ❓ ${unconfirmed} unverified`);

  writeFileSync(outPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    verificationSummary: { confirmed, unconfirmed, mismatched },
    events: merged,
  }, null, 2));

  console.log(`\nSaved ${merged.length} total events to ${outPath}`);

  if (mismatched > 0) {
    console.warn(`\n⚠️ ${mismatched} event(s) have date mismatches — manual review recommended`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

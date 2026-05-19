/**
 * fetch-macro-events.mjs
 * Financial Modeling Prep 무료 API로 실적·경제 캘린더 자동 수집 후
 * 수동 큐레이션 이벤트(crypto-law, geopolitical)와 병합
 * → macro-events.json 업데이트
 *
 * 환경변수: FMP_API_KEY (없으면 demo 키 사용, 하루 250 req 제한)
 */

import https from 'https';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const FMP_KEY = process.env.FMP_API_KEY || 'demo';

// BTC에 영향 높은 티커
const WATCH_TICKERS = new Set([
  'NVDA','AAPL','MSFT','GOOGL','META','AMZN','TSLA','AMD','INTC','AVGO',
  'COIN','MSTR','MARA','RIOT','CLSK',
]);

// 경제 지표 → 영향 매핑
const ECON_MAP = {
  'Federal Funds Rate':          { impact:'HIGH',   bias:'neutral',   cat:'통화정책',   label:'FOMC 금리 결정' },
  'CPI':                         { impact:'HIGH',   bias:'neutral',   cat:'경제지표',   label:'소비자물가지수(CPI)' },
  'Core CPI':                    { impact:'HIGH',   bias:'neutral',   cat:'경제지표',   label:'근원 CPI' },
  'PPI':                         { impact:'MEDIUM', bias:'neutral',   cat:'경제지표',   label:'생산자물가지수(PPI)' },
  'Nonfarm Payrolls':            { impact:'HIGH',   bias:'neutral',   cat:'경제지표',   label:'비농업 고용(NFP)' },
  'Unemployment Rate':           { impact:'MEDIUM', bias:'neutral',   cat:'경제지표',   label:'실업률' },
  'GDP':                         { impact:'MEDIUM', bias:'neutral',   cat:'경제지표',   label:'GDP 성장률' },
  'Initial Jobless Claims':      { impact:'LOW',    bias:'neutral',   cat:'경제지표',   label:'신규 실업수당 청구' },
  'Retail Sales':                { impact:'MEDIUM', bias:'neutral',   cat:'경제지표',   label:'소매판매' },
  'PCE':                         { impact:'HIGH',   bias:'neutral',   cat:'경제지표',   label:'PCE 물가지수' },
  'Core PCE':                    { impact:'HIGH',   bias:'neutral',   cat:'경제지표',   label:'근원 PCE' },
  'JOLTS':                       { impact:'LOW',    bias:'neutral',   cat:'경제지표',   label:'JOLTS 구인 건수' },
  'ISM Manufacturing':           { impact:'LOW',    bias:'neutral',   cat:'경제지표',   label:'ISM 제조업 PMI' },
  'Consumer Confidence':         { impact:'LOW',    bias:'neutral',   cat:'경제지표',   label:'소비자신뢰지수' },
};

// 티커별 BTC 영향 설명 생성
const TICKER_BIAS = {
  NVDA: { desc:'AI 인프라 수요 바로미터. BTC-나스닥 상관계수 r=0.72. NVDA 실적 강세 시 위험자산 전반 상승.', bull:'EPS 상회 + 강한 가이던스 → 나스닥 급등 → BTC 연동 상승', bear:'실적 미스 또는 공급망 이슈 → 기술주 전반 매도 → BTC 동반 하락' },
  AAPL: { desc:'기술주 심리 지표. 세계 시총 1위. AI 기능 통합 여부가 관건.', bull:'EPS 상회 + AI 서비스 성장 → 나스닥 강세 → BTC 간접 수혜', bear:'아이폰 판매 둔화 → 기술주 조정 → BTC 소폭 연동 하락' },
  MSFT: { desc:'클라우드·AI 수요 지표. Azure OpenAI 매출 성장률이 핵심.', bull:'클라우드 성장 가속 → 기술주 랠리 → BTC 상승 동반', bear:'클라우드 성장 둔화 → 기술주 조정 → 위험자산 약세' },
  GOOGL:{ desc:'디지털 광고·AI 수요 지표. Gemini 사업화 속도가 관건.', bull:'광고 회복 + AI 수익화 → 나스닥 강세 → BTC 연동', bear:'광고 시장 둔화 → 기술주 약세 → 위험자산 전반 하락' },
  META: { desc:'디지털 광고·AI 투자. 메타버스·AI 인프라 지출 규모 주목.', bull:'광고 성장 + AI ROI 입증 → 위험자산 선호 강화', bear:'비용 증가 + 광고 둔화 → 기술주 매도 압력' },
  TSLA: { desc:'위험자산 대표 주자. BTC와 높은 상관관계. 머스크 BTC 발언 가능성.', bull:'실적 강세 + 에너지 사업 성장 → 위험자산 선호 + BTC 상승', bear:'마진 압박 + 수요 둔화 → 위험자산 전반 약세' },
  COIN: { desc:'크립토 시장 직접 노출. COIN 실적 = 크립토 거래량/심리 확인.', bull:'거래량·수수료 수익 증가 → 크립토 시장 건강성 확인 → BTC 강세', bear:'거래량 감소 → 크립토 시장 침체 신호 → BTC 약세' },
  MSTR: { desc:'최대 기업 BTC 보유자. 추가 매입 공시 가능성 높음.', bull:'추가 BTC 매입 공시 → BTC 수급 긍정 + 심리 강화', bear:'매입 중단 또는 손실 → BTC 약세 심리 확산' },
  MARA: { desc:'BTC 채굴 상장사. BTC 가격과 거의 동기화.', bull:'채굴 효율 개선 + BTC 가격 상승 → 강한 매수 연동', bear:'에너지 비용 증가 + 해시레이트 압박 → 채굴주 동반 하락' },
};

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'BTC-Macro-Dashboard/1.0', 'Accept': 'application/json' },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 100))); }
      });
    })
    .on('error', reject)
    .setTimeout(12000, function() { this.destroy(); reject(new Error('timeout')); });
  });
}

function dateRange(daysBack = 0, daysAhead = 45) {
  const from = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
  const to   = new Date(Date.now() + daysAhead * 86400000).toISOString().split('T')[0];
  return { from, to };
}

async function fetchEarnings(from, to) {
  try {
    const url = `https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${FMP_KEY}`;
    const data = await fetchJson(url);
    if (!Array.isArray(data)) return [];
    return data.filter(e => WATCH_TICKERS.has(e.symbol));
  } catch (e) {
    console.error('Earnings fetch error:', e.message);
    return [];
  }
}

async function fetchEconomicCalendar(from, to) {
  try {
    const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${from}&to=${to}&apikey=${FMP_KEY}`;
    const data = await fetchJson(url);
    if (!Array.isArray(data)) return [];
    // HIGH/MEDIUM 영향 미국 지표만 필터
    return data.filter(e => e.country === 'US' && (e.impact === 'High' || e.impact === 'Medium'));
  } catch (e) {
    console.error('Economic calendar fetch error:', e.message);
    return [];
  }
}

function earningsToEvent(e) {
  const info   = TICKER_BIAS[e.symbol] || {};
  const isAMC  = e.time === 'amc'; // after market close
  const timeStr = isAMC ? '16:00' : '09:30';
  return {
    id:            `earnings-${e.symbol}-${e.date}`,
    date:          e.date,
    time:          timeStr,
    tz:            'ET',
    title:         `${e.symbol} 실적 발표 (${e.fiscalDateEnding || ''})`,
    category:      'earnings',
    categoryLabel: '기업 실적',
    impact:        ['NVDA','AAPL','MSFT','GOOGL','TSLA','COIN','MSTR'].includes(e.symbol) ? 'HIGH' : 'MEDIUM',
    btcBias:       'correlated',
    description:   info.desc || `${e.symbol} 분기 실적 발표. EPS 컨센서스 ${e.epsEstimated ? '$' + e.epsEstimated : '미집계'}.${WATCH_TICKERS.has(e.symbol) ? ' BTC-나스닥 상관관계를 통해 간접 영향.' : ''}`,
    bull:          info.bull || `EPS·매출 컨센서스 상회 → 기술주 강세 → BTC 상승 동반`,
    bear:          info.bear || `실적 미스 또는 가이던스 하향 → 기술주 약세 → BTC 하락 압력`,
    confirmed:     true,
    autoFetched:   true,
  };
}

function econToEvent(e) {
  const meta = Object.entries(ECON_MAP).find(([k]) => e.event?.includes(k))?.[1];
  if (!meta) return null;
  const dateStr = (e.date || '').split(' ')[0];
  const timeStr = (e.date || '').split(' ')[1] || '';
  const prevStr = e.previous !== null && e.previous !== undefined ? ` (이전: ${e.previous}${e.unit||''})` : '';
  const estStr  = e.estimate  !== null && e.estimate  !== undefined ? ` | 컨센서스: ${e.estimate}${e.unit||''}` : '';
  return {
    id:            `econ-${e.event?.replace(/\s+/g,'_')}-${dateStr}`,
    date:          dateStr,
    time:          timeStr,
    tz:            'ET',
    title:         `미국 ${meta.label}${prevStr}`,
    category:      'macro',
    categoryLabel: meta.cat,
    impact:        meta.impact,
    btcBias:       meta.bias,
    description:   `${e.event}. ${estStr ? '컨센서스: ' + e.estimate + (e.unit||'') + '. ' : ''}이전 수치: ${e.previous ?? 'N/A'}${e.unit||''}. 결과에 따라 연준 금리 기대치가 변동하며 BTC 단기 방향성에 영향.`,
    bull:          '지표 예상 하회(물가 하락/경기 둔화) → 금리 인하 기대 → BTC·위험자산 상승',
    bear:          '지표 예상 상회(인플레 재가속) → 금리 인상 우려 → DXY 강세 → BTC 하락',
    confirmed:     true,
    autoFetched:   true,
  };
}

async function main() {
  const outPath = 'macro-events.json';
  let existing = { updatedAt: null, events: [] };
  if (existsSync(outPath)) {
    try { existing = JSON.parse(readFileSync(outPath, 'utf8')); } catch (_) {}
  }

  // 수동 큐레이션 이벤트는 그대로 유지 (autoFetched=false 또는 미설정)
  const manual = (existing.events || []).filter(e => !e.autoFetched);

  const { from, to } = dateRange(3, 45); // 3일 전 ~ 45일 후
  console.log(`Fetching ${from} ~ ${to}...`);

  const [earnings, econ] = await Promise.all([
    fetchEarnings(from, to),
    fetchEconomicCalendar(from, to),
  ]);

  console.log(`Earnings: ${earnings.length}, Economic: ${econ.length}`);

  const autoItems = [
    ...earnings.map(earningsToEvent),
    ...econ.map(econToEvent).filter(Boolean),
  ];

  // 중복 제거: 같은 id는 새 것 우선
  const allById = new Map();
  for (const e of [...manual, ...autoItems]) {
    if (!allById.has(e.id)) allById.set(e.id, e);
  }

  const merged = Array.from(allById.values())
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  writeFileSync(outPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    events: merged,
  }, null, 2));

  console.log(`Saved ${merged.length} events (${manual.length} manual + ${autoItems.length} auto-fetched)`);
}

main().catch(e => { console.error(e); process.exit(1); });

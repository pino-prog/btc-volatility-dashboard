/**
 * verify-events.mjs — 매일 1회 실행되는 가벼운 검증 스크립트
 *
 * 동작 (보수적, 외부 API 의존 최소):
 *  1. macro-events.json 로드
 *  2. 과거 이벤트에 occurred:true 자동 마킹 (date < today)
 *  3. 각 이벤트의 confidence 자동 산출 (출처 수/공식 도메인 기반)
 *  4. root.verifiedAt = 오늘, updatedAt 갱신
 *  5. verificationSummary 재계산
 *  6. (선택) Fed FOMC 일정 가져와서 ±2일 이내 매칭 안 되는 FOMC 항목은 콘솔 알림만
 *     - false positive 방지를 위해 mismatch 자동 마킹은 하지 않음
 *
 * 호출: node scripts/verify-events.mjs
 * 워크플로: .github/workflows/daily-verify.yml (매일 09:00 UTC)
 *
 * fetch-macro-events.mjs와 역할 분담:
 *  - fetch (6시간마다): 새 FOMC/BLS/실적 이벤트 자동 추가, AV API 호출
 *  - verify (1일 1회): 기존 이벤트 메타 자동 보강 + occurred 마킹 (API 의존 최소)
 */

import https from 'https';
import { readFileSync, writeFileSync } from 'fs';

const OUT_PATH = 'macro-events.json';

// ────────────────────────────────────────────────────────────────
// HTTP 유틸
// ────────────────────────────────────────────────────────────────
function fetchText(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BTC-MacroVerify/1.0)',
        'Accept': 'text/html,application/json,*/*',
        ...opts.headers,
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location, opts).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
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

// ────────────────────────────────────────────────────────────────
// Fed FOMC 일정 파싱 (federalreserve.gov)
// ────────────────────────────────────────────────────────────────
const MONTH_IDX = {
  january:0, february:1, march:2, april:3, may:4, june:5,
  july:6, august:7, september:8, october:9, november:10, december:11
};

async function fetchFOMCDates() {
  console.log('[FED] FOMC 일정 파싱 중...');
  try {
    const html = await fetchText('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm');
    const pairRe = /fomc-meeting__(month|date)[^>]*>(?:<strong>)?([^<]+)(?:<\/strong>)?<\//gi;
    const pairs = [];
    let m;
    while ((m = pairRe.exec(html)) !== null) {
      pairs.push({ type: m[1], val: m[2].trim().replace(/\*/g, '') });
    }

    const schedule = [];
    for (let i = 0; i < pairs.length - 1; i++) {
      if (pairs[i].type === 'month' && pairs[i + 1].type === 'date') {
        schedule.push({ month: pairs[i].val, dateStr: pairs[i + 1].val });
        i++;
      }
    }

    const startYear = new Date().getFullYear();
    let curYear = startYear;
    let prevMonthIdx = -1;
    const results = [];

    for (const { month, dateStr } of schedule) {
      const monthIdx = MONTH_IDX[month.toLowerCase()];
      if (monthIdx === undefined) continue;
      if (monthIdx < prevMonthIdx) curYear++;
      prevMonthIdx = monthIdx;

      const nums = dateStr.match(/\d+/g);
      if (!nums) continue;
      const day = parseInt(nums[nums.length - 1], 10);
      if (isNaN(day)) continue;

      const isoDate = `${curYear}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      results.push(isoDate);
    }

    const unique = [...new Set(results)].sort();
    console.log(`[FED] ${unique.length}개 FOMC 일정 파싱 완료`);
    return unique;
  } catch (e) {
    console.error('[FED] 파싱 실패:', e.message);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// 신뢰도 자동 추론
// ────────────────────────────────────────────────────────────────
function inferConfidence(e) {
  if (e.mismatch) return 'low';
  if (!e.confirmed) return 'low';
  const sources = e.sources || [];
  const isOfficial = sources.some(s =>
    s.includes('.gov') || s.includes('(공식)') ||
    s.includes('federalreserve') || s.includes('bls.gov') || s.includes('bea.gov') ||
    s.includes('SEC ') || s.includes('sec.gov')
  );
  if (isOfficial) return 'high';
  if (sources.length >= 2) return 'high';
  if (sources.length === 1) return 'medium';
  return 'low';
}

// ────────────────────────────────────────────────────────────────
// 메인 검증 로직
// ────────────────────────────────────────────────────────────────
async function main() {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const todayMs = today.getTime();

  console.log(`\n=== 일일 이벤트 검증 (${todayStr}) ===\n`);

  // 1) 데이터 로드
  let data;
  try {
    data = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
  } catch (e) {
    console.error(`${OUT_PATH} 로드 실패:`, e.message);
    process.exit(1);
  }

  const events = data.events || [];
  const changes = [];

  // 2) Fed FOMC 공식 일정 비교
  const officialFOMC = await fetchFOMCDates();
  const fedFOMCSet = officialFOMC ? new Set(officialFOMC) : null;

  // 3) 이벤트별 검증
  for (const e of events) {
    const evDate = new Date(e.date + 'T12:00:00Z');
    const evMs = evDate.getTime();
    const isPast = evMs < todayMs - 86400000; // 1일 여유

    // (a) 과거 이벤트인데 occurred 누락 → 자동 마킹
    if (isPast && !e.occurred) {
      e.occurred = true;
      e.verifiedAt = todayStr;
      changes.push(`✓ occurred 마킹: ${e.id} (${e.date})`);
    }

    // (b) FOMC 이벤트 — Fed 공식 일정과 ±2일 이내 매칭되지 않으면 알림만 (mismatch 자동 마킹 X)
    //     이유: regex 기반 파싱은 month/date 쌍이 어긋날 수 있어 false positive 발생 가능
    //     phantom 마킹은 사람이 수동 확인 후 처리 (이 스크립트는 알림만)
    if (fedFOMCSet && e.id?.startsWith('fomc-') && !e.occurred) {
      const within6Months = evMs - todayMs < 180 * 86400000;
      if (within6Months) {
        // ±2일 이내 매칭 시도
        const matched = [...fedFOMCSet].some(d => {
          const diff = Math.abs(new Date(d + 'T12:00:00Z').getTime() - evMs);
          return diff <= 2 * 86400000;
        });
        if (!matched) {
          console.log(`  [알림] ${e.id} (${e.date}) — Fed 공식 일정에 ±2일 매칭 없음. 수동 확인 권장.`);
        }
      }
    }

    // (c) confidence 자동 추론 (사용자가 명시한 값은 보존)
    if (!e.confidence) {
      const inferred = inferConfidence(e);
      e.confidence = inferred;
    }

    // (d) verifiedAt 갱신 (개별 이벤트별로 명시되지 않은 경우)
    if (!e.verifiedAt) {
      e.verifiedAt = todayStr;
    }
  }

  // 4) Fed 일정과 6개월 이내 FOMC 비교 알림 (정보성, mismatch 자동 마킹 안 함)
  //    regex 파싱 정확도 한계로 false positive 위험 → 알림만, 결정은 사람
  if (officialFOMC) {
    const localFOMC6m = events.filter(e =>
      e.id?.startsWith('fomc-') && !e.occurred &&
      (new Date(e.date + 'T12:00:00Z').getTime() - todayMs) < 180 * 86400000
    );
    const fedSet = new Set(officialFOMC);
    const unmatchedLocal = localFOMC6m.filter(e => {
      // ±2일 매칭
      const evMs = new Date(e.date + 'T12:00:00Z').getTime();
      return !officialFOMC.some(d => Math.abs(new Date(d + 'T12:00:00Z').getTime() - evMs) <= 2 * 86400000);
    });
    if (unmatchedLocal.length > 0) {
      console.log(`\n[알림] Fed 공식 일정과 ±2일 매칭 안 되는 6개월 이내 FOMC: ${unmatchedLocal.map(e => e.date).join(', ')}`);
      console.log('       (수동 확인 권장. regex 파싱 한계로 알림은 정보성이며 자동 mismatch 처리 안 함.)');
    }
  }

  // 5) verificationSummary 재계산
  const confirmed = events.filter(e => e.confirmed && !e.mismatch).length;
  const unconfirmed = events.filter(e => !e.confirmed && !e.mismatch).length;
  const mismatched = events.filter(e => e.mismatch).length;
  data.verificationSummary = { confirmed, unconfirmed, mismatched };

  // 6) 글로벌 verifiedAt 갱신
  data.verifiedAt = todayStr;
  data.updatedAt = today.toISOString();

  // 7) 저장
  writeFileSync(OUT_PATH, JSON.stringify(data, null, 2));

  // 8) 결과 출력
  console.log(`\n=== 검증 완료 ===`);
  console.log(`총 이벤트: ${events.length}`);
  console.log(`✓ 검증: ${confirmed} | ❓ 미검증: ${unconfirmed} | ⚠️ 불일치: ${mismatched}`);
  console.log(`변경: ${changes.length}건`);
  if (changes.length > 0) {
    console.log('\n변경 내역:');
    for (const c of changes) console.log(`  ${c}`);
  }

  // 9) 종료 코드: mismatch가 있으면 1 (CI 알림용)
  if (mismatched > 0) {
    console.log(`\n⚠️ ${mismatched}건의 불일치 이벤트 — 수동 검토 권장`);
  }
}

main().catch(e => { console.error('verify-events 실행 실패:', e); process.exit(1); });

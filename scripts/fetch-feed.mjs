import https from 'https';
import http from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const ACCOUNTS = [
  // 온체인 / 파생상품
  { handle: 'cryptoquant_com', label: 'CryptoQuant',    category: '온체인/파생상품', color: 'cyan'   },
  { handle: 'ki_young_ju',     label: 'Ki Young Ju',    category: '온체인/파생상품', color: 'sky'    },
  { handle: '_Checkmatey_',    label: 'James Check',    category: '온체인 심리',     color: 'indigo' },
  { handle: 'woonomic',        label: 'Willy Woo',      category: '온체인 심리',     color: 'purple' },
  { handle: 'glassnode',       label: 'Glassnode',      category: '온체인 심리',     color: 'violet' },
  // 기술적 분석
  { handle: 'ColinTCrypto',    label: 'Colin',          category: '기술적 분석',     color: 'orange' },
  { handle: 'rektcapital',     label: 'Rekt Capital',   category: '기술적 분석',     color: 'amber'  },
  // 고래 추적
  { handle: 'lookonchain',     label: 'Lookonchain',    category: '고래 추적',        color: 'blue'   },
  { handle: 'whale_alert',     label: 'Whale Alert',    category: '고래 추적',        color: 'teal'   },
  { handle: 'spotonchain',     label: 'Spot On Chain',  category: '고래 추적',        color: 'green'  },
  // ETF / 기관 수급
  { handle: 'EricBalchunas',   label: 'Balchunas (ETF)',category: 'ETF/기관 수급',    color: 'emerald'},
  { handle: 'JSeyff',          label: 'Seyffart (ETF)', category: 'ETF/기관 수급',    color: 'lime'   },
];

const NITTER_INSTANCES = [
  'https://nitter.privacydev.net',
  'https://nitter.poast.org',
  'https://nitter.tiekoetter.com',
  'https://nitter.1d4.us',
  'https://nitter.kavin.rocks',
  'https://nitter.fdn.fr',
  'https://nitter.it',
  'https://nitter.net',
];

function fetchUrl(rawUrl, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const mod = rawUrl.startsWith('https') ? https : http;
    const req = mod.get(rawUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BTC-Intel-Feed/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => {
      const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
      return (r.exec(block) || [])[1]?.trim() || '';
    };
    const raw = (get('title') || get('description'))
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
      .replace(/\s+/g, ' ').trim();
    const link = get('link') || get('guid');
    const pubDate = get('pubDate');
    if (raw.length > 15) items.push({ text: raw, link, pubDate });
  }
  return items.slice(0, 8);
}

const KW_MAP = [
  ['exchange reserve',  ['Exchange Reserve', '거래소 잔량']],
  ['exchange inflow',   ['Exchange Inflow']],
  ['exchange outflow',  ['Exchange Outflow']],
  ['netflow',           ['Netflow', '거래소 흐름']],
  ['miner',             ['Miner Flow']],
  ['whale',             ['고래', 'Whale']],
  ['large transaction', ['대형 트랜잭션']],
  ['moved',             ['고래 이동']],
  ['etf',               ['ETF 수급']],
  ['spot etf',          ['스팟 ETF']],
  ['etf inflow',        ['ETF 유입']],
  ['etf outflow',       ['ETF 유출']],
  ['blackrock',         ['BlackRock', 'ETF']],
  ['fidelity',          ['Fidelity', 'ETF']],
  ['microstrategy',     ['MicroStrategy', '기관 매집']],
  ['strategy',          ['Strategy(MSTR)', '기관 매집']],
  ['institutional',     ['기관 수급']],
  ['funding rate',      ['펀딩비']],
  ['funding',           ['Funding Rate']],
  ['open interest',     ['OI', '미결제약정']],
  ['liquidation',       ['청산']],
  ['long/short',        ['L/S 비율']],
  ['sopr',              ['SOPR', '온체인']],
  ['nupl',              ['NUPL', '온체인']],
  ['mvrv',              ['MVRV Z-Score']],
  ['lth',               ['LTH 보유자']],
  ['sth',               ['STH 보유자']],
  ['realized cap',      ['Realized Cap']],
  ['halving',           ['반감기', '사이클']],
  ['cycle',             ['BTC 사이클']],
  ['bull',              ['강세장']],
  ['bear',              ['약세장']],
  ['resistance',        ['저항선', 'TA']],
  ['support',           ['지지선', 'TA']],
  ['bullish',           ['강세 신호']],
  ['bearish',           ['약세 신호']],
  ['bos',               ['BOS', '구조 전환']],
  ['break of structure',['BOS']],
  ['order block',       ['Order Block']],
  ['liquidity',         ['유동성']],
  ['stablecoin',        ['스테이블코인', 'SSR']],
  ['accumulation',      ['매집']],
  ['distribution',      ['분배']],
  ['bitcoin',           ['BTC']],
  [' btc ',             ['BTC']],
];

function extractKeywords(text) {
  const lower = ' ' + text.toLowerCase() + ' ';
  const found = new Set();
  for (const [key, tags] of KW_MAP) {
    if (lower.includes(key.toLowerCase())) {
      tags.forEach(t => found.add(t));
      if (found.size >= 5) break;
    }
  }
  return [...found].slice(0, 4);
}

async function fetchNitter(handle) {
  for (const inst of NITTER_INSTANCES) {
    try {
      const url = `${inst}/${handle}/rss`;
      console.log(`  Try ${url}`);
      const xml = await fetchUrl(url, 9000);
      if (xml && xml.includes('<item>')) {
        console.log(`  OK ${inst}`);
        return parseRSS(xml);
      }
    } catch (e) {
      console.log(`  FAIL ${e.message}`);
    }
  }
  return null;
}

async function fetchRSSHub(handle) {
  try {
    const url = `https://rsshub.app/twitter/user/${handle}`;
    console.log(`  Try RSSHub ${url}`);
    const xml = await fetchUrl(url, 12000);
    if (xml && xml.includes('<item>')) return parseRSS(xml);
  } catch (e) {
    console.log(`  RSSHub FAIL ${e.message}`);
  }
  return null;
}

async function main() {
  const outPath = 'feed-data.json';
  let existing = { updatedAt: null, items: [] };
  if (existsSync(outPath)) {
    try { existing = JSON.parse(readFileSync(outPath, 'utf8')); } catch (_) {}
  }

  const newItems = [];
  let anySuccess = false;

  for (const acct of ACCOUNTS) {
    console.log(`\nFetching @${acct.handle}...`);
    let items = await fetchNitter(acct.handle);
    if (!items || items.length === 0) {
      items = await fetchRSSHub(acct.handle);
    }
    if (items && items.length > 0) {
      anySuccess = true;
      for (const item of items) {
        newItems.push({
          id:       `${acct.handle}__${item.pubDate || item.text.slice(0,20)}`,
          handle:   acct.handle,
          label:    acct.label,
          category: acct.category,
          color:    acct.color,
          text:     item.text.slice(0, 320),
          pubDate:  item.pubDate,
          link:     item.link,
          keywords: extractKeywords(item.text),
        });
      }
      console.log(`  => ${items.length} items`);
    } else {
      console.log(`  => no data`);
    }
  }

  if (!anySuccess) {
    console.log('\nNo data fetched. Keeping existing feed-data.json unchanged.');
    process.exit(0);
  }

  // 기존 항목 중 48시간 이내 것만 유지
  const cutoff = Date.now() - 48 * 3600 * 1000;
  const existingKept = (existing.items || []).filter(i => {
    if (!i.pubDate) return false;
    return new Date(i.pubDate).getTime() > cutoff;
  });

  // 새 항목 ID 셋
  const newIds = new Set(newItems.map(i => i.id));
  const merged = [
    ...newItems,
    ...existingKept.filter(i => !newIds.has(i.id)),
  ];

  // 최신순 정렬
  merged.sort((a, b) => {
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return tb - ta;
  });

  const output = {
    updatedAt: new Date().toISOString(),
    items: merged.slice(0, 96),   // 12계정 × 8개 = 96
  };

  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${output.items.length} items to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });

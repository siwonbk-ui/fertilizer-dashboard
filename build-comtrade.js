/* =====================================================================
   build-comtrade.js
   ดึงราคาปุ๋ย "รายประเทศจริง" จาก UN Comtrade API
   หลักการ: unit value = มูลค่าการค้า (USD) ÷ น้ำหนักสุทธิ (kg) × 1000
            = ราคาต่อเมตริกตันโดยประมาณ (USD/ตัน)

   - ไทย (764)  ใช้ฝั่ง "นำเข้า" (M)  = ราคาที่ไทยจ่ายจริง
   - ผู้ส่งออก  ใช้ฝั่ง "ส่งออก" (X)  = ราคา FOB หน้าด่านผู้ส่งออก
   - รัสเซีย    หยุดรายงาน Comtrade ตั้งแต่ ~2022 -> ตั้งธง noData

   วิธีใช้:
     node build-comtrade.js
   อ่าน API key จากไฟล์ .env (COMTRADE_KEY=...)

   ผลลัพธ์: data-comtrade.js -> window.COMTRADE_DATA = {...}
===================================================================== */
const fs = require('fs');
const path = require('path');
const https = require('https');

/* ---------- อ่าน key จาก .env ---------- */
function loadKey() {
  // 1) จาก environment variable ก่อน (ใช้บน GitHub Actions ผ่าน secret)
  if (process.env.COMTRADE_KEY) return process.env.COMTRADE_KEY.trim();
  // 2) fallback: ไฟล์ .env (ตอนรันบนเครื่อง local)
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) throw new Error('ไม่พบ COMTRADE_KEY (ตั้ง env var หรือสร้างไฟล์ .env)');
  const m = /COMTRADE_KEY\s*=\s*(\S+)/.exec(fs.readFileSync(envPath, 'utf8'));
  if (!m) throw new Error('ไม่พบ COMTRADE_KEY ในไฟล์ .env');
  return m[1].trim();
}
const KEY = loadKey();

/* ---------- config ---------- */
// ชนิดปุ๋ย -> HS code (ตรวจสอบกับ API จริงแล้ว)
const FERTS = [
  { id: 'urea',           name: 'ยูเรีย 46-0-0',            hs: '310210' },
  { id: 'dap',            name: 'ฟอสเฟต (DAP 18-46-0)',     hs: '310530' },
  { id: 'mop',            name: 'โพแทสเซียม (MOP 0-0-60)',  hs: '310420' },
  { id: 'phosphate_rock', name: 'หินฟอสเฟต (Phosphate Rock)', hs: '251010' },
];

// ประเทศ: reporterCode (M49) + ฝั่งการค้าที่ใช้
const COUNTRIES = [
  { code: 'TH', m49: 764, name: 'ไทย',            flow: 'M', isHome: true },
  { code: 'RU', m49: 643, name: 'รัสเซีย',         flow: 'X' },
  { code: 'SA', m49: 682, name: 'ซาอุดีอาระเบีย', flow: 'X' },
  { code: 'BN', m49:  96, name: 'บรูไน',           flow: 'X' },
  { code: 'ID', m49: 360, name: 'อินโดนีเซีย',     flow: 'X' },
  { code: 'CN', m49: 156, name: 'จีน',             flow: 'X' },
];

/* กลยุทธ์: "ใหม่สุดเท่าที่มี"
   ดึงข้อมูลรายเดือนย้อนหลัง แล้วเลือก "เดือนล่าสุด" ที่ปริมาณผ่านเกณฑ์ของแต่ละประเทศ
   (Comtrade เป็นข้อมูลศุลกากรย้อนหลัง แต่ละประเทศมาไม่พร้อมกัน จึงตามหลัง Pink Sheet)
   MONTHS_BACK = จำนวนเดือนย้อนหลังที่ค้นหา (ดึงได้ในไม่กี่ request ด้วย multi-period) */
const MONTHS_BACK = 24;
const MIN_KT = 10; // ปริมาณขั้นต่ำต่อเดือน (kt) ที่ถือว่า unit value น่าเชื่อถือ

/* สร้าง list period รายเดือนย้อนหลัง N เดือน จากเดือนอ้างอิง (ส่งเข้ามาทาง args) */
function recentMonths(fromYear, fromMonth, n) {
  const out = [];
  let y = fromYear, m = fromMonth;
  for (let i = 0; i < n; i++) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
    m--; if (m === 0) { m = 12; y--; }
  }
  return out; // ใหม่ -> เก่า
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- HTTP GET (JSON) ดิบ ---------- */
function rawGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Ocp-Apim-Subscription-Key': KEY } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('timeout')));
  });
}

/* ---------- GET พร้อม retry เมื่อเจอ 429 (rate limit) ---------- */
async function getJSON(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { status, body } = await rawGet(url);
    if (status === 200) {
      try { return JSON.parse(body); } catch (e) { throw new Error('JSON parse: ' + body.slice(0, 120)); }
    }
    if (status === 429) {
      // อ่านวินาทีที่ต้องรอจาก message ("Try again in N seconds")
      const m = /in (\d+) second/.exec(body);
      const waitMs = (m ? +m[1] : 2) * 1000 + 500;
      await sleep(waitMs);
      continue; // ลองใหม่
    }
    throw new Error('HTTP ' + status + ': ' + body.slice(0, 120));
  }
  throw new Error('rate limit เกินจำนวน retry');
}

/* ---------- ดึง "เดือนล่าสุดที่ใช้ได้" ของ 1 ประเทศ × 1 ปุ๋ย ----------
   ดึงรายเดือนย้อนหลัง MONTHS_BACK เดือน (แบ่งเป็นชุดละ 12 เดือนต่อ request)
   แล้วเลือกเดือน "ล่าสุด" ที่ปริมาณ >= MIN_KT */
async function fetchLatest(reporter, flow, hs, periods) {
  // Comtrade รับ period หลายค่าคั่นด้วย comma แต่จำกัดจำนวน จึงแบ่งเป็นชุดละ 12
  const chunks = [];
  for (let i = 0; i < periods.length; i += 12) chunks.push(periods.slice(i, i + 12));

  const byPeriod = {}; // period -> {value, netWgt}
  for (const chunk of chunks) {
    const url =
      `https://comtradeapi.un.org/data/v1/get/C/M/HS?reporterCode=${reporter}` +
      `&period=${chunk.join(',')}&flowCode=${flow}&cmdCode=${hs}&partnerCode=0`;
    const j = await getJSON(url);
    for (const x of j.data || []) {
      if (x.partnerCode !== 0 || !(x.netWgt > 0) || !(x.primaryValue > 0)) continue;
      const p = String(x.period);
      // เก็บแถวที่ netWgt สูงสุดของแต่ละเดือน (= aggregate รวม ไม่ใช่แถวแยก transport)
      if (!byPeriod[p] || x.netWgt > byPeriod[p].netWgt) byPeriod[p] = { value: x.primaryValue, netWgt: x.netWgt };
    }
    await sleep(700);
  }

  // periods เรียงใหม่->เก่าอยู่แล้ว เลือกเดือนแรกที่ปริมาณผ่านเกณฑ์
  let lowVolumeSeen = null;
  for (const p of periods) {
    const r = byPeriod[p];
    if (!r) continue;
    const kt = r.netWgt / 1e6;
    const usdPerTon = (r.value / r.netWgt) * 1000;
    if (kt >= MIN_KT) {
      return { period: p, usdPerTon: Math.round(usdPerTon * 100) / 100, volumeKt: Math.round(kt), lowVolume: false };
    }
    if (!lowVolumeSeen) lowVolumeSeen = { period: p, volumeKt: Math.round(kt), lowVolume: true };
  }
  return lowVolumeSeen; // อาจเป็น null (ไม่มีข้อมูลเลย) หรือ lowVolume
}

// "202512" -> "ธ.ค. 68"
const TH_MON = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
function periodLabel(p) {
  const y = +p.slice(0, 4), m = +p.slice(4, 6);
  return `${TH_MON[m - 1]} ${String((y + 543) % 100).padStart(2, '0')}`;
}

/* ---------- main ---------- */
async function main() {
  console.log('• ใช้ UN Comtrade API (key: ***' + KEY.slice(-4) + ')');
  // เดือนเริ่มค้นหา: ส่งผ่าน arg เช่น "node build-comtrade.js 2026-06" ไม่งั้นใช้เดือนปัจจุบัน
  const arg = process.argv.find((a) => /^\d{4}-\d{2}$/.test(a));
  const now = new Date();
  const start = arg || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [sy, sm] = start.split('-').map(Number);
  const periods = recentMonths(sy, sm, MONTHS_BACK); // ใหม่ -> เก่า
  console.log(`• ค้นหาเดือนล่าสุดที่มีข้อมูล ย้อนหลังจาก ${start} (${MONTHS_BACK} เดือน)`);

  const result = { fertilizers: {}, meta: {} };
  let newest = null, oldest = null;

  for (const f of FERTS) {
    result.fertilizers[f.id] = {};
    for (const c of COUNTRIES) {
      let rec = null;
      try {
        rec = await fetchLatest(c.m49, c.flow, f.hs, periods);
      } catch (e) {
        console.log(`  ! ${c.name}/${f.id}: ${e.message}`);
      }
      const usable = rec && !rec.lowVolume;
      const flag = usable ? '✓' : (rec && rec.lowVolume ? '⚠ ปริมาณน้อย (ตัดทิ้ง)' : '✗ ไม่มีข้อมูล');
      console.log(`  ${c.name.padEnd(16)} ${f.id.padEnd(15)} ${usable ? rec.usdPerTon + ' USD/t (' + rec.volumeKt + 'kt, ' + periodLabel(rec.period) + ')' : '—'}  ${flag}`);
      if (usable) {
        if (!newest || rec.period > newest) newest = rec.period;
        if (!oldest || rec.period < oldest) oldest = rec.period;
      }
      result.fertilizers[f.id][c.code] = usable
        ? { price: rec.usdPerTon, period: rec.period, periodLabel: periodLabel(rec.period), volumeKt: rec.volumeKt, flow: c.flow }
        : { price: null, noData: true, reason: rec && rec.lowVolume ? 'lowVolume' : 'noReport', flow: c.flow };
    }
  }

  result.meta = {
    source: 'UN Comtrade (comtradeapi.un.org)',
    sourceUrl: 'https://comtradeplus.un.org',
    method: 'unit value = primaryValue / netWeight (USD per metric ton), World aggregate, monthly',
    note: 'ราคา = มูลค่าการค้า ÷ น้ำหนัก ของ "เดือนล่าสุดที่แต่ละประเทศมีข้อมูล" · ไทย=ราคานำเข้า, อื่นๆ=ราคาส่งออก FOB · แต่ละประเทศอาจคนละเดือน (Comtrade เป็นข้อมูลศุลกากรย้อนหลัง)',
    newestPeriod: newest ? periodLabel(newest) : null,
    oldestPeriod: oldest ? periodLabel(oldest) : null,
    fertNames: Object.fromEntries(FERTS.map((f) => [f.id, f.name])),
    countryNames: Object.fromEntries(COUNTRIES.map((c) => [c.code, c.name])),
  };

  const banner =
    '/* AUTO-GENERATED by build-comtrade.js — อย่าแก้ด้วยมือ */\n' +
    '/* ราคาปุ๋ยรายประเทศจริง คำนวณจาก UN Comtrade (unit value) */\n';
  fs.writeFileSync(
    path.join(__dirname, 'data-comtrade.js'),
    banner + 'window.COMTRADE_DATA = ' + JSON.stringify(result, null, 2) + ';\n',
    'utf8'
  );
  console.log('• เขียน data-comtrade.js สำเร็จ');
}

main().catch((e) => { console.error('ผิดพลาด:', e.message); process.exit(1); });

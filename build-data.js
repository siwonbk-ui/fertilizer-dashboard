/* =====================================================================
   build-data.js
   ดึงราคาปุ๋ยจริงจาก World Bank "Pink Sheet" (รายเดือน, USD/ตัน)
   แล้วเขียนเป็นไฟล์ data.js  ->  window.FERT_DATA = {...}

   วิธีใช้:
     node build-data.js
   (ถ้าไม่มี pinksheet.xlsx จะดาวน์โหลดให้อัตโนมัติ)

   ทำไมต้อง data.js ไม่ใช่ data.json:
     เปิด index.html ด้วย file:// แล้ว fetch('data.json') จะโดน CORS บล็อก
     แต่ <script src="data.js"> โหลดได้ปกติ -> ดับเบิลคลิกเปิดใช้ได้เลย
===================================================================== */
const fs = require('fs');
const path = require('path');
const https = require('https');
const XLSX = require('xlsx');

// หน้าทางการที่มีลิงก์ไฟล์รายเดือนล่าสุด (URL ไฟล์เปลี่ยนทุกเดือน จึงต้อง scrape)
const CMO_PAGE = 'https://www.worldbank.org/en/research/commodity-markets';
// URL สำรอง (เผื่อ scrape ไม่สำเร็จ) — อัปเดตล่าสุด มิ.ย. 2026
const FALLBACK_URL =
  'https://thedocs.worldbank.org/en/doc/74e8be41ceb20fa0da750cda2f6b9e4e-0050012026/related/CMO-Historical-Data-Monthly.xlsx';
const XLSX_FILE = path.join(__dirname, 'pinksheet.xlsx');

// คอลัมน์ในชีต "Monthly Prices" (อ้างอิงจากการสำรวจไฟล์จริง)
const COLS = {
  phosphate_rock: 57, // Phosphate rock
  dap: 58,            // DAP (Diammonium phosphate)
  urea: 60,           // Urea
  mop: 61,            // Potassium chloride (MOP)
};

const MONTHS_BACK = 13; // เก็บ 13 เดือนล่าสุด (พอสำหรับเทรนด์ 6-12 ด.)

/* ดึงหน้าเว็บเป็น string (ตาม redirect) */
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const go = (u) => https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return go(res.headers.location);
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve(body));
    }).on('error', reject);
    go(url);
  });
}

/* หา URL ไฟล์ CMO-Historical-Data-Monthly.xlsx ล่าสุดจากหน้าทางการ */
async function resolveLatestUrl() {
  try {
    const html = await fetchText(CMO_PAGE);
    // มองหา href ที่ลงท้ายด้วย CMO-Historical-Data-Monthly.xlsx
    const m = html.match(/https:\/\/[^"')\s]*CMO-Historical-Data-Monthly\.xlsx/i);
    if (m) { console.log('• พบ URL ล่าสุด:', m[0]); return m[0]; }
    console.log('• หา URL ในหน้าเว็บไม่พบ ใช้ URL สำรอง');
  } catch (e) {
    console.log('• ดึงหน้าเว็บไม่สำเร็จ (' + e.message + ') ใช้ URL สำรอง');
  }
  return FALLBACK_URL;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const go = (u) => https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return go(res.headers.location); // ตาม redirect
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
    go(url);
  });
}

// "2024M12" -> { label:'ธ.ค. 67', iso:'2024-12' }
const TH_MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
function parsePeriod(code) {
  const m = /^(\d{4})M(\d{2})$/.exec(code);
  if (!m) return null;
  const year = +m[1], mon = +m[2];
  return {
    iso: `${m[1]}-${m[2]}`,
    label: `${TH_MONTHS[mon - 1]} ${String((year + 543) % 100).padStart(2, '0')}`,
  };
}

async function main() {
  let usedUrl = FALLBACK_URL;
  const useCache = process.argv.includes('--cache');
  if (useCache && fs.existsSync(XLSX_FILE)) {
    console.log('• ใช้ไฟล์ที่ดาวน์โหลดไว้ (--cache)');
  } else {
    usedUrl = await resolveLatestUrl();
    console.log('• ดาวน์โหลด Pink Sheet ล่าสุด ...');
    await download(usedUrl, XLSX_FILE);
  }
  console.log('• อ่านไฟล์ xlsx ...');
  const wb = XLSX.readFile(XLSX_FILE);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Monthly Prices'], { header: 1, raw: true });

  const updatedNote = (rows[3] && rows[3][0]) || '';

  // หาแถวข้อมูลทั้งหมด (เริ่มแถว 6, key เป็น YYYYMmm)
  const dataRows = rows.slice(6).filter((r) => r[0] && /^\d{4}M\d{2}$/.test(String(r[0])));
  const recent = dataRows.slice(-MONTHS_BACK);

  const periods = recent.map((r) => parsePeriod(String(r[0])));
  const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null);

  const series = {};
  for (const [key, col] of Object.entries(COLS)) {
    series[key] = recent.map((r) => num(r[col]));
  }

  const out = {
    source: 'World Bank Commodity Price Data (The Pink Sheet)',
    sourceUrl: usedUrl,
    note: updatedNote,
    currency: 'USD',
    unit: 'mt', // metric ton
    generatedFrom: 'CMO-Historical-Data-Monthly.xlsx',
    latestPeriod: periods[periods.length - 1].iso,
    months: periods.map((p) => p.label),
    monthsIso: periods.map((p) => p.iso),
    // ราคา benchmark โลกจริง (USD/ตัน) ต่อชนิดปุ๋ย
    benchmark: {
      urea: series.urea,
      dap: series.dap,
      phosphate_rock: series.phosphate_rock,
      mop: series.mop,
    },
  };

  const banner =
    '/* AUTO-GENERATED by build-data.js — อย่าแก้ด้วยมือ */\n' +
    '/* ราคาจริงจาก World Bank Pink Sheet (USD/metric ton) */\n';

  // ถ้าข้อมูลยังเป็นเดือนเดิม -> ไม่ต้องเขียนทับ (กันไฟล์/log เปลี่ยนโดยไม่จำเป็นเวลารันถี่ๆ ต้นเดือน)
  const dataPath = path.join(__dirname, 'data.js');
  if (fs.existsSync(dataPath)) {
    const prev = fs.readFileSync(dataPath, 'utf8');
    const m = /"latestPeriod":\s*"([^"]+)"/.exec(prev);
    if (m && m[1] === out.latestPeriod) {
      console.log('• ข้อมูลยังเป็นเดือนเดิม (' + out.months.at(-1) + ') — ไม่เขียนทับ');
      console.log('  NO_UPDATE'); // ให้ update-all.js ตรวจจับได้
      return;
    }
  }

  fs.writeFileSync(
    dataPath,
    banner + 'window.FERT_DATA = ' + JSON.stringify(out, null, 2) + ';\n',
    'utf8'
  );

  console.log('• เขียน data.js สำเร็จ (อัปเดตใหม่!)');
  console.log('  ช่วงเวลา :', out.months[0], '→', out.months[out.months.length - 1]);
  console.log('  Urea ล่าสุด :', out.benchmark.urea.at(-1), 'USD/ตัน');
  console.log('  DAP  ล่าสุด :', out.benchmark.dap.at(-1), 'USD/ตัน');
  console.log('  MOP  ล่าสุด :', out.benchmark.mop.at(-1), 'USD/ตัน');
  console.log('  Phosphate rock ล่าสุด :', out.benchmark.phosphate_rock.at(-1), 'USD/ตัน');
}

main().catch((e) => { console.error('ผิดพลาด:', e.message); process.exit(1); });

/* =====================================================================
   update-all.js — อัปเดตข้อมูลทั้งหมดในครั้งเดียว
   รัน: node update-all.js
   - ดึง Pink Sheet ล่าสุด (build-data.js)
   - ดึง Comtrade ล่าสุด (build-comtrade.js)  *ต้องมี .env ที่มี COMTRADE_KEY
   เขียน log ลง update.log เพื่อตรวจย้อนหลัง

   หมายเหตุเรื่องความถี่:
   แหล่งข้อมูลฟรี (World Bank Pink Sheet) ออกไฟล์ใหม่ "เดือนละครั้ง" (ช่วงต้นเดือน)
   การรันถี่กว่านั้นจะได้ข้อมูลเดิม จึงเหมาะกับ schedule รายเดือน ไม่ใช่รายวัน
===================================================================== */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG = path.join(__dirname, 'update.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG, line);
  process.stdout.write(line);
}

function run(script, args = []) {
  return new Promise((resolve) => {
    execFile('node', [path.join(__dirname, script), ...args], { cwd: __dirname, timeout: 300000 }, (err, stdout, stderr) => {
      if (stdout) stdout.trim().split('\n').forEach((l) => log('  ' + l));
      if (err) log(`✗ ${script} ล้มเหลว: ${err.message}`);
      else log(`✓ ${script} สำเร็จ`);
      resolve(!err);
    });
  });
}

(async () => {
  log('=== เริ่มอัปเดตข้อมูลปุ๋ย ===');
  await run('build-data.js');                 // Pink Sheet (auto-resolve URL ล่าสุด)
  // มี key ไหม? จาก env var (Actions) หรือไฟล์ .env (local)
  const hasKey = !!process.env.COMTRADE_KEY || fs.existsSync(path.join(__dirname, '.env'));
  if (hasKey) {
    await run('build-comtrade.js');           // Comtrade (ต้องมี key)
  } else {
    log('• ข้าม Comtrade (ไม่พบ COMTRADE_KEY)');
  }
  log('=== จบการอัปเดต ===\n');
})();

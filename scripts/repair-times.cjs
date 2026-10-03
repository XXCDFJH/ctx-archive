/**
 * 一次性修复工具:归档里"时间等于 header 时间"的事件是旧版兜底逻辑写死的假时间
 * (早期版本在取不到请求时间时会回退到文件创建时刻,重建归档时又会回退到 header)。
 *
 * 做法:重放源会话日志,拿到"每轮对话的真实时间",把命中假时间的事件就地重打;
 * 日志已不覆盖的轮次沿用最近已知时间。绝不增删事件,只改 time 字段。
 *
 * 用法:
 *   node scripts/repair-times.cjs            # 预演,只报告
 *   node scripts/repair-times.cjs --apply    # 落盘(每个文件先生成 .timefix.bak)
 */
const fs = require('fs');
const path = require('path');

const ARCHIVE_ROOT = process.argv.find((a) => a.startsWith('--root='))?.slice(7) ?? 'E:/Code/Agent/ctx-archive';
const APPLY = process.argv.includes('--apply');
const { OtReplayer } = require(path.resolve(__dirname, '..', 'out', 'otlog.js'));

/** 定位 sid 对应的原始 chatSessions 文件 */
function findSource(sid, knownSource) {
  if (typeof knownSource === 'string' && knownSource && fs.existsSync(knownSource)) {
    return knownSource;
  }
  const base = path.join(process.env.APPDATA ?? '', 'Code', 'User', 'workspaceStorage');
  let dirs = [];
  try {
    dirs = fs.readdirSync(base);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = path.join(base, d, 'chatSessions', `${sid}.jsonl`);
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/** 重放源日志 → 每轮对话可解析出的最早真实时间 */
function requestTimes(source) {
  const replayer = new OtReplayer(source);
  const events = [];
  for (const line of fs.readFileSync(source, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(...replayer.process(line, 0));
    } catch {
      // 坏行跳过
    }
  }
  const byRequest = new Map();
  for (const e of events) {
    const t = e.time;
    if (typeof t !== 'number' || t <= 0) continue;
    const cur = byRequest.get(e.request);
    if (cur === undefined || t < cur) byRequest.set(e.request, t);
  }
  return byRequest;
}

function repairFile(file) {
  // 插件可能正在并发追加(只会在文件尾部加行),写回前做乐观校验:文件变了就重来
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = fs.statSync(file);
    const result = repairOnce(file);
    if (result.skipped || result.fixed + result.carried === 0) {
      return result;
    }
    if (!APPLY) {
      return result;
    }
    const after = fs.statSync(file);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      continue; // 期间被追加过,重新读取再修
    }
    fs.copyFileSync(file, `${file}.timefix.bak`);
    fs.writeFileSync(file, result.content, 'utf8');
    return { ...result, applied: true };
  }
  return { file, skipped: 'concurrent append retry exhausted' };
}

/** 读入 + 计算修复结果(不落盘) */
function repairOnce(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let header = null;
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 撕裂尾行直接丢弃(读取时本就如此)
    }
    if (obj.type === 'header') header = obj;
    else records.push(obj);
  }
  if (!header || records.length === 0) {
    return { file, skipped: 'no header/events' };
  }
  const sid = header.sid ?? path.basename(file).replace(/\.jsonl$/, '');
  const source = findSource(sid, header.source);
  if (!source) {
    return { file, skipped: 'source log not found' };
  }
  const times = requestTimes(source);
  const bogus = header.time;
  let fixed = 0;
  let carried = 0;
  let lastKnown = 0;
  for (const ev of records) {
    const t = typeof ev.time === 'number' && ev.time > 0 ? ev.time : 0;
    if (t === bogus || t === 0) {
      const known = times.get(ev.request);
      if (typeof known === 'number' && known > 0) {
        ev.time = known;
        fixed += 1;
      } else if (lastKnown > 0) {
        ev.time = lastKnown;
        carried += 1;
      }
    }
    if (typeof ev.time === 'number' && ev.time > lastKnown) {
      lastKnown = ev.time;
    }
  }
  return {
    file,
    total: records.length,
    fixed,
    carried,
    source: path.basename(source),
    content: [JSON.stringify(header), ...records.map((r) => JSON.stringify(r))].join('\n') + '\n',
  };
}

function main() {
  const files = fs.readdirSync(ARCHIVE_ROOT)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => path.join(ARCHIVE_ROOT, n));
  let totalFixed = 0;
  let totalCarried = 0;
  for (const file of files) {
    try {
      const r = repairFile(file);
      if (r.skipped) {
        console.log(`- ${path.basename(file)}: ${r.skipped}`);
        continue;
      }
      totalFixed += r.fixed;
      totalCarried += r.carried;
      console.log(`- ${path.basename(file).slice(0, 8)}: 事件 ${r.total} · 重打 ${r.fixed} · 顺延 ${r.carried}${r.applied ? ' · 已写入' : ''}`);
    } catch (e) {
      console.log(`- ${path.basename(file)}: 失败 ${String(e)}`);
    }
  }
  console.log(`\n[repair-times] 合计:重打 ${totalFixed} · 顺延 ${totalCarried}${APPLY ? ' · 已落盘' : ' · 预演(加 --apply 落盘)'}`);
}

main();

/**
 * 一次性修复工具:清掉归档里因"重启重放"造成的重复事件。
 *
 * 背景:旧版 tracker 每次窗口重载都从 offset 0 重放整份会话日志,
 * 而归档层当时没有去重,于是同一批事件被反复追加(实测最多重复 81 次)。
 *
 * 判据:同一条内容(类型+轮次+文本+工具+命令+退出码+耗时)在序列中的
 * 两次出现间隔 > 30 条,视为"重放产生的重复";间隔很近的保留,避免误删
 * 真的连续重复调用。保留最后一次出现(最新的那遍最完整)。
 *
 * 用法:
 *   node scripts/dedupe-archives.cjs            # 预演
 *   node scripts/dedupe-archives.cjs --apply    # 落盘(生成 .dedup.bak 备份)
 */
const fs = require('fs');
const path = require('path');

const ARCHIVE_ROOT = process.argv.find((a) => a.startsWith('--root='))?.slice(7) ?? 'E:/Code/Agent/ctx-archive';
const APPLY = process.argv.includes('--apply');
const GAP_THRESHOLD = 30;

function identityOf(e) {
  return [
    e.type,
    e.request,
    String(e.text ?? '').slice(0, 120),
    e.toolId ?? '',
    String(e.command ?? '').slice(0, 120),
    e.exitCode === undefined ? '' : String(e.exitCode),
    e.durationMs === undefined ? '' : String(e.durationMs),
    e.promptTokens === undefined ? '' : String(e.promptTokens),
    e.completionTokens === undefined ? '' : String(e.completionTokens),
  ].join('\u0000');
}

function dedupeFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  let header = null;
  const events = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'header') header = obj;
      else events.push(obj);
    } catch {
      // 撕裂尾行丢弃
    }
  }
  if (!header || events.length === 0) return { file, skipped: 'no header/events' };

  // 先找出重复(按间隔判据),再从后往前保留"最后一个实例"
  const kept = new Array(events.length).fill(true);
  const lastIndexByIdentity = new Map();
  for (let i = 0; i < events.length; i += 1) {
    const id = identityOf(events[i]);
    const previous = lastIndexByIdentity.get(id);
    if (previous !== undefined && i - previous > GAP_THRESHOLD) {
      kept[previous] = false; // 更早的那遍是重复,丢弃
    }
    lastIndexByIdentity.set(id, i);
  }

  const out = [];
  let maxTime = 0;
  let seq = 1;
  for (let i = 0; i < events.length; i += 1) {
    if (!kept[i]) continue;
    const e = events[i];
    e.seq = seq;
    seq += 1;
    if (typeof e.time === 'number' && e.time > maxTime) maxTime = e.time;
    out.push(e);
  }
  let minTime = 0;
  for (const e of out) {
    if (typeof e.time === 'number' && e.time > 0 && (minTime === 0 || e.time < minTime)) minTime = e.time;
  }
  if (minTime > 0) header.time = minTime;

  const result = {
    file,
    before: events.length,
    after: out.length,
    removed: events.length - out.length,
    content: [JSON.stringify(header), ...out.map((e) => JSON.stringify(e))].join('\n') + '\n',
  };
  if (APPLY && result.removed > 0) {
    fs.copyFileSync(file, `${file}.dedup.bak`);
    fs.writeFileSync(file, result.content, 'utf8');
    result.applied = true;
  }
  return result;
}

function main() {
  const files = fs.readdirSync(ARCHIVE_ROOT)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => path.join(ARCHIVE_ROOT, n));
  let before = 0;
  let after = 0;
  for (const file of files) {
    try {
      const r = dedupeFile(file);
      if (r.skipped) {
        console.log(`- ${path.basename(file)}: ${r.skipped}`);
        continue;
      }
      before += r.before;
      after += r.after;
      console.log(`- ${path.basename(file).slice(0, 8)}: ${r.before} → ${r.after}(去掉 ${r.removed})${r.applied ? ' · 已写入' : ''}`);
    } catch (e) {
      console.log(`- ${path.basename(file)}: 失败 ${String(e)}`);
    }
  }
  console.log(`\n[dedupe] 合计 ${before} → ${after}${APPLY ? ' · 已落盘' : ' · 预演(加 --apply 落盘)'}`);
}

main();

"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.rebuildArchives = rebuildArchives;
/**
 * 重建归档:从原始 chatSessions 文件用最新提取逻辑(含工具指令与返回结果)重新生成归档。
 * - 保留旧归档中的手动注释(note),按时间合并
 * - 写临时文件 + fsync 后原子替换;旧文件备份为 .bak
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const archive_1 = require("./archive");
const otlog_1 = require("./otlog");
/** 查找会话的原始 chatSessions 文件:优先旧 header 记录的 source,否则全盘扫描 workspaceStorage */
async function findSource(sid, knownSource) {
    if (knownSource) {
        try {
            await fs.promises.access(knownSource);
            return knownSource;
        }
        catch {
            // 源已不存在,继续扫描
        }
    }
    const base = path.join(process.env.APPDATA ?? '', 'Code', 'User', 'workspaceStorage');
    let dirs = [];
    try {
        dirs = await fs.promises.readdir(base);
    }
    catch {
        return null;
    }
    for (const d of dirs) {
        const p = path.join(base, d, 'chatSessions', `${sid}.jsonl`);
        try {
            await fs.promises.access(p);
            return p;
        }
        catch {
            // 下一个 workspace
        }
    }
    return null;
}
/** 全量重放原始日志,返回带原始时间戳与来源指纹的事件列表 */
async function replaySource(source, sid) {
    const replayer = new otlog_1.OtReplayer(source);
    const content = await fs.promises.readFile(source, 'utf8');
    const events = [];
    // 与跟踪器用同一套指纹算法(sid 取归档会话 id,与跟踪器的文件名 sid 一致)
    const counters = new Map();
    for (const line of content.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        const lineTrimmed = line.trim();
        events.push(...replayer.process(lineTrimmed, 0, (0, otlog_1.lineFingerprintKey)(sid, lineTrimmed, counters)));
    }
    const meta = replayer.sessionMeta;
    return { events, metaTitle: meta?.title, metaModel: meta?.model };
}
async function rebuildArchives(root) {
    const report = { total: 0, rebuilt: 0, skippedNoSource: 0, failed: 0, errors: [] };
    let names = [];
    try {
        names = (await fs.promises.readdir(root)).filter((n) => n.endsWith('.jsonl') && !n.endsWith('.bak') && !n.endsWith('.tmp'));
    }
    catch {
        return report;
    }
    for (const name of names) {
        report.total++;
        const file = path.join(root, name);
        try {
            const old = await archive_1.Archive.readArchive(file);
            const sid = old.header?.sid ?? name.replace(/\.jsonl$/, '');
            const source = await findSource(sid, old.header?.source);
            if (!source) {
                report.skippedNoSource++;
                continue;
            }
            const { events, metaTitle, metaModel } = await replaySource(source, sid);
            // 保留旧归档中的手动注释(原始数据里不存在),按时间合并
            const notes = old.events
                .filter((e) => e.type === 'note')
                .map((e) => ({ type: 'note', request: e.request ?? 0, text: e.text ?? '', time: e.time }));
            // 并集而非替换:日志被 VS Code 压缩过时,旧归档里往往还有日志已不再提供的内容。
            // 重建绝不能把归档变小,否则等于删数据(实测曾从 3915 条掉到 1562 条)。
            const identity = (e) => [
                e.type,
                e.request ?? 0,
                (e.text ?? '').slice(0, 120),
                e.toolId ?? '',
                (e.command ?? '').slice(0, 120),
                e.exitCode === undefined ? '' : String(e.exitCode),
            ].join('\u0000');
            const seen = new Set(events.map(identity));
            const preserved = [];
            for (const e of old.events) {
                if (e.type === 'note') {
                    continue;
                }
                const id = identity(e);
                if (seen.has(id)) {
                    continue;
                }
                seen.add(id);
                const rest = { ...e };
                delete rest.v;
                delete rest.seq; // seq 由重建过程重新分配
                preserved.push(rest);
            }
            const merged = [...events, ...preserved, ...notes].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
            // 起始时间取最早的真实事件时间(而非旧文件/当前时刻)
            let firstTime = 0;
            for (const ev of merged) {
                const t = ev.time;
                if (typeof t === 'number' && t > 0 && (firstTime === 0 || t < firstTime)) {
                    firstTime = t;
                }
            }
            const header = {
                v: 1,
                type: 'header',
                seq: 0,
                time: firstTime > 0 ? firstTime : (old.header?.time ?? Date.now()),
                sid,
                title: metaTitle || old.header?.title,
                model: metaModel || old.header?.model,
                source,
            };
            const lines = [JSON.stringify(header)];
            let seq = 1;
            let lastKnown = header.time;
            for (const ev of merged) {
                const { time, ...rest } = ev;
                // 无时间的事件沿用最近已知时间,不能落回 header 时间(会产生跨天假时间)
                const hasTime = typeof time === 'number' && time > 0;
                const stamp = hasTime ? time : lastKnown;
                if (stamp > lastKnown) {
                    lastKnown = stamp;
                }
                lines.push(JSON.stringify({ v: 1, ...rest, seq, time: stamp }));
                seq += 1;
            }
            const tmpFile = `${file}.tmp`;
            await fs.promises.writeFile(tmpFile, lines.join('\n') + '\n', 'utf8');
            const handle = await fs.promises.open(tmpFile, 'r+');
            await handle.sync();
            await handle.close();
            // 备份旧文件,再原子替换
            const bak = `${file}.bak`;
            try {
                await fs.promises.copyFile(file, bak);
            }
            catch {
                // 备份失败不阻断重建
            }
            await fs.promises.rename(tmpFile, file);
            report.rebuilt++;
        }
        catch (err) {
            report.failed++;
            report.errors.push(`${name}: ${String(err)}`);
        }
    }
    return report;
}
//# sourceMappingURL=rebuild.js.map
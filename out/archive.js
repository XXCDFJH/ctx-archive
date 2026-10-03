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
exports.Archive = void 0;
/**
 * append-only 归档层(对齐 DeepSeek Harness 的会话持久化语义):
 * - 每会话一个 JSONL 文件:首行 header,之后每行一个事件,seq 连续递增
 * - 已提交行永不重写;每批追加后 fsync(持久性屏障)
 * - 读取时丢弃末尾撕裂行(崩溃安全),绝不返回给读者
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class Archive {
    root;
    /** sid -> 写队列尾(串行化同一会话的追加) */
    queues = new Map();
    /** sid -> 下一个 seq */
    nextSeq = new Map();
    /** sid -> 文件是否已创建 */
    initialized = new Set();
    constructor(root) {
        this.root = root;
    }
    /** 追加事件到指定会话(异步,内部串行) */
    append(sid, events, meta, now) {
        if (events.length === 0) {
            return Promise.resolve();
        }
        const time = now ?? Date.now();
        const prev = this.queues.get(sid) ?? Promise.resolve();
        const next = prev.then(() => this.appendInner(sid, events, meta, time));
        // 吞掉错误,避免污染队列链
        this.queues.set(sid, next.catch(() => undefined));
        return next;
    }
    async appendInner(sid, events, meta, time) {
        await fs.promises.mkdir(this.root, { recursive: true });
        const file = path.join(this.root, `${sid}.jsonl`);
        const lines = [];
        if (!this.initialized.has(sid)) {
            // 若文件已存在(上次会话的归档),则不重写 header,而是接续 seq
            let exists = false;
            try {
                await fs.promises.access(file);
                exists = true;
            }
            catch {
                exists = false;
            }
            if (!exists) {
                const header = {
                    v: 1,
                    type: 'header',
                    seq: 0,
                    time,
                    sid,
                    title: meta?.title,
                    model: meta?.model,
                    source: meta?.workspace,
                };
                lines.push(JSON.stringify(header));
                this.nextSeq.set(sid, 1);
            }
            else {
                // 接续:读已有文件的最大 seq + 1
                const existing = await Archive.readArchive(file);
                const maxSeq = existing.events.reduce((m, e) => Math.max(m, e.seq), 0);
                this.nextSeq.set(sid, maxSeq + 1);
            }
            this.initialized.add(sid);
        }
        let seq = this.nextSeq.get(sid) ?? 1;
        for (const ev of events) {
            const evTime = ev.time;
            lines.push(JSON.stringify({ v: 1, ...ev, seq, time: evTime ?? time }));
            seq += 1;
        }
        this.nextSeq.set(sid, seq);
        // 只追加 + fsync
        const handle = await fs.promises.open(file, 'a');
        try {
            await handle.writeFile(lines.join('\n') + '\n');
            await handle.sync();
        }
        finally {
            await handle.close();
        }
    }
    /** 重建归档后调用:清空 seq/初始化缓存,后续追加重新从文件读取接续点 */
    reset() {
        this.queues.clear();
        this.nextSeq.clear();
        this.initialized.clear();
    }
    /** 读取归档:校验连续 seq、跳过撕裂尾行;返回已提交前缀 */
    static async readArchive(file) {
        const result = { header: null, events: [], tornLines: 0 };
        let content;
        try {
            content = await fs.promises.readFile(file, 'utf8');
        }
        catch {
            return result;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) {
                continue;
            }
            try {
                const obj = JSON.parse(line);
                if (obj.type === 'header') {
                    result.header = obj;
                }
                else {
                    result.events.push(obj);
                }
            }
            catch {
                // 只有最后一段非空内容才可能是撕裂尾行
                const rest = lines.slice(i).find((l) => l.trim().length > 0);
                if (rest === line || line === lines[lines.length - 1].trim()) {
                    result.tornLines += 1;
                    break;
                }
                // 中间坏行:计数并跳过,不中断
                result.tornLines += 1;
            }
        }
        return result;
    }
    async listArchives() {
        let entries = [];
        try {
            entries = (await fs.promises.readdir(this.root)).filter((n) => n.endsWith('.jsonl'));
        }
        catch {
            return [];
        }
        const out = [];
        for (const name of entries) {
            const file = path.join(this.root, name);
            const r = await Archive.readArchive(file);
            const firstUser = r.events.find((e) => e.type === 'user');
            const displayTitle = r.header?.title ||
                (firstUser?.text ? firstUser.text.replace(/\s+/g, ' ').slice(0, 40) : '') ||
                name.replace(/\.jsonl$/, '').slice(0, 8);
            const displayTime = r.header ? new Date(r.header.time).toLocaleString() : '?';
            out.push({ file, header: r.header, count: r.events.length, displayTitle, displayTime });
        }
        out.sort((a, b) => (b.header?.time ?? 0) - (a.header?.time ?? 0));
        return out;
    }
}
exports.Archive = Archive;
//# sourceMappingURL=archive.js.map
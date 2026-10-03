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
exports.Tracker = void 0;
/**
 * 文件跟踪器:扫描并跟踪所有工作区的
 * `workspaceStorage/<ws>/chatSessions/*.jsonl`。
 *
 * 策略:
 * - 源文件本身是 append-only OT 日志;跟踪器记住 (path -> byteOffset),
 *   只处理新增字节(天然幂等,崩溃/重启后从 offset 续)
 * - 文件变小视为被 VS Code 重写,重置重放状态
 * - 最后一行不完整时留在残行缓冲,等下次补齐(撕裂尾行语义)
 */
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const otlog_1 = require("./otlog");
class Tracker {
    archive;
    files = new Map();
    timer = null;
    watchers = [];
    watchedDirs = new Set();
    enabled = true;
    log = vscode.window.createOutputChannel('Ctx Archive');
    constructor(archive) {
        this.archive = archive;
    }
    setEnabled(enabled) {
        this.enabled = enabled;
    }
    getEnabled() {
        return this.enabled;
    }
    /** 当前最活跃会话(chatSessions 里 mtime 最新文件的 sid),供 @ctxlog 使用 */
    getActiveSessionId() {
        let best = null;
        for (const st of this.files.values()) {
            if (!best || st.lastMtimeMs > best.lastMtimeMs) {
                best = st;
            }
        }
        return best?.sid ?? null;
    }
    start(pollIntervalMs) {
        this.scanAll().catch((e) => this.log.appendLine(`scan error: ${String(e)}`));
        this.timer = setInterval(() => {
            this.scanAll().catch((e) => this.log.appendLine(`scan error: ${String(e)}`));
        }, pollIntervalMs);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        for (const w of this.watchers) {
            try {
                w.close();
            }
            catch {
                // ignore
            }
        }
        this.watchers = [];
    }
    chatSessionsRoots() {
        const base = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage');
        const roots = [];
        let workspaces = [];
        try {
            workspaces = fs.readdirSync(base);
        }
        catch {
            return roots;
        }
        for (const ws of workspaces) {
            const p = path.join(base, ws, 'chatSessions');
            try {
                if (fs.statSync(p).isDirectory()) {
                    roots.push(p);
                }
            }
            catch {
                // ignore
            }
        }
        return roots;
    }
    async scanAll() {
        for (const root of this.chatSessionsRoots()) {
            this.ensureWatcher(root);
            let names = [];
            try {
                names = fs.readdirSync(root).filter((n) => n.endsWith('.jsonl'));
            }
            catch {
                continue;
            }
            for (const name of names) {
                const full = path.join(root, name);
                const sid = name.replace(/\.jsonl$/, '');
                let st = this.files.get(full);
                if (!st) {
                    st = { path: full, sid, offset: 0, carry: '', replayer: new otlog_1.OtReplayer(full), lastMtimeMs: 0 };
                    this.files.set(full, st);
                }
                await this.ingest(st);
            }
        }
    }
    ensureWatcher(root) {
        if (this.watchedDirs.has(root)) {
            return;
        }
        try {
            const w = fs.watch(root, () => {
                // 目录有变化时立刻增量扫描(与轮询互为兜底)
                setTimeout(() => {
                    this.scanAll().catch(() => undefined);
                }, 300);
            });
            this.watchers.push(w);
            this.watchedDirs.add(root);
        }
        catch {
            // watch 失败时靠轮询
        }
    }
    /** 读取 [offset, size) 的新增字节,按完整行交给重放器 */
    async ingest(st) {
        let stat;
        try {
            stat = await fs.promises.stat(st.path);
        }
        catch {
            return;
        }
        st.lastMtimeMs = stat.mtimeMs;
        if (stat.size < st.offset) {
            // 文件被重写:重置
            st.offset = 0;
            st.carry = '';
            st.replayer = new otlog_1.OtReplayer(st.path);
        }
        if (stat.size <= st.offset) {
            return;
        }
        const bytesToRead = stat.size - st.offset;
        const handle = await fs.promises.open(st.path, 'r');
        let chunk;
        try {
            const buf = Buffer.alloc(bytesToRead);
            const { bytesRead } = await handle.read(buf, 0, bytesToRead, st.offset);
            chunk = buf.toString('utf8', 0, bytesRead);
        }
        finally {
            await handle.close();
        }
        st.carry += chunk;
        const parts = st.carry.split('\n');
        // 最后一段可能是不完整行,留作残行
        const complete = parts.slice(0, -1);
        const last = parts[parts.length - 1];
        let consumed = 0;
        for (const part of complete) {
            consumed += Buffer.byteLength(part, 'utf8') + 1; // +1 换行
        }
        st.offset += consumed;
        st.carry = last;
        const now = Date.now();
        for (const line of complete) {
            const lineTrimmed = line.trim();
            if (!lineTrimmed) {
                continue;
            }
            const events = st.replayer.process(lineTrimmed, now);
            if (events.length > 0 && this.enabled) {
                const meta = st.replayer.sessionMeta ?? undefined;
                this.archive.append(st.sid, events, meta, now).catch((e) => {
                    this.log.appendLine(`archive append failed for ${st.sid}: ${String(e)}`);
                });
            }
        }
    }
    dispose() {
        this.stop();
        this.log.dispose();
    }
}
exports.Tracker = Tracker;
//# sourceMappingURL=tracker.js.map
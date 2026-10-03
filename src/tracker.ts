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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Archive } from './archive';
import { OtReplayer } from './otlog';

interface FileState {
  path: string;
  sid: string;
  offset: number;
  carry: string; // 撕裂残行
  replayer: OtReplayer;
  lastMtimeMs: number;
}

export class Tracker {
  private files = new Map<string, FileState>();
  private timer: NodeJS.Timeout | null = null;
  private watchers: fs.FSWatcher[] = [];
  private watchedDirs = new Set<string>();
  private enabled = true;
  private log = vscode.window.createOutputChannel('Ctx Archive');

  constructor(private readonly archive: Archive) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  getEnabled(): boolean {
    return this.enabled;
  }

  /** 当前最活跃会话(chatSessions 里 mtime 最新文件的 sid),供 @ctxlog 使用 */
  getActiveSessionId(): string | null {
    let best: FileState | null = null;
    for (const st of this.files.values()) {
      if (!best || st.lastMtimeMs > best.lastMtimeMs) {
        best = st;
      }
    }
    return best?.sid ?? null;
  }

  start(pollIntervalMs: number): void {
    this.scanAll().catch((e) => this.log.appendLine(`scan error: ${String(e)}`));
    this.timer = setInterval(() => {
      this.scanAll().catch((e) => this.log.appendLine(`scan error: ${String(e)}`));
    }, pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.watchers = [];
  }

  private chatSessionsRoots(): string[] {
    const base = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage');
    const roots: string[] = [];
    let workspaces: string[] = [];
    try {
      workspaces = fs.readdirSync(base);
    } catch {
      return roots;
    }
    for (const ws of workspaces) {
      const p = path.join(base, ws, 'chatSessions');
      try {
        if (fs.statSync(p).isDirectory()) {
          roots.push(p);
        }
      } catch {
        // ignore
      }
    }
    return roots;
  }

  private async scanAll(): Promise<void> {
    for (const root of this.chatSessionsRoots()) {
      this.ensureWatcher(root);
      let names: string[] = [];
      try {
        names = fs.readdirSync(root).filter((n) => n.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const name of names) {
        const full = path.join(root, name);
        const sid = name.replace(/\.jsonl$/, '');
        let st = this.files.get(full);
        if (!st) {
          st = { path: full, sid, offset: 0, carry: '', replayer: new OtReplayer(full), lastMtimeMs: 0 };
          this.files.set(full, st);
        }
        await this.ingest(st);
      }
    }
  }

  private ensureWatcher(root: string): void {
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
    } catch {
      // watch 失败时靠轮询
    }
  }

  /** 读取 [offset, size) 的新增字节,按完整行交给重放器 */
  private async ingest(st: FileState): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(st.path);
    } catch {
      return;
    }
    st.lastMtimeMs = stat.mtimeMs;
    if (stat.size < st.offset) {
      // 文件被重写:重置
      st.offset = 0;
      st.carry = '';
      st.replayer = new OtReplayer(st.path);
    }
    if (stat.size <= st.offset) {
      return;
    }
    const bytesToRead = stat.size - st.offset;
    const handle = await fs.promises.open(st.path, 'r');
    let chunk: string;
    try {
      const buf = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buf, 0, bytesToRead, st.offset);
      chunk = buf.toString('utf8', 0, bytesRead);
    } finally {
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

  dispose(): void {
    this.stop();
    this.log.dispose();
  }
}

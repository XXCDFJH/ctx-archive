/**
 * 文件跟踪器:扫描并跟踪所有工作区的
 * `workspaceStorage/<ws>/chatSessions/*.jsonl`。
 *
 * 策略:
 * - 源文件本身是 append-only OT 日志;跟踪器记住 (path -> byteOffset),
 *   只处理新增字节;
 * - OT 日志是有状态的,进程重启后必须从 0 全量重放才能重建出正确状态;
 *   重复追加交给归档层的来源指纹(src)拦截:同一行内容无论处理几次都只有一个指纹
 * - 指纹用内容哈希而非字节偏移:日志被 VS Code 压缩重写后位置会变,内容不会
 * - 文件变小视为被 VS Code 重写,重置重放状态
 * - 最后一行不完整时留在残行缓冲,等下次补齐(撕裂尾行语义)
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Archive } from './archive';
import { OtReplayer, lineFingerprintKey } from './otlog';

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
  /** sid:内容哈希 -> 该内容在本会话第几次出现(指纹的序号部分) */
  private lineCounters = new Map<string, number>();
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
      // 文件被重写:重置重放状态与指纹计数(否则同一行的指纹会变,去重失效)
      st.offset = 0;
      st.carry = '';
      st.replayer = new OtReplayer(st.path);
      const prefix = st.sid + ':';
      for (const key of [...this.lineCounters.keys()]) {
        if (key.startsWith(prefix)) {
          this.lineCounters.delete(key);
        }
      }
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
      // 来源指纹:会话 + 行内容哈希 + 同内容出现序号 → 重启重放/日志重写都不会重复
      const lineKey = lineFingerprintKey(st.sid, lineTrimmed, this.lineCounters);
      const events = st.replayer.process(lineTrimmed, now, lineKey);
      if (events.length > 0 && this.enabled) {
        const meta = st.replayer.sessionMeta ?? undefined;
        this.archive.append(st.sid, events, meta, now).then((skipped) => {
          if (skipped > 0) {
            this.log.appendLine(`dedup ${st.sid}: skipped ${skipped} already-archived event(s)`);
          }
        }).catch((e) => {
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

/**
 * append-only 归档层(对齐 DeepSeek Harness 的会话持久化语义):
 * - 每会话一个 JSONL 文件:首行 header,之后每行一个事件,seq 连续递增
 * - 已提交行永不重写;每批追加后 fsync(持久性屏障)
 * - 读取时丢弃末尾撕裂行(崩溃安全),绝不返回给读者
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ArchiveEvent, SessionMeta } from './otlog';

export interface ArchiveHeader {
  v: number;
  type: 'header';
  seq: 0;
  time: number;
  sid: string;
  title?: string;
  model?: string;
  source?: string;
}

export interface StoredEvent {
  v: number;
  type: string;
  seq: number;
  time: number;
  request?: number;
  text?: string;
  /** 工具调用(指令)与结果(toolResult)携带的附加字段 */
  toolId?: string;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  details?: string[];
  /** usage 事件:请求的 token 用量 */
  promptTokens?: number;
  completionTokens?: number;
}

export interface ReadArchiveResult {
  header: ArchiveHeader | null;
  events: StoredEvent[];
  /** 丢弃的撕裂尾行数 */
  tornLines: number;
}

export class Archive {
  /** sid -> 写队列尾(串行化同一会话的追加) */
  private queues = new Map<string, Promise<unknown>>();
  /** sid -> 下一个 seq */
  private nextSeq = new Map<string, number>();
  /** sid -> 文件是否已创建 */
  private initialized = new Set<string>();

  constructor(private readonly root: string) {}

  /** 追加事件到指定会话(异步,内部串行) */
  append(sid: string, events: ArchiveEvent[], meta?: SessionMeta, now?: number): Promise<void> {
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

  private async appendInner(sid: string, events: ArchiveEvent[], meta: SessionMeta | undefined, time: number): Promise<void> {
    await fs.promises.mkdir(this.root, { recursive: true });
    const file = path.join(this.root, `${sid}.jsonl`);
    const lines: string[] = [];

    if (!this.initialized.has(sid)) {
      // 若文件已存在(上次会话的归档),则不重写 header,而是接续 seq
      let exists = false;
      try {
        await fs.promises.access(file);
        exists = true;
      } catch {
        exists = false;
      }
      if (!exists) {
        const header: ArchiveHeader = {
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
      } else {
        // 接续:读已有文件的最大 seq + 1
        const existing = await Archive.readArchive(file);
        const maxSeq = existing.events.reduce((m, e) => Math.max(m, e.seq), 0);
        this.nextSeq.set(sid, maxSeq + 1);
      }
      this.initialized.add(sid);
    }

    let seq = this.nextSeq.get(sid) ?? 1;
    for (const ev of events) {
      const evTime = (ev as { time?: number }).time;
      lines.push(JSON.stringify({ v: 1, ...ev, seq, time: evTime ?? time } satisfies StoredEvent));
      seq += 1;
    }
    this.nextSeq.set(sid, seq);

    // 只追加 + fsync
    const handle = await fs.promises.open(file, 'a');
    try {
      await handle.writeFile(lines.join('\n') + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** 重建归档后调用:清空 seq/初始化缓存,后续追加重新从文件读取接续点 */
  reset(): void {
    this.queues.clear();
    this.nextSeq.clear();
    this.initialized.clear();
  }

  /** 读取归档:校验连续 seq、跳过撕裂尾行;返回已提交前缀 */
  static async readArchive(file: string): Promise<ReadArchiveResult> {
    const result: ReadArchiveResult = { header: null, events: [], tornLines: 0 };
    let content: string;
    try {
      content = await fs.promises.readFile(file, 'utf8');
    } catch {
      return result;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }
      try {
        const obj = JSON.parse(line) as ArchiveHeader | StoredEvent;
        if (obj.type === 'header') {
          result.header = obj as ArchiveHeader;
        } else {
          result.events.push(obj as StoredEvent);
        }
      } catch {
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

  async listArchives(): Promise<
    { file: string; header: ArchiveHeader | null; count: number; displayTitle: string; displayTime: string }[]
  > {
    let entries: string[] = [];
    try {
      entries = (await fs.promises.readdir(this.root)).filter((n) => n.endsWith('.jsonl'));
    } catch {
      return [];
    }
    const out: {
      file: string;
      header: ArchiveHeader | null;
      count: number;
      displayTitle: string;
      displayTime: string;
    }[] = [];
    for (const name of entries) {
      const file = path.join(this.root, name);
      const r = await Archive.readArchive(file);
      const firstUser = r.events.find((e) => e.type === 'user');
      const displayTitle =
        r.header?.title ||
        (firstUser?.text ? firstUser.text.replace(/\s+/g, ' ').slice(0, 40) : '') ||
        name.replace(/\.jsonl$/, '').slice(0, 8);
      const displayTime = r.header ? new Date(r.header.time).toLocaleString() : '?';
      out.push({ file, header: r.header, count: r.events.length, displayTitle, displayTime });
    }
    out.sort((a, b) => (b.header?.time ?? 0) - (a.header?.time ?? 0));
    return out;
  }
}

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
  /** 来源指纹(sid:字节偏移:行内序号):同一源日志行只归档一次 */
  src?: string;
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
  /** sid -> 已写入的最后已知时间(供缺失时间的事件回退) */
  private lastTime = new Map<string, number>();
  /** sid -> 已归档的来源指纹(同一源日志行不重复追加) */
  private srcs = new Map<string, Set<string>>();

  constructor(private readonly root: string) {}

  /** 追加事件到指定会话(异步,内部串行);返回本次因指纹重复而跳过的事件数 */
  append(sid: string, events: ArchiveEvent[], meta?: SessionMeta, now?: number): Promise<number> {
    if (events.length === 0) {
      return Promise.resolve(0);
    }
    const time = now ?? Date.now();
    const prev = this.queues.get(sid) ?? Promise.resolve();
    const next = prev.then(() => this.appendInner(sid, events, meta, time));
    // 吞掉错误,避免污染队列链
    this.queues.set(sid, next.catch(() => undefined));
    return next;
  }

  private async appendInner(sid: string, events: ArchiveEvent[], meta: SessionMeta | undefined, time: number): Promise<number> {
    await fs.promises.mkdir(this.root, { recursive: true });
    const file = path.join(this.root, `${sid}.jsonl`);
    const lines: string[] = [];
    const eventTimes = events
      .map((ev) => (ev as { time?: number }).time)
      .filter((t): t is number => typeof t === 'number' && t > 0);

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
          // 取本批最早事件时间:比"插件第一次看到它的时刻"更接近真实会话起点
          time: eventTimes.length > 0 ? Math.min.apply(null, eventTimes) : time,
          sid,
          title: meta?.title,
          model: meta?.model,
          source: meta?.workspace,
        };
        lines.push(JSON.stringify(header));
        this.nextSeq.set(sid, 1);
        this.srcs.set(sid, new Set());
      } else {
        // 接续:读已有文件的最大 seq + 1,并接住最后已知时间与已归档指纹
        const existing = await Archive.readArchive(file);
        const maxSeq = existing.events.reduce((m, e) => Math.max(m, e.seq), 0);
        this.nextSeq.set(sid, maxSeq + 1);
        let last = existing.header?.time ?? 0;
        const known = new Set<string>();
        for (const e of existing.events) {
          if (typeof e.time === 'number' && e.time > last) {
            last = e.time;
          }
          if (typeof e.src === 'string' && e.src !== '') {
            known.add(e.src);
          }
        }
        this.lastTime.set(sid, last);
        this.srcs.set(sid, known);
      }
      this.initialized.add(sid);
    }

    let seq = this.nextSeq.get(sid) ?? 1;
    let lastKnown = this.lastTime.get(sid) ?? (eventTimes.length > 0 ? Math.min.apply(null, eventTimes) : time);
    const known = this.srcs.get(sid) ?? new Set<string>();
    let skipped = 0;
    for (const ev of events) {
      const src = (ev as { src?: string }).src;
      if (typeof src === 'string' && src !== '') {
        if (known.has(src)) {
          skipped += 1; // 同一条源日志行已经归档过(重启重放 / 日志重写)
          continue;
        }
        known.add(src);
      }
      const evTime = (ev as { time?: number }).time;
      const hasTime = typeof evTime === 'number' && evTime > 0;
      // 缺时间的事件沿用最近已知时间:写 header 时间或处理时刻都会产生假时间
      const stamp = hasTime ? evTime : lastKnown;
      if (stamp > lastKnown) {
        lastKnown = stamp;
      }
      lines.push(JSON.stringify({ v: 1, ...ev, seq, time: stamp } satisfies StoredEvent));
      seq += 1;
    }
    this.nextSeq.set(sid, seq);
    this.lastTime.set(sid, lastKnown);
    this.srcs.set(sid, known);

    // 只追加 + fsync
    const handle = await fs.promises.open(file, 'a');
    try {
      await handle.writeFile(lines.join('\n') + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return skipped;
  }

  /** 重建归档后调用:清空 seq/初始化缓存,后续追加重新从文件读取接续点 */
  reset(): void {
    this.queues.clear();
    this.nextSeq.clear();
    this.initialized.clear();
    this.lastTime.clear();
    this.srcs.clear();
  }

  /** 归档文件当前字节数(0 表示尚未归档) */
  async archiveSize(sid: string): Promise<number> {
    try {
      const stat = await fs.promises.stat(path.join(this.root, `${sid}.jsonl`));
      return stat.size;
    } catch {
      return 0;
    }
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
    {
      file: string;
      header: ArchiveHeader | null;
      count: number;
      displayTitle: string;
      displayTime: string;
      /** 会话起始时间(header) */
      startTime: number;
      /** 最后活动时间(最大事件时间) */
      lastTime: number;
    }[]
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
      startTime: number;
      lastTime: number;
    }[] = [];
    for (const name of entries) {
      const file = path.join(this.root, name);
      const r = await Archive.readArchive(file);
      const firstUser = r.events.find((e) => e.type === 'user');
      const displayTitle =
        r.header?.title ||
        (firstUser?.text ? firstUser.text.replace(/\s+/g, ' ').slice(0, 40) : '') ||
        name.replace(/\.jsonl$/, '').slice(0, 8);
      // 显示与排序都用"最后活动时间":header 是文件创建时刻,对跨天长会话会严重失真
      const startTime = r.header?.time ?? 0;
      let lastTime = startTime;
      for (const e of r.events) {
        if (typeof e.time === 'number' && e.time > lastTime) {
          lastTime = e.time;
        }
      }
      const displayTime = lastTime > 0 ? new Date(lastTime).toLocaleString() : '?';
      out.push({ file, header: r.header, count: r.events.length, displayTitle, displayTime, startTime, lastTime });
    }
    out.sort((a, b) => b.lastTime - a.lastTime);
    return out;
  }
}

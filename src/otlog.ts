/**
 * OT 日志重放器:把 VS Code `chatSessions/<sid>.jsonl` 的追加操作日志
 * (kind0 初始快照 + kind1 增量 patch + kind2 完整值快照)
 * 重放为事件流,从中提取可归档事件。
 *
 * 格式参考(实测 VS Code 1.135):
 *   kind 0: {"kind":0,"v":{...初始状态...,"sessionId":"...","requests":[],"inputState":{...}}}
 *   kind 1: {"kind":1,"k":["requests",9,"result"],"v":{...}}           JSON 指针增量 patch
 *   kind 2: {"kind":2,"k":["requests",9,"response"],"v":[...],"i":n}   完整值快照
 */

/** 归档事件(与 dsh 的 SessionEvent 同构的简化词汇表) */
export type ArchiveEvent = (
  | { type: 'user'; request: number; text: string }
  | { type: 'assistant'; request: number; text: string }
  | {
      type: 'tool';
      request: number;
      text: string;
      /** 工具 id,如 run_in_terminal / copilot_createFile */
      toolId?: string;
      /** 终端类工具的完整命令原文 */
      command?: string;
    }
  | {
      type: 'toolResult';
      request: number;
      text: string;
      toolId?: string;
      command?: string;
      exitCode?: number;
      durationMs?: number;
      /** 结构化结果条目(文件路径 / URL 等) */
      details?: string[];
    }
  | { type: 'edit'; request: number; text: string }
  | { type: 'thinking'; request: number; text: string }
  | { type: 'note'; request: number; text: string }
  | {
      type: 'usage';
      request: number;
      text: string;
      /** 该请求的输入 token 数 */
      promptTokens?: number;
      /** 该请求的输出 token 数 */
      completionTokens?: number;
    }
) & {
  /** 事件原始时间戳(重建归档时保留);缺省时由归档层取追加时刻 */
  time?: number;
  /**
   * 来源指纹(sid:字节偏移:行内序号)。
   * 同一条源日志行无论被处理几次(重启重放、日志重写),指纹都不变,
   * 归档层据此去重,避免重复追加同一内容。
   */
  src?: string;
};

/** 32 位 FNV-1a 内容哈希(十六进制) */
export function hash32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * 生成稳定的行指纹键:sid + 行内容哈希 + 同内容出现序号。
 * 与字节偏移无关 —— 日志被压缩重写后位置会变,内容不会。
 * @param sid - 会话 id。
 * @param line - 已 trim 的单行日志文本。
 * @param seen - sid:哈希 -> 已出现次数 的计数器(同一会话内复用)。
 * @returns 作为事件 src 前缀的指纹键。
 */
export function lineFingerprintKey(sid: string, line: string, seen: Map<string, number>): string {
  const base = sid + ':' + hash32(line);
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return base + ':' + count;
}

/** 会话元数据(来自初始快照与后续 patch) */
export interface SessionMeta {
  sid: string;
  title?: string;
  model?: string;
  workspace?: string;
}

type JsonObject = { [key: string]: unknown };

/** 从 response 条目里尽力提取可读文本 */
function extractText(item: JsonObject): string {
  const direct = item.value ?? item.text;
  if (typeof direct === 'string' && direct.trim()) {
    return direct;
  }
  return JSON.stringify(item, null, 0);
}

/** 把 renderedUserMessage(片段列表)拼接为纯文本 */
function concatRenderedMessage(rendered: unknown): string {
  if (!Array.isArray(rendered)) {
    return '';
  }
  const parts: string[] = [];
  for (const part of rendered) {
    if (part && typeof part === 'object' && typeof (part as JsonObject).text === 'string') {
      parts.push((part as JsonObject).text as string);
    }
  }
  return parts.join('\n');
}

/** 提取终端类工具的完整命令原文 */
function extractCommandLine(item: JsonObject): string | undefined {
  const tsd = item.toolSpecificData as JsonObject | undefined;
  if (!tsd) {
    return undefined;
  }
  const cl = tsd.commandLine as JsonObject | undefined;
  if (!cl) {
    return undefined;
  }
  const cmd = cl.original ?? cl.forDisplay;
  return typeof cmd === 'string' ? cmd : undefined;
}

/** 从 {value} 或字符串形式的消息对象中提取文本 */
function messageText(msg: unknown): string {
  if (typeof msg === 'string') {
    return msg.trim();
  }
  if (msg && typeof msg === 'object' && typeof (msg as JsonObject).value === 'string') {
    return ((msg as JsonObject).value as string).trim();
  }
  return '';
}

/** 清洗 VS Code 消息中的 Markdown 链接引用,如 `[](file:///e%3A/Code/a.py)` → `e:/Code/a.py` */
function cleanMarkdownRefs(s: string): string {
  return s.replace(/\[\]\(([^)]+)\)/g, (_all, uri: string) => {
    const u = uri.replace(/^file:\/\//, '');
    try {
      return decodeURIComponent(u);
    } catch {
      return u;
    }
  });
}

/** 从单个响应条目里取出真实时间(直接字段 / 12 位以上 id 即毫秒时间戳) */
function itemTimestamp(item: JsonObject): number | undefined {
  const direct = item.timestamp;
  if (typeof direct === 'number' && direct > 0) {
    return direct;
  }
  const responseTs = item.responseTimestamp;
  if (typeof responseTs === 'number' && responseTs > 0) {
    return responseTs;
  }
  const id = item.id;
  if (typeof id === 'string' && /^\d{12,}$/.test(id)) {
    return Number(id);
  }
  return undefined;
}

/** 判定工具条目是否"已完成"且携带结果信息;若有则返回结果事件字段,否则返回 null */
function extractToolResult(item: JsonObject): {
  text: string;
  toolId?: string;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  details?: string[];
  timestamp?: number;
} | null {
  const toolId = typeof item.toolId === 'string' ? (item.toolId as string) : undefined;
  const command = extractCommandLine(item);

  // 结果摘要:pastTenseMessage(完成态消息),过滤掉 shell integration 提示这类占位文本
  let text = messageText(item.pastTenseMessage);
  if (text.startsWith('$(info)') || text.startsWith('$(')) {
    text = '';
  }
  if (text) {
    text = cleanMarkdownRefs(text);
  }

  // 终端执行状态:退出码 + 耗时 + 完成时间戳
  const tsd = item.toolSpecificData as JsonObject | undefined;
  const state = tsd?.terminalCommandState as JsonObject | undefined;
  let exitCode: number | undefined;
  let durationMs: number | undefined;
  let timestamp: number | undefined;
  if (state && typeof state === 'object') {
    if (typeof state.exitCode === 'number') {
      exitCode = state.exitCode as number;
    }
    if (typeof state.duration === 'number') {
      durationMs = state.duration as number;
    }
    if (typeof state.timestamp === 'number') {
      timestamp = state.timestamp as number;
    }
  }

  // 结构化结果条目(搜索/任务类工具的返回列表)
  const rawDetails = item.resultDetails as unknown[] | undefined;
  const details: string[] = [];
  if (Array.isArray(rawDetails)) {
    for (const d of rawDetails.slice(0, 30)) {
      if (d && typeof d === 'object') {
        const s = (d as JsonObject).external ?? (d as JsonObject).fsPath ?? (d as JsonObject).path;
        if (typeof s === 'string') {
          details.push(s);
        }
      }
    }
  }

  const complete = item.isComplete === true;
  const hasInfo = text.length > 0 || exitCode !== undefined || details.length > 0;
  if (!complete || !hasInfo) {
    return null;
  }
  if (!text) {
    const title = messageText(item.generatedTitle);
    text = title || '命令已执行';
  }
  return { text, toolId, command, exitCode, durationMs, details: details.length > 0 ? details : undefined, timestamp };
}

export class OtReplayer {
  private state: JsonObject | null = null;
  private meta: SessionMeta | null = null;
  /** request 下标 -> 已解析出的请求时间(仅缓存成功值) */
  private requestTimeCache = new Map<number, number>();
  /** request 下标 -> 已归档的 response 条目数(快照只增,按条数去重) */
  private processed = new Map<number, number>();
  /** 已发出 user 事件的 request 下标 */
  private userEmitted = new Set<number>();
  /** 已发出 toolResult 事件的工具调用(request:toolCallId) */
  private resultEmitted = new Set<string>();
  /** 已发出 usage 事件的 request 下标 */
  private usageEmitted = new Set<number>();

  constructor(private readonly sourcePath: string) {}

  /**
   * 从重建状态中解析指定请求的真实时间。
   * VS Code 只为早期请求写 requests[N].timestamp;后续请求要依次回退到
   * responseTimestamp → 响应条目自身时间 → 工具轮次时间,否则时间会缺失。
   * 只在成功解析时缓存:状态随日志推进继续补全,缺值不能锁死。
   */
  private requestTimestamp(idx: number): number | undefined {
    const cached = this.requestTimeCache.get(idx);
    if (cached !== undefined) {
      return cached;
    }
    const requests = this.state?.requests as unknown[] | undefined;
    const req = requests?.[idx] as JsonObject | undefined;
    if (!req) {
      return undefined;
    }
    const candidates: number[] = [];
    if (typeof req.timestamp === 'number' && req.timestamp > 0) {
      candidates.push(req.timestamp);
    }
    if (typeof req.responseTimestamp === 'number' && req.responseTimestamp > 0) {
      candidates.push(req.responseTimestamp);
    }
    const response = req.response as unknown[] | undefined;
    if (Array.isArray(response)) {
      for (const item of response) {
        if (item && typeof item === 'object') {
          const t = itemTimestamp(item as JsonObject);
          if (t !== undefined) {
            candidates.push(t);
          }
        }
      }
    }
    for (const t of this.roundTimes(idx)) {
      if (t !== undefined) {
        candidates.push(t);
      }
    }
    if (candidates.length === 0) {
      return undefined;
    }
    const resolved = candidates.reduce((m, t) => (t < m ? t : m), candidates[0]);
    this.requestTimeCache.set(idx, resolved);
    return resolved;
  }

  /** result.metadata.toolCallRounds 的逐个时间戳(与工具调用顺序对应,可能含 undefined) */
  private roundTimes(idx: number): (number | undefined)[] {
    const requests = this.state?.requests as unknown[] | undefined;
    const req = requests?.[idx] as JsonObject | undefined;
    const metadata = (req?.result as JsonObject | undefined)?.metadata as JsonObject | undefined;
    const rounds = metadata?.toolCallRounds;
    const out: (number | undefined)[] = [];
    if (Array.isArray(rounds)) {
      for (const round of rounds) {
        const raw = round && typeof round === 'object' ? (round as JsonObject).timestamp : undefined;
        out.push(typeof raw === 'number' && raw > 0 ? raw : undefined);
      }
    }
    return out;
  }

  /** 请求完成后读取重建状态的最终 token 用量,每个请求仅发出一次 */
  private emitUsage(idx: number, events: ArchiveEvent[]): void {
    if (this.usageEmitted.has(idx)) {
      return;
    }
    const requests = this.state?.requests as unknown[] | undefined;
    const req = requests?.[idx] as JsonObject | undefined;
    const prompt = typeof req?.promptTokens === 'number' ? (req.promptTokens as number) : undefined;
    const completion = typeof req?.completionTokens === 'number' ? (req.completionTokens as number) : undefined;
    if (prompt === undefined && completion === undefined) {
      return;
    }
    this.usageEmitted.add(idx);
    events.push({
      type: 'usage',
      request: idx,
      text: '',
      promptTokens: prompt,
      completionTokens: completion,
      time: this.requestTimestamp(idx),
    });
  }

  get sessionMeta(): SessionMeta | null {
    return this.meta;
  }

  get hasState(): boolean {
    return this.state !== null;
  }

  /** 处理一行日志,返回此行新产生的归档事件 */
  process(line: string, now: number, lineKey?: string): ArchiveEvent[] {
    const events = this.processLine(line, now);
    if (lineKey !== undefined) {
      for (let i = 0; i < events.length; i += 1) {
        events[i].src = lineKey + ':' + i;
      }
    }
    return events;
  }

  private processLine(line: string, now: number): ArchiveEvent[] {
    let obj: JsonObject;
    try {
      obj = JSON.parse(line) as JsonObject;
    } catch {
      return []; // 容错:无法解析的行跳过,绝不崩
    }

    const kind = obj.kind as number;
    if (kind === 0) {
      return this.initState(obj);
    }
    if (kind === 1) {
      return this.applyPatch(obj, now);
    }
    if (kind === 2) {
      return this.applySnapshot(obj, now);
    }
    return [];
  }

  private initState(obj: JsonObject): ArchiveEvent[] {
    const v = obj.v as JsonObject | undefined;
    if (!v || typeof v !== 'object') {
      return [];
    }
    this.state = v;
    const inputState = v.inputState as JsonObject | undefined;
    const selectedModel = inputState?.selectedModel as JsonObject | undefined;
    this.meta = {
      sid: typeof v.sessionId === 'string' ? v.sessionId : '',
      title: typeof v.customTitle === 'string' ? v.customTitle : undefined,
      model: typeof selectedModel?.identifier === 'string' ? (selectedModel.identifier as string) : undefined,
      workspace: this.sourcePath,
    };
    // 初始快照里已经存在的历史轮次不会再收到增量补丁,必须在这里补发,
    // 否则日志被 VS Code 压缩重建后,早期对话会整段缺内容
    return this.emitExistingRequests();
  }

  /** 补发初始状态中已存在轮次的事件(用户消息 + 响应条目 + 用量) */
  private emitExistingRequests(): ArchiveEvent[] {
    const requests = this.state?.requests as unknown[] | undefined;
    if (!Array.isArray(requests)) {
      return [];
    }
    const events: ArchiveEvent[] = [];
    for (let idx = 0; idx < requests.length; idx += 1) {
      const req = requests[idx] as JsonObject | undefined;
      if (!req || typeof req !== 'object') {
        continue;
      }
      if (!this.userEmitted.has(idx)) {
        const result = req.result as JsonObject | undefined;
        const rendered = (result?.metadata as JsonObject | undefined)?.renderedUserMessage;
        const text = concatRenderedMessage(rendered).trim();
        if (text) {
          this.userEmitted.add(idx);
          events.push({ type: 'user', request: idx, text, time: this.requestTimestamp(idx) });
        }
      }
      const items = req.response as unknown[] | undefined;
      if (Array.isArray(items) && items.length > 0) {
        events.push(...this.emitResponseItems(idx, items as JsonObject[], 0));
      }
      this.emitUsage(idx, events);
    }
    return events;
  }

  private applyPatch(obj: JsonObject, now: number): ArchiveEvent[] {
    if (!this.state) {
      return [];
    }
    const k = obj.k as unknown[];
    const v = obj.v;
    if (!Array.isArray(k) || k.length === 0) {
      return [];
    }
    try {
      this.setByPointer(this.state, k, v);
    } catch {
      return [];
    }

    const events: ArchiveEvent[] = [];
    // 标题更新
    if (k.length === 1 && k[0] === 'customTitle' && typeof v === 'string' && this.meta) {
      this.meta.title = v;
    }
    // requests/N 出现结果后,从重建状态读取 renderedUserMessage → 用户消息事件
    if (k.length >= 2 && k[0] === 'requests' && typeof k[1] === 'number' && !this.userEmitted.has(k[1] as number)) {
      const idx = k[1] as number;
      const requests = this.state.requests as unknown[] | undefined;
      const req = requests?.[idx] as JsonObject | undefined;
      const result = req?.result as JsonObject | undefined;
      const rendered = (result?.metadata as JsonObject | undefined)?.renderedUserMessage;
      const text = concatRenderedMessage(rendered).trim();
      if (text) {
        this.userEmitted.add(idx);
        events.push({ type: 'user', request: idx, text, time: this.requestTimestamp(idx) });
        this.emitUsage(idx, events);
      }
    }
    return events;
  }

  private applySnapshot(obj: JsonObject, now: number): ArchiveEvent[] {
    const k = obj.k as unknown[];
    if (!Array.isArray(k) || k.length < 2 || k[0] !== 'requests' || k[k.length - 1] !== 'response') {
      return [];
    }
    if (typeof k[1] !== 'number' || !Array.isArray(obj.v)) {
      return [];
    }
    const idx = k[1] as number;
    const items = obj.v as JsonObject[];
    return this.emitResponseItems(idx, items, this.processed.get(idx) ?? 0);
  }

  /** 从一轮的响应条目列表发射事件(增量 start 起算;含工具结果的全量扫描去重) */
  private emitResponseItems(idx: number, items: JsonObject[], start: number): ArchiveEvent[] {
    const reqTime = this.requestTimestamp(idx);
    // 工具调用优先用各自轮次的时间戳:比"整轮共用请求时间"更接近真实
    const roundTimes = this.roundTimes(idx);
    const toolTimeByIndex = new Map<number, number>();
    let toolCursor = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item && typeof item === 'object' && item.kind === 'toolInvocationSerialized') {
        const own = itemTimestamp(item) ?? roundTimes[toolCursor];
        if (own !== undefined) {
          toolTimeByIndex.set(i, own);
        }
        toolCursor += 1;
      }
    }
    const events: ArchiveEvent[] = [];
    // 兜底:若用户消息已由 kind=1 发出但 usage 尚未发出(快照型会话),在此补发
    if (this.userEmitted.has(idx)) {
      this.emitUsage(idx, events);
    }
    for (let i = start; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== 'object') {
        continue;
      }
      const kind = item.kind as string | undefined;
      if (kind === 'toolInvocationSerialized') {
        const inv = item.invocationMessage;
        let text: string;
        if (typeof inv === 'string') {
          text = inv;
        } else if (inv && typeof inv === 'object' && typeof (inv as JsonObject).value === 'string') {
          text = (inv as JsonObject).value as string;
        } else {
          text = extractText(item);
        }
        const toolId = typeof item.toolId === 'string' ? (item.toolId as string) : undefined;
        const command = extractCommandLine(item);
        events.push({ type: 'tool', request: idx, text: cleanMarkdownRefs(text), toolId, command, time: toolTimeByIndex.get(i) ?? reqTime });
      } else if (kind === 'textEditGroup') {
        events.push({ type: 'edit', request: idx, text: extractText(item), time: itemTimestamp(item) ?? reqTime });
      } else if (kind === 'thinking') {
        // 思考条目的 id 通常是毫秒时间戳字符串,用其作为事件时间
        const thinkTs = typeof item.id === 'string' && /^\d{12,}$/.test(item.id) ? Number(item.id) : undefined;
        events.push({ type: 'thinking', request: idx, text: extractText(item), time: itemTimestamp(item) ?? thinkTs ?? reqTime });
      } else {
        // 纯文本 / 其他未知条目:视为助手文本
        events.push({ type: 'assistant', request: idx, text: extractText(item), time: itemTimestamp(item) ?? reqTime });
      }
    }
    this.processed.set(idx, items.length);

    // 工具结果:全量扫描(工具条目在后续快照中可能从"运行中"更新为"已完成"),
    // 按 toolCallId 去重,只为每个调用追加一次结果事件。
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== 'object' || item.kind !== 'toolInvocationSerialized') {
        continue;
      }
      const toolCallId = typeof item.toolCallId === 'string' ? (item.toolCallId as string) : undefined;
      const dedupKey = `${idx}:${toolCallId ?? i}`;
      if (this.resultEmitted.has(dedupKey)) {
        continue;
      }
      const result = extractToolResult(item);
      if (!result) {
        continue;
      }
      this.resultEmitted.add(dedupKey);
      const { timestamp, ...rest } = result;
      events.push({
        type: 'toolResult',
        request: idx,
        ...rest,
        time: timestamp ?? itemTimestamp(item) ?? toolTimeByIndex.get(i) ?? this.requestTimestamp(idx),
      });
    }
    return events;
  }

  /** 沿 JSON 指针路径设置值;路径中 list 下标越界时自动补位 */
  private setByPointer(root: JsonObject, k: unknown[], v: unknown): void {
    let node: unknown = root;
    for (let i = 0; i < k.length - 1; i++) {
      const seg = k[i];
      if (Array.isArray(node)) {
        const idx = Number(seg);
        while (node.length <= idx) {
          node.push(null);
        }
        if (node[idx] === null || typeof node[idx] !== 'object') {
          node[idx] = {};
        }
        node = node[idx];
      } else {
        const key = String(seg);
        const obj = node as JsonObject;
        if (obj[key] === null || typeof obj[key] !== 'object') {
          obj[key] = {};
        }
        node = obj[key];
      }
    }
    const last = k[k.length - 1];
    if (Array.isArray(node)) {
      const idx = Number(last);
      while (node.length <= idx) {
        node.push(null);
      }
      node[idx] = v;
    } else {
      (node as JsonObject)[String(last)] = v;
    }
  }
}

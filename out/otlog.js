"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.OtReplayer = void 0;
/** 从 response 条目里尽力提取可读文本 */
function extractText(item) {
    const direct = item.value ?? item.text;
    if (typeof direct === 'string' && direct.trim()) {
        return direct;
    }
    return JSON.stringify(item, null, 0);
}
/** 把 renderedUserMessage(片段列表)拼接为纯文本 */
function concatRenderedMessage(rendered) {
    if (!Array.isArray(rendered)) {
        return '';
    }
    const parts = [];
    for (const part of rendered) {
        if (part && typeof part === 'object' && typeof part.text === 'string') {
            parts.push(part.text);
        }
    }
    return parts.join('\n');
}
/** 提取终端类工具的完整命令原文 */
function extractCommandLine(item) {
    const tsd = item.toolSpecificData;
    if (!tsd) {
        return undefined;
    }
    const cl = tsd.commandLine;
    if (!cl) {
        return undefined;
    }
    const cmd = cl.original ?? cl.forDisplay;
    return typeof cmd === 'string' ? cmd : undefined;
}
/** 从 {value} 或字符串形式的消息对象中提取文本 */
function messageText(msg) {
    if (typeof msg === 'string') {
        return msg.trim();
    }
    if (msg && typeof msg === 'object' && typeof msg.value === 'string') {
        return msg.value.trim();
    }
    return '';
}
/** 清洗 VS Code 消息中的 Markdown 链接引用,如 `[](file:///e%3A/Code/a.py)` → `e:/Code/a.py` */
function cleanMarkdownRefs(s) {
    return s.replace(/\[\]\(([^)]+)\)/g, (_all, uri) => {
        const u = uri.replace(/^file:\/\//, '');
        try {
            return decodeURIComponent(u);
        }
        catch {
            return u;
        }
    });
}
/** 判定工具条目是否"已完成"且携带结果信息;若有则返回结果事件字段,否则返回 null */
function extractToolResult(item) {
    const toolId = typeof item.toolId === 'string' ? item.toolId : undefined;
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
    const tsd = item.toolSpecificData;
    const state = tsd?.terminalCommandState;
    let exitCode;
    let durationMs;
    let timestamp;
    if (state && typeof state === 'object') {
        if (typeof state.exitCode === 'number') {
            exitCode = state.exitCode;
        }
        if (typeof state.duration === 'number') {
            durationMs = state.duration;
        }
        if (typeof state.timestamp === 'number') {
            timestamp = state.timestamp;
        }
    }
    // 结构化结果条目(搜索/任务类工具的返回列表)
    const rawDetails = item.resultDetails;
    const details = [];
    if (Array.isArray(rawDetails)) {
        for (const d of rawDetails.slice(0, 30)) {
            if (d && typeof d === 'object') {
                const s = d.external ?? d.fsPath ?? d.path;
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
class OtReplayer {
    sourcePath;
    state = null;
    meta = null;
    /** request 下标 -> 已归档的 response 条目数(快照只增,按条数去重) */
    processed = new Map();
    /** 已发出 user 事件的 request 下标 */
    userEmitted = new Set();
    /** 已发出 toolResult 事件的工具调用(request:toolCallId) */
    resultEmitted = new Set();
    /** 已发出 usage 事件的 request 下标 */
    usageEmitted = new Set();
    constructor(sourcePath) {
        this.sourcePath = sourcePath;
    }
    /** 从重建状态中读取指定请求的原始时间戳 */
    requestTimestamp(idx) {
        const requests = this.state?.requests;
        const req = requests?.[idx];
        return typeof req?.timestamp === 'number' ? req.timestamp : undefined;
    }
    /** 请求完成后读取重建状态的最终 token 用量,每个请求仅发出一次 */
    emitUsage(idx, events) {
        if (this.usageEmitted.has(idx)) {
            return;
        }
        const requests = this.state?.requests;
        const req = requests?.[idx];
        const prompt = typeof req?.promptTokens === 'number' ? req.promptTokens : undefined;
        const completion = typeof req?.completionTokens === 'number' ? req.completionTokens : undefined;
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
    get sessionMeta() {
        return this.meta;
    }
    get hasState() {
        return this.state !== null;
    }
    /** 处理一行日志,返回此行新产生的归档事件 */
    process(line, now) {
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            return []; // 容错:无法解析的行跳过,绝不崩
        }
        const kind = obj.kind;
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
    initState(obj) {
        const v = obj.v;
        if (!v || typeof v !== 'object') {
            return [];
        }
        this.state = v;
        const inputState = v.inputState;
        const selectedModel = inputState?.selectedModel;
        this.meta = {
            sid: typeof v.sessionId === 'string' ? v.sessionId : '',
            title: typeof v.customTitle === 'string' ? v.customTitle : undefined,
            model: typeof selectedModel?.identifier === 'string' ? selectedModel.identifier : undefined,
            workspace: this.sourcePath,
        };
        return [];
    }
    applyPatch(obj, now) {
        if (!this.state) {
            return [];
        }
        const k = obj.k;
        const v = obj.v;
        if (!Array.isArray(k) || k.length === 0) {
            return [];
        }
        try {
            this.setByPointer(this.state, k, v);
        }
        catch {
            return [];
        }
        const events = [];
        // 标题更新
        if (k.length === 1 && k[0] === 'customTitle' && typeof v === 'string' && this.meta) {
            this.meta.title = v;
        }
        // requests/N 出现结果后,从重建状态读取 renderedUserMessage → 用户消息事件
        if (k.length >= 2 && k[0] === 'requests' && typeof k[1] === 'number' && !this.userEmitted.has(k[1])) {
            const idx = k[1];
            const requests = this.state.requests;
            const req = requests?.[idx];
            const result = req?.result;
            const rendered = result?.metadata?.renderedUserMessage;
            const text = concatRenderedMessage(rendered).trim();
            if (text) {
                this.userEmitted.add(idx);
                events.push({ type: 'user', request: idx, text, time: this.requestTimestamp(idx) });
                this.emitUsage(idx, events);
            }
        }
        return events;
    }
    applySnapshot(obj, now) {
        const k = obj.k;
        if (!Array.isArray(k) || k.length < 2 || k[0] !== 'requests' || k[k.length - 1] !== 'response') {
            return [];
        }
        if (typeof k[1] !== 'number' || !Array.isArray(obj.v)) {
            return [];
        }
        const idx = k[1];
        const items = obj.v;
        const start = this.processed.get(idx) ?? 0;
        const reqTime = this.requestTimestamp(idx);
        const events = [];
        // 兜底:若用户消息已由 kind=1 发出但 usage 尚未发出(快照型会话),在此补发
        if (this.userEmitted.has(idx)) {
            this.emitUsage(idx, events);
        }
        for (let i = start; i < items.length; i++) {
            const item = items[i];
            if (!item || typeof item !== 'object') {
                continue;
            }
            const kind = item.kind;
            if (kind === 'toolInvocationSerialized') {
                const inv = item.invocationMessage;
                let text;
                if (typeof inv === 'string') {
                    text = inv;
                }
                else if (inv && typeof inv === 'object' && typeof inv.value === 'string') {
                    text = inv.value;
                }
                else {
                    text = extractText(item);
                }
                const toolId = typeof item.toolId === 'string' ? item.toolId : undefined;
                const command = extractCommandLine(item);
                events.push({ type: 'tool', request: idx, text: cleanMarkdownRefs(text), toolId, command, time: reqTime });
            }
            else if (kind === 'textEditGroup') {
                events.push({ type: 'edit', request: idx, text: extractText(item), time: reqTime });
            }
            else if (kind === 'thinking') {
                // 思考条目的 id 通常是毫秒时间戳字符串,用其作为事件时间
                const thinkTs = typeof item.id === 'string' && /^\d{12,}$/.test(item.id) ? Number(item.id) : undefined;
                events.push({ type: 'thinking', request: idx, text: extractText(item), time: thinkTs ?? reqTime });
            }
            else {
                // 纯文本 / 其他未知条目:视为助手文本
                events.push({ type: 'assistant', request: idx, text: extractText(item), time: reqTime });
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
            const toolCallId = typeof item.toolCallId === 'string' ? item.toolCallId : undefined;
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
            events.push({ type: 'toolResult', request: idx, ...rest, time: timestamp ?? this.requestTimestamp(idx) });
        }
        return events;
    }
    /** 沿 JSON 指针路径设置值;路径中 list 下标越界时自动补位 */
    setByPointer(root, k, v) {
        let node = root;
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
            }
            else {
                const key = String(seg);
                const obj = node;
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
        }
        else {
            node[String(last)] = v;
        }
    }
}
exports.OtReplayer = OtReplayer;
//# sourceMappingURL=otlog.js.map
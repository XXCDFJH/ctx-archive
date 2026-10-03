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
exports.ArchivePanel = void 0;
/**
 * 图形化回溯面板(Webview):
 * - 左侧:归档会话列表(可搜索)
 * - 主区:选中会话的消息流(用户气泡 / 助手文本 / 工具调用卡片 / 编辑卡片 / 思考折叠)
 * - 工具栏:记录开关、导出 Markdown、刷新
 * - 底部:向当前会话追加注释(append-only)
 *
 * 数据只读自 append-only 归档;渲染用 DOM API + textContent,天然防注入。
 */
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const archive_1 = require("./archive");
const MAX_EVENTS = 5000;
const TRUNCATE_LEN = 5000;
/** postMessage 体积预算:超出时只发最近的部分(截断时保留最新内容) */
const MAX_PAYLOAD_BYTES = 6 * 1024 * 1024;
function truncate(s, max = TRUNCATE_LEN) {
    return s.length > max ? s.slice(0, max) + '\n…(已截断)' : s;
}
class ArchivePanel {
    archive;
    tracker;
    panel = null;
    log;
    constructor(archive, tracker) {
        this.archive = archive;
        this.tracker = tracker;
        this.log = vscode.window.createOutputChannel('Ctx Archive');
    }
    info(msg) {
        this.log.appendLine(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);
    }
    async show(file) {
        this.info(`show() called, file=${file ?? '(none)'}, panelExists=${this.panel !== null}`);
        try {
            if (this.panel) {
                this.panel.reveal();
                if (file) {
                    await this.sendSessionData(file);
                }
                else {
                    await this.sendSessionList();
                }
                return;
            }
            this.panel = vscode.window.createWebviewPanel('ctxArchive.panel', 'Ctx Archive 回溯', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
            this.info('webview panel created');
            this.panel.webview.html = this.buildHtml();
            this.info('webview html assigned');
        }
        catch (err) {
            this.info(`show() ERROR: ${String(err)}`);
            vscode.window.showErrorMessage(`Ctx Archive: 打开面板失败: ${String(err)}`);
            throw err;
        }
        this.panel.webview.onDidReceiveMessage(async (msg) => {
            try {
                this.info(`webview msg: ${msg.type}${msg.file ? ' ' + msg.file : ''}`);
                switch (msg.type) {
                    case 'ready':
                        await this.sendSessionList();
                        if (file) {
                            await this.sendSessionData(file);
                        }
                        break;
                    case 'selectSession':
                        if (msg.file) {
                            await this.sendSessionData(msg.file);
                        }
                        break;
                    case 'toggleRecording':
                        await vscode.commands.executeCommand('ctxArchive.toggleRecording');
                        await this.sendStatus();
                        break;
                    case 'export':
                        if (msg.file) {
                            await vscode.commands.executeCommand('ctxArchive.exportMarkdown', msg.file);
                        }
                        break;
                    case 'addNote': {
                        const text = (msg.text ?? '').trim();
                        if (!text) {
                            break;
                        }
                        const sid = msg.file ? path.basename(msg.file).replace(/\.jsonl$/, '') : this.tracker.getActiveSessionId() ?? 'manual-note';
                        await this.archive.append(sid, [{ type: 'note', request: 0, text }], { sid, title: '手动注释', workspace: 'panel' });
                        await this.sendSessionData(msg.file ?? path.join(this.archiveRoot(), `${sid}.jsonl`));
                        break;
                    }
                    case 'refresh':
                        await this.sendSessionList();
                        break;
                    case 'rebuild':
                        await vscode.commands.executeCommand('ctxArchive.rebuildArchives');
                        if (msg.file) {
                            await this.sendSessionData(msg.file);
                        }
                        else {
                            await this.sendSessionList();
                        }
                        break;
                }
            }
            catch (err) {
                this.info(`webview msg ERROR: ${String(err)}`);
            }
        });
        this.panel.onDidDispose(() => {
            this.info('panel disposed');
            this.panel = null;
        });
    }
    archiveRoot() {
        return vscode.workspace.getConfiguration('ctxArchive').get('outputDir') ?? '';
    }
    async sendStatus() {
        await this.panel?.webview.postMessage({
            type: 'status',
            recording: this.tracker.getEnabled(),
        });
    }
    async sendSessionList() {
        this.info('sendSessionList()');
        const list = await this.archive.listArchives();
        this.info(`listArchives -> ${list.length} sessions`);
        const sessions = list.map((item) => ({
            file: item.file,
            sid: item.header?.sid ?? path.basename(item.file).replace(/\.jsonl$/, ''),
            title: item.displayTitle,
            time: item.displayTime,
            timeMs: item.lastTime,
            startTime: item.startTime,
            count: item.count,
            model: item.header?.model ?? '',
        }));
        await this.panel?.webview.postMessage({ type: 'sessionList', sessions });
        await this.sendStatus();
    }
    async sendSessionData(file) {
        const r = await archive_1.Archive.readArchive(file);
        // 长会话只发最近的一段:截断时保留最新内容(早期内容已被更近的上下文取代),
        // 并用字节预算兜住消息体积
        const selected = [];
        let bytes = 0;
        for (let i = r.events.length - 1; i >= 0 && selected.length < MAX_EVENTS; i -= 1) {
            const e = r.events[i];
            const cost = (e.text !== undefined ? e.text.length : 0)
                + (e.command !== undefined ? e.command.length : 0) + 256;
            if (bytes + cost > MAX_PAYLOAD_BYTES && selected.length > 0) {
                break;
            }
            bytes += cost;
            selected.push(e);
        }
        selected.reverse();
        const events = selected.map((e) => ({
            type: e.type,
            seq: e.seq,
            time: e.time,
            request: e.request ?? 0,
            text: truncate(e.text ?? ''),
            toolId: e.toolId,
            command: e.command ? truncate(e.command, 4000) : undefined,
            exitCode: e.exitCode,
            durationMs: e.durationMs,
            details: e.details ? e.details.slice(0, 30).map((d) => truncate(d, 300)) : undefined,
            promptTokens: e.promptTokens,
            completionTokens: e.completionTokens,
        }));
        await this.panel?.webview.postMessage({
            type: 'sessionData',
            file,
            sid: r.header?.sid ?? path.basename(file).replace(/\.jsonl$/, ''),
            title: r.header?.title || (r.events.find((e) => e.type === 'user')?.text ?? '').slice(0, 60) || '未命名会话',
            model: r.header?.model ?? '',
            time: r.header ? new Date(r.header.time).toLocaleString() : '?',
            source: r.header?.source ?? '',
            total: r.events.length,
            truncated: selected.length < r.events.length,
            events,
        });
    }
    buildHtml() {
        const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
:root {
  --bubble-user: var(--vscode-button-background);
  --bubble-user-fg: var(--vscode-button-foreground);
  --card-bg: var(--vscode-editorWidget-background, rgba(128,128,128,.1));
  --border: var(--vscode-panel-border, rgba(128,128,128,.3));
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0; font-family: var(--vscode-font-family);
  color: var(--vscode-foreground); background: var(--vscode-editor-background);
  height: 100vh; display: flex; flex-direction: column; overflow: hidden;
}
header {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--border); flex: 0 0 auto;
}
header .title { font-weight: 600; font-size: 13px; }
header .spacer { flex: 1; }
#status-dot { width: 8px; height: 8px; border-radius: 50%; background: #4caf50; }
#status-dot.paused { background: #9e9e9e; }
button {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border: 1px solid var(--vscode-button-border, var(--border));
  padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px;
}
button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.2)); }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.main { flex: 1; display: flex; min-height: 0; }
#list {
  width: 260px; flex: 0 0 auto; overflow-y: auto; border-right: 1px solid var(--border);
  background: var(--vscode-sideBar-background);
}
#list-tools { display: flex; align-items: center; gap: 6px; padding: 8px; }
#search {
  flex: 1; min-width: 0; padding: 5px 8px; color: var(--vscode-input-foreground);
  background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 4px;
}
/* 排序小按钮(聊天列表 / 对话块共用) */
.mini {
  padding: 1px 8px; font-size: 10.5px; border-radius: 10px; white-space: nowrap;
  background: transparent; border: 1px solid var(--border); color: var(--vscode-foreground);
  cursor: pointer; opacity: .85; flex: 0 0 auto;
}
.mini:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); opacity: 1; }
.mini:focus-visible { outline: 1px solid var(--vscode-focusBorder, #3794ff); outline-offset: 1px; }
.session {
  padding: 8px 12px; cursor: pointer; border-bottom: 1px solid transparent;
}
.session:hover { background: var(--vscode-list-hoverBackground); }
.session.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.session .t { font-size: 12.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session .m { font-size: 11px; opacity: .75; margin-top: 2px; }
#feed { flex: 1; overflow-y: auto; padding: 12px 16px 24px; }
#feed-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
#feed-title { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; }
#feed-meta { font-size: 11px; opacity: .7; margin-bottom: 6px; }
#feed-stats {
  font-size: 11px; opacity: .85; margin-bottom: 12px; padding: 6px 10px;
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px;
  display: flex; flex-wrap: wrap; gap: 4px 14px;
}
#feed-stats b { font-weight: 600; }
/* ---- 时间总轴(固定总览轴,套用 DSH TrajectoryTimeline 方案) ---- */
#right { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
#timeline {
  flex: 0 0 auto; position: relative; user-select: none;
  border-bottom: 1px solid var(--border);
  background: var(--vscode-editorWidget-background, rgba(128,128,128,.06));
}
.tl-bar {
  display: flex; align-items: center; gap: 10px; padding: 4px 8px; font-size: 11px;
  border-bottom: 1px solid var(--border);
}
.tl-bar .tl-name { font-weight: 600; opacity: .9; }
.tl-bar .spacer { flex: 1; }
.tl-bar .tl-chip {
  padding: 1px 8px; border-radius: 9px; cursor: pointer;
  border: 1px solid var(--vscode-textLink-foreground, #3794ff);
  color: var(--vscode-textLink-foreground, #3794ff); white-space: nowrap;
}
.tl-bar .tl-hint { opacity: .55; font-size: 10.5px; white-space: nowrap; }
/* 模式按钮:四种投影收进一个可循环点击的按钮 */
.tl-mode-cycle {
  display: inline-flex; align-items: center; gap: 5px; padding: 1px 9px;
  background: transparent; border: 1px solid var(--border); border-radius: 10px;
  color: inherit; font: inherit; cursor: pointer; opacity: .9; white-space: nowrap;
}
.tl-mode-cycle:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); opacity: 1; }
.tl-mode-cycle:focus-visible { outline: 1px solid var(--vscode-focusBorder, #3794ff); outline-offset: 1px; }
.tl-mode-cycle .tl-mode-key { opacity: .5; font-size: 10px; }
.tl-mode-cycle .tl-mode-label { font-weight: 600; }
.tl-plot { display: grid; grid-template-columns: 44px minmax(0, 1fr); height: 50px; overflow: hidden; }
.tl-labels { position: relative; border-right: 1px solid var(--border); font-size: 10px; opacity: .8; }
.tl-labels span { position: absolute; right: 4px; height: 8px; line-height: 8px; }
.tl-labels span:nth-child(1) { top: 7px; }
.tl-labels span:nth-child(2) { top: 21px; }
.tl-labels span:nth-child(3) { top: 35px; }
.tl-track { position: relative; overflow: hidden; cursor: crosshair; touch-action: none; }
.tl-track:focus-visible { outline: 1px solid var(--vscode-focusBorder, #3794ff); outline-offset: -1px; }
.tl-track[data-panning='true'] { cursor: grabbing; }
/* 域容器:按缩放窗口拉伸,子元素一律用全域百分比定位 */
.tl-projected { position: absolute; top: 0; bottom: 0; left: var(--tl-domain-left); width: var(--tl-domain-width); }
.tl-turns, .tl-domain { position: absolute; top: 0; bottom: 0; left: 0; right: 0; }
.tl-turn { position: absolute; top: 0; bottom: 0; left: var(--tl-turn-left); width: .5px; background: var(--border); z-index: 3; }
.tl-span {
  position: absolute; top: calc(7px + var(--tl-span-lane) * 14px);
  left: calc(var(--tl-span-left) + var(--tl-span-gap));
  width: max(2px, calc(var(--tl-span-width) - var(--tl-span-gap) * 2));
  height: 8px; min-width: 2px; border-radius: 1px; background: #8a8a8a; opacity: .8; z-index: 2;
}
.tl-span[data-equal='true'] { width: 8px; min-width: 8px; }
.tl-span[data-kind='user'] { background: #4fc1ff; }
.tl-span[data-kind='assistant'] { background: #c586c0; }
.tl-span[data-kind='thinking'] { background: #8a8a8a; }
.tl-span[data-kind='tool'] { background: #e6b800; }
.tl-span[data-kind='toolResult'] { background: #4caf50; }
.tl-span[data-kind='edit'] { background: #d16969; }
.tl-span[data-kind='note'] { background: #e6d23c; }
.tl-span[data-error='true'] { background: #f14c4c; }
.tl-span[data-dim='true'] { opacity: .16; }
.tl-span[data-current='true'] {
  opacity: 1; z-index: 5;
  box-shadow: 0 0 0 1px var(--vscode-editor-background), 0 0 0 2px #3794ff;
}
.tl-sel {
  position: absolute; z-index: 1; top: 0; bottom: 0; min-width: 1px;
  left: var(--tl-sel-left); width: var(--tl-sel-width);
  background: rgba(55,148,255,.14); pointer-events: none;
}
.tl-sel-edges {
  position: absolute; z-index: 4; top: 0; bottom: 0; min-width: 1px;
  left: var(--tl-sel-left); width: var(--tl-sel-width); pointer-events: none;
}
.tl-sel-edges::before, .tl-sel-edges::after {
  content: ''; position: absolute; top: 0; bottom: 0; width: 1px; background: #3794ff;
}
.tl-sel-edges::before { left: 0; }
.tl-sel-edges::after { right: 0; }
.tl-hline {
  position: absolute; z-index: 4; top: 0; bottom: 0; left: var(--tl-hover-left);
  width: 1px; background: var(--vscode-foreground); opacity: .35; pointer-events: none;
}
.tl-empty { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 11px; opacity: .55; }
.tl-tip {
  position: fixed; z-index: 50; display: none; max-width: 340px; padding: 6px 9px;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--vscode-editorHoverWidget-background, #252526);
  color: var(--vscode-editorHoverWidget-foreground, #cccccc);
  font-size: 11px; line-height: 1.55; white-space: pre-line; pointer-events: none;
  box-shadow: 0 2px 10px rgba(0,0,0,.35);
}
.tl-node.dimmed { opacity: .2; }
.tl-node.focused .summary-row {
  border-color: var(--vscode-textLink-foreground, #3794ff);
  background: var(--vscode-list-hoverBackground);
}
/* ---- 时间轴 ---- */
.tl { position: relative; }
.tl-node { display: flex; align-items: flex-start; }
.tl-rail { position: relative; width: 16px; flex: 0 0 16px; align-self: stretch; }
.tl-rail::before {
  content: ''; position: absolute; left: 7px; top: 18px; bottom: -2px; width: 2px;
  background: var(--border);
}
.tl-node:last-child .tl-rail::before { display: none; }
.tl-rail .dot {
  position: absolute; left: 3px; top: 6px; width: 8px; height: 8px;
  border-radius: 50%; border: 2px solid var(--vscode-editor-background);
  background: var(--vscode-textLink-foreground, #3794ff);
  z-index: 1;
}
.tl-node.n-user .dot { background: var(--vscode-button-background, #0e639c); }
.tl-node.n-tool .dot { background: #e6b800; }
.tl-node.n-result .dot { background: #4caf50; }
.tl-node.n-edit .dot { background: #c586c0; }
.tl-node.n-thinking .dot { background: #9e9e9e; }
.tl-node.n-note .dot { background: #e6b800; }
.tl-node.n-usage .dot { background: #4fc1ff; }
.tl-meta {
  flex: 0 0 84px; text-align: right; padding-right: 12px; padding-top: 2px;
  font-size: 10px; opacity: .7; line-height: 1.3;
}
.tl-meta .t { white-space: nowrap; }
.tl-meta .tok { margin-top: 2px; font-size: 9.5px; color: #4fc1ff; opacity: .9; white-space: nowrap; }
.badge {
  display: inline-block; font-size: 10px; padding: 0 6px; border-radius: 8px;
  margin-top: 2px; border: 1px solid var(--border); opacity: .9; line-height: 1.6;
}
.b-user { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.b-assistant { color: var(--vscode-foreground); background: var(--card-bg); }
.b-tool { color: #e6b800; background: rgba(230,184,0,.12); }
.b-result { color: #4caf50; background: rgba(76,175,80,.12); }
.b-edit { color: #c586c0; background: rgba(197,134,192,.12); }
.b-thinking { color: #9e9e9e; background: rgba(158,158,158,.12); }
.b-note { color: #e6b800; background: rgba(230,184,0,.12); }
.b-usage { color: #4fc1ff; background: rgba(79,193,255,.12); }
.tl-body { flex: 1; min-width: 0; padding-bottom: 14px; padding-top: 1px; }
/* ---- 折叠概览行与展开详情 ---- */
.summary-row {
  cursor: pointer; padding: 3px 8px; border-radius: 6px;
  border: 1px solid transparent; font-size: 12.5px; line-height: 1.5;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.summary-row:hover { background: var(--vscode-list-hoverBackground); border-color: var(--border); }
.summary-row .s-icon { margin-right: 6px; }
.summary-row .s-type { opacity: .65; font-size: 11px; margin-right: 6px; }
/* 行内结果(借鉴 DSH:同一条记录直接展示 "调用 → 结果") */
.summary-row .s-arrow { opacity: .45; margin: 0 6px; }
.summary-row .s-result { opacity: .72; }
.summary-row .s-result.err { color: #f14c4c; opacity: .9; }
/* 折叠摘要行(整轮折叠后的合成行) */
.summary-row.folded { opacity: .72; font-style: italic; }
.tl-node.n-folded .dot { background: transparent; border-color: var(--border); }
.tl-node.n-folded .badge.b-folded { border-style: dashed; opacity: .7; }
.detail {
  margin-top: 6px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--vscode-editorWidget-background, rgba(128,128,128,.06));
  overflow: hidden; display: none;
}
.detail.open { display: block; }
.dtabs {
  display: flex; gap: 2px; padding: 4px 6px; border-bottom: 1px solid var(--border);
  background: rgba(0,0,0,.08); flex-wrap: wrap;
}
.dtab {
  background: transparent; border: 1px solid transparent; border-radius: 4px;
  padding: 3px 10px; font-size: 11.5px; cursor: pointer; color: var(--vscode-foreground);
}
.dtab:hover { background: var(--vscode-list-hoverBackground); }
.dtab.active {
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  border-color: var(--vscode-button-background);
}
.dpane { padding: 8px 10px; }
.dpane .ov-text { white-space: pre-wrap; word-break: break-word; font-size: 12.5px; line-height: 1.55; }
.dpane .ov-meta { margin-top: 6px; font-size: 11px; opacity: .75; }
.dpane .ov-meta span { margin-right: 12px; }
.raw-json {
  margin: 0; padding: 8px 10px; font-family: var(--vscode-editor-font-family);
  font-size: 11.5px; white-space: pre-wrap; word-break: break-all;
  background: rgba(0,0,0,.12); border-radius: 4px; max-height: 320px; overflow: auto;
}
.src-table { border-collapse: collapse; font-size: 12px; width: 100%; }
.src-table td { padding: 4px 10px 4px 0; border-bottom: 1px dashed var(--border); vertical-align: top; }
.src-table td:first-child { opacity: .65; width: 90px; white-space: nowrap; }
.src-table td:last-child { word-break: break-all; }
.user-bubble {
  display: inline-block; background: var(--bubble-user); color: var(--bubble-user-fg);
  border-radius: 10px 10px 2px 10px; padding: 8px 12px; white-space: pre-wrap; word-break: break-word;
  font-size: 12.5px;
}
.assistant-text { white-space: pre-wrap; word-break: break-word; line-height: 1.55; font-size: 12.5px; }
.tool-card, .result-card, .edit-card {
  border: 1px solid var(--border); border-radius: 6px; background: var(--card-bg);
  font-family: var(--vscode-editor-font-family); font-size: 12px; overflow: hidden;
}
.tool-card { border-left: 3px solid #e6b800; }
.result-card { border-left: 3px solid #4caf50; }
.edit-card { border-left: 3px solid #c586c0; }
.tool-card .head, .result-card .head, .edit-card .head {
  padding: 4px 10px; font-weight: 600; border-bottom: 1px solid var(--border); opacity: .95;
}
.tool-card .desc, .result-card .desc { padding: 6px 10px; white-space: pre-wrap; word-break: break-word; }
.result-card .desc { color: #b8e0b8; }
.tool-card pre, .result-card pre, .edit-card pre {
  margin: 0; padding: 6px 10px; white-space: pre-wrap; word-break: break-all;
  border-top: 1px dashed var(--border); background: rgba(0,0,0,.12);
}
.result-card .status { padding: 3px 10px; font-size: 11px; opacity: .8; border-top: 1px dashed var(--border); }
.result-card .details-list { border-top: 1px dashed var(--border); padding: 6px 10px; font-size: 11.5px; }
.result-card .details-list li { word-break: break-all; margin: 2px 0; }
details.thinking { border-left: 3px solid var(--vscode-textLink-foreground); padding-left: 10px; }
details.thinking summary { cursor: pointer; opacity: .8; font-size: 12px; }
details.thinking .body { white-space: pre-wrap; opacity: .85; font-size: 12.5px; margin-top: 6px; }
.note-text { background: var(--vscode-textBlockQuote-background, rgba(255,255,0,.06)); border-left: 3px solid #e6b800; padding: 6px 10px; font-size: 12.5px; white-space: pre-wrap; }
.usage-card {
  border: 1px solid var(--border); border-left: 3px solid #4fc1ff; border-radius: 6px;
  background: var(--card-bg); font-size: 12px; overflow: hidden; display: inline-block;
}
.usage-card .head { padding: 4px 10px; font-weight: 600; border-bottom: 1px solid var(--border); opacity: .95; }
.usage-row { display: flex; gap: 6px 16px; padding: 6px 10px; flex-wrap: wrap; }
.usage-row .u-item { white-space: nowrap; }
#composer {
  flex: 0 0 auto; display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border);
}
#composer input {
  flex: 1; padding: 6px 10px; color: var(--vscode-input-foreground);
  background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 4px;
}
.empty { padding: 40px 16px; text-align: center; opacity: .6; font-size: 13px; }
</style>
</head>
<body>
<header>
  <span class="title">Ctx Archive 回溯</span>
  <span id="status-dot" title="记录状态"></span>
  <span id="status-text" style="font-size:11px;opacity:.8"></span>
  <span class="spacer"></span>
  <button id="btn-toggle">暂停记录</button>
  <button id="btn-rebuild" title="从原始会话数据重建归档,提取工具指令与返回结果">重建归档</button>
  <button id="btn-export" title="导出当前会话为 Markdown">导出 MD</button>
  <button id="btn-refresh">刷新</button>
</header>
<div class="main">
  <div id="list">
    <div id="list-tools">
      <input id="search" type="text" placeholder="搜索标题 / ID...">
      <button id="btn-list-order" class="mini" title="聊天按时间排序"></button>
    </div>
    <div id="list-body"><div class="empty">加载中…</div></div>
  </div>
  <div id="right">
  <div id="timeline"></div>
  <div id="feed">
    <div id="feed-stats"></div>
    <div id="feed-head">
      <div id="feed-title"></div>
      <button id="btn-fold" class="mini" title="折叠 / 展开整轮对话" style="display:none"></button>
      <button id="btn-feed-order" class="mini" title="对话块按时间排序" style="display:none"></button>
    </div>
    <div id="feed-meta"></div>
    <div id="feed-body"><div class="empty">左侧选择一个会话开始回溯</div></div>
  </div>
  </div>
</div>
<div id="composer">
  <input id="note-input" type="text" placeholder="向当前会话追加一条注释 (append-only)...">
  <button id="btn-note" class="primary">追加</button>
</div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  let sessions = [];
  let currentFile = null;
  let recording = true;

  // 面板级偏好(排序、时间轴模式):统一存进一个持久化对象
  let panelState = {};
  try {
    const restored = typeof vscode.getState === 'function' ? vscode.getState() : null;
    if (restored !== null && typeof restored === 'object') panelState = restored;
  } catch (e) {
    panelState = {};
  }
  function saveState(patch) {
    panelState = Object.assign({}, panelState, patch);
    try {
      if (typeof vscode.setState === 'function') vscode.setState(panelState);
    } catch (e) {
      // 持久化失败不影响渲染
    }
  }
  /** 聊天列表顺序:desc=新→旧(默认),asc=旧→新 */
  let listOrder = panelState.listOrder === 'asc' ? 'asc' : 'desc';
  /** 对话块顺序:asc=旧→新(默认),desc=新→旧 */
  let feedOrder = panelState.feedOrder === 'desc' ? 'desc' : 'asc';
  /** 明细面板标签记忆(借鉴 DSH tabHistory) */
  let detailTab = typeof panelState.detailTab === 'string' ? panelState.detailTab : 'overview';
  /** 已折叠的轮次(按 request 编号,稳定键) */
  const collapsedRequests = new Set();
  /** 当前账本事件(供折叠/定位使用) */
  let feedEvents = [];
  /** 当前会话 id(切会话时重置折叠) */
  let feedSessionId = null;

  const $ = (id) => document.getElementById(id);
  const dot = $('status-dot'), statusText = $('status-text'), toggleBtn = $('btn-toggle');
  const listBody = $('list-body'), feedTitle = $('feed-title'), feedMeta = $('feed-meta');
  const feedStats = $('feed-stats'), timelineRoot = $('timeline'), feedBody = $('feed-body');
  const listOrderBtn = $('btn-list-order'), feedOrderBtn = $('btn-feed-order'), foldBtn = $('btn-fold');

  const BADGES = {
    user: ['输入', 'b-user'],
    assistant: ['助手', 'b-assistant'],
    tool: ['工具', 'b-tool'],
    toolResult: ['结果', 'b-result'],
    edit: ['编辑', 'b-edit'],
    thinking: ['思考', 'b-thinking'],
    note: ['注释', 'b-note'],
    usage: ['用量', 'b-usage'],
  };

  const fmtTime = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });

  function fmtDuration(ms) {
    if (ms < 60000) return Math.max(0, Math.round(ms / 1000)) + ' 秒';
    const totalMin = Math.floor(ms / 60000);
    if (totalMin < 60) {
      return totalMin + ' 分 ' + Math.round((ms % 60000) / 1000) + ' 秒';
    }
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h + ' 小时 ' + m + ' 分';
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function renderList(filter) {
    listBody.textContent = '';
    const q = (filter || '').toLowerCase();
    listOrderBtn.textContent = listOrder === 'asc' ? '时间 ↑' : '时间 ↓';
    listOrderBtn.title = listOrder === 'asc'
      ? '聊天按时间升序(旧 → 新),点击切换为降序'
      : '聊天按时间降序(新 → 旧),点击切换为升序';
    const items = sessions
      .filter(s => !q || s.title.toLowerCase().includes(q) || s.sid.toLowerCase().includes(q))
      .sort((a, b) => (listOrder === 'asc' ? a.timeMs - b.timeMs : b.timeMs - a.timeMs));
    if (items.length === 0) { listBody.appendChild(el('div', 'empty', '没有匹配的会话')); return; }
    for (const s of items) {
      const d = el('div', 'session' + (currentFile === s.file ? ' active' : ''));
      d.appendChild(el('div', 't', s.title));
      const meta = el('div', 'm', '最近 ' + s.time + ' · ' + s.count + ' 事件' + (s.model ? ' · ' + s.model : ''));
      meta.title = '最近活动:' + s.time
        + '\\n开始于:' + (s.startTime > 0 ? new Date(s.startTime).toLocaleString('zh-CN') : '未知');
      d.appendChild(meta);
      d.addEventListener('click', () => { currentFile = s.file; renderList(q); vscode.postMessage({ type: 'selectSession', file: s.file }); });
      listBody.appendChild(d);
    }
  }

  const TYPE_ICONS = { user: '👤', assistant: '🤖', tool: '🔧', toolResult: '✅', edit: '✏️', thinking: '💭', note: '📝', usage: '⚡' };

  /** 泳道归属:0=输入(含手动注释),1=模型,2=工具 */
  function laneOf(ev) {
    if (ev.type === 'user' || ev.type === 'note') return 0;
    if (ev.type === 'assistant' || ev.type === 'thinking') return 1;
    return 2;
  }

  /* ---- 时间总轴(固定总览轴,套用 DSH TrajectoryTimeline 方案) ----
   * 1) 轴的 DOM 一次构建,缩放/平移只改 CSS 变量,不重建节点
   * 2) 域容器按缩放窗口拉伸,子元素一律用全域百分比定位 → 缩放零重排
   * 3) 滚轮以鼠标为锚点缩放;左键拖动选区;右键拖动平移;拖到边缘自动平移
   * 4) 选区联动账本:未命中的节点淡出
   * 5) 两个开关组合出四种投影:顺序等宽 / 真实时间 / 真实耗时 / 空闲压缩
   */
  const TL_SHORT = {
    user: '输入', assistant: '助手', tool: '工具调用',
    toolResult: '返回结果', edit: '文件编辑', thinking: '思考', note: '注释',
  };
  const TL_MIN_DRAG_PX = 3;
  /** 超过该间隔视为挂机,不计入活动时长 */
  const TL_IDLE_GAP_MS = 30 * 60 * 1000;
  const TL_EDGE_ZONE_FRACTION = 0.08;
  const TL_EDGE_STEP_FRACTION = 0.025;
  const TL_EDGE_MAX_PX = 32;
  const TL_TIP_DELAY_MS = 400;

  let tlEvents = [];
  let tlModel = null;
  /** 投影模式表:一个按钮按此顺序循环切换 */
  const TL_MODES = [
    { key: 'sequence', label: '顺序', duration: false, time: false, hint: '按事件顺序等宽排布(不含真实时间)' },
    { key: 'time', label: '时间', duration: false, time: true, hint: '横坐标=真实时间戳,保留空闲间隙' },
    { key: 'duration', label: '时长', duration: true, time: false, hint: '宽度=真实耗时,压缩空闲间隙' },
    { key: 'actual', label: '实际', duration: true, time: true, hint: '完整真实轴:宽度=真实耗时且保留空闲' },
  ];
  let tlOpts = { duration: false, time: false };
  // 记住上次选择的模式(读取失败时退回顺序模式)
  for (const mode of TL_MODES) {
    if (mode.key === panelState.tlMode) tlOpts = { duration: mode.duration, time: mode.time };
  }
  let tlViewport = null;
  let tlRange = null;
  let tlDraft = null;
  let tlDrag = null;
  let tlPan = null;
  let tlTipTimer = null;
  let tlTipIndex = null;
  let tlSpanEls = new Map();
  let tlIndexToNode = new Map();
  let tlDom = null;
  const tlTip = el('div', 'tl-tip');
  document.body.appendChild(tlTip);

  function tlDurationMs(ev) {
    return typeof ev.durationMs === 'number' && isFinite(ev.durationMs) && ev.durationMs > 0 ? ev.durationMs : 0;
  }

  function fmtMs(ms) {
    return ms < 1000 ? Math.round(ms) + ' ms' : fmtDuration(ms);
  }

  function fmtTimeMs(t) {
    return new Date(t).toLocaleTimeString('zh-CN', { hour12: false, fractionalSecondDigits: 3 });
  }

  /** 两个开关 → 四种投影:顺序等宽 / 真实时间 / 真实耗时 / 空闲压缩 */
  function deriveModel() {
    const actualDuration = tlOpts.duration;
    const actualTime = tlOpts.time;
    const spans = [];
    const turnBounds = [];
    // 仅当两个开关都关闭才退回「按事件顺序等宽」;任一时间开关打开即按真实时间戳定位
    if (!actualDuration && !actualTime) {
      for (const ev of tlEvents) {
        spans.push({
          index: ev.__i, ev: ev, kind: ev.type, lane: laneOf(ev),
          start: spans.length, end: spans.length + 1,
        });
      }
      if (spans.length === 0) return null;
      let seen = null;
      for (const s of spans) {
        if (s.ev.request !== seen) { seen = s.ev.request; turnBounds.push({ request: seen, time: s.start }); }
      }
      return { start: 0, end: spans.length, spans: spans, turnBounds: turnBounds };
    }
    const raw = tlEvents.map((ev) => ({
      index: ev.__i, ev: ev, kind: ev.type, lane: laneOf(ev),
      start: ev.time, end: ev.time + tlDurationMs(ev),
    }));
    if (raw.length === 0) return null;
    // 空闲压缩:排序扫描累计被折叠掉的空隙,投影时统一减掉
    const compress = actualDuration && !actualTime;
    const removedBySpan = new Map();
    let removed = 0;
    let coveredUntil = null;
    for (const s of raw.slice().sort((a, b) => a.start - b.start || a.end - b.end)) {
      if (compress && coveredUntil !== null && s.start > coveredUntil) removed += s.start - coveredUntil;
      removedBySpan.set(s, removed);
      coveredUntil = coveredUntil === null ? s.end : Math.max(coveredUntil, s.end);
    }
    const projected = raw.map((s) => {
      const off = removedBySpan.get(s) || 0;
      return {
        index: s.index, ev: s.ev, kind: s.kind, lane: s.lane,
        start: s.start - off,
        end: (actualDuration ? s.end : s.start) - off,
      };
    });
    const firstByRequest = new Map();
    for (const s of projected) {
      const prev = firstByRequest.get(s.ev.request);
      if (prev === undefined || s.start < prev) firstByRequest.set(s.ev.request, s.start);
    }
    firstByRequest.forEach((t, request) => turnBounds.push({ request: request, time: t }));
    turnBounds.sort((a, b) => a.time - b.time);
    return {
      start: Math.min.apply(null, projected.map((s) => s.start)),
      end: Math.max.apply(null, projected.map((s) => s.end)),
      spans: projected,
      turnBounds: turnBounds,
    };
  }

  /** 当前可见域(视窗为空表示全域) */
  function tlDomain() {
    const full = Math.max(1, tlModel.end - tlModel.start);
    if (tlViewport === null) return { start: tlModel.start, duration: full, full: full };
    const dur = Math.min(full, Math.max(1, tlViewport.end - tlViewport.start));
    const start = Math.min(Math.max(tlViewport.start, tlModel.start), Math.max(tlModel.start, tlModel.end - dur));
    return { start: start, duration: dur, full: full };
  }

  function tlUpdateProjection() {
    if (tlDom === null || tlModel === null) return;
    const d = tlDomain();
    // 左偏移取负:容器被放大后向左移出,子元素的全域百分比才落回真实时间位置
    tlDom.projected.style.setProperty('--tl-domain-left', (-(d.start - tlModel.start) / d.duration * 100).toFixed(4) + '%');
    tlDom.projected.style.setProperty('--tl-domain-width', (d.full / d.duration * 100).toFixed(4) + '%');
  }

  function tlFocusIndexes() {
    if (tlModel === null || tlRange === null) return null;
    const set = new Set();
    for (const s of tlModel.spans) {
      if (s.start <= tlRange.end && s.end >= tlRange.start) set.add(s.index);
    }
    return set;
  }

  function tlFractionOfRange(range) {
    const d = tlDomain();
    const hi = Math.max(d.start, Math.min(d.start + d.duration, range.end));
    const lo = Math.max(d.start, Math.min(d.start + d.duration, range.start));
    return {
      start: (Math.min(lo, hi) - d.start) / d.duration,
      end: (Math.max(lo, hi) - d.start) / d.duration,
    };
  }

  function tlUpdateSelection() {
    if (tlDom === null || tlModel === null) return;
    const frac = tlDraft !== null ? tlFractionOfRange(tlDraft)
      : tlRange !== null ? tlFractionOfRange(tlRange) : null;
    if (frac === null) {
      tlDom.sel.style.display = 'none';
      tlDom.edges.style.display = 'none';
      return;
    }
    tlDom.sel.style.display = '';
    tlDom.edges.style.display = '';
    tlDom.sel.dataset.dragging = tlDraft !== null ? 'true' : 'false';
    [tlDom.sel, tlDom.edges].forEach((node) => {
      node.style.setProperty('--tl-sel-left', (frac.start * 100).toFixed(4) + '%');
      node.style.setProperty('--tl-sel-width', ((frac.end - frac.start) * 100).toFixed(4) + '%');
    });
  }

  function tlApplyLedgerFilter() {
    const focus = tlFocusIndexes();
    tlIndexToNode.forEach((node, index) => {
      const on = focus === null || focus.has(index);
      node.classList.toggle('dimmed', !on);
      node.classList.toggle('focused', focus !== null && on);
    });
    tlSpanEls.forEach((spanEl, index) => {
      if (focus === null || focus.has(index)) spanEl.removeAttribute('data-dim');
      else spanEl.dataset.dim = 'true';
    });
    if (tlDom === null) return;
    if (focus === null) {
      tlDom.chip.style.display = 'none';
      tlDom.chip.textContent = '';
    } else {
      tlDom.chip.style.display = '';
      tlDom.chip.textContent = '已选 ' + focus.size + ' / ' + tlEvents.length + ' 事件';
    }
  }

  function tlHideTip() {
    if (tlTipTimer) { clearTimeout(tlTipTimer); tlTipTimer = null; }
    tlTipIndex = null;
    tlTip.style.display = 'none';
  }

  function tlTipText(span) {
    const ev = span.ev;
    const head = (TL_SHORT[ev.type] || ev.type)
      + (ev.toolId ? ' · ' + ev.toolId : '')
      + ' · 请求 #' + ev.request + ' · seq ' + ev.seq;
    const d = tlDurationMs(ev);
    const range = fmtTimeMs(ev.time) + (d > 0 ? ' → ' + fmtTimeMs(ev.time + d) : '');
    const meta = [];
    if (d > 0) meta.push('耗时 ' + fmtMs(d));
    if (ev.exitCode !== undefined) meta.push('退出码 ' + ev.exitCode);
    if (ev.promptTokens !== undefined || ev.completionTokens !== undefined) {
      meta.push('tokens ' + fmtTok(ev.promptTokens) + ' + ' + fmtTok(ev.completionTokens));
    }
    return meta.length > 0 ? head + '\\n' + range + '\\n' + meta.join(' · ') : head + '\\n' + range;
  }

  function tlShowTip(span, clientX, clientY) {
    tlTip.textContent = tlTipText(span);
    tlTip.style.display = 'block';
    const w = tlTip.offsetWidth, h = tlTip.offsetHeight;
    const x = Math.min(clientX + 12, window.innerWidth - w - 8);
    const y = clientY + 16 + h > window.innerHeight ? clientY - h - 10 : clientY + 16;
    tlTip.style.left = Math.max(6, x) + 'px';
    tlTip.style.top = Math.max(6, y) + 'px';
  }

  function tlSpanAt(index) {
    if (tlModel === null) return null;
    for (const s of tlModel.spans) {
      if (s.index === index) return s;
    }
    return null;
  }

  function tlNearestIndex(time) {
    if (tlModel === null) return null;
    let best = null, bestGap = Infinity;
    for (const s of tlModel.spans) {
      const gap = time < s.start ? s.start - time : time > s.end ? time - s.end : 0;
      if (gap < bestGap) { bestGap = gap; best = s.index; }
    }
    return best;
  }

  function tlSelectRecord(index) {
    let node = tlIndexToNode.get(index);
    // 目标被折叠了就先展开整轮,再定位(否则点击时间轴会没有反应)
    if (node === undefined && collapsedRequests.size > 0) {
      const request = feedEvents[index] === undefined ? undefined : feedEvents[index].request;
      if (request !== undefined && collapsedRequests.has(request)) {
        collapsedRequests.delete(request);
        if (curData) renderFeed(curData);
        node = tlIndexToNode.get(index);
      }
    }
    tlSpanEls.forEach((spanEl, i) => {
      if (i === index) spanEl.dataset.current = 'true';
      else spanEl.removeAttribute('data-current');
    });
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function tlClearSelection() {
    tlRange = null;
    tlDraft = null;
    tlUpdateSelection();
    tlApplyLedgerFilter();
  }

  function tlCenterRange(center) {
    const d = tlDomain();
    const width = Math.min(Math.min(d.duration, d.full / Math.max(1, tlModel.spans.length)), d.full);
    const start = Math.min(Math.max(center - width / 2, tlModel.start), Math.max(tlModel.start, tlModel.end - width));
    return { start: start, end: start + width };
  }

  /** 当前模式在 TL_MODES 中的下标 */
  function tlModeIndex() {
    for (let i = 0; i < TL_MODES.length; i++) {
      if (TL_MODES[i].duration === tlOpts.duration && TL_MODES[i].time === tlOpts.time) return i;
    }
    return 0;
  }

  /** 同步模式按钮文案与提示,并记住选择 */
  function tlSyncModeButton() {
    if (tlDom === null) return;
    const mode = TL_MODES[tlModeIndex()];
    tlDom.modeLabel.textContent = mode.label;
    tlDom.modeBtn.title = '投影模式:' + mode.label + '(' + mode.hint + ')\\n点击切换到下一个模式';
    tlDom.modeBtn.setAttribute('aria-label', '投影模式 ' + mode.label + ',点击切换');
    saveState({ tlMode: mode.key });
  }

  /** 重建色块与分界线(会话切换或模式切换时调用;缩放/平移只改 CSS 变量) */
  function tlRebuild() {
    if (tlDom === null) return;
    tlSyncModeButton();
    tlDom.projected.textContent = '';
    tlDom.hline.style.display = 'none';
    tlSpanEls = new Map();
    tlModel = deriveModel();
    if (tlModel === null) {
      tlDom.empty.style.display = '';
      tlDom.sel.style.display = 'none';
      tlDom.edges.style.display = 'none';
      tlDom.chip.style.display = 'none';
      return;
    }
    tlDom.empty.style.display = 'none';
    const full = Math.max(1, tlModel.end - tlModel.start);
    const turns = el('div', 'tl-turns');
    for (const b of tlModel.turnBounds) {
      if (b.time <= tlModel.start) continue;
      const line = el('span', 'tl-turn');
      line.dataset.request = String(b.request);
      line.style.setProperty('--tl-turn-left', ((b.time - tlModel.start) / full * 100).toFixed(4) + '%');
      turns.appendChild(line);
    }
    const domain = el('div', 'tl-domain');
    for (const s of tlModel.spans) {
      const spanEl = el('span', 'tl-span');
      spanEl.dataset.kind = s.kind;
      spanEl.dataset.tlIndex = String(s.index);
      if (tlOpts.time && !tlOpts.duration) spanEl.dataset.equal = 'true';
      if (s.ev.exitCode !== undefined && s.ev.exitCode !== 0) spanEl.dataset.error = 'true';
      const wp = (s.end - s.start) / full * 100;
      spanEl.style.setProperty('--tl-span-left', ((s.start - tlModel.start) / full * 100).toFixed(4) + '%');
      spanEl.style.setProperty('--tl-span-width', wp.toFixed(4) + '%');
      spanEl.style.setProperty('--tl-span-gap', 'min(' + (wp * 0.08).toFixed(4) + '%, 1px)');
      spanEl.style.setProperty('--tl-span-lane', String(s.lane));
      tlSpanEls.set(s.index, spanEl);
      domain.appendChild(spanEl);
    }
    tlDom.projected.appendChild(turns);
    tlDom.projected.appendChild(domain);
    tlUpdateProjection();
    tlUpdateSelection();
    tlApplyLedgerFilter();
  }

  function tlFractionAt(clientX, rect) {
    return Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
  }

  function tlIndexAt(target) {
    const node = target instanceof HTMLElement ? target.closest('[data-tl-index]') : null;
    if (node === null) return null;
    const n = Number(node.dataset.tlIndex);
    return isFinite(n) ? n : null;
  }

  /** 会话数据 → 总览轴(骨架只建一次,后续按模式重建色块) */
  function buildTimeline(data) {
    tlDom = null;
    tlEvents = [];
    tlModel = null;
    tlRange = null;
    tlDraft = null;
    tlDrag = null;
    tlPan = null;
    tlViewport = null;
    tlIndexToNode = new Map();
    tlHideTip();
    for (let i = 0; i < data.events.length; i++) {
      const ev = data.events[i];
      if (ev.type === 'usage') continue;
      ev.__i = i;
      tlEvents.push(ev);
    }
    timelineRoot.textContent = '';

    const bar = el('div', 'tl-bar');
    const modeBtn = document.createElement('button');
    modeBtn.type = 'button';
    modeBtn.className = 'tl-mode-cycle';
    modeBtn.appendChild(el('span', 'tl-mode-key', '模式'));
    const modeLabel = el('span', 'tl-mode-label', '顺序');
    modeBtn.appendChild(modeLabel);
    modeBtn.addEventListener('click', () => {
      const next = TL_MODES[(tlModeIndex() + 1) % TL_MODES.length];
      tlOpts = { duration: next.duration, time: next.time };
      tlViewport = null;
      tlRebuild();
    });
    bar.appendChild(modeBtn);
    bar.appendChild(el('span', 'spacer'));
    const chip = el('span', 'tl-chip');
    chip.style.display = 'none';
    chip.title = '点击清除选区';
    chip.addEventListener('click', () => tlClearSelection());
    bar.appendChild(chip);
    bar.appendChild(el('span', 'tl-hint', '滚轮缩放 · 拖动选区 · 右键拖动平移 · Esc 清除'));
    timelineRoot.appendChild(bar);

    const plot = el('div', 'tl-plot');
    const labels = el('div', 'tl-labels');
    labels.appendChild(el('span', '', '输入'));
    labels.appendChild(el('span', '', '模型'));
    labels.appendChild(el('span', '', '工具'));
    plot.appendChild(labels);

    const track = el('div', 'tl-track');
    track.tabIndex = 0;
    const sel = el('div', 'tl-sel');
    const projected = el('div', 'tl-projected');
    const edges = el('div', 'tl-sel-edges');
    const hline = el('div', 'tl-hline');
    const empty = el('div', 'tl-empty', '无可显示的事件');
    track.appendChild(sel);
    track.appendChild(projected);
    track.appendChild(edges);
    track.appendChild(hline);
    track.appendChild(empty);
    plot.appendChild(track);
    timelineRoot.appendChild(plot);
    tlDom = { track: track, sel: sel, projected: projected, edges: edges, hline: hline, empty: empty, chip: chip, modeBtn: modeBtn, modeLabel: modeLabel };

    const domainTime = (fraction) => {
      const d = tlDomain();
      return d.start + fraction * d.duration;
    };

    // 滚轮缩放:以鼠标位置为锚点,只更新投影变量
    track.addEventListener('wheel', (e) => {
      if (tlModel === null) return;
      e.preventDefault();
      const rect = track.getBoundingClientRect();
      const frac = tlFractionAt(e.clientX, rect);
      const d = tlDomain();
      const isSequence = !tlOpts.duration && !tlOpts.time;
      const minDur = Math.min(isSequence ? 4 : 20, d.full);
      const nextDur = Math.min(d.full, Math.max(minDur, d.duration * Math.exp(e.deltaY * 0.0015)));
      if (nextDur >= d.full * 0.999) {
        tlViewport = null;
        tlUpdateProjection();
        return;
      }
      const anchor = d.start + frac * d.duration;
      const nextStart = Math.min(Math.max(anchor - frac * nextDur, tlModel.start), Math.max(tlModel.start, tlModel.end - nextDur));
      tlViewport = { start: nextStart, end: nextStart + nextDur };
      tlUpdateProjection();
    }, { passive: false });

    track.addEventListener('pointerdown', (e) => {
      if (tlModel === null) return;
      if (e.button === 2) {
        tlPan = { pointerId: e.pointerId, anchorX: e.clientX, anchorStart: tlDomain().start, moved: false, pannable: tlViewport !== null };
        track.dataset.panning = 'true';
        track.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      tlHideTip();
      const rect = track.getBoundingClientRect();
      const frac = tlFractionAt(e.clientX, rect);
      tlDrag = { pointerId: e.pointerId, anchorTime: domainTime(frac), anchorX: e.clientX, index: tlIndexAt(e.target), rect: rect };
      track.setPointerCapture(e.pointerId);
      tlDraft = { start: tlDrag.anchorTime, end: tlDrag.anchorTime };
      tlUpdateSelection();
    });

    track.addEventListener('pointermove', (e) => {
      if (tlModel === null) return;
      const rect = track.getBoundingClientRect();
      if (tlPan !== null && tlPan.pointerId === e.pointerId) {
        if (Math.abs(e.clientX - tlPan.anchorX) >= TL_MIN_DRAG_PX) tlPan.moved = true;
        if (!tlPan.pannable) return;
        const d = tlDomain();
        const delta = (e.clientX - tlPan.anchorX) / Math.max(1, rect.width);
        const nextStart = Math.min(Math.max(tlPan.anchorStart - delta * d.duration, tlModel.start), Math.max(tlModel.start, tlModel.end - d.duration));
        tlViewport = { start: nextStart, end: nextStart + d.duration };
        tlUpdateProjection();
        return;
      }
      const frac = tlFractionAt(e.clientX, rect);
      const index = tlIndexAt(e.target);
      if (tlDrag === null) {
        if (index === null) {
          tlHideTip();
          hline.style.display = '';
          hline.style.setProperty('--tl-hover-left', (frac * 100).toFixed(4) + '%');
        } else {
          hline.style.display = 'none';
          if (tlTipIndex !== index) {
            tlHideTip();
            tlTipIndex = index;
            const span = tlSpanAt(index);
            const cx = e.clientX, cy = e.clientY;
            if (span) {
              tlTipTimer = setTimeout(() => { tlTipTimer = null; tlShowTip(span, cx, cy); }, TL_TIP_DELAY_MS);
            }
          }
        }
        return;
      }
      if (tlDrag.pointerId !== e.pointerId) return;
      let domainStart = tlDomain().start;
      if (tlViewport !== null) {
        // 拖到边缘附近自动平移,越靠边越快
        const localX = e.clientX - rect.left;
        const edge = Math.min(TL_EDGE_MAX_PX, Math.max(1, rect.width * TL_EDGE_ZONE_FRACTION));
        const dir = localX < edge ? -1 : localX > rect.width - edge ? 1 : 0;
        if (dir !== 0) {
          const dist = dir < 0 ? edge - localX : localX - (rect.width - edge);
          const strength = Math.min(1, Math.max(0, dist / edge));
          const d = tlDomain();
          const desired = domainStart + dir * d.duration * TL_EDGE_STEP_FRACTION * Math.max(0.2, strength);
          const nextStart = Math.min(Math.max(desired, tlModel.start), Math.max(tlModel.start, tlModel.end - d.duration));
          if (nextStart !== domainStart) {
            tlViewport = { start: nextStart, end: nextStart + d.duration };
            tlUpdateProjection();
            domainStart = nextStart;
          }
        }
      }
      const point = domainStart + frac * tlDomain().duration;
      tlDraft = { start: Math.min(tlDrag.anchorTime, point), end: Math.max(tlDrag.anchorTime, point) };
      tlUpdateSelection();
    });

    track.addEventListener('pointerup', (e) => {
      if (tlModel === null) return;
      if (tlPan !== null && tlPan.pointerId === e.pointerId) {
        const moved = tlPan.moved || Math.abs(e.clientX - tlPan.anchorX) >= TL_MIN_DRAG_PX;
        tlPan = null;
        track.removeAttribute('data-panning');
        if (!moved) tlClearSelection();
        return;
      }
      if (tlDrag === null || tlDrag.pointerId !== e.pointerId) return;
      const rect = track.getBoundingClientRect();
      const frac = tlFractionAt(e.clientX, rect);
      const d = tlDomain();
      const point = d.start + frac * d.duration;
      const drag = tlDrag;
      tlDrag = null;
      tlDraft = null;
      const click = Math.abs(e.clientX - drag.anchorX) < TL_MIN_DRAG_PX;
      if (click && drag.index !== null) {
        tlClearSelection();
        tlSelectRecord(drag.index);
        return;
      }
      const start = Math.min(drag.anchorTime, point);
      const end = Math.max(drag.anchorTime, point);
      const minRange = Math.min(d.duration, d.full / Math.max(1, tlModel.spans.length));
      if (end - start < minRange) {
        const center = click ? start : (start + end) / 2;
        tlRange = tlCenterRange(center);
        if (click) {
          const nearest = tlNearestIndex(center);
          if (nearest !== null) tlSelectRecord(nearest);
        }
      } else {
        tlRange = { start: start, end: end };
      }
      tlUpdateSelection();
      tlApplyLedgerFilter();
    });

    track.addEventListener('pointercancel', () => {
      tlDrag = null;
      tlPan = null;
      tlDraft = null;
      track.removeAttribute('data-panning');
      tlUpdateSelection();
      tlHideTip();
    });
    track.addEventListener('pointerleave', () => {
      if (tlDrag === null && tlPan === null) {
        hline.style.display = 'none';
        tlHideTip();
      }
    });
    track.addEventListener('dblclick', (e) => {
      e.preventDefault();
      tlClearSelection();
    });
    track.addEventListener('contextmenu', (e) => e.preventDefault());
    track.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && tlRange !== null) {
        e.preventDefault();
        tlClearSelection();
      }
    });

    tlRebuild();
  }

  /** 当前会话上下文(供"来源"区块展示) */
  let curData = null;
  /** request -> {p, c}:每轮对话的 token 用量(由 usage 事件聚合,显示在各节点上) */
  let usageByReq = new Map();

  /** 概览文本:去除指令参数(反引号内容)与多余空白 */
  function stripBackticks(s) {
    return s.replace(/\`[^\`]*\`/g, '〈指令〉').replace(/\s+/g, ' ').trim();
  }

  /** 有界单行预览(借鉴 DSH trajectoryPreviewText):先截源文本再处理,成本有硬上限 */
  const PREVIEW_SOURCE_CHARS = 2048;
  function previewOf(text, limit) {
    const full = text === undefined || text === null ? '' : String(text);
    const source = full.slice(0, PREVIEW_SOURCE_CHARS);
    const compact = source.replace(/[>*_#\[\]]/g, '').replace(/\s+/g, ' ').trim();
    const preview = compact.slice(0, limit).trimEnd();
    return source.length < full.length || preview.length < compact.length ? preview + '…' : preview;
  }

  function summaryText(ev) {
    if (ev.type === 'usage') {
      return '输入 ' + fmtTok(ev.promptTokens) + ' · 输出 ' + fmtTok(ev.completionTokens);
    }
    const t = (ev.text || '').trim();
    if (!t) return '(空)';
    if (ev.type === 'tool') {
      return previewOf(stripBackticks(t), 140);
    }
    return previewOf(t, ev.type === 'thinking' ? 80 : 140);
  }

  /** token 数格式化:k/M 缩写 */
  function fmtTok(n) {
    if (n === undefined || n === null) return '-';
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  /** 预览区块:原格式化视图(气泡 / 卡片 / 折叠列表) */
  function previewContent(ev) {
    const wrap = el('div', '');
    if (ev.type === 'user') {
      wrap.appendChild(el('div', 'user-bubble', ev.text));
    } else if (ev.type === 'assistant') {
      wrap.appendChild(el('div', 'assistant-text', ev.text));
    } else if (ev.type === 'tool') {
      const card = el('div', 'tool-card');
      card.appendChild(el('div', 'head', '🔧 工具调用' + (ev.toolId ? ' · ' + ev.toolId : '')));
      card.appendChild(el('div', 'desc', ev.text));
      if (ev.command) {
        const det = el('details', '');
        det.appendChild(el('summary', '', '📜 指令'));
        det.appendChild(el('pre', '', ev.command));
        card.appendChild(det);
      }
      wrap.appendChild(card);
    } else if (ev.type === 'toolResult') {
      const card = el('div', 'result-card');
      const statusParts = [];
      if (ev.exitCode !== undefined) statusParts.push('退出码 ' + ev.exitCode);
      if (ev.durationMs !== undefined) statusParts.push(fmtDuration(ev.durationMs));
      card.appendChild(el('div', 'head', '✅ 返回结果' + (ev.toolId ? ' · ' + ev.toolId : '')));
      card.appendChild(el('div', 'desc', ev.text));
      if (statusParts.length > 0) {
        card.appendChild(el('div', 'status', statusParts.join(' · ')));
      }
      if (ev.details && ev.details.length > 0) {
        const det = el('details', 'details-list');
        det.appendChild(el('summary', '', '📋 明细 (' + ev.details.length + ')'));
        const ul = el('ul', '');
        for (const d of ev.details.slice(0, 30)) {
          ul.appendChild(el('li', '', d));
        }
        det.appendChild(ul);
        card.appendChild(det);
      }
      wrap.appendChild(card);
    } else if (ev.type === 'edit') {
      const card = el('div', 'edit-card');
      card.appendChild(el('div', 'head', '✏️ 文件编辑'));
      card.appendChild(el('pre', '', ev.text));
      wrap.appendChild(card);
    } else if (ev.type === 'thinking') {
      const det = el('details', 'thinking');
      det.appendChild(el('summary', '', '💭 思考'));
      det.appendChild(el('div', 'body', ev.text));
      wrap.appendChild(det);
    } else if (ev.type === 'note') {
      wrap.appendChild(el('div', 'note-text', '📝 ' + ev.text));
    } else if (ev.type === 'usage') {
      const card = el('div', 'usage-card');
      card.appendChild(el('div', 'head', '⚡ Token 用量'));
      const row = el('div', 'usage-row');
      row.appendChild(el('span', 'u-item', '输入 ' + (ev.promptTokens ?? '-' )));
      row.appendChild(el('span', 'u-item', '输出 ' + (ev.completionTokens ?? '-')));
      if (ev.promptTokens !== undefined && ev.completionTokens !== undefined) {
        row.appendChild(el('span', 'u-item', '合计 ' + (ev.promptTokens + ev.completionTokens)));
      }
      card.appendChild(row);
      wrap.appendChild(card);
    } else {
      wrap.appendChild(el('div', 'assistant-text', ev.text));
    }
    return wrap;
  }

  /** 来源区块:事件溯源信息表 */
  function sourceTable(ev) {
    const rows = [
      ['事件类型', ev.type],
      ['seq', String(ev.seq)],
      ['请求编号', '#' + ev.request],
      ['事件时间', new Date(ev.time).toLocaleString('zh-CN')],
      ['工具 ID', ev.toolId || '-'],
      ['会话 ID', curData ? curData.sid : '-'],
      ['归档文件', curData ? curData.file : '-'],
      ['原始来源', curData ? (curData.source || '-') : '-'],
      ['模型', curData ? (curData.model || '-') : '-'],
    ];
    const table = el('table', 'src-table');
    for (const [k, v] of rows) {
      const tr = el('tr', '');
      tr.appendChild(el('td', '', k));
      tr.appendChild(el('td', '', v));
      table.appendChild(tr);
    }
    return table;
  }

  /** 展开详情:概述 / 预览 / 原始内容 / 来源 四个区块 */
  function buildDetail(ev) {
    const detail = el('div', 'detail');
    const tabs = el('div', 'dtabs');
    const paneWrap = el('div', 'dpane');
    const panes = {};

    const ov = el('div', '');
    ov.appendChild(el('div', 'ov-text', ev.text));
    const om = el('div', 'ov-meta');
    if (ev.toolId) om.appendChild(el('span', '', '工具: ' + ev.toolId));
    if (ev.exitCode !== undefined) om.appendChild(el('span', '', '退出码: ' + ev.exitCode));
    if (ev.durationMs !== undefined) om.appendChild(el('span', '', '耗时: ' + fmtDuration(ev.durationMs)));
    ov.appendChild(om);
    panes.overview = ov;

    const pv = el('div', '');
    pv.appendChild(previewContent(ev));
    panes.preview = pv;

    const rw = el('div', '');
    rw.appendChild(el('pre', 'raw-json', JSON.stringify(ev, null, 2)));
    panes.raw = rw;

    const sc = el('div', '');
    sc.appendChild(sourceTable(ev));
    panes.source = sc;

    const defs = [['概述', 'overview'], ['预览', 'preview'], ['原始内容', 'raw'], ['来源', 'source']];
    // 标签记忆(借鉴 DSH):默认打开上次查看过的标签
    const initialTab = defs.some(([, key]) => key === detailTab) ? detailTab : 'overview';
    defs.forEach(([label, key]) => {
      const b = el('button', 'dtab' + (key === initialTab ? ' active' : ''), label);
      b.addEventListener('click', () => {
        tabs.querySelectorAll('.dtab').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        paneWrap.textContent = '';
        paneWrap.appendChild(panes[key]);
        detailTab = key;
        saveState({ detailTab: key });
      });
      tabs.appendChild(b);
    });
    paneWrap.appendChild(panes[initialTab]);
    detail.appendChild(tabs);
    detail.appendChild(paneWrap);
    return detail;
  }

  function tlNode(ev, index) {
    // 用量事件不单独渲染,而是聚合后显示在每个节点的 meta 区
    if (ev.type === 'usage') {
      return null;
    }
    const node = el('div', 'tl-node n-' + ev.type);
    node.id = 'req-anchor-' + ev.request;
    node.dataset.tlIndex = String(index);
    tlIndexToNode.set(index, node);
    const rail = el('div', 'tl-rail');
    rail.appendChild(el('span', 'dot'));
    node.appendChild(rail);
    const meta = el('div', 'tl-meta');
    meta.appendChild(el('div', 't', fmtTime(ev.time)));
    const badge = BADGES[ev.type] || ['事件', 'b-assistant'];
    const b = el('span', 'badge ' + badge[1], badge[0]);
    b.title = 'seq ' + ev.seq + ' · 请求 ' + ev.request;
    meta.appendChild(b);
    const u = usageByReq.get(ev.request);
    if (u && (u.p !== undefined || u.c !== undefined)) {
      const tt = el('div', 'tok', '⚡ ' + fmtTok(u.p) + '+' + fmtTok(u.c));
      tt.title = '本次对话 tokens: 输入 ' + (u.p ?? '-') + ' · 输出 ' + (u.c ?? '-');
      meta.appendChild(tt);
    }
    node.appendChild(meta);
    const body = el('div', 'tl-body');
    const summary = el('div', 'summary-row');
    summary.appendChild(el('span', 's-icon', TYPE_ICONS[ev.type] || '•'));
    if (ev.type === 'tool' && ev.toolId) {
      summary.appendChild(el('span', 's-type', ev.toolId));
    }
    summary.appendChild(el('span', '', summaryText(ev)));
    // 行内结果:同一条工具记录直接带上返回(借鉴 DSH 的"摘要 → 结果")
    const resultInfo = toolResultInfo.get(index);
    if (resultInfo !== undefined) {
      summary.appendChild(el('span', 's-arrow', '→'));
      summary.appendChild(el('span', 's-result' + (resultInfo.error ? ' err' : ''), resultInfo.text));
    }
    summary.title = '单击展开完整内容 · 双击折叠本轮';
    summary.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleRequestFold(ev.request);
    });
    body.appendChild(summary);
    // 明细面板延迟到首次展开时才构建:既让"标签记忆"对每条都生效,也避免为上千行预建 4 个面板
    let detail = null;
    summary.addEventListener('click', () => {
      if (detail === null) {
        detail = buildDetail(ev);
        body.appendChild(detail);
      }
      detail.classList.toggle('open');
    });
    node.appendChild(body);
    return node;
  }

  function renderEvents(data) {
    curData = data;
    if (feedSessionId !== data.sid) {
      feedSessionId = data.sid;
      collapsedRequests.clear();
    }
    buildTimeline(data);
    renderFeed(data);
  }

  /** 工具调用索引 → 行内结果预览(同轮次内先到先得) */
  let toolResultInfo = new Map();

  function syncFoldButton() {
    foldBtn.style.display = '';
    const active = collapsedRequests.size > 0;
    foldBtn.textContent = active ? '展开轮次' : '折叠轮次';
    foldBtn.title = active
      ? '展开全部轮次(恢复逐条显示)'
      : '折叠轮次:每轮只留首条 + 折叠摘要行';
  }

  /** 单轮折叠切换 */
  function toggleRequestFold(request) {
    if (collapsedRequests.has(request)) collapsedRequests.delete(request);
    else collapsedRequests.add(request);
    if (curData) renderFeed(curData);
  }

  /** 工具栏总开关:有展开的轮次就全折,否则全展 */
  function toggleAllFolds() {
    if (!curData) return;
    const counts = new Map();
    for (const e of curData.events) {
      if (e.type === 'usage') continue;
      counts.set(e.request, (counts.get(e.request) || 0) + 1);
    }
    const foldable = [];
    counts.forEach((n, request) => { if (n > 1) foldable.push(request); });
    // 与按钮文案一致:已有折叠就全部展开,否则全部折叠
    const active = collapsedRequests.size > 0;
    collapsedRequests.clear();
    if (!active) {
      for (const r of foldable) collapsedRequests.add(r);
    }
    renderFeed(curData);
  }

  /** 折叠摘要行(合成行:点击展开整轮) */
  function foldedRow(row) {
    const node = el('div', 'tl-node n-folded');
    const rail = el('div', 'tl-rail');
    rail.appendChild(el('span', 'dot'));
    node.appendChild(rail);
    const meta = el('div', 'tl-meta');
    meta.appendChild(el('div', 't', '轮次 #' + row.foldedRequest));
    meta.appendChild(el('span', 'badge b-folded', '已折叠'));
    node.appendChild(meta);
    const body = el('div', 'tl-body');
    const summary = el('div', 'summary-row folded');
    summary.appendChild(el('span', 's-icon', '…'));
    summary.appendChild(el('span', '', '折叠了 ' + row.count + ' 个事件'
      + (row.tools > 0 ? ' · ' + row.tools + ' 次工具调用' : '')
      + '(点击展开整轮)'));
    summary.title = '点击展开整轮';
    summary.addEventListener('click', () => {
      collapsedRequests.delete(row.foldedRequest);
      if (curData) renderFeed(curData);
    });
    body.appendChild(summary);
    node.appendChild(body);
    return node;
  }

  /** 账本渲染:标题 / 统计 / 对话块;feedOrder 决定对话块按时间升序或降序 */
  function renderFeed(data) {
    feedTitle.textContent = data.title;
    feedOrderBtn.style.display = '';
    feedOrderBtn.textContent = feedOrder === 'asc' ? '时间 ↑' : '时间 ↓';
    feedOrderBtn.title = feedOrder === 'asc'
      ? '对话块按时间升序(旧 → 新),点击切换为降序'
      : '对话块按时间降序(新 → 旧),点击切换为升序';
    feedMeta.textContent = '会话 ' + data.sid + ' · ' + data.time + ' · ' + data.total + ' 条事件' + (data.model ? ' · 模型 ' + data.model : '') + (data.total > data.events.length ? ' · 仅显示最近 ' + data.events.length + ' 条' : '');
    feedBody.textContent = '';
    if (data.events.length === 0) { feedStats.textContent = ''; feedBody.appendChild(el('div', 'empty', '该会话还没有可显示的事件')); return; }
    const nTool = data.events.filter(e => e.type === 'tool').length;
    const nResult = data.events.filter(e => e.type === 'toolResult').length;
    const maxReq = data.events.reduce((m, e) => Math.max(m, e.request), 0);
    // 活动时长:排除手动注释/用量事件,按时间排序后累加间隔,超长空闲(挂机)不计入
    let t0 = Infinity, t1 = -Infinity;
    const stamps = [];
    for (const e of data.events) {
      if (e.type === 'note' || e.type === 'usage') continue;
      if (!(typeof e.time === 'number' && e.time > 0)) continue;
      if (e.time < t0) t0 = e.time;
      if (e.time > t1) t1 = e.time;
      stamps.push(e.time);
    }
    // 聚合每轮 token 用量
    usageByReq = new Map();
    for (const e of data.events) {
      if (e.type === 'usage') {
        usageByReq.set(e.request, { p: e.promptTokens, c: e.completionTokens });
      }
    }
    const parts = [];
    if (isFinite(t0)) {
      stamps.sort((a, b) => a - b);
      let active = 0;
      for (let i = 1; i < stamps.length; i++) {
        active += Math.min(stamps[i] - stamps[i - 1], TL_IDLE_GAP_MS);
      }
      parts.push('🕒 活跃 ' + (active > 0 ? fmtDuration(active) : '—'));
      if (t1 > t0) parts.push('📏 跨度 ' + fmtDuration(t1 - t0));
    } else {
      parts.push('🕒 活跃 —');
    }
    parts.push('💬 ' + maxReq + ' 轮');
    if (nTool > 0) parts.push('🔧 ' + nTool + ' 次调用');
    if (nResult > 0) parts.push('✅ ' + nResult + ' 条结果');
    const tokIn = data.events.reduce((s, e) => s + (e.promptTokens || 0), 0);
    const tokOut = data.events.reduce((s, e) => s + (e.completionTokens || 0), 0);
    if (tokIn > 0 || tokOut > 0) parts.push('⚡ tokens ' + fmtTok(tokIn) + ' + ' + fmtTok(tokOut));
    parts.push('Σ ' + data.events.length + ' 事件');
    feedStats.textContent = '';
    parts.forEach((p) => feedStats.appendChild(el('b', '', p)));
    syncFoldButton();

    // 工具调用 → 结果 配对(同轮次内先到先得),供行内"→ 结果"预览
    feedEvents = data.events;
    toolResultInfo = new Map();
    const pendingTools = new Map();
    for (let i = 0; i < feedEvents.length; i++) {
      const e = feedEvents[i];
      if (e.type === 'tool') {
        const queue = pendingTools.get(e.request) || [];
        queue.push(i);
        pendingTools.set(e.request, queue);
      } else if (e.type === 'toolResult') {
        const queue = pendingTools.get(e.request);
        if (queue && queue.length > 0) {
          toolResultInfo.set(queue.shift(), {
            text: previewOf(e.text || '', 120),
            error: typeof e.exitCode === 'number' && e.exitCode !== 0,
          });
        }
      }
    }
    tlIndexToNode = new Map();
    // 对话块顺序:按事件时间排序(同一时间回退到 seq)。
    // 事件时间并非严格随 seq 递增(思考 id、工具轮次各有真实时间),所以不能用 seq 反序冒充时间倒序。
    const order = [];
    for (let i = 0; i < data.events.length; i++) {
      order.push(i);
    }
    order.sort((a, b) => {
      const ta = data.events[a].time;
      const tb = data.events[b].time;
      const ha = typeof ta === 'number' && ta > 0;
      const hb = typeof tb === 'number' && tb > 0;
      let cmp;
      if (ha && hb) {
        cmp = ta === tb ? a - b : ta - tb;
      } else if (ha !== hb) {
        cmp = ha ? -1 : 1;
      } else {
        cmp = a - b;
      }
      return feedOrder === 'asc' ? cmp : -cmp;
    });
    // 整轮折叠投影(借鉴 DSH:折叠在数据层做,渲染逻辑不分叉)
    const rows = [];
    for (const i of order) {
      const e = data.events[i];
      if (e.type === 'usage') continue;
      if (collapsedRequests.has(e.request)) {
        const prev = rows[rows.length - 1];
        if (prev !== undefined && prev.foldedRequest === e.request) {
          prev.count += 1;
          if (e.type === 'tool') prev.tools += 1;
          continue;
        }
        if (prev !== undefined && prev.index !== undefined
          && data.events[prev.index].request === e.request) {
          rows.push({ foldedRequest: e.request, count: 1, tools: e.type === 'tool' ? 1 : 0 });
          continue;
        }
      }
      rows.push({ index: i });
    }
    const list = el('div', 'tl');
    for (const row of rows) {
      if (row.foldedRequest !== undefined) {
        list.appendChild(foldedRow(row));
      } else {
        const n = tlNode(data.events[row.index], row.index);
        if (n) {
          list.appendChild(n);
        }
      }
    }
    feedBody.appendChild(list);
    tlApplyLedgerFilter();
    feedBody.scrollTop = feedOrder === 'desc' ? 0 : feedBody.scrollHeight;
  }

  function setRecording(on) {
    recording = on;
    dot.classList.toggle('paused', !on);
    statusText.textContent = on ? '记录中' : '已暂停';
    toggleBtn.textContent = on ? '暂停记录' : '开启记录';
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'sessionList') { sessions = m.sessions; renderList($('search').value); }
    else if (m.type === 'sessionData') {
      currentFile = m.file;
      m.sid = m.file.split('\\\\').pop().split('/').pop().replace(/\\.jsonl$/, '');
      renderList($('search').value);
      renderEvents(m);
    }
    else if (m.type === 'status') { setRecording(m.recording); }
  });

  $('search').addEventListener('input', (e) => renderList(e.target.value));
  listOrderBtn.addEventListener('click', () => {
    listOrder = listOrder === 'asc' ? 'desc' : 'asc';
    saveState({ listOrder: listOrder });
    renderList($('search').value);
  });
  feedOrderBtn.addEventListener('click', () => {
    feedOrder = feedOrder === 'asc' ? 'desc' : 'asc';
    saveState({ feedOrder: feedOrder });
    if (curData) {
      renderFeed(curData);
    }
  });
  foldBtn.addEventListener('click', () => { toggleAllFolds(); });
  toggleBtn.addEventListener('click', () => vscode.postMessage({ type: 'toggleRecording' }));
  $('btn-refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('btn-rebuild').addEventListener('click', () => vscode.postMessage({ type: 'rebuild', file: currentFile }));
  $('btn-export').addEventListener('click', () => { if (currentFile) vscode.postMessage({ type: 'export', file: currentFile }); });
  $('btn-note').addEventListener('click', () => {
    const input = $('note-input');
    if (input.value.trim()) { vscode.postMessage({ type: 'addNote', file: currentFile, text: input.value }); input.value = ''; }
  });
  $('note-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-note').click(); });

  // 总轴用百分比定位,窗口缩放无需重建(区别于旧的像素/分层实现)

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}
exports.ArchivePanel = ArchivePanel;
//# sourceMappingURL=webview.js.map
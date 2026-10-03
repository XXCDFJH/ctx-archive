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
const MAX_EVENTS = 2000;
const TRUNCATE_LEN = 5000;
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
            count: item.count,
            model: item.header?.model ?? '',
        }));
        await this.panel?.webview.postMessage({ type: 'sessionList', sessions });
        await this.sendStatus();
    }
    async sendSessionData(file) {
        const r = await archive_1.Archive.readArchive(file);
        const events = r.events.slice(0, MAX_EVENTS).map((e) => ({
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
#search {
  margin: 8px; width: calc(100% - 16px); padding: 5px 8px; color: var(--vscode-input-foreground);
  background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 4px;
}
.session {
  padding: 8px 12px; cursor: pointer; border-bottom: 1px solid transparent;
}
.session:hover { background: var(--vscode-list-hoverBackground); }
.session.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.session .t { font-size: 12.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session .m { font-size: 11px; opacity: .75; margin-top: 2px; }
#feed { flex: 1; overflow-y: auto; padding: 12px 16px 24px; }
#feed-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
#feed-meta { font-size: 11px; opacity: .7; margin-bottom: 6px; }
#feed-stats {
  font-size: 11px; opacity: .85; margin-bottom: 12px; padding: 6px 10px;
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px;
  display: flex; flex-wrap: wrap; gap: 4px 14px;
}
#feed-stats b { font-weight: 600; }
/* ---- 时间总轴(泳道图) ---- */
#gantt {
  margin-bottom: 10px; padding: 6px 8px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--card-bg);
}
#gantt .g-title { font-size: 10.5px; opacity: .75; margin-bottom: 4px; }
.g-row { display: flex; align-items: center; margin-bottom: 2px; }
.g-label { flex: 0 0 36px; font-size: 10.5px; opacity: .85; text-align: right; padding-right: 8px; white-space: nowrap; align-self: flex-start; padding-top: 3px; }
.g-track { position: relative; flex: 1; height: 14px; background: rgba(0,0,0,.10); border-radius: 4px; overflow: hidden; }
.g-block { position: absolute; border-radius: 2px; cursor: pointer; opacity: .85; min-width: 2px; }
.g-block:hover { opacity: 1; }
.g-block.sel { opacity: 1; outline: 1.5px solid #3794ff; outline-offset: 1px; z-index: 2; }
.g-playhead {
  position: absolute; top: -2px; bottom: -2px; width: 2px; background: #e6d23c;
  display: none; pointer-events: none; z-index: 3;
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
    <input id="search" type="text" placeholder="搜索标题 / ID...">
    <div id="list-body"><div class="empty">加载中…</div></div>
  </div>
  <div id="feed">
    <div id="feed-stats"></div>
    <div id="gantt"></div>
    <div id="feed-title"></div>
    <div id="feed-meta"></div>
    <div id="feed-body"><div class="empty">左侧选择一个会话开始回溯</div></div>
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

  const $ = (id) => document.getElementById(id);
  const dot = $('status-dot'), statusText = $('status-text'), toggleBtn = $('btn-toggle');
  const listBody = $('list-body'), feedTitle = $('feed-title'), feedMeta = $('feed-meta');
  const feedStats = $('feed-stats'), gantt = $('gantt'), feedBody = $('feed-body');

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
    const items = sessions.filter(s => !q || s.title.toLowerCase().includes(q) || s.sid.toLowerCase().includes(q));
    if (items.length === 0) { listBody.appendChild(el('div', 'empty', '没有匹配的会话')); return; }
    for (const s of items) {
      const d = el('div', 'session' + (currentFile === s.file ? ' active' : ''));
      d.appendChild(el('div', 't', s.title));
      d.appendChild(el('div', 'm', s.time + ' · ' + s.count + ' 事件' + (s.model ? ' · ' + s.model : '')));
      d.addEventListener('click', () => { currentFile = s.file; renderList(q); vscode.postMessage({ type: 'selectSession', file: s.file }); });
      listBody.appendChild(d);
    }
  }

  const TYPE_ICONS = { user: '👤', assistant: '🤖', tool: '🔧', toolResult: '✅', edit: '✏️', thinking: '💭', note: '📝', usage: '⚡' };

  /** 泳道归属:0=输入,1=模型,2=工具 */
  function laneOf(ev) {
    if (ev.type === 'user' || ev.type === 'note') return 0;
    if (ev.type === 'assistant' || ev.type === 'thinking') return 1;
    return 2;
  }

  /** 时间总轴:三泳道横向连续分段,每个事件一个色块,点击高亮并显示播放头 */
  let lastGanttData = null;
  function buildGantt(data) {
    lastGanttData = data;
    gantt.textContent = '';
    const evs = data.events.filter((e) => e.type !== 'usage' && e.type !== 'note');
    if (evs.length < 2) {
      gantt.appendChild(el('div', 'g-title', '时间总轴:事件过少,暂不显示'));
      return;
    }
    const t0 = evs.reduce((m, e) => Math.min(m, e.time), Infinity);
    const t1 = evs.reduce((m, e) => Math.max(m, e.time), -Infinity);
    const span = Math.max(1, t1 - t0);
    const leftPct = (t) => ((t - t0) / span) * 100;
    const names = ['输入', '模型', '工具'];
    const typeColors = {
      user: '#4fc1ff', assistant: '#c586c0', tool: '#e6b800',
      toolResult: '#4caf50', edit: '#d16969', thinking: '#8a8a8a',
    };
    const typeNames = {
      user: '输入', assistant: '助手', tool: '工具调用',
      toolResult: '返回结果', edit: '文件编辑', thinking: '思考',
    };
    /** 块宽自适应:事件越多越窄,夹在 1.5% ~ 4% 之间 */
    const blockWpct = (n) => Math.min(4, Math.max(1.5, (80 / Math.max(1, n)) * 0.8));
    const playheads = [];
    let selectedBlock = null;
    const selectBlock = (block, e) => {
      if (selectedBlock) {
        selectedBlock.classList.remove('sel');
      }
      block.classList.add('sel');
      selectedBlock = block;
      const center = parseFloat(block.style.left) + parseFloat(block.style.width) / 2;
      playheads.forEach((p) => {
        p.style.left = center + '%';
        p.style.display = 'block';
      });
      const anchor = feedBody.querySelector('#req-anchor-' + e.request);
      if (anchor) {
        anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    gantt.appendChild(el('div', 'g-title', '时间总轴(点击色块定位轮次)'));
    for (let li = 0; li < 3; li++) {
      const lane = evs.filter((e) => laneOf(e) === li).sort((a, b) => a.time - b.time || a.seq - b.seq);
      const byTime = new Map();
      for (const e of lane) {
        const list = byTime.get(e.time) || [];
        list.push(e);
        byTime.set(e.time, list);
      }
      const times = Array.from(byTime.keys()).sort((a, b) => a - b);
      const row = el('div', 'g-row');
      row.appendChild(el('div', 'g-label', names[li]));
      const track = el('div', 'g-track');
      const playhead = el('div', 'g-playhead');
      track.appendChild(playhead);
      playheads.push(playhead);
      const bw = blockWpct(lane.length);
      // 1) 同时刻事件先横向铺开(块宽递增),并钳制在轨道内
      const items = [];
      for (const t of times) {
        const list = byTime.get(t);
        list.forEach((e, j) => {
          items.push({ e, left: Math.min(leftPct(t) + j * bw, 100 - bw), layer: 0 });
        });
      }
      items.sort((a, b) => a.left - b.left || a.e.seq - b.e.seq);
      // 2) 仍横向重叠的块用贪心分层纵向错开,保证 y 方向不重叠
      const layerRight = [];
      for (const it of items) {
        let layer = 0;
        while (layer < 30 && layerRight[layer] !== undefined && layerRight[layer] > it.left) {
          layer++;
        }
        layerRight[layer] = it.left + bw;
        it.layer = layer;
      }
      const BH = 6; // 每层块高(px)
      track.style.height = Math.max(14, layerRight.length * BH + 2) + 'px';
      for (const it of items) {
        const block = el('div', 'g-block');
        block.style.left = it.left + '%';
        block.style.width = bw + '%';
        block.style.top = it.layer * BH + 1 + 'px';
        block.style.height = BH - 1 + 'px';
        block.style.background = typeColors[it.e.type] || '#8a8a8a';
        block.title = (typeNames[it.e.type] || it.e.type) + ' · 请求 #' + it.e.request + ' · seq ' + it.e.seq + ' · ' + fmtTime(it.e.time);
        block.addEventListener('click', () => selectBlock(block, it.e));
        track.appendChild(block);
      }
      row.appendChild(track);
      gantt.appendChild(row);
    }
  }

  /** 当前会话上下文(供"来源"区块展示) */
  let curData = null;
  /** request -> {p, c}:每轮对话的 token 用量(由 usage 事件聚合,显示在各节点上) */
  let usageByReq = new Map();

  /** 概览文本:去除指令参数(反引号内容)与多余空白 */
  function stripBackticks(s) {
    return s.replace(/\`[^\`]*\`/g, '〈指令〉').replace(/\s+/g, ' ').trim();
  }

  function summaryText(ev) {
    if (ev.type === 'usage') {
      return '输入 ' + fmtTok(ev.promptTokens) + ' · 输出 ' + fmtTok(ev.completionTokens);
    }
    const t = (ev.text || '').trim();
    if (!t) return '(空)';
    let s = ev.type === 'tool' ? stripBackticks(t) : t.replace(/\s+/g, ' ');
    const max = ev.type === 'thinking' ? 80 : 140;
    return s.length > max ? s.slice(0, max) + '…' : s;
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
    defs.forEach(([label, key], i) => {
      const b = el('button', 'dtab' + (i === 0 ? ' active' : ''), label);
      b.addEventListener('click', () => {
        tabs.querySelectorAll('.dtab').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        paneWrap.textContent = '';
        paneWrap.appendChild(panes[key]);
      });
      tabs.appendChild(b);
    });
    paneWrap.appendChild(panes.overview);
    detail.appendChild(tabs);
    detail.appendChild(paneWrap);
    return detail;
  }

  function tlNode(ev) {
    // 用量事件不单独渲染,而是聚合后显示在每个节点的 meta 区
    if (ev.type === 'usage') {
      return null;
    }
    const node = el('div', 'tl-node n-' + ev.type);
    node.id = 'req-anchor-' + ev.request;
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
    summary.title = '点击展开完整内容';
    body.appendChild(summary);
    const detail = buildDetail(ev);
    body.appendChild(detail);
    summary.addEventListener('click', () => {
      detail.classList.toggle('open');
    });
    node.appendChild(body);
    return node;
  }

  function renderEvents(data) {
    curData = data;
    buildGantt(data);
    feedTitle.textContent = data.title;
    feedMeta.textContent = '会话 ' + data.sid + ' · ' + data.time + ' · ' + data.total + ' 条事件' + (data.model ? ' · 模型 ' + data.model : '') + (data.total > data.events.length ? ' · 仅显示前 ' + data.events.length + ' 条' : '');
    feedBody.textContent = '';
    if (data.events.length === 0) { feedStats.textContent = ''; feedBody.appendChild(el('div', 'empty', '该会话还没有可显示的事件')); return; }
    const nTool = data.events.filter(e => e.type === 'tool').length;
    const nResult = data.events.filter(e => e.type === 'toolResult').length;
    const maxReq = data.events.reduce((m, e) => Math.max(m, e.request), 0);
    // 活跃时长:仅按会话实际活动事件(排除手动注释等外部事件)的最小/最大时间
    let t0 = Infinity, t1 = -Infinity;
    for (const e of data.events) {
      if (e.type === 'note' || e.type === 'usage') continue;
      if (e.time < t0) t0 = e.time;
      if (e.time > t1) t1 = e.time;
    }
    // 聚合每轮 token 用量
    usageByReq = new Map();
    for (const e of data.events) {
      if (e.type === 'usage') {
        usageByReq.set(e.request, { p: e.promptTokens, c: e.completionTokens });
      }
    }
    const parts = [];
    if (isFinite(t0)) parts.push('🕒 时长 ' + (t1 > t0 ? fmtDuration(t1 - t0) : '—'));
    parts.push('💬 ' + maxReq + ' 轮');
    if (nTool > 0) parts.push('🔧 ' + nTool + ' 次调用');
    if (nResult > 0) parts.push('✅ ' + nResult + ' 条结果');
    const tokIn = data.events.reduce((s, e) => s + (e.promptTokens || 0), 0);
    const tokOut = data.events.reduce((s, e) => s + (e.completionTokens || 0), 0);
    if (tokIn > 0 || tokOut > 0) parts.push('⚡ tokens ' + fmtTok(tokIn) + ' + ' + fmtTok(tokOut));
    parts.push('Σ ' + data.events.length + ' 事件');
    feedStats.textContent = '';
    parts.forEach((p) => feedStats.appendChild(el('b', '', p)));
    const tl = el('div', 'tl');
    for (const ev of data.events) {
      const n = tlNode(ev);
      if (n) {
        tl.appendChild(n);
      }
    }
    feedBody.appendChild(tl);
    feedBody.scrollTop = feedBody.scrollHeight;
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
  toggleBtn.addEventListener('click', () => vscode.postMessage({ type: 'toggleRecording' }));
  $('btn-refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('btn-rebuild').addEventListener('click', () => vscode.postMessage({ type: 'rebuild', file: currentFile }));
  $('btn-export').addEventListener('click', () => { if (currentFile) vscode.postMessage({ type: 'export', file: currentFile }); });
  $('btn-note').addEventListener('click', () => {
    const input = $('note-input');
    if (input.value.trim()) { vscode.postMessage({ type: 'addNote', file: currentFile, text: input.value }); input.value = ''; }
  });
  $('note-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-note').click(); });

  // 窗口缩放时重新渲染时间总轴(自适应宽度)
  let ganttResizeTimer = null;
  window.addEventListener('resize', () => {
    if (ganttResizeTimer) clearTimeout(ganttResizeTimer);
    ganttResizeTimer = setTimeout(() => {
      if (lastGanttData) buildGantt(lastGanttData);
    }, 120);
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}
exports.ArchivePanel = ArchivePanel;
//# sourceMappingURL=webview.js.map
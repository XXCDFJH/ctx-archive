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
exports.activate = activate;
exports.deactivate = deactivate;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const archive_1 = require("./archive");
const markdown_1 = require("./markdown");
const participant_1 = require("./participant");
const rebuild_1 = require("./rebuild");
const tracker_1 = require("./tracker");
const webview_1 = require("./webview");
const DEFAULT_OUTPUT_DIR = 'E:\\Code\\Agent\\ctx-archive';
/** 状态栏记录开关按钮(模块级,供 toggle 时刷新显示) */
let statusBarRec;
/** 刷新状态栏记录按钮外观 */
function refreshStatusBarRec(enabled) {
    if (!statusBarRec) {
        return;
    }
    statusBarRec.text = enabled ? '$(circle-filled) 记录中' : '$(circle-outline) 已暂停';
    statusBarRec.tooltip = enabled ? 'Ctx Archive: 点击暂停记录' : 'Ctx Archive: 点击开启记录';
    statusBarRec.color = enabled ? undefined : new vscode.ThemeColor('disabledForeground');
}
/** 切换记录开关(命令面板 / 输入框按钮共用) */
async function toggleRecording(tracker) {
    const cfg = vscode.workspace.getConfiguration('ctxArchive');
    const next = !(cfg.get('recordingEnabled') ?? true);
    await cfg.update('recordingEnabled', next, vscode.ConfigurationTarget.Global);
    tracker.setEnabled(next);
    refreshStatusBarRec(next);
    vscode.window.showInformationMessage(`Ctx Archive: 记录已${next ? '开启' : '暂停'}`);
}
function activate(context) {
    const log = vscode.window.createOutputChannel('Ctx Archive');
    const info = (msg) => log.appendLine(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);
    info('activate() start');
    try {
        const config = vscode.workspace.getConfiguration('ctxArchive');
        const root = config.get('outputDir') || DEFAULT_OUTPUT_DIR;
        info(`outputDir=${root}, recordingEnabled=${config.get('recordingEnabled')}`);
        const archive = new archive_1.Archive(root);
        const tracker = new tracker_1.Tracker(archive);
        tracker.setEnabled(config.get('recordingEnabled') ?? true);
        tracker.start(config.get('pollIntervalMs') ?? 5000);
        info('tracker started');
        const panel = new webview_1.ArchivePanel(archive, tracker);
        info('panel created');
        (0, participant_1.registerParticipant)(context, tracker, archive);
        info('participant registered');
        registerCommands(context, tracker, archive, root, panel);
        info('commands registered: openPanel/listSessions/exportMarkdown/openArchiveFolder/toggleRecording');
        // 状态栏兜底入口(不受聊天输入框菜单兼容性问题影响,始终可靠可点)
        const statusPanel = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
        statusPanel.text = '$(history) 回溯';
        statusPanel.tooltip = 'Ctx Archive: 打开图形回溯面板';
        statusPanel.command = 'ctxArchive.openPanel';
        statusPanel.show();
        context.subscriptions.push(statusPanel);
        statusBarRec = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        statusBarRec.command = 'ctxArchive.toggleRecording';
        refreshStatusBarRec(tracker.getEnabled());
        statusBarRec.show();
        context.subscriptions.push(statusBarRec);
        info('status bar items created');
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('ctxArchive.recordingEnabled')) {
                const enabled = vscode.workspace.getConfiguration('ctxArchive').get('recordingEnabled') ?? true;
                tracker.setEnabled(enabled);
                refreshStatusBarRec(enabled);
            }
        }));
        context.subscriptions.push({ dispose: () => tracker.dispose() });
        info('activate() done');
    }
    catch (err) {
        info(`activate() ERROR: ${String(err)}`);
        throw err;
    }
}
function registerCommands(context, tracker, archive, root, panel) {
    const log = vscode.window.createOutputChannel('Ctx Archive');
    const info = (msg) => log.appendLine(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);
    context.subscriptions.push(vscode.commands.registerCommand('ctxArchive.openPanel', async (fileArg) => {
        info(`openPanel command, fileArg=${fileArg ?? '(none)'}`);
        try {
            await panel.show(fileArg);
            info('openPanel command done');
        }
        catch (err) {
            info(`openPanel ERROR: ${String(err)}`);
            vscode.window.showErrorMessage(`Ctx Archive: 打开面板失败: ${String(err)}`);
        }
    }), vscode.commands.registerCommand('ctxArchive.listSessions', async () => {
        const list = await archive.listArchives();
        if (list.length === 0) {
            vscode.window.showInformationMessage('Ctx Archive: 还没有归档会话。正常使用 Copilot Chat 后自动记录。');
            return;
        }
        const picked = await vscode.window.showQuickPick(list.map((item) => ({
            label: item.displayTitle,
            description: `${item.displayTime} · ${item.count} 条事件`,
            detail: item.file,
            file: item.file,
        })), { placeHolder: '选择一个已归档会话' });
        if (!picked) {
            return;
        }
        const action = await vscode.window.showQuickPick([
            { label: '$(history) 图形回溯', action: 'panel' },
            { label: '$(markdown) 导出为 Markdown', action: 'export' },
            { label: '$(json) 打开原始归档 (JSONL)', action: 'open' },
        ], { placeHolder: '选择操作' });
        if (!action) {
            return;
        }
        if (action.action === 'panel') {
            await panel.show(picked.file);
        }
        else if (action.action === 'export') {
            await exportMarkdownFile(archive, picked.file, root);
        }
        else {
            const doc = await vscode.workspace.openTextDocument(picked.file);
            await vscode.window.showTextDocument(doc, { preview: true });
        }
    }), vscode.commands.registerCommand('ctxArchive.exportMarkdown', async (fileArg) => {
        let file = fileArg;
        if (!file) {
            const list = await archive.listArchives();
            if (list.length === 0) {
                vscode.window.showInformationMessage('Ctx Archive: 还没有归档会话。');
                return;
            }
            const picked = await vscode.window.showQuickPick(list.map((item) => ({ label: item.displayTitle, description: item.displayTime, file: item.file })), { placeHolder: '选择要导出的会话' });
            if (!picked) {
                return;
            }
            file = picked.file;
        }
        await exportMarkdownFile(archive, file, root);
    }), vscode.commands.registerCommand('ctxArchive.openArchiveFolder', async () => {
        await fs.promises.mkdir(root, { recursive: true });
        await vscode.env.openExternal(vscode.Uri.file(root));
    }), vscode.commands.registerCommand('ctxArchive.rebuildArchives', async () => {
        info('rebuildArchives command');
        const wasEnabled = tracker.getEnabled();
        tracker.setEnabled(false); // 暂停记录,避免重建期间并发追加
        try {
            const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Ctx Archive: 重建归档…' }, () => (0, rebuild_1.rebuildArchives)(root));
            archive.reset(); // 清空 seq 缓存,后续追加从重建后的文件接续
            info(`rebuild done: ${JSON.stringify(report)}`);
            const msg = `重建完成:成功 ${report.rebuilt} / 共 ${report.total}` +
                (report.skippedNoSource > 0 ? `,无源数据跳过 ${report.skippedNoSource}` : '') +
                (report.failed > 0 ? `,失败 ${report.failed}` : '');
            if (report.errors.length > 0) {
                info(`rebuild errors: ${report.errors.join(' | ')}`);
                vscode.window.showWarningMessage(`${msg}。详情见输出通道 Ctx Archive。`);
            }
            else {
                vscode.window.showInformationMessage(msg);
            }
        }
        finally {
            tracker.setEnabled(wasEnabled);
        }
    }), vscode.commands.registerCommand('ctxArchive.toggleRecording', () => toggleRecording(tracker)));
}
async function exportMarkdownFile(archive, file, root) {
    const r = await archive_1.Archive.readArchive(file);
    const md = (0, markdown_1.eventsToMarkdown)(r.header, r.events);
    const exportsDir = path.join(root, 'exports');
    await fs.promises.mkdir(exportsDir, { recursive: true });
    const title = r.header?.title || (r.events.find((e) => e.type === 'user')?.text ?? '').slice(0, 60);
    const outFile = path.join(exportsDir, `${(0, markdown_1.safeFileName)(title, r.header?.sid ?? 'session')}.md`);
    await fs.promises.writeFile(outFile, md, 'utf8');
    const doc = await vscode.workspace.openTextDocument(outFile);
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`Ctx Archive: 已导出 ${path.basename(outFile)}`);
}
function deactivate() {
    // tracker 通过 context.subscriptions 的 dispose 钩子清理
}
//# sourceMappingURL=extension.js.map
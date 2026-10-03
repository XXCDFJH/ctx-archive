import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Archive } from './archive';
import { eventsToMarkdown, safeFileName } from './markdown';
import { registerParticipant } from './participant';
import { rebuildArchives } from './rebuild';
import { Tracker } from './tracker';
import { ArchivePanel } from './webview';

const DEFAULT_OUTPUT_DIR = 'E:\\Code\\Agent\\ctx-archive';

/** 状态栏记录开关按钮(模块级,供 toggle 时刷新显示) */
let statusBarRec: vscode.StatusBarItem | undefined;

/** 刷新状态栏记录按钮外观 */
function refreshStatusBarRec(enabled: boolean): void {
  if (!statusBarRec) {
    return;
  }
  statusBarRec.text = enabled ? '$(circle-filled) 记录中' : '$(circle-outline) 已暂停';
  statusBarRec.tooltip = enabled ? 'Ctx Archive: 点击暂停记录' : 'Ctx Archive: 点击开启记录';
  statusBarRec.color = enabled ? undefined : new vscode.ThemeColor('disabledForeground');
}

/** 切换记录开关(命令面板 / 输入框按钮共用) */
async function toggleRecording(tracker: Tracker): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('ctxArchive');
  const next = !(cfg.get<boolean>('recordingEnabled') ?? true);
  await cfg.update('recordingEnabled', next, vscode.ConfigurationTarget.Global);
  tracker.setEnabled(next);
  refreshStatusBarRec(next);
  vscode.window.showInformationMessage(`Ctx Archive: 记录已${next ? '开启' : '暂停'}`);
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Ctx Archive');
  const info = (msg: string): void =>
    log.appendLine(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);

  info('activate() start');
  try {
    const config = vscode.workspace.getConfiguration('ctxArchive');
    const root = config.get<string>('outputDir') || DEFAULT_OUTPUT_DIR;
    info(`outputDir=${root}, recordingEnabled=${config.get<boolean>('recordingEnabled')}`);

    const archive = new Archive(root);
    const tracker = new Tracker(archive);
    tracker.setEnabled(config.get<boolean>('recordingEnabled') ?? true);
    tracker.start(config.get<number>('pollIntervalMs') ?? 5000);
    info('tracker started');

    const panel = new ArchivePanel(archive, tracker);
    info('panel created');
    registerParticipant(context, tracker, archive);
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

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('ctxArchive.recordingEnabled')) {
          const enabled = vscode.workspace.getConfiguration('ctxArchive').get<boolean>('recordingEnabled') ?? true;
          tracker.setEnabled(enabled);
          refreshStatusBarRec(enabled);
        }
      })
    );
    context.subscriptions.push({ dispose: () => tracker.dispose() });
    info('activate() done');
  } catch (err) {
    info(`activate() ERROR: ${String(err)}`);
    throw err;
  }
}

function registerCommands(
  context: vscode.ExtensionContext,
  tracker: Tracker,
  archive: Archive,
  root: string,
  panel: ArchivePanel
): void {
  const log = vscode.window.createOutputChannel('Ctx Archive');
  const info = (msg: string): void =>
    log.appendLine(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);

  context.subscriptions.push(
    vscode.commands.registerCommand('ctxArchive.openPanel', async (fileArg?: string) => {
      info(`openPanel command, fileArg=${fileArg ?? '(none)'}`);
      try {
        await panel.show(fileArg);
        info('openPanel command done');
      } catch (err) {
        info(`openPanel ERROR: ${String(err)}`);
        vscode.window.showErrorMessage(`Ctx Archive: 打开面板失败: ${String(err)}`);
      }
    }),
    vscode.commands.registerCommand('ctxArchive.listSessions', async () => {
      const list = await archive.listArchives();
      if (list.length === 0) {
        vscode.window.showInformationMessage('Ctx Archive: 还没有归档会话。正常使用 Copilot Chat 后自动记录。');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        list.map((item) => ({
          label: item.displayTitle,
          description: `${item.displayTime} · ${item.count} 条事件`,
          detail: item.file,
          file: item.file,
        })),
        { placeHolder: '选择一个已归档会话' }
      );
      if (!picked) {
        return;
      }
      const action = await vscode.window.showQuickPick(
        [
          { label: '$(history) 图形回溯', action: 'panel' },
          { label: '$(markdown) 导出为 Markdown', action: 'export' },
          { label: '$(json) 打开原始归档 (JSONL)', action: 'open' },
        ],
        { placeHolder: '选择操作' }
      );
      if (!action) {
        return;
      }
      if (action.action === 'panel') {
        await panel.show(picked.file);
      } else if (action.action === 'export') {
        await exportMarkdownFile(archive, picked.file, root);
      } else {
        const doc = await vscode.workspace.openTextDocument(picked.file);
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    }),
    vscode.commands.registerCommand('ctxArchive.exportMarkdown', async (fileArg?: string) => {
      let file = fileArg;
      if (!file) {
        const list = await archive.listArchives();
        if (list.length === 0) {
          vscode.window.showInformationMessage('Ctx Archive: 还没有归档会话。');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          list.map((item) => ({ label: item.displayTitle, description: item.displayTime, file: item.file })),
          { placeHolder: '选择要导出的会话' }
        );
        if (!picked) {
          return;
        }
        file = picked.file;
      }
      await exportMarkdownFile(archive, file, root);
    }),
    vscode.commands.registerCommand('ctxArchive.openArchiveFolder', async () => {
      await fs.promises.mkdir(root, { recursive: true });
      await vscode.env.openExternal(vscode.Uri.file(root));
    }),
    vscode.commands.registerCommand('ctxArchive.rebuildArchives', async () => {
      info('rebuildArchives command');
      const wasEnabled = tracker.getEnabled();
      tracker.setEnabled(false); // 暂停记录,避免重建期间并发追加
      try {
        const report = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Ctx Archive: 重建归档…' },
          () => rebuildArchives(root)
        );
        archive.reset(); // 清空 seq 缓存,后续追加从重建后的文件接续
        info(`rebuild done: ${JSON.stringify(report)}`);
        const msg =
          `重建完成:成功 ${report.rebuilt} / 共 ${report.total}` +
          (report.skippedNoSource > 0 ? `,无源数据跳过 ${report.skippedNoSource}` : '') +
          (report.failed > 0 ? `,失败 ${report.failed}` : '');
        if (report.errors.length > 0) {
          info(`rebuild errors: ${report.errors.join(' | ')}`);
          vscode.window.showWarningMessage(`${msg}。详情见输出通道 Ctx Archive。`);
        } else {
          vscode.window.showInformationMessage(msg);
        }
      } finally {
        tracker.setEnabled(wasEnabled);
      }
    }),
    vscode.commands.registerCommand('ctxArchive.toggleRecording', () => toggleRecording(tracker))
  );
}

async function exportMarkdownFile(archive: Archive, file: string, root: string): Promise<void> {
  const r = await Archive.readArchive(file);
  const md = eventsToMarkdown(r.header, r.events);
  const exportsDir = path.join(root, 'exports');
  await fs.promises.mkdir(exportsDir, { recursive: true });
  const title = r.header?.title || (r.events.find((e) => e.type === 'user')?.text ?? '').slice(0, 60);
  const outFile = path.join(exportsDir, `${safeFileName(title, r.header?.sid ?? 'session')}.md`);
  await fs.promises.writeFile(outFile, md, 'utf8');
  const doc = await vscode.workspace.openTextDocument(outFile);
  await vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage(`Ctx Archive: 已导出 ${path.basename(outFile)}`);
}

export function deactivate(): void {
  // tracker 通过 context.subscriptions 的 dispose 钩子清理
}

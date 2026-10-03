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
exports.registerParticipant = registerParticipant;
/**
 * @ctxlog chat participant:把"记录开关 + 内容回溯"集成到聊天界面。
 *
 * 子命令(斜杠命令,需在 package.json 的 chatParticipants.commands 中声明):
 *   /on          开启记录
 *   /off         暂停记录
 *   /status      查看记录状态
 *   /list        列出已归档会话(带回溯/导出按钮)
 *   /replay N    在聊天中回溯第 N 个会话(也支持 sid/标题关键词)
 *   无命令       追加一条注释到当前会话归档(原行为)
 */
const vscode = __importStar(require("vscode"));
const archive_1 = require("./archive");
const markdown_1 = require("./markdown");
const KNOWN_COMMANDS = ['on', 'off', 'status', 'list', 'replay'];
/** 从 prompt 中兜底解析命令(某些版本未识别斜杠命令时) */
function parseFallback(prompt) {
    const t = prompt.trim();
    const m = t.match(/^\/([a-zA-Z]+)\s*(.*)$/s);
    if (m && KNOWN_COMMANDS.includes(m[1].toLowerCase())) {
        return { command: m[1].toLowerCase(), arg: m[2].trim() };
    }
    return { command: '', arg: t };
}
async function setRecording(on, tracker) {
    tracker.setEnabled(on);
    await vscode.workspace
        .getConfiguration('ctxArchive')
        .update('recordingEnabled', on, vscode.ConfigurationTarget.Global);
}
/** 按编号 / sid / 标题关键词解析归档文件 */
async function resolveArchive(archive, arg) {
    const list = await archive.listArchives();
    if (list.length === 0) {
        return null;
    }
    const q = arg.trim().toLowerCase();
    if (/^\d+$/.test(q)) {
        const idx = Number(q);
        if (idx >= 1 && idx <= list.length) {
            return list[idx - 1].file;
        }
    }
    if (q) {
        for (const item of list) {
            const sid = item.header?.sid ?? '';
            if (sid.toLowerCase().includes(q)) {
                return item.file;
            }
        }
        for (const item of list) {
            if (item.displayTitle.toLowerCase().includes(q)) {
                return item.file;
            }
        }
    }
    // 未指定:回溯最近一个
    return list[0].file;
}
const MAX_INLINE = 20000;
function registerParticipant(context, tracker, archive) {
    const participant = vscode.chat.createChatParticipant('ctxlog', async (request, _chatContext, stream) => {
        const { command, arg } = request.command
            ? { command: request.command.toLowerCase(), arg: request.prompt.trim() }
            : parseFallback(request.prompt);
        switch (command) {
            case 'on':
                await setRecording(true, tracker);
                stream.markdown('✅ **Ctx Archive** 记录已开启。');
                break;
            case 'off':
                await setRecording(false, tracker);
                stream.markdown('⏸ **Ctx Archive** 记录已暂停。用 `/on` 恢复。');
                break;
            case 'status': {
                const cfg = vscode.workspace.getConfiguration('ctxArchive');
                const list = await archive.listArchives();
                const state = tracker.getEnabled() ? '🟢 记录中' : '⏸ 已暂停';
                stream.markdown(`**Ctx Archive 状态**\n\n` +
                    `- ${state}\n` +
                    `- 归档目录: \`${cfg.get('outputDir')}\`\n` +
                    `- 已归档会话: ${list.length} 个\n\n` +
                    `输入 \`@ctxlog /list\` 查看列表。`);
                break;
            }
            case 'list': {
                const list = await archive.listArchives();
                if (list.length === 0) {
                    stream.markdown('还没有归档会话。正常使用 Copilot Chat 后会自动记录。');
                    break;
                }
                const rows = list
                    .map((item, i) => `| ${i + 1} | ${item.displayTitle.replace(/\|/g, '\\|')} | ${item.count} | ${item.displayTime} |`)
                    .join('\n');
                stream.markdown(`共 **${list.length}** 个已归档会话:\n\n| # | 标题 | 事件数 | 归档时间 |\n|---|------|-------|---------|\n${rows}\n\n` +
                    `输入 \`@ctxlog /replay 编号\` 在聊天中回溯;或点击下方按钮。`);
                const limit = Math.min(list.length, 10);
                for (let i = 0; i < limit; i++) {
                    stream.button({
                        command: 'ctxArchive.openPanel',
                        title: `图形回溯 #${i + 1}`,
                        arguments: [list[i].file],
                    });
                    stream.button({
                        command: 'ctxArchive.exportMarkdown',
                        title: `导出 #${i + 1}`,
                        arguments: [list[i].file],
                    });
                }
                break;
            }
            case 'replay': {
                const file = await resolveArchive(archive, arg);
                if (!file) {
                    stream.markdown('找不到归档会话。试试 `@ctxlog /list`。');
                    break;
                }
                const r = await archive_1.Archive.readArchive(file);
                const md = (0, markdown_1.eventsToMarkdown)(r.header, r.events);
                const truncated = md.length > MAX_INLINE;
                stream.markdown(truncated
                    ? md.slice(0, MAX_INLINE) + '\n\n---\n\n*(内容过长已截断,点击下方按钮查看图形回溯)*'
                    : md);
                stream.button({ command: 'ctxArchive.openPanel', title: '打开图形回溯', arguments: [file] });
                break;
            }
            default: {
                // 注释(note)
                const text = request.prompt.trim();
                if (!text) {
                    stream.markdown('`@ctxlog` 用法:\n\n- 直接输入内容 → 追加注释到当前会话归档\n' +
                        '- `/on` `/off` 开启/暂停记录\n' +
                        '- `/status` 查看状态\n' +
                        '- `/list` 列出归档会话\n' +
                        '- `/replay 编号` 回溯会话内容');
                    break;
                }
                const sid = tracker.getActiveSessionId() ?? 'manual-note';
                const now = Date.now();
                await archive.append(sid, [{ type: 'note', request: 0, text }], { sid, title: '手动注释', workspace: 'ctxlog participant' }, now);
                stream.markdown(`✅ 已以 append-only 方式追加到归档 \`${sid}\``);
                break;
            }
        }
        return { metadata: { command: command ?? '' } };
    });
    context.subscriptions.push(participant);
}
//# sourceMappingURL=participant.js.map
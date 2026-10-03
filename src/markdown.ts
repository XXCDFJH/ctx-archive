/**
 * 从归档事件派生 Markdown 视图(事件溯源:不存第二份对话文本,回放即派生)。
 */
import type { ArchiveHeader, StoredEvent } from './archive';

function section(level: number, icon: string, title: string): string {
  return `${'#'.repeat(level)} ${icon} ${title}\n\n`;
}

export function eventsToMarkdown(header: ArchiveHeader | null, events: StoredEvent[]): string {
  const lines: string[] = [];
  const firstUser = events.find((e) => e.type === 'user');
  const title = header?.title || (firstUser?.text ? firstUser.text.replace(/\s+/g, ' ').slice(0, 60) : '未命名会话');

  lines.push(`# ${title}\n`);
  lines.push(`> 会话 \`${header?.sid ?? '?'}\` · 归档时间 ${header ? new Date(header.time).toLocaleString() : '?'}`);
  if (header?.model) {
    lines.push(`>\n> 模型: \`${header.model}\``);
  }
  if (header?.source) {
    lines.push(`>\n> 来源: \`${header.source}\``);
  }
  lines.push('');

  for (const ev of events) {
    switch (ev.type) {
      case 'user':
        lines.push(section(2, '👤', `用户 · 请求 ${ev.request ?? '?'}`));
        lines.push(ev.text ?? '');
        lines.push('');
        break;
      case 'assistant':
        lines.push(section(3, '🤖', `回复 · 请求 ${ev.request ?? '?'}`));
        lines.push(ev.text ?? '');
        lines.push('');
        break;
      case 'tool':
        lines.push(section(3, '🔧', `工具调用 · 请求 ${ev.request ?? '?'}`));
        if (ev.toolId) {
          lines.push(`> 工具: \`${ev.toolId}\``);
          lines.push('');
        }
        if (ev.command) {
          lines.push('指令:');
          lines.push('```text');
          lines.push(ev.command);
          lines.push('```');
          lines.push('');
        }
        lines.push(ev.text ?? '');
        lines.push('');
        break;
      case 'toolResult':
        lines.push(section(3, '✅', `返回结果 · 请求 ${ev.request ?? '?'}`));
        if (ev.toolId) {
          lines.push(`> 工具: \`${ev.toolId}\``);
          lines.push('');
        }
        lines.push(ev.text ?? '');
        if (ev.exitCode !== undefined || ev.durationMs !== undefined) {
          const parts: string[] = [];
          if (ev.exitCode !== undefined) {
            parts.push(`退出码 \`${ev.exitCode}\``);
          }
          if (ev.durationMs !== undefined) {
            parts.push(`耗时 \`${(ev.durationMs / 1000).toFixed(1)}s\``);
          }
          lines.push(`> ${parts.join(' · ')}`);
        }
        if (ev.details && ev.details.length > 0) {
          lines.push('');
          lines.push(ev.details.map((d) => `- \`${d}\``).join('\n'));
        }
        lines.push('');
        break;
      case 'edit':
        lines.push(section(3, '✏️', `文件编辑 · 请求 ${ev.request ?? '?'}`));
        lines.push(ev.text ?? '');
        lines.push('');
        break;
      case 'thinking':
        lines.push('<details>');
        lines.push(`<summary>💭 思考 · 请求 ${ev.request ?? '?'}</summary>`);
        lines.push('');
        lines.push(ev.text ?? '');
        lines.push('');
        lines.push('</details>');
        lines.push('');
        break;
      case 'note':
        lines.push(section(3, '📝', '注释'));
        lines.push(`> ${ev.text ?? ''}`);
        lines.push('');
        break;
      case 'usage': {
        const parts: string[] = [];
        if (ev.promptTokens !== undefined) {
          parts.push(`输入 \`${ev.promptTokens}\``);
        }
        if (ev.completionTokens !== undefined) {
          parts.push(`输出 \`${ev.completionTokens}\``);
        }
        lines.push(section(3, '⚡', `Token 用量 · 请求 ${ev.request ?? '?'}`));
        lines.push(`> ${parts.join(' · ')}`);
        lines.push('');
        break;
      }
    }
  }

  lines.push(`---\n\n*由 Ctx Archive 从 append-only 归档派生,共 ${events.length} 条事件。*`);
  return lines.join('\n');
}

/** 生成安全文件名 */
export function safeFileName(title: string, fallback: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

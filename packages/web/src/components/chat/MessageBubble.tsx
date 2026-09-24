import type { Message } from '@/types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolGroup } from './ToolGroup';
import type { ToolGroupDisplayItem } from '@/utils/messageIdentity';
import { getQuickJumpKind } from './messageFilter';

export type GroupedItem = Message | ToolGroupDisplayItem;
type PrevRole = Message['role'] | 'tool' | null;

/** Role used for spacing decisions. Tool groups behave like 'tool'. */
export function getItemRole(item: GroupedItem): PrevRole {
  if ('type' in item && item.type === 'tool_group') return 'tool';
  return (item as Message).role;
}

/** Kimi-style variant-aware top spacing.
 *  Mirrors kimi-cli's virtualized-message-list spacing rules:
 *  user pt-4, assistant-after-user pt-2, consecutive-assistant pt-1,
 *  tool pt-1.5, thinking pt-1.
 *
 * Padding is intentional here. A margin inside a measured virtual row can
 * collapse outside the row, making its cached height smaller than its painted
 * content and allowing the next row to overlap it. */
function marginTopClass(role: PrevRole, prevRole: PrevRole): string {
  if (!prevRole) return '';
  if (role === 'user') return 'pt-4';
  if (role === 'assistant') return prevRole === 'user' ? 'pt-2' : 'pt-1';
  if (role === 'tool') return 'pt-1.5';
  if (role === 'thinking') return 'pt-1';
  return 'pt-1';
}

interface MessageBubbleProps {
  message: Message;
  prevRole?: PrevRole;
}

/** HH:MM；非今天附日期（YYYY-MM-DD）。解析失败返回空（不显示）。 */
export function formatMessageTs(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return time;
  }
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date} ${time}`;
}

/** 消息时间标签：小号次要色；旧历史条目无 ts 时不渲染。 */
function MessageTimestamp({ ts }: { ts?: string }) {
  if (!ts) return null;
  const label = formatMessageTs(ts);
  if (!label) return null;
  return (
    <div className="text-[11px] text-text-secondary mt-0.5 select-none">
      {label}
    </div>
  );
}

export function MessageBubble({ message, prevRole = null }: MessageBubbleProps) {
  const role = message.role;
  const mt = marginTopClass(role, prevRole);
  const isWorkerReport = getQuickJumpKind(message) === 'worker';
  const workerReportLabel = isWorkerReport ? (
    <span className="worker-report-label" aria-label="Worker report">Worker report</span>
  ) : null;

  // Thinking blocks get their own component
  if (role === 'thinking') {
    return (
      <div className={`${mt} px-3 sm:px-6 lg:px-8`}>
        <ThinkingBlock message={message} />
      </div>
    );
  }

  // Tool blocks are handled by ToolGroup — they shouldn't appear standalone
  if (role === 'tool') {
    return null;
  }

  // System messages
  if (role === 'system') {
    return (
      <div className={`system-message flex justify-center py-2 ${mt}`}>
        <span className="msg system text-xs text-text-tertiary bg-bg-tertiary rounded px-3 py-1">
          {message.content}
        </span>
      </div>
    );
  }

  // TUI-style message rows use flex alignment so the virtualized row can keep
  // its full width without changing the measured wrapper's layout.
  if (role === 'user') {
    return (
      <div className={`message-row message-row-user ${isWorkerReport ? 'message-row-worker-report' : ''} ${mt} px-3 sm:px-6 lg:px-8`}>
        {workerReportLabel}
        <div className="msg user text-sm">
          <MarkdownRenderer
            content={message.content}
            attachmentIds={message.parts?.flatMap((part) => part.type === 'attachment' ? [part.attachmentId] : [])}
            className="text-sm"
          />
        </div>
        <MessageTimestamp ts={message.ts} />
      </div>
    );
  }

  // Assistant messages — no bubble, left-aligned, full-width markdown flow
  return (
    <div className={`message-row message-row-assistant ${isWorkerReport ? 'message-row-worker-report' : ''} ${mt} px-3 sm:px-6 lg:px-8`}>
      {workerReportLabel}
      <div className="msg assistant text-sm leading-relaxed">
        <MarkdownRenderer
          content={message.content}
          attachmentIds={message.parts?.flatMap((part) => part.type === 'attachment' ? [part.attachmentId] : [])}
        />
      </div>
      <MessageTimestamp ts={message.ts} />
    </div>
  );
}

/**
 * Group consecutive messages into display items.
 * Consecutive tool messages are grouped into a single ToolGroup.
 */
export function groupMessages(
  messages: Message[],
): Array<Message | { type: 'tool_group'; items: Message[] }> {
  const grouped: Array<Message | { type: 'tool_group'; items: Message[] }> = [];
  let currentToolGroup: Message[] | null = null;

  for (const msg of messages) {
    if (msg.role === 'tool') {
      if (!currentToolGroup) {
        currentToolGroup = [];
        grouped.push({
          type: 'tool_group',
          items: currentToolGroup,
        });
      }
      currentToolGroup.push(msg);
    } else {
      currentToolGroup = null;
      grouped.push(msg);
    }
  }

  return grouped;
}

interface MessageDisplayItemProps {
  item: GroupedItem;
  prevRole?: PrevRole;
}

export function MessageDisplayItem({ item, prevRole = null }: MessageDisplayItemProps) {
  if ('type' in item && item.type === 'tool_group') {
    return (
      <div className={`${marginTopClass('tool', prevRole)} pb-3 px-3 sm:px-6 lg:px-8`}>
        <ToolGroup items={item.items} />
      </div>
    );
  }
  return <MessageBubble message={item as Message} prevRole={prevRole} />;
}

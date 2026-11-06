// 通知信封构造与转义——纯函数，双端共享
// 被监控的外部输出无法伪造信封边界：正文中出现的信封标签一律实体转义

const OPEN = "<task-notification>";
const CLOSE = "</task-notification>";

/** 实体转义正文中的信封标签，防伪造/终止信封 */
export function escapeEnvelope(text: string): string {
  return text
    .replaceAll("<task-notification>", "&lt;task-notification&gt;")
    .replaceAll("</task-notification>", "&lt;/task-notification&gt;");
}

export interface EnvelopeInput {
  id: string;
  description: string | null;
  body: string;
}

/**
 * 构造通知信封：
 * <task-notification>
 * [monitor mon_xxx · description]
 * 正文
 * </task-notification>
 */
export function buildEnvelope(input: EnvelopeInput): string {
  const label =
    input.description !== null && input.description !== ""
      ? `[monitor ${input.id} · ${escapeEnvelope(input.description)}]`
      : `[monitor ${input.id}]`;
  return `${OPEN}\n${label}\n${escapeEnvelope(input.body)}\n${CLOSE}`;
}

import { z } from 'zod';

/** Private UI/engine command: concurrency tokens stay on the trusted wire. */
export const notesCommandSchema = z.object({
  action: z.enum(['view', 'search', 'create', 'edit', 'move', 'delete', 'sources']),
  path: z.string().optional().describe('笔记中的相对路径；省略时查看根目录。'),
  query: z.string().optional().describe('按名称和正文搜索的词语。'),
  content: z.string().optional(),
  oldText: z.string().optional().describe('编辑时需要精确匹配的原文。'),
  newText: z.string().optional(),
  to: z.string().optional().describe('移动后的相对路径。'),
  kind: z.enum(['file', 'directory']).optional(),
  startLine: z.number().int().positive().optional(),
  lineCount: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  revision: z.string().optional().describe('上次读取返回的修订值；修改时用于检测并发变化。'),
}).strict();
/** Conversational tools use natural paths and exact text, never revision IDs. */
export const notesSchema = notesCommandSchema.omit({ revision: true }).strict();

export const NOTES_DESCRIPTION = '你的私人记忆笔记。可按自然语言名称查看、搜索、创建、精确编辑、移动和删除 Markdown 笔记，也可查看来源对话。没有自动检索：需要往事时请主动查找。view 分页阅读目录或正文，search 返回命中片段，sources 查看证据。正文仍有下一页时按返回的页码继续。创建与整理不要求固定模板；记下有用的事，合并重复内容。修改前先读，遇到修订冲突重新读取。删除立即移出当前笔记并保留历史。只有写入工具成功后才能声称刚完成保存；查询已有记录不代表执行了新写入。按实际阅读范围描述查证过程，搜索片段不等于通读全部笔记。';
export const notesToolSchema = {
  name: 'notes',
  description: NOTES_DESCRIPTION,
  parameters: z.toJSONSchema(notesSchema) as Record<string, unknown>,
};

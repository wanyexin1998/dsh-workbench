/** `dsh-workbench` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'banner.label': '同工作区提醒',
  'banner.text': '两个 Pane 的会话共享同一工作区，同时操作可能互相覆盖文件。',
  'banner.ack': '知道了',
  // Startup-Guard failure surface (ARCH-02 / #25): the role="alert" entry
  // that replaces every other Workbench feature when the carrier's
  // presentation descriptor fails the compatibility verdict.
  'guard.title': 'DSH Workbench 已停用：客户端运行时不兼容',
  'guard.detected': '检测到',
  'guard.supported': '本版本支持',
  'selection.toolbar.label': '选区操作',
  'selection.add': '添加到对话',
  'selection.moreDetails': '更多详情',
  'selection.askInSideChat': '在侧边聊天中提问',
  'selection.reference.label': '已选内容',
  // “添加到对话”投影里的散文标签：这条路径没有 fork、没有边界声明，
  // 装订线只是排版约定，靠这几句话告诉模型“下面是引用的上文”。
  // 另一份真相在 native-ux/client/side-chat-actions.ts 的 SELECTION_QUOTE_COPY（默认回退）。
  'selection.quote.heading': '引用上文：',
  'selection.quote.headingMultiple': '引用上文（{count} 处）',
  'selection.quote.item': '引用 {index}：',
  'selection.quote.note': '备注：',
  'selection.side.reference.label': '侧聊选区',
  'selection.side.boundary': '继承的会话历史仅供参考。当前任务从此边界之后开始。除非用户明确要求修改，否则请只做轻量、非修改性的解释。',
  // 消息里已经没有叫“所选上下文”的容器了（XML 信封已删），
  // 文案改为指向它真正能看到的东西：上面那个装订线引用块。
  'selection.side.moreDetailsRequest': '请更详细地解释上面引用的内容。',
  'selection.side.confirmReplace': '已经打开两个 Pane。是否替换非来源 Pane？',
  'selection.side.pending': '正在准备侧边聊天…',
  'selection.side.cancelled': '已取消，未创建侧边聊天。',
  'selection.side.partial': '侧边会话 {childId} 已保留，但操作未能完成。',
  'selection.side.error.sourceNotVisible': '来源 Pane 已不可见，请重新选择。',
  'selection.side.error.unavailable': '当前版本不支持侧边聊天。',
  'selection.side.error.failed': '无法完成侧边聊天操作，请重试。',
  'selection.dock.label': '选区引用',
  // 引用区的可见计数（原来的「选区引用 (N)」标题行）已经删掉——计数由正文里的
  // 编号徽标承担。屏读用户看不到徽标，所以把计数并进 section 的无障碍名。
  'selection.dock.labelCount': '选区引用（{count} 条）',
  'selection.comment.placeholder': '添加可选评论...',
  // 摘要进 aria-label 而不是 aria-describedby：它是这个输入框的身份（用来区分
  // 几个长得一样的框），身份属于 name，聚焦时立刻朗读。
  'selection.comment.aria': '对引用 {n} 的评论：{excerpt}',
  'selection.remove.aria': '删除引用 {n}：{excerpt}',
  // 「跳到原文」的可访问名。摘要**不**进这句：同一行的 title 已经把摘要给了
  // 指针用户，而屏读用户在同一行的评论框名里已经听过一次，再念一遍就是复读。
  'selection.reveal.aria': '跳到引用 {n} 的原文',
  // 锚点三态里需要说出口的两个。anchored 不发声（滚动会让它与 offscreen 频繁
  // 翻转，任何提示都会变噪音）。detached 那句后半段是关键：色带没了不等于引用
  // 失效——发送时序列化的是捕获时冻结的文本快照。
  'selection.anchor.offscreen': '引用的原文当前不在视野内。',
  'selection.anchor.unmeasured': '暂时无法确定引用原文的位置，引用本身仍然有效。',
  'selection.anchor.detached': '引用的原文已不在当前对话中，引用内容仍会随消息发送。',
  'selection.error.stale': '选区已失效，请重新选择。',
  'selection.error.composer': '无法访问来源对话输入框。',
  'selection.error.draftChanged': '草稿已变化，请重试。',
  'selection.error.reference': '无法更新选区引用。',
} satisfies Record<string, string>

/** The workbench namespace key union. */
export type WorkbenchLocaleKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The workbench banner copy. */
    'dsh-workbench': WorkbenchLocaleKey
  }
}

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'banner.label': 'Same Workspace Warning',
  'banner.text': 'Two panes share one workspace directory; simultaneous writes may overwrite each other.',
  'banner.ack': 'Got it',
  'guard.title': 'DSH Workbench disabled: incompatible client runtime',
  'guard.detected': 'Detected',
  'guard.supported': 'Supported by this release',
  'selection.toolbar.label': 'Selection actions',
  'selection.add': 'Add to conversation',
  'selection.moreDetails': 'More details',
  'selection.askInSideChat': 'Ask in side chat',
  'selection.reference.label': 'Selected context',
  'selection.quote.heading': 'Quoting from above:',
  'selection.quote.headingMultiple': 'Quoting from above ({count} passages)',
  'selection.quote.item': 'Quote {index}:',
  'selection.quote.note': 'Note: ',
  'selection.side.reference.label': 'Side-chat selection',
  'selection.side.boundary': 'Inherited conversation history is reference-only. The current task begins after this boundary. Give a lightweight, non-modifying explanation unless the user explicitly requests changes.',
  'selection.side.moreDetailsRequest': 'Explain the quoted passage above in more detail.',
  'selection.side.confirmReplace': 'Two Panes are already open. Replace the non-source Pane?',
  'selection.side.pending': 'Preparing side chat…',
  'selection.side.cancelled': 'Cancelled. No side chat was created.',
  'selection.side.partial': 'Side session {childId} was retained, but the action could not finish.',
  'selection.side.error.sourceNotVisible': 'The source Pane is no longer visible. Select the text again.',
  'selection.side.error.unavailable': 'Side chat is unavailable in this edition.',
  'selection.side.error.failed': 'The side-chat action could not be completed. Try again.',
  'selection.dock.label': 'Selection references',
  'selection.dock.labelCount': 'Selection references ({count})',
  'selection.comment.placeholder': 'Add an optional comment…',
  'selection.comment.aria': 'Comment on quote {n}: {excerpt}',
  'selection.remove.aria': 'Remove quote {n}: {excerpt}',
  'selection.reveal.aria': 'Jump to the source of quote {n}',
  'selection.anchor.offscreen': 'The quoted passage is currently out of view.',
  'selection.anchor.unmeasured': 'The quoted passage’s position cannot be read right now. The quote itself is still valid.',
  'selection.anchor.detached': 'The quoted passage is no longer in this conversation. The quote is still sent with your message.',
  'selection.error.stale': 'The selection is stale. Select the text again.',
  'selection.error.composer': 'The source conversation composer is unavailable.',
  'selection.error.draftChanged': 'The draft changed. Try again.',
  'selection.error.reference': 'The selection reference could not be updated.',
} satisfies Record<WorkbenchLocaleKey, string>

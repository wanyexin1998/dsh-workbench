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
} satisfies Record<WorkbenchLocaleKey, string>

/**
 * 表格图标选择器：顶栏「表格名」前面那个 emoji，点一下展开常用图标面板，
 * 选一个立刻保存（只 `PATCH` 一个 icon 字段，见 DatabasePage 的 changeIcon）。
 *
 * 图标本身就是一个 emoji（`databases.icon`，服务端限 8 个字符），所以面板里
 * 只做「挑一个」、不做自由输入；分组只是方便找，面板装不下时会自己滚动。
 */
import { Popover } from './Popover';

/** 常用图标分组：`title` 是分组名，`icons` 是按用途挑的一组常见 emoji */
const ICON_GROUPS: { title: string; icons: string[] }[] = [
  { title: '表格与文档', icons: ['📋', '📄', '📝', '📊', '📈', '📉', '📁', '📂', '📌', '📎'] },
  { title: '任务与时间', icons: ['✅', '☑️', '🎯', '🚀', '⏰', '⏳', '📅', '🗓️', '🔔', '⚙️'] },
  { title: '人员与沟通', icons: ['👤', '👥', '💬', '📣', '📢', '✉️', '📞', '🤝', '🙋', '💼'] },
  { title: '商务与收款', icons: ['💰', '💳', '🧾', '🏦', '🛒', '📦', '🏢', '🏬', '📤', '📥'] },
  { title: '内容与素材', icons: ['🎨', '📷', '🎬', '🎵', '🖼️', '✍️', '⭐', '❤️', '🔥', '👍'] },
  { title: '常用标记', icons: ['💡', '🌟', '🌈', '🎉', '⚡', '⛔', '🚧', '🔒', '🔑', '🧭'] },
];

interface IconPickerProps {
  /** 当前图标（空值按默认的 📋 展示） */
  value: string;
  /** 只读（没有编辑权限时不弹面板） */
  disabled?: boolean;
  /** 选中一个图标：由调用方去保存，面板会自己关掉 */
  onChange: (icon: string) => void;
}

export function IconPicker({ value, disabled, onChange }: IconPickerProps) {
  const current = value || '📋';
  // 老数据 / 从别处带过来的图标可能不在候选里：先把它单独列成一组，
  // 免得打开面板发现没有一个是选中的、换了就回不去
  const groups = ICON_GROUPS.some((group) => group.icons.includes(current))
    ? ICON_GROUPS
    : [{ title: '当前', icons: [current] }, ...ICON_GROUPS];

  return (
    <Popover
      label={current}
      title={disabled ? '当前表格图标' : '点击更换表格图标'}
      triggerClassName="icon-input"
      panelWidth={300}
      align="left"
      disabled={disabled}
    >
      {(close) => (
        <div className="icon-picker">
          {groups.map((group) => (
            <div key={group.title} className="icon-picker-group">
              <div className="menu-label">{group.title}</div>
              <div className="icon-picker-grid">
                {group.icons.map((icon) => (
                  <button
                    key={icon}
                    type="button"
                    className={`icon-picker-cell${icon === current ? ' active' : ''}`}
                    title={icon}
                    onClick={() => {
                      onChange(icon);
                      close();
                    }}
                  >
                    {icon}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Popover>
  );
}

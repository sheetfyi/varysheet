/**
 * Cell rendering + inline editors for every field type.
 * `created_time` / `updated_time` / `created_by` / `updated_by` are derived from
 * the row metadata, never from `row.values`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  cellGraceHint,
  cellLockHint,
  formatDateValue,
  formatTimestamp,
  formatValueForDisplay,
  isEmptyValue,
} from '../../shared/fields';
import type { CellValue, DateValue, FileValue, Property, RowRecord, SelectOption } from '../../shared/types';
import { api } from '../api';

export type UserNames = Record<string, string>;

export function computedText(property: Property, row: RowRecord, users: UserNames): string {
  switch (property.type) {
    case 'created_time':
      return formatTimestamp(row.createdAt, property.config);
    case 'updated_time':
      return formatTimestamp(row.updatedAt, property.config);
    case 'created_by':
      return (row.createdBy && users[row.createdBy]) || '';
    case 'updated_by':
      return (row.updatedBy && users[row.updatedBy]) || '';
    default:
      return '';
  }
}

export function Pill({ option }: { option: SelectOption }) {
  return <span className={`pill pill-${option.color}`}>{option.name}</span>;
}

function fileSizeLabel(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

interface CellViewProps {
  property: Property;
  row: RowRecord;
  users: UserNames;
  /** 这个格子是否允许编辑（访问权 + 字段锁 + 字段类型都会影响它） */
  editable: boolean;
  /**
   * 该格子已经被当前访问者填过内容、10 秒计时窗口已经关了，而且值还在
   * （只有勾了「限制编辑」的分享才有这个约束）。为真时呈现为只读并给出提示，
   * 单击也不会进入编辑。
   */
  spent?: boolean;
  /**
   * 这一格还在计时窗口内时窗口的剩余毫秒数（> 0 = 刚刚保存过，窗口内还能继续改）。
   * 悬停提示里会带上倒计时的秒数。
   */
  graceMsLeft?: number;
  /**
   * 别人刚改过这个格子（增量同步带回来的）：短暂高亮一下，
   * 让人一眼看出「哪一格有新数据」。
   */
  flash?: boolean;
  onEdit: () => void;
  /** checkbox cells commit on a single click instead of opening an editor */
  onQuickChange?: (next: CellValue | undefined) => void;
}

export function CellView({
  property,
  row,
  users,
  editable,
  spent,
  graceMsLeft,
  flash,
  onEdit,
  onQuickChange,
}: CellViewProps) {
  const value = row.values[property.id];

  if (property.type === 'created_time' || property.type === 'updated_time' || property.type === 'created_by' || property.type === 'updated_by') {
    // 计算字段是只读的：外层还是 .cell-static，但文字得躺在 .cell-text 这一层，
    // 省略号才画得出来（见 styles.css 里「.cell-view > .cell-text」的说明）
    return (
      <span className="cell-static muted">
        <span className="cell-text">{computedText(property, row, users)}</span>
      </span>
    );
  }

  const empty = isEmptyValue(value);
  const startable = editable && !spent;
  const start = () => {
    if (!startable) return;
    if (property.type === 'checkbox' && onQuickChange) {
      onQuickChange(value === true ? undefined : true);
      return;
    }
    onEdit();
  };

  let content: React.ReactNode = null;
  switch (property.type) {
    case 'checkbox':
      content = <span className={value === true ? 'checkbox on' : 'checkbox'}>{value === true ? '✔' : ''}</span>;
      break;
    case 'select':
    case 'status':
      content = value ? <Pill option={value as SelectOption} /> : null;
      break;
    case 'multi_select':
      content = (
        <span className="pills">
          {((value as SelectOption[] | undefined) ?? []).map((option) => (
            <Pill key={option.id} option={option} />
          ))}
        </span>
      );
      break;
    case 'date':
      content = <span className="cell-text">{formatDateValue(value as DateValue | undefined, property.config)}</span>;
      break;
    case 'files':
      content = (
        <span className="file-list">
          {((value as FileValue[] | undefined) ?? []).map((file) => (
            <a
              key={file.id}
              className="file-chip"
              href={api.fileUrl(file.id)}
              target="_blank"
              rel="noreferrer"
              title={`${file.name} · ${fileSizeLabel(file.size)}`}
              aria-label={`打开文件 ${file.name}`}
              onClick={(event) => event.stopPropagation()}
            >
              📎
            </a>
          ))}
        </span>
      );
      break;
    case 'url': {
      const href = typeof value === 'string' ? value : '';
      content = href ? (
        // 列宽只由 <colgroup> 决定（见 styles.css 的「单元格不许按内容顶宽」），长网址会被
        // 省略成「…」，所以这里补一个完整地址的悬停提示；只有「限制编辑」那两种状态例外，
        // 那时按钮上的 title 要负责解释「为什么这格现在不能改」。
        <a
          className="link cell-text"
          href={href}
          target="_blank"
          rel="noreferrer"
          title={spent || graceMsLeft ? undefined : href}
          onClick={(event) => event.stopPropagation()}
        >
          {href}
        </a>
      ) : null;
      break;
    }
    default:
      // 普通文本 / 数字 / 电话…：这一层才是那个「装文字的盒子」，省略号靠它
      content = <span className="cell-text">{formatValueForDisplay(property.type, value, property.config, { users })}</span>;
  }

  return (
    <button
      type="button"
      className={`cell-view${empty ? ' empty' : ''}${spent ? ' spent' : ''}${flash ? ' flash' : ''}`}
      onClick={start}
      // 已经锁上的格子保持可悬停（这样才看得到提示），但点击不再进入编辑
      disabled={!editable && !spent}
      aria-disabled={startable ? undefined : true}
      // 还在 10 秒计时窗口里：提示「还能继续改几秒」；窗口一关换成「联系表格所有者」
      title={
        spent ? cellLockHint(property.name) : graceMsLeft ? cellGraceHint(property.name, graceMsLeft) : undefined
      }
      // 单击它就会开始编辑这个单元格：调用方的「点别处退出输入」据此放行，
      // 否则新单元格的编辑框刚打开就会被关掉（勾选类字段是就地切换，不算）
      data-start-edit={startable && !(property.type === 'checkbox' && onQuickChange) ? 'true' : undefined}
    >
      {content}
    </button>
  );
}

/* ------------------------------------------------------------------ editors */

export interface CellEditorProps {
  property: Property;
  value: CellValue | undefined;
  /** uploads an attachment and resolves with its stored metadata */
  uploadFile?: (file: File) => Promise<FileValue>;
  /** 保存并结束该单元格的编辑（Enter / 键盘操作时用） */
  onCommit: (value: CellValue | undefined) => void;
  /**
   * 只保存、不结束编辑：日期与文件字段「选完即自动确认」，编辑器保留在单元格里，
   * 等用户点击其它位置再退出。未提供时退化为「保存并退出」。
   */
  onAutoSave?: (value: CellValue | undefined) => void;
  onCancel: () => void;
}

/**
 * 「点击单元格以外的任意位置就退出该单元格的输入」。
 *
 * 监听 document 冒泡阶段的 click（此时 React 根节点上的 onClick 已经跑完），
 * 两种点击不关闭：
 * 1. 落在正在编辑的单元格内部（编辑器里的按钮 / 下拉 / 日期输入框）；
 * 2. 点的是另一个「可编辑单元格」——它的 onClick 已经开始编辑那个格子，
 *    这里再关就会把刚打开的编辑框顺手关掉。
 *    注意：React 重渲染会换掉被点中的按钮节点，此时它已经脱离文档，
 *    所以只能读节点自身的属性，不能靠 closest 往上找。
 * 文字类编辑器靠 blur 先提交，所以提前卸载输入框不会丢数据。
 */
export function useCloseOnOutsideClick(active: boolean, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!active) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest?.('[data-editing-cell="true"]')) return;
      if (target.matches?.('[data-start-edit="true"]')) return;
      close.current();
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [active]);
}

/** Wrap a handler so it only ever fires once (blur + Enter both commit). */
function useOnce<Args extends unknown[]>(handler: (...args: Args) => void): (...args: Args) => void {
  const fired = useRef(false);
  return (...args: Args) => {
    if (fired.current) return;
    fired.current = true;
    handler(...args);
  };
}

function TextEditor({ property, value, onCommit, onCancel }: CellEditorProps) {
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const commit = useOnce(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      onCommit(undefined);
      return;
    }
    if (property.type === 'number') {
      const parsed = Number(trimmed);
      onCommit(Number.isFinite(parsed) ? parsed : undefined);
      return;
    }
    onCommit(trimmed);
  });

  return (
    <input
      ref={ref}
      className="cell-input"
      value={text}
      inputMode={property.type === 'number' ? 'decimal' : property.type === 'phone' ? 'tel' : undefined}
      type={property.type === 'email' ? 'email' : property.type === 'url' ? 'url' : 'text'}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={commit}
    />
  );
}

function SelectEditor({ property, value, onCommit, onCancel }: CellEditorProps) {
  const current = (value as SelectOption | undefined)?.name ?? '';
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const commit = useOnce((next: string) => {
    const option = (property.config.options ?? []).find((item) => item.name === next);
    onCommit(option ? { ...option } : undefined);
  });

  return (
    <select
      ref={ref}
      className="cell-input"
      value={current}
      onChange={(event) => commit(event.target.value)}
      onBlur={() => commit(current)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <option value="">—</option>
      {(property.config.options ?? []).map((option) => (
        <option key={option.id} value={option.name}>
          {option.name}
        </option>
      ))}
    </select>
  );
}


function MultiSelectEditor({ property, value, onCommit, onCancel }: CellEditorProps) {
  const selected = useMemo(() => (value as SelectOption[] | undefined) ?? [], [value]);
  const [ids, setIds] = useState<string[]>(selected.map((option) => option.id));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const toggle = (option: SelectOption) => {
    const next = ids.includes(option.id) ? ids.filter((id) => id !== option.id) : [...ids, option.id];
    setIds(next);
    const picked = (property.config.options ?? []).filter((item) => next.includes(item.id));
    onCommit(picked.length ? picked.map((item) => ({ ...item })) : undefined);
  };

  return (
    <div
      ref={ref}
      className="cell-dropdown"
      tabIndex={0}
      onBlur={() => onCancel()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      {(property.config.options ?? []).map((option) => (
        <label key={option.id} className="cell-option">
          <input type="checkbox" checked={ids.includes(option.id)} onChange={() => toggle(option)} />
          <Pill option={option} />
        </label>
      ))}
      {!(property.config.options ?? []).length ? <span className="muted">该字段还没有选项</span> : null}
    </div>
  );
}

/** 把「日期 + 可选时间」组合成单元格值；日期被清空时返回 undefined（等于清空该单元格）。 */
function dateValueOf(day: string, clock: string, includeTime: boolean): DateValue | undefined {
  if (!day) return undefined;
  if (includeTime && clock) return { start: `${day}T${clock}:00.000Z`, end: null, includeTime: true };
  return { start: day, end: null, includeTime: false };
}

/**
 * 日期编辑器：选好日期 / 时间就已经自动保存，没有「确定 / 取消」按钮；
 * 点击单元格以外的任意位置即退出（由调用方的 useCloseOnOutsideClick 处理）。
 */
function DateEditor({ property, value, onCommit, onAutoSave, onCancel }: CellEditorProps) {
  const current = (value as DateValue | undefined) ?? null;
  const date = current?.start ? current.start.slice(0, 10) : '';
  const time = current?.start && current.start.includes('T') ? current.start.slice(11, 16) : '';
  const includeTime = current?.includeTime ?? property.config.includeTime ?? false;
  const [day, setDay] = useState(date);
  const [clock, setClock] = useState(time);
  const ref = useRef<HTMLInputElement>(null);
  /** 改动过就已经自动保存了，Enter 只负责退出，不必再发一次请求 */
  const dirty = useRef(false);
  useEffect(() => ref.current?.focus(), []);

  const save = (nextDay: string, nextClock: string) => {
    dirty.current = true;
    (onAutoSave ?? onCommit)(dateValueOf(nextDay, nextClock, includeTime));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (dirty.current) onCommit(dateValueOf(day, clock, includeTime));
      else onCancel();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <span className="cell-date">
      <input
        ref={ref}
        className="cell-input"
        type="date"
        value={day}
        onChange={(event) => {
          setDay(event.target.value);
          save(event.target.value, clock);
        }}
        onKeyDown={onKeyDown}
      />
      {includeTime ? (
        <input
          className="cell-input"
          type="time"
          value={clock}
          onChange={(event) => {
            setClock(event.target.value);
            save(day, event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
      ) : null}
    </span>
  );
}

function FilesEditor({ value, uploadFile, onCommit, onAutoSave, onCancel }: CellEditorProps) {
  const files = (value as FileValue[] | undefined) ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  /** 上传成功 / 移除文件都自动保存，不需要「完成」按钮 */
  const save = (next: FileValue[] | undefined) => (onAutoSave ?? onCommit)(next);

  const pick = async (list: FileList | null) => {
    if (!list?.length || !uploadFile) return;
    setBusy(true);
    setError('');
    try {
      const uploaded: FileValue[] = [];
      for (const file of Array.from(list)) uploaded.push(await uploadFile(file));
      save([...files, ...uploaded]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '上传失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="cell-dropdown"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      {files.map((file) => (
        <span key={file.id} className="file-chip">
          <a
            href={api.fileUrl(file.id)}
            target="_blank"
            rel="noreferrer"
            title={`${file.name} · ${fileSizeLabel(file.size)}`}
            aria-label={`打开文件 ${file.name}`}
          >
            📎
          </a>
          <button
            type="button"
            className="icon-btn"
            title="移除"
            onClick={() => save(files.filter((item) => item.id !== file.id))}
          >
            ✕
          </button>
        </span>
      ))}
      <div className="row gap">
        <button type="button" className="btn small" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? '上传中…' : '添加文件'}
        </button>
      </div>
      {error ? <span className="error small">{error}</span> : null}
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          void pick(event.target.files);
          event.target.value = '';
        }}
      />
    </div>
  );
}

export function CellEditor(props: CellEditorProps) {
  switch (props.property.type) {
    case 'select':
    case 'status':
      return <SelectEditor {...props} />;
    case 'multi_select':
      return <MultiSelectEditor {...props} />;
    case 'date':
      return <DateEditor {...props} />;
    case 'files':
      return <FilesEditor {...props} />;
    case 'checkbox':
      return (
        <button
          type="button"
          className="btn small"
          onClick={() => props.onCommit(props.value === true ? undefined : true)}
        >
          {props.value === true ? '取消勾选' : '勾选'}
        </button>
      );
    default:
      return <TextEditor {...props} />;
  }
}


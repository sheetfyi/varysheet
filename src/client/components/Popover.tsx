import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface PopoverProps {
  /** trigger content */
  label: React.ReactNode;
  title?: string;
  wide?: boolean;
  /** 面板宽度（px）；默认 320，`wide` 时 420。超出视口时会自动收窄（窄屏不溢出） */
  panelWidth?: number;
  disabled?: boolean;
  /** trigger style (defaults to a ghost button) */
  variant?: 'ghost' | 'primary';
  /**
   * 触发按钮的自定义类名：给了就整份替换默认的 ghost / primary 小按钮样式
   * （例如顶栏那个 emoji 图标按钮要沿用 `.icon-input` 的尺寸）。
   */
  triggerClassName?: string;
  /** which edge of the trigger the panel is aligned to (default: right) */
  align?: 'left' | 'right';
  /** 面板打开时回调（例如打开收件箱前先刷新一次未读私信） */
  onOpen?: () => void;
  /** render prop receiving a close() helper */
  children: (close: () => void) => React.ReactNode;
}

interface PanelPosition {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
}

const PANEL_WIDTH = { normal: 320, wide: 420 };
const GAP = 6;
const MARGIN = 8;
/** keep at least this much room before flipping the panel above the trigger */
const MIN_HEIGHT = 220;

/**
 * Button + panel that closes on outside click / Escape.
 *
 * The panel is rendered through a portal with `position: fixed`, so it is never
 * clipped by scrollable / `overflow: hidden` ancestors (视图栏、表格表头等),
 * and it flips above the trigger when there is not enough room below.
 */
export function Popover({
  label,
  title,
  wide,
  panelWidth,
  disabled,
  variant = 'ghost',
  triggerClassName,
  align = 'right',
  onOpen,
  children,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  /** Anchor the panel to the trigger, clamped to the viewport. */
  const place = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const wanted = panelWidth ?? (wide ? PANEL_WIDTH.wide : PANEL_WIDTH.normal);
    // 视口太窄时收窄面板（窄屏 390px 也放得下），left 用实际宽度来夹取
    const width = Math.min(wanted, Math.max(PANEL_WIDTH.normal, window.innerWidth - MARGIN * 2));
    const maxLeft = Math.max(MARGIN, window.innerWidth - width - MARGIN);
    const left = Math.min(Math.max(MARGIN, align === 'left' ? rect.left : rect.right - width), maxLeft);
    const below = window.innerHeight - rect.bottom - GAP - MARGIN;
    const above = rect.top - GAP - MARGIN;
    if (below < MIN_HEIGHT && above > below) {
      setPosition({
        bottom: Math.max(MARGIN, window.innerHeight - rect.top + GAP),
        left,
        width,
        maxHeight: Math.max(MIN_HEIGHT, above),
      });
    } else {
      setPosition({ top: rect.bottom + GAP, left, width, maxHeight: Math.max(MIN_HEIGHT, below) });
    }
  }, [align, wide, panelWidth]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (host.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="popover-host" ref={host}>
      <button
        ref={trigger}
        type="button"
        className={
          triggerClassName
            ? `${triggerClassName}${open ? ' open' : ''}`
            : `btn ${variant === 'primary' ? 'primary' : 'ghost'} small${open ? ' active' : ''}`
        }
        title={title}
        disabled={disabled}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) onOpen?.();
        }}
      >
        {label}
      </button>
      {open
        ? createPortal(
            <div
              ref={panel}
              className={`popover${wide ? ' wide' : ''}`}
              style={{
                top: position?.top ?? 'auto',
                bottom: position?.bottom ?? 'auto',
                left: position?.left ?? 0,
                right: 'auto',
                width: position?.width,
                maxHeight: position ? position.maxHeight : undefined,
                visibility: position ? 'visible' : 'hidden',
              }}
            >
              {children(() => setOpen(false))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}


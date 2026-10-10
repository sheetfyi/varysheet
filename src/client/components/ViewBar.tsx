/**
 * View tabs + the view level toolbar (分享 / ⋯)。
 *
 * 视图设置（行高 / 卡片大小 / 卡片预览字段 / 显示的字段）原来挂在最右边独立的
 * 「设置」按钮上，现在整体合并进「⋯」菜单，右侧只剩「分享」和「⋯」；同时下线了
 * 三个入口：
 *   - 「分组依据」：老视图里已保存的 `groupBy` 照旧渲染（看板列 / 表格分组都还有
 *     数据来自示例数据与历史数据），只是不再提供修改入口；
 *   - 「锁定视图」：视图锁定整体下线 —— 「⋯」里的锁定项与「＋ 新建视图」表单里的
 *     「锁定该视图」勾选都已移除。服务端 `views.is_locked` 仍然保留（拦截改名 /
 *     删除，兼容老数据），客户端只保留「🔒 视图已锁定」提示；
 *   - 「分享此视图」：与右侧「分享」按钮重复，统一走「分享」。
 *
 * Filter conditions are edited from the "＋ 新建筛选" button rendered above the
 * view body (see DatabasePage) and from the "＋ 新建视图" form below.
 */
import { useState } from 'react';
import { VIEW_TYPE_LABEL } from '../../shared/views';
import type { Filters, Property, ViewConfig, ViewDef, ViewType } from '../../shared/types';
import { FilterPanel, emptyFilters, type FilterUserNames } from './FilterPanel';
import { Popover } from './Popover';

/** Payload of the "＋ 新建视图" form: 自定义名称 / 筛选 / 定向分享. */
export interface NewViewInput {
  /** 恒为 'table'：UI 上不再让用户选视图类型（见 NEW_VIEW_TYPE） */
  type: ViewType;
  name: string;
  filters: Filters;
  /** 定向分享（可选）：role = 'editor' 时可以额外勾选「限制编辑」 */
  share?: { email: string; role: 'editor' | 'viewer'; limitEdits?: boolean };
}

interface ViewBarProps {
  views: ViewDef[];
  active: ViewDef;
  properties: Property[];
  /** userId -> 显示名，用于「创建人」等人员类筛选条件 */
  users?: FilterUserNames;
  /** the active view may be renamed / reconfigured / deleted (false once locked) */
  canEdit: boolean;
  /** owner only actions: 该视图的定向分享 */
  canManage: boolean;
  total: number;
  rowCount: number;
  onSelectView: (id: string) => void;
  onCreateView: (input: NewViewInput) => void;
  onRenameView: (id: string, name: string) => void;
  onDeleteView: (id: string) => void;
  onUpdateConfig: (patch: Partial<ViewConfig>) => void;
  onShareView: (id: string) => void;
  /** 还能不能再加视图（基础表格 3 个 / 专业表格 10 个）：到上限时「＋」置灰 */
  canAddView: boolean;
  /** 「＋」置灰时的悬停说明（写清当前上限与怎么恢复） */
  addViewHint: string;
}

const VIEW_ICON: Record<ViewType, string> = { table: '▤', board: '▥', gallery: '▦' };

/** 新建视图固定为表格类型：表单里不再提供类型选择，避免误建看板 / 画廊视图 */
const NEW_VIEW_TYPE: ViewType = 'table';

/** 视图设置面板：行高 / 卡片大小 / 卡片预览字段 / 显示的字段。渲染在「⋯」菜单里。 */
function SettingsPanel({
  view,
  properties,
  canEdit,
  onChange,
}: {
  view: ViewDef;
  properties: Property[];
  canEdit: boolean;
  onChange: (patch: Partial<ViewConfig>) => void;
}) {
  const visible = view.config.visibleProperties;

  const toggleVisible = (id: string) => {
    const current = visible ?? properties.map((property) => property.id);
    const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    onChange({ visibleProperties: next });
  };

  return (
    <div>
      {view.type === 'gallery' ? (
        <label className="field">
          <span>卡片大小</span>
          <select
            className="input"
            value={view.config.cardSize ?? 'medium'}
            disabled={!canEdit}
            onChange={(event) => onChange({ cardSize: event.target.value as NonNullable<ViewConfig['cardSize']> })}
          >
            <option value="small">小</option>
            <option value="medium">中</option>
            <option value="large">大</option>
          </select>
        </label>
      ) : (
        <label className="field">
          <span>行高</span>
          <select
            className="input"
            value={view.config.rowHeight ?? 'short'}
            disabled={!canEdit}
            onChange={(event) => onChange({ rowHeight: event.target.value as NonNullable<ViewConfig['rowHeight']> })}
          >
            <option value="short">紧凑</option>
            <option value="medium">中等</option>
            <option value="tall">宽松</option>
          </select>
        </label>
      )}

      {view.type === 'gallery' ? (
        <label className="field">
          <span>卡片预览字段</span>
          <select
            className="input"
            value={view.config.cardPreviewPropertyId ?? ''}
            disabled={!canEdit}
            onChange={(event) => onChange({ cardPreviewPropertyId: event.target.value || null })}
          >
            <option value="">无</option>
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="field">
        <span>显示的字段</span>
        <div style={{ maxHeight: 200, overflow: 'auto' }}>
          {properties.map((property) => (
            <label key={property.id} className="row gap" style={{ padding: '2px 0' }}>
              <input
                type="checkbox"
                checked={!visible || visible.includes(property.id)}
                disabled={!canEdit}
                onChange={() => toggleVisible(property.id)}
              />
              <span>{property.name}</span>
            </label>
          ))}
        </div>
        {visible ? (
          <button
            type="button"
            className="btn ghost small"
            disabled={!canEdit}
            onClick={() => onChange({ visibleProperties: null })}
          >
            显示全部字段
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** "＋ 新建视图" form: name, conditions and optional view share. 类型固定为表格。 */
function NewViewForm({
  properties,
  users,
  canShare,
  onCancel,
  onSubmit,
}: {
  properties: Property[];
  /** userId -> 显示名，用于「创建人」等人员类筛选条件 */
  users: FilterUserNames;
  canShare: boolean;
  onCancel: () => void;
  onSubmit: (input: NewViewInput) => void;
}) {
  const [name, setName] = useState('');
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('viewer');
  /** 「限制编辑」：只随「可编辑」的定向分享一起提交 */
  const [limitEdits, setLimitEdits] = useState(false);

  return (
    <div>
      <label className="field">
        <span>视图名称</span>
        <input
          className="input"
          value={name}
          autoFocus
          placeholder={`默认：${VIEW_TYPE_LABEL[NEW_VIEW_TYPE]}视图`}
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      {/* 新建视图不再选类型：固定为表格类型 */}
      <div className="field">
        <span>视图类型</span>
        <div className="row gap" style={{ alignItems: 'center' }}>
          <span className="badge">
            {VIEW_ICON[NEW_VIEW_TYPE]} {VIEW_TYPE_LABEL[NEW_VIEW_TYPE]}
          </span>
          <span className="small muted">新建视图固定为表格类型</span>
        </div>
      </div>

      <FilterPanel properties={properties} users={users} filters={filters} canEdit onChange={setFilters} />

      {canShare ? (
        <>
          <div className="menu-label">定向分享（可选）</div>
          <div className="row gap">
            <input
              className="input"
              type="email"
              placeholder="对方邮箱"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <select
              className="input"
              style={{ width: 110 }}
              value={role}
              onChange={(event) => setRole(event.target.value as 'editor' | 'viewer')}
            >
              <option value="viewer">可查看</option>
              <option value="editor">可编辑</option>
            </select>
          </div>
          <p className="small muted">被分享者只能看到这一个视图及其中的数据。</p>
          {role === 'editor' ? (
            <label className="row gap" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={limitEdits}
                onChange={(event) => setLimitEdits(event.target.checked)}
              />
              <span className="small">
                限制编辑：被分享者对每个格子只有一次输入机会（保存成功后 10 秒内还能改回来），之后该格子只能查看
              </span>
            </label>
          ) : null}
        </>
      ) : null}

      <div className="row gap" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn primary small"
          onClick={() =>
            onSubmit({
              type: NEW_VIEW_TYPE,
              name: name.trim(),
              filters,
              share: canShare && email.trim() ? { email: email.trim(), role, limitEdits: role === 'editor' && limitEdits } : undefined,
            })
          }
        >
          创建视图
        </button>
        <button type="button" className="btn ghost small" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

export function ViewBar({
  views,
  active,
  properties,
  users = {},
  canEdit,
  canManage,
  total,
  rowCount,
  onSelectView,
  onCreateView,
  onRenameView,
  onDeleteView,
  onUpdateConfig,
  onShareView,
  canAddView,
  addViewHint,
}: ViewBarProps) {
  const [draftName, setDraftName] = useState(active.name);
  const filterCount = active.config.filters?.conditions.length ?? 0;

  return (
    <div className="viewbar">
      {views.map((view) => (
        <button
          key={view.id}
          type="button"
          className={`tab${view.id === active.id ? ' active' : ''}`}
          title={view.locked ? `${view.name}（已锁定）` : view.name}
          onClick={() => {
            setDraftName(view.name);
            onSelectView(view.id);
          }}
        >
          {VIEW_ICON[view.type]} {view.name}
          {view.locked ? <span className="small muted"> 🔒</span> : null}
        </button>
      ))}

      <Popover
        label="＋"
        title={canAddView ? '新建视图' : addViewHint}
        panelWidth={560}
        disabled={!canEdit || !canAddView}
      >
        {(close) => (
          <NewViewForm
            properties={properties}
            users={users}
            canShare={canManage}
            onCancel={close}
            onSubmit={(input) => {
              onCreateView(input);
              close();
            }}
          />
        )}
      </Popover>

      <span className="spacer" />
      {/* 老数据里被锁定的视图：锁定入口已下线，服务端仍会拦改名 / 删除，这里只做提示 */}
      {active.locked ? (
        <span className="badge" title="视图已锁定（历史数据）：名称、设置与删除均不可修改">
          🔒 视图已锁定
        </span>
      ) : null}
      <span className="small muted">
        {rowCount === total ? `${total} 条记录` : `显示 ${rowCount} / 共 ${total} 条`}
        {filterCount ? ` · 筛选 ${filterCount}` : ''}
      </span>

      {canManage ? (
        <button
          type="button"
          className="btn ghost small"
          title="把当前视图定向分享给指定成员"
          onClick={() => onShareView(active.id)}
        >
          分享
        </button>
      ) : null}

      {/* 最右边的「⋯」：重命名 + 视图设置（原来独立的「设置」按钮已合并进来）+ 删除 */}
      {canEdit ? (
        <Popover label="⋯" title="当前视图" wide>
          {(close) => (
            <div>
              <div className="menu-label">重命名视图</div>
              <div className="row gap" style={{ padding: '0 8px 8px' }}>
                <input
                  className="input"
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                />
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    const name = draftName.trim();
                    if (name && name !== active.name) onRenameView(active.id, name);
                    close();
                  }}
                >
                  保存
                </button>
              </div>

              <div className="menu-label">视图设置</div>
              <div style={{ padding: '0 8px 8px' }}>
                <SettingsPanel
                  view={active}
                  properties={properties}
                  canEdit={canEdit}
                  onChange={onUpdateConfig}
                />
              </div>

              <button
                type="button"
                className="menu-item danger"
                disabled={views.length <= 1}
                onClick={() => {
                  if (views.length > 1) onDeleteView(active.id);
                  close();
                }}
              >
                🗑 删除此视图
              </button>
            </div>
          )}
        </Popover>
      ) : null}
    </div>
  );
}

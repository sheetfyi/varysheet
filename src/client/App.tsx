/**
 * Client entry: session bootstrap, workspace shell (collapsible sidebar +
 * database page) and the public share route (`/share/:token`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BrandingResponse,
  DatabaseDetail,
  DatabaseSummary,
  InboxMessage,
  InboxResponse,
  SessionUser,
  TableKind,
  TableQuotaSet,
} from '../shared/types';
import { purchaseMonthsLabel, tableKindLabel } from '../shared/tableKind';
import { ApiError, api, setSessionToken, type SessionPayload } from './api';
import { applyBranding } from './branding';
import { AdminSystemPanel, AdminUsersPanel, type AdminSection } from './components/AdminPanel';
import { AuthPage } from './components/AuthPage';
import { ChangePasswordDialog } from './components/ChangePasswordDialog';
import { DatabasePage } from './components/DatabasePage';
import { InboxButton } from './components/InboxButton';
import { InvitePage } from './components/InvitePage';
import { PublicPage } from './components/PublicPage';
import { Sidebar } from './components/Sidebar';
import { SiteMark } from './components/SiteMark';

interface ToastItem {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

/** 私信（@提醒）的轮询间隔：改备注的人不少，60 秒足够及时又不费流量 */
const INBOX_POLL_MS = 60_000;
const EMPTY_INBOX: InboxResponse = { messages: [], unread: 0 };

/**
 * 会话探测的重试次数与间隔。
 *
 * 手机上丢一次请求太常见了（切前后台、地铁里信号跳一下、运营商偶发超时）。以前任何一次
 * 失败都会被当成「没登录」直接打回登录页，所以这里多试几次，只有服务端明确回答「没登录」
 * （200 且 user 为空，或 401）才真的退出登录。
 */
const SESSION_ATTEMPTS = 3;
const SESSION_RETRY_MS = 400;

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** 点开私信后要打开的位置：某张表格的某条记录里的某条备注 */
interface InboxTarget {
  databaseId: string;
  recordId: string;
  noteId: string;
}

/** 侧边栏展开状态在本地记住（下次打开保持上次的选择） */
const SIDEBAR_KEY = 'varysheet.sidebar-open';
/** 品牌改名前的旧键（读得到就顺手迁到新键上，老用户上次的展开 / 收起选择不会丢） */
const LEGACY_SIDEBAR_KEYS = ['qafield.sidebar-open'];
/** 窄屏断点，必须与 styles.css 里的媒体查询保持一致 */
const NARROW_QUERY = '(max-width: 900px)';

function isNarrowViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(NARROW_QUERY).matches;
}

/**
 * 侧边栏初始状态：手机 / 平板上默认收起（抽屉会盖住表格），宽屏默认展开，
 * 除非用户上次手动收起过。
 */
function initialSidebarOpen(): boolean {
  if (isNarrowViewport()) return false;
  try {
    const saved = window.localStorage.getItem(SIDEBAR_KEY) ?? readLegacySidebarPreference();
    return saved !== 'false';
  } catch {
    // 隐私模式下 localStorage 不可用，退化为默认展开
    return true;
  }
}

/** 旧键里还留着「展开 / 收起」的话，迁到新键上并把旧键删掉 */
function readLegacySidebarPreference(): string | null {
  for (const legacyKey of LEGACY_SIDEBAR_KEYS) {
    const value = window.localStorage.getItem(legacyKey);
    if (value === null) continue;
    window.localStorage.setItem(SIDEBAR_KEY, value);
    window.localStorage.removeItem(legacyKey);
    return value;
  }
  return null;
}

/** `/share/<token>` is served by the SPA fallback, everything else is the app. */
function shareTokenFromPath(): string | null {
  const match = /^\/share\/([^/]+)\/?$/.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

/** `/invite/<token>`：视图分享邀请链接，受邀人在这里填昵称 + 密码完成注册。 */
function inviteTokenFromPath(): string | null {
  const match = /^\/invite\/([^/]+)\/?$/.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

function summaryOf(detail: DatabaseDetail): DatabaseSummary {
  return {
    id: detail.id,
    name: detail.name,
    icon: detail.icon,
    kind: detail.kind,
    description: detail.description,
    ownerId: detail.ownerId,
    role: detail.role,
    locked: detail.locked,
    viewScoped: detail.viewScoped,
    sharedViewNames: detail.viewScoped ? detail.views.map((view) => view.name) : [],
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    rowCount: detail.total,
    capacity: detail.capacity,
  };
}

export function App() {
  const shareToken = useMemo(shareTokenFromPath, []);
  const inviteToken = useMemo(inviteTokenFromPath, []);
  const [booting, setBooting] = useState(!shareToken && !inviteToken);
  const [appName, setAppName] = useState('Varysheet');
  /** 站点图标（管理员在后台传过才有）：`<title>` 与 favicon 也跟着它走 */
  const [siteIconUrl, setSiteIconUrl] = useState<string | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [databases, setDatabases] = useState<DatabaseSummary[]>([]);
  /** 表格名额（试用 / 基础 / 专业各自还能加几张）：侧边栏显示，登录与刷新列表时更新 */
  const [quota, setQuota] = useState<TableQuotaSet | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DatabaseDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const [narrow, setNarrow] = useState(isNarrowViewport);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  /** 收件箱：别人在备注里 @ 我的未读私信（红点里的数字就是 messages 的条数） */
  const [inbox, setInbox] = useState<InboxResponse>(EMPTY_INBOX);
  /** 点开私信后要打开的记录 / 备注；由 DatabasePage 消费后清空 */
  const [inboxTarget, setInboxTarget] = useState<InboxTarget | null>(null);
  /** 主区域停在后台的哪一页（'users' 用户管理 / 'system' 系统管理；null = 看表格）。只有管理员进得去，服务端另有校验 */
  const [adminView, setAdminView] = useState<AdminSection | null>(null);
  /** 「修改密码」弹窗 */
  const [changingPassword, setChangingPassword] = useState(false);
  /** 邀请页已经处理完（注册成功 / 点了「去登录」）：回到正常的登录或工作区 */
  const [inviteDone, setInviteDone] = useState(false);
  /** 会话拉取失败的原因（网络 / 服务端问题）。有值时未登录界面显示「重试」而不是直接判为未登录 */
  const [sessionError, setSessionError] = useState('');

  const toast = useCallback((message: string, kind: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, kind }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((item) => item.id !== id)), 3200);
  }, []);

  /* ------------------------------------------------- 侧边栏展开 / 收起控制 */

  const setSidebar = useCallback((next: boolean) => {
    setSidebarOpen(next);
    try {
      window.localStorage.setItem(SIDEBAR_KEY, String(next));
    } catch {
      // 隐私模式下存不下也没关系，本次会话内依然生效
    }
  }, []);

  const narrowRef = useRef(isNarrowViewport());

  useEffect(() => {
    const sync = () => {
      const next = isNarrowViewport();
      const changed = narrowRef.current !== next;
      narrowRef.current = next;
      setNarrow(next);
      // 宽窄屏切换时给出合理默认：手机收起抽屉，切回宽屏重新展开
      if (changed) setSidebarOpen(!next);
    };
    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
    };
  }, []);

  /* ------------------------------------------------------------- 品牌标识 */

  /** 「后台 → 站点设置」保存成功：立刻把新的站点名称 / 图标套到侧边栏标识、标题与 favicon 上 */
  const applyBrandingChange = useCallback((branding: BrandingResponse) => {
    setAppName(branding.siteName);
    setSiteIconUrl(branding.iconUrl);
  }, []);

  /**
   * 站点名称 / 图标跟着会话走（管理员在「后台 → 站点设置」里改完会重新拉会话）：
   * 这里统一落到 `<title>` 与 favicon。公开分享页没有会话，那份由 `main.tsx`
   * 启动时的 `/api/branding` 负责。
   */
  useEffect(() => {
    applyBranding({ siteName: appName, iconUrl: siteIconUrl });
  }, [appName, siteIconUrl]);

  /* ----------------------------------------------------------- 会话与数据 */

  /**
   * 拉取会话（用户 + 表格列表）并自动打开第一张表格。
   * 登录成功后同样会走这里：手机上不必再手动展开侧边栏才有内容。
   *
   * 只有服务端**明确**回答「没登录」才把人退回登录页；断网 / 超时 / 5xx 会重试几次，
   * 仍然失败就保留现状并给出重试入口 —— 手机上一次网络抖动就把人从工作区踢回登录页，
   * 正是之前「登录后闪退」的来源。
   */
  const bootstrapSession = useCallback(async (): Promise<SessionPayload | null> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < SESSION_ATTEMPTS; attempt += 1) {
      try {
        const payload = await api.session();
        setAppName(payload.appName);
        setSiteIconUrl(payload.siteIconUrl ?? null);
        setUser(payload.user);
        setDatabases(payload.databases);
        // 会话里带着名额：侧边栏一进来就能显示「还能添加几个表格」
        setQuota(payload.quota);
        if (payload.user && payload.databases.length) {
          setActiveId((prev) =>
            prev && payload.databases.some((item) => item.id === prev) ? prev : payload.databases[0].id,
          );
        }
        // 服务端明确说没登录：本地那份兜底令牌也已经没用了
        if (!payload.user) setSessionToken(null);
        setSessionError('');
        return payload;
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 401) {
          setSessionToken(null);
          setUser(null);
          setDatabases([]);
          setQuota(null);
          setSessionError('');
          return null;
        }
        lastError = cause;
        if (attempt < SESSION_ATTEMPTS - 1) await delay(SESSION_RETRY_MS * (attempt + 1));
      }
    }
    // 连不上服务器：保留当前界面（可能已经在工作区里），只记下原因并在未登录时提供重试
    setSessionError(lastError instanceof ApiError ? lastError.message : '网络连接失败');
    return null;
  }, []);

  /** 会话拉取失败后点「重试」：回到载入态再拉一次 */
  const retrySession = useCallback(() => {
    setBooting(true);
    void bootstrapSession().finally(() => setBooting(false));
  }, [bootstrapSession]);

  /**
   * 单次 401 不足以下结论（手机网络 / 代理偶发），跟服务端复核一次：
   * 返回 true 才是真的掉线了（此时 `/api/session` 明确回答没登录）。
   */
  const confirmSignedOut = useCallback(async (): Promise<boolean> => {
    try {
      const payload = await api.session();
      if (payload.user) return false;
      setSessionToken(null);
      setUser(null);
      setDatabases([]);
      setQuota(null);
      return true;
    } catch {
      // 连问都问不到：更像网络问题，保留当前界面不要把人踢出去
      return false;
    }
  }, []);

  useEffect(() => {
    // 公开分享页 / 邀请页自己取数据，不需要会话与表格列表
    if (shareToken || inviteToken) return;
    let cancelled = false;
    setBooting(true);
    void bootstrapSession().finally(() => {
      if (!cancelled) setBooting(false);
    });
    return () => {
      cancelled = true;
    };
  }, [shareToken, inviteToken, bootstrapSession]);

  /** 不是管理员（或退出登录）时，把主区域从后台收回来 */
  useEffect(() => {
    if (!user?.isAdmin) setAdminView(null);
  }, [user]);

  useEffect(() => {
    if (!activeId) {
      setDetail(null);
      setDetailError('');
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError('');
    void (async () => {
      try {
        const next = await api.getDatabase(activeId, { limit: 100 });
        if (!cancelled) setDetail(next);
      } catch (cause) {
        if (cancelled) return;
        setDetail(null);
        if (cause instanceof ApiError && cause.status === 401) {
          // 一次 401 说明不了什么（手机网络 / 代理偶发），先跟服务端复核再决定要不要退出登录
          const signedOut = await confirmSignedOut();
          if (cancelled) return;
          const message = signedOut ? '登录状态已失效，请重新登录' : '暂时连不上服务器，请稍后重试';
          setDetailError(message);
          toast(message, 'error');
          return;
        }
        const message = cause instanceof ApiError ? cause.message : '加载表格失败，请检查网络后重试';
        setDetailError(message);
        toast(message, 'error');
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, toast, detailReloadKey, confirmSignedOut]);

  /* ------------------------------------------------------------- 收件箱 */

  const refreshInbox = useCallback(async () => {
    if (!user) return;
    try {
      setInbox(await api.inbox());
    } catch {
      // 未登录 / 网络抖动时保持现状，下一轮轮询会再试
    }
  }, [user]);

  // 登录后立刻拉一次，之后轮询；切回标签页时也顺手刷新一次
  useEffect(() => {
    if (!user) {
      setInbox(EMPTY_INBOX);
      return;
    }
    void refreshInbox();
    const timer = window.setInterval(() => void refreshInbox(), INBOX_POLL_MS);
    const onFocus = () => void refreshInbox();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [user, refreshInbox]);

  /**
   * 点开一条私信：本地先把红点数字 -1（服务端同时标记已读），
   * 再打开这条私信对应的记录卡片，并定位到那条备注。
   */
  const openInboxMessage = useCallback(
    async (message: InboxMessage) => {
      setInbox((prev) => ({
        unread: Math.max(0, prev.unread - 1),
        messages: prev.messages.filter((item) => item.id !== message.id),
      }));
      try {
        const result = await api.readInboxMessage(message.id);
        setInbox((prev) => ({ ...prev, unread: result.unread }));
      } catch {
        // 标记已读失败也照样打开（下一轮轮询会把未读数同步回来）
      }
      setInboxTarget({ databaseId: message.databaseId, recordId: message.recordId, noteId: message.noteId });
      setActiveId(message.databaseId);
      // 手机上先收起抽屉，露出刚打开的记录卡片
      if (narrow) setSidebar(false);
    },
    [narrow, setSidebar],
  );

  const clearInboxTarget = useCallback(() => setInboxTarget(null), []);

  const refreshList = useCallback(async () => {
    try {
      // 列表和名额一起刷新：建表 / 删表（名额 -1 / +1）、买完名额后
      // 侧边栏底部的数字要跟着变
      const [result, nextQuota] = await Promise.all([
        api.listDatabases(),
        // 名额拿不到不影响列表刷新（沿用上一次的数字）
        api.quota().catch(() => null),
      ]);
      setDatabases(result.databases);
      if (nextQuota) setQuota(nextQuota.quota);
    } catch {
      // the list refresh is best effort only
    }
  }, []);

  const createDatabase = useCallback(
    /**
     * 新建表格固定走「空白表格」模板（不传 templateId 时后端就是 blank），不再让用户
     * 挑选模板；表格类型（试用 / 基础 / 专业）由侧边栏的表单选，名额按类型扣。
     */
    async ({ name, kind }: { name: string; kind: TableKind }) => {
      const created = await api.createDatabase({ name, kind });
      setDatabases((prev) => [summaryOf(created), ...prev.filter((item) => item.id !== created.id)]);
      setDetail(created);
      setActiveId(created.id);
      if (narrow) setSidebarOpen(false);
      toast(`已创建${tableKindLabel(created.kind)}「${created.name}」`);
      // 新建表格会占掉一个名额：顺手刷新侧边栏的「还能添加几个」
      void api
        .quota()
        .then((next) => setQuota(next.quota))
        // 名额只是提示，拿不到就沿用上一次的数字
        .catch(() => undefined);
    },
    [narrow, toast],
  );

  /** 购买表格名额：服务端算价（类型单价 × 数量 × 月数）并写一条购买流水，成功后刷新侧边栏的数字 */
  const buyQuota = useCallback(
    async ({ kind, count, months }: { kind: TableKind; count: number; months: number }) => {
      const result = await api.purchaseQuota({ kind, count, months });
      setQuota(result.quota);
      toast(
        `已购买 ${count} 个${tableKindLabel(kind)}名额（${purchaseMonthsLabel(months)}），现在可以添加了`,
      );
    },
    [toast],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // ignore: the local session is cleared either way
    }
    setUser(null);
    setDatabases([]);
    setQuota(null);
    setActiveId(null);
    setDetail(null);
    setDetailError('');
    setInbox(EMPTY_INBOX);
    setInboxTarget(null);
    setAdminView(null);
    setChangingPassword(false);
  }, []);

  const reauthenticate = useCallback(
    (next: SessionUser) => {
      setUser(next);
      // 重新拉一次会话：拿到表格列表并自动打开第一张（手机端不必再手动展开侧边栏）
      setDetailError('');
      setDetailReloadKey((value) => value + 1);
      void bootstrapSession().then((payload) => {
        if (!payload?.user) {
          toast('已登录，但这次没能同步会话：网络似乎不稳定，刷新页面或点「重试」即可', 'error');
        }
      });
    },
    [bootstrapSession, toast],
  );


  // 受邀人通过邮件里的 /invite/<token> 打开：填昵称 + 密码完成注册后直接进工作区
  if (inviteToken && !inviteDone && !user) {
    return (
      <InvitePage
        token={inviteToken}
        onAuthenticated={(next) => {
          setInviteDone(true);
          reauthenticate(next);
        }}
        onGoToLogin={() => setInviteDone(true)}
      />
    );
  }

  if (shareToken) return <PublicPage token={shareToken} />;

  if (booting) {
    return (
      <div className="centered">
        <p className="muted">正在载入 {appName}…</p>
      </div>
    );
  }

  if (!user) {
    // 会话没拉上（断网 / 服务端出错）：给一个明确的重试入口，而不是让人以为「没登录」
    if (sessionError) {
      return (
        <div className="centered">
          <div className="empty-state">
            <h2>连不上服务器</h2>
            <p className="error">{sessionError}</p>
            <p className="small muted">
              手机网络不稳定时很常见：点「重试」重新连接，登录状态不会因此丢失。
            </p>
            <div className="empty-actions">
              <button type="button" className="btn primary" onClick={retrySession}>
                重试
              </button>
            </div>
          </div>
        </div>
      );
    }
    return <AuthPage appName={appName} siteIconUrl={siteIconUrl} onAuthenticated={reauthenticate} />;
  }

  return (
    <div className={`app-shell${sidebarOpen ? '' : ' sidebar-collapsed'}${narrow ? ' narrow' : ''}`}>
      <Sidebar
        appName={appName}
        siteIconUrl={siteIconUrl}
        user={user}
        databases={databases}
        quota={quota}
        activeId={activeId}
        inbox={inbox.messages}
        inboxUnread={inbox.unread}
        open={sidebarOpen}
        narrow={narrow}
        onSelect={(id) => {
          setActiveId(id);
          // 从后台（用户管理 / 系统管理）切回表格
          setAdminView(null);
          // 手机上选完表格就收起抽屉，把屏幕还给表格
          if (narrow) setSidebarOpen(false);
        }}
        onCreate={createDatabase}
        onClose={() => setSidebar(false)}
        onLogout={() => void logout()}
        onChangePassword={() => setChangingPassword(true)}
        adminView={adminView}
        onOpenAdmin={(section) => {
          setAdminView(section);
          // 手机上点完就收起抽屉，把屏幕让给后台页面
          if (narrow) setSidebarOpen(false);
        }}
        onInboxRefresh={() => void refreshInbox()}
        onInboxSelect={(message) => void openInboxMessage(message)}
        onBuyQuota={buyQuota}
      />

      {narrow && sidebarOpen ? (
        <div className="sidebar-backdrop" role="presentation" onClick={() => setSidebar(false)} />
      ) : null}

      <main className="main">
        {narrow || !sidebarOpen ? (
          <div className="app-bar">
            <button
              type="button"
              className="icon-btn sidebar-toggle"
              title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
              aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
              aria-expanded={sidebarOpen}
              onClick={() => setSidebar(!sidebarOpen)}
            >
              {sidebarOpen ? '«' : '☰'}
            </button>
            <SiteMark appName={appName} siteIconUrl={siteIconUrl} className="brand" />
            {/* 侧边栏收起时看不到底部的用户信息，这里把登录用户昵称补在站点名与收件箱之间 */}
            {!sidebarOpen ? (
              <span className="small muted app-bar-user" title={user.email || user.name || ''}>
                {user.name || user.email}
              </span>
            ) : null}
            {/* 侧边栏收起时，收件箱标志挪到顶部条（看不到侧边栏左上角的那个） */}
            {!sidebarOpen ? (
              <InboxButton
                messages={inbox.messages}
                unread={inbox.unread}
                onRefresh={() => void refreshInbox()}
                onSelect={(message) => void openInboxMessage(message)}
              />
            ) : null}
            {narrow && detail ? <span className="muted small db-hint">{detail.name}</span> : null}
            <span className="spacer" />
            {/* 侧边栏收起时看不到「管理」下的入口，这里补两个后台按钮（右上角不再放邮箱 / 改密码 / 退出） */}
            {!sidebarOpen && user.isAdmin ? (
              <div className="app-bar-admin">
                <button
                  type="button"
                  className={`icon-btn${adminView === 'users' ? ' active' : ''}`}
                  title={adminView === 'users' ? '返回表格' : '用户管理'}
                  aria-label={adminView === 'users' ? '返回表格' : '用户管理'}
                  aria-pressed={adminView === 'users'}
                  onClick={() => setAdminView((prev) => (prev === 'users' ? null : 'users'))}
                >
                  👥
                </button>
                <button
                  type="button"
                  className={`icon-btn${adminView === 'system' ? ' active' : ''}`}
                  title={adminView === 'system' ? '返回表格' : '系统管理'}
                  aria-label={adminView === 'system' ? '返回表格' : '系统管理'}
                  aria-pressed={adminView === 'system'}
                  onClick={() => setAdminView((prev) => (prev === 'system' ? null : 'system'))}
                >
                  ⚙️
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {adminView === 'users' ? (
          <AdminUsersPanel me={user} onToast={toast} onReloadSession={() => void bootstrapSession()} />
        ) : adminView === 'system' ? (
          <AdminSystemPanel
            onToast={toast}
            onReloadSession={() => void bootstrapSession()}
            onBrandingChange={applyBrandingChange}
          />
        ) : detail ? (
          <DatabasePage
            key={detail.id}
            database={detail}
            me={user}
            onToast={toast}
            onReloadList={() => void refreshList()}
            inboxTarget={
              inboxTarget && inboxTarget.databaseId === detail.id
                ? { recordId: inboxTarget.recordId, noteId: inboxTarget.noteId }
                : null
            }
            onInboxTargetHandled={clearInboxTarget}
            onClose={() => {
              setActiveId(null);
              setDetail(null);
            }}
          />
        ) : detailLoading ? (
          <div className="centered">
            <p className="muted">正在载入表格…</p>
          </div>
        ) : detailError ? (
          <div className="centered">
            <div className="empty-state">
              <h2>无法加载表格</h2>
              <p className="error">{detailError}</p>
              <div className="empty-actions">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => setDetailReloadKey((value) => value + 1)}
                >
                  重试
                </button>
                {!sidebarOpen ? (
                  <button type="button" className="btn" onClick={() => setSidebar(true)}>
                    打开表格列表
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="centered">
            <div className="empty-state">
              <h2>
                <SiteMark appName={appName} siteIconUrl={siteIconUrl} />
              </h2>
              <p className="muted">从左侧选择一个表格，或点击 ＋ 新建一个。</p>
              {!sidebarOpen ? (
                <div className="empty-actions">
                  <button type="button" className="btn" onClick={() => setSidebar(true)}>
                    打开表格列表
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </main>

      {changingPassword ? (
        <ChangePasswordDialog onClose={() => setChangingPassword(false)} onToast={toast} />
      ) : null}

      {toasts.length ? (
        <div className="toasts">
          {toasts.map((item) => (
            <div key={item.id} className={`toast ${item.kind}`}>
              {item.message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

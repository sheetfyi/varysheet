/**
 * 站点标识：管理员在「后台 → 站点设置」上传过图标时，在站点名称前面显示那个图标。
 *
 * 没上传过就只显示名称，所以任何地方都能直接用（侧边栏、顶部条、空状态标题…）。
 * `img` 的 `alt` 留空（名称就在旁边，读两遍没有意义），于是外层元素的文本内容
 * 始终恰好等于站点名称。
 */
interface SiteMarkProps {
  appName: string;
  siteIconUrl: string | null;
  className?: string;
}

export function SiteMark({ appName, siteIconUrl, className }: SiteMarkProps) {
  return (
    <span className={className}>
      {siteIconUrl ? <img className="brand-icon" src={siteIconUrl} alt="" /> : null}
      {appName}
    </span>
  );
}

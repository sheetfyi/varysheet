/**
 * 新建记录时的状态默认值：状态类字段默认落到「录入中」。
 *
 * 表格的状态字段（含模板生成的）通常只列了「未开始 / 进行中 / 已完成」，
 * 因此字段里还没有「录入中」选项时由这里自动补一个并写回字段配置（只发生一次），
 * 否则「默认落到录入中」就无从落地。
 */
import { DEFAULT_STATUS_OPTION, createId, defaultOptionColor, hasDefaultStatus } from '../shared/fields';
import type { Property, RowValues, SelectOption } from '../shared/types';

/**
 * 把新建记录的字段值补上状态默认值。
 * `overwrite` 为 true 时用户显式传了状态值也会被覆盖（目前只用于「新建」语义的接口）。
 *
 * `db` 是这张表所在的分片库（`properties` 在分片里，跟调用方手上的库是同一个）。
 */
export async function withDefaultStatus(
  db: D1Database,
  databaseId: string,
  properties: Property[],
  values: RowValues,
  overwrite = false,
): Promise<RowValues> {
  const targets = properties.filter(
    (property) => hasDefaultStatus(property) && !property.locked,
  );
  if (!targets.length) return values;

  const next: RowValues = { ...values };
  let touched = false;
  for (const property of targets) {
    if (!overwrite && next[property.id] !== undefined && next[property.id] !== null) continue;
    const option = await ensureStatusOption(db, databaseId, property);
    if (!option) continue;
    next[property.id] = option;
    touched = true;
  }
  return touched ? next : values;
}

/** 字段里没有「录入中」时补一个（写回 properties.config），返回该选项。 */
async function ensureStatusOption(
  db: D1Database,
  databaseId: string,
  property: Property,
): Promise<SelectOption | null> {
  const options: SelectOption[] = Array.isArray(property.config?.options)
    ? [...property.config.options]
    : [];
  const existing = options.find((option) => option.name === DEFAULT_STATUS_OPTION);
  if (existing) return existing;

  const option: SelectOption = {
    id: createId(),
    name: DEFAULT_STATUS_OPTION,
    color: defaultOptionColor(options.length),
  };
  const config = { ...property.config, options: [...options, option] };
  await db
    .prepare('UPDATE properties SET config = ?, updated_at = ? WHERE id = ? AND database_id = ?')
    .bind(JSON.stringify(config), Date.now(), property.id, databaseId)
    .run();

  // 同一次请求里可能还会用到这个字段（例如批量新建），就地更新内存中的配置
  property.config = config;
  return option;
}

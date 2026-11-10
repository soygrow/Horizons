/**
 * 后台脚本的共用参数解析。
 *
 * enrich / revert 两个脚本的入参形态完全一致（--slugs=a,b + --dry + --force），
 * 放一份省得各写一遍，也免得哪天一处改了另一处没跟上。
 */

/** 支持 `--slugs a,b` 与 `--slugs=a,b` 两种写法：workflow 用前者，命令行手敲常用后者 */
export function arg(name: string): string | undefined {
  const inline = process.argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

/** 逗号或空白分隔的 slug 列表 */
export function parseSlugs(): Set<string> {
  const raw = arg("--slugs") ?? "";
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
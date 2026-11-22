/**
 * 同网分组：把服务端观察到的来源出口地址映射成一个组键。
 * 与具体框架无关，Node / Cloudflare 都能用。
 */

/** 去掉 IPv4-mapped IPv6 前缀（::ffff:1.2.3.4 → 1.2.3.4）。 */
export function normalizeAddress(raw: string): string {
  return raw.replace(/^::ffff:/i, '');
}

export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  if (!parts.every((part) => /^\d{1,3}$/.test(part))) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** 按 RFC1918 自然边界归组：10/8、172.16/12、192.168/16，回环与链路本地各自成组。 */
function privateIpv4Block(ip: string): string {
  const [a, b] = ip.split('.').map(Number);
  if (a === 127) return 'loopback';
  if (a === 10) return '10';
  if (a === 172 && b >= 16 && b <= 31) return '172.16-31';
  if (a === 192 && b === 168) return '192.168';
  if (a === 169 && b === 254) return '169.254';
  return ip;
}

/**
 * 分组键，按服务器所处位置自动适配：
 * - 回环地址：全部同组（本机多标签页/本地调试）。
 * - 私网地址：服务器就在这个局域网里，按 RFC1918 块边界归组。
 * - 公网地址：服务器在公网/云上，来源是 NAT 之后的出口 IP，按完整地址归组。
 * - 拿不到来源地址（Next Route Handler 直连部署）：全部并入 direct 组，
 *   同一台服务器前的设备默认互相可见。
 */
export function groupKey(raw: string): string {
  const value = normalizeAddress(raw).trim();
  if (!value) return 'direct';
  if (value === '127.0.0.1' || value === '::1') return 'loopback';
  if (value.includes(':')) {
    const head = value.split(':')[0].toLowerCase();
    if (/^f[cd]/.test(head)) return `lan:v6:${value.split(':').slice(0, 4).join(':')}`;
    if (/^fe[89ab]/.test(head)) return 'lan:v6:link-local';
    return `wan:v6:${value}`;
  }
  if (!isPrivateIpv4(value)) return `wan:v4:${value}`;
  return `lan:v4:${privateIpv4Block(value)}`;
}

/**
 * 从请求里推导分组键。
 * - Cloudflare 部署：优先 `CF-Connecting-IP`（由边缘自动注入，不可伪造）。
 * - 受信反代之后：`TRUST_PROXY=1` 时取 `X-Forwarded-For` 首段。
 * - 直连部署拿不到来源地址时归入 direct 组。
 */
export function networkIdFromRequest(
  headers: Headers,
  trustProxy = false,
): string {
  const cf = headers.get('cf-connecting-ip');
  const forwarded = headers.get('x-forwarded-for');
  const raw = trustProxy && forwarded && forwarded.trim()
    ? forwarded.split(',')[0].trim()
    : (cf ?? '');
  return groupKey(normalizeAddress(raw));
}

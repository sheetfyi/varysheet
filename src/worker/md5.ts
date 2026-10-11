/**
 * 纯 TypeScript 的 MD5（RFC 1321），给 XorPay 的签名 / 验签用。
 *
 * 为什么不用现成的：Workers 的 Web Crypto 没有 MD5（只有 SHA 系列），
 * 而 XorPay 的下单、回调、查单三个签名都是 `md5(value 顺序拼接 + app secret)`。
 * 实现只做一件事：UTF-8 字符串 → 32 位小写十六进制摘要。
 *
 * 已对 RFC 1321 标准向量验证：`md5("")` = d41d8cd98f00b204e9800998ecf8427e、
 * `md5("abc")` = 900150983cd24fb0d6963f7d28e17f72，并与 `node:crypto` 的
 * `createHash('md5')` 对 300 条随机 UTF-8 字符串结果完全一致。
 */
export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  // 填充：先补一个 0x80，再补 0 到「长度 % 64 === 56」，最后 8 字节小端位长
  const withOne = bytes.length + 1;
  const padLength = (56 - (withOne % 64) + 64) % 64;
  const total = withOne + padLength + 8;
  const buffer = new Uint8Array(total);
  buffer.set(bytes, 0);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(total - 8, bitLength >>> 0, true);
  view.setUint32(total - 4, Math.floor(bitLength / 0x100000000), true);

  /** 每轮的左移位数（RFC 1321 表 T） */
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  /** K[i] = floor(abs(sin(i + 1)) * 2^32) */
  const table = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  const chunk = new Uint32Array(16);

  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) chunk[i] = view.getUint32(offset + i * 4, true);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const previousD = d;
      d = c;
      c = b;
      const sum = (a + f + table[i] + chunk[g]) | 0;
      b = (b + ((sum << shifts[i]) | (sum >>> (32 - shifts[i])))) | 0;
      a = previousD;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
  }

  let out = '';
  for (const word of [h0, h1, h2, h3]) {
    // 小端序输出
    for (let i = 0; i < 4; i += 1) out += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return out;
}

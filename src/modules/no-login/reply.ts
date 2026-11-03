/**
 * 免登录子评论请求改写（纯逻辑）——可单测。
 * 子评论接口 /x/v2/reply/reply 带 x-bili-device-req-json 时，匿名请求只返回第 1 页、翻页失效；
 * 去掉该参数即可正常翻页（逆向自 beefreely v3.0.1 / vruses/beefreely@8409e7b）。
 * 不带该参数时返回 undefined：不改 url，让 net-hook 走「只改 credentials」的 Request 克隆路径，原请求其余字段不动。
 */
export function stripReplyDeviceParam(url: string): string | undefined {
  const i = url.indexOf('?')
  if (i < 0) return undefined
  const params = new URLSearchParams(url.slice(i + 1))
  if (!params.has('x-bili-device-req-json')) return undefined
  params.delete('x-bili-device-req-json')
  const qs = params.toString()
  return qs ? `${url.slice(0, i)}?${qs}` : url.slice(0, i)
}

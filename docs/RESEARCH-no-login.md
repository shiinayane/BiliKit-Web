# 免登录（看评论 / 动态 / 1080p）：机制与设计

> 目标：BiliKit-Web **自己**实现「免登录看评论 + 看他人动态 + 1080p 视频」，装了它就能**卸载 beefreely**，
> 从根上消掉「两个脚本抢 fetch/XHR」的竞态（见 issue #2）。落成 Core 新模块 `no-login`。
>
> 结论来自 2026-07 逆向 [vruses/beefreely](https://github.com/vruses/beefreely)（`@grant none`、`document-start`）
> 的源码 + 我们已有基建（wbi 签名、playurl hook）。

## 一、完整配方（逆向自 beefreely，实测可用）

前提：**仅在服务端确认未登录时动手**；已登录一律不碰。仅顶层窗口；跳过 `passport`。

不能把 `DedeUserID__ckMd5` 是否存在直接等同于有效登录：Firefox 普通窗口可能残留服务端已失效的
登录 cookie，导致 B 站按访客处理、而 BiliKit-Web 误判成真登录后整体退出（issue #5）。现在采用三态判断：

1. 没有 `DedeUserID__ckMd5`：立即进入访客快路径，不增加请求；
2. 有标记且同一 cookie 已由 `/x/web-interface/nav` 确认真登录：短期缓存并完全让路；
3. 有标记但 nav 明确返回 `isLogin:false`（无 Cookie 时 `code:0`，失效 Cookie 时通常 `code:-101`）：
   把 cookie 摘要记入当前标签页的 `sessionStorage`，只刷新一次，
   下一次 `document-start` 忽略该失效标记并及时安装 playinfo/fetch/XHR hook。

网络失败、限流或异常响应均保持 `unknown` 并保守让路；不删除用户 cookie，也不刷新，避免误伤真账号。

| 目的 | 手法 | 接口 / 位置 |
|---|---|---|
| 全站「已登录」假象 | 伪造 `DedeUserID=<随机>; domain=.bilibili.com` cookie | `document.cookie` |
| 登录态 UI + 动态可见 | nav 响应里把登录字段填成已登录（**保留 `wbi_img` 不动**） | `/x/web-interface/nav` |
| 看评论（含子评论） | 请求改 `credentials:'omit'` 走匿名（假 cookie 会被拒，去掉反而正常返公开评论） | `/x/v2/reply/wbi/main`、`/x/v2/reply/reply` |
| 1080p 取流 | query 塞 `qn=80` + `try_look=1`（官方试看），去掉旧 `w_rid/wts`，**重新 wbi 签名** | `/x/player/wbi/playurl` |
| 播放器 UI 认账（清晰度/字幕可选） | 响应里改 `login_mid`=随机、`need_login_subtitle`=false、`current_level`=6 | `/x/player/wbi/v2` |
| 逼播放器重新取流 | 清空页面预埋的低清 `window.__playinfo__`（置 null）+ 注入空 `playurlSSRData` | document-start |

要点：
- **评论无需改响应**，只需 `credentials:'omit'`（beefreely `useReply` 就一行）。
- **1080p 无需真登录**：`try_look=1` 是 B 站官方「试看」；配 `qn=80` + 重签即出 1080p。
- **动态无需专门 hook**：nav 变「已登录」后自然加载。

## 二、我们已有 vs 要新增

**已有（直接复用）**：
- **wbi 签名算法**：`src/lib/wbi.ts` 的 mixin 表 + `md5` 与 beefreely `encWbi` **逐字一致**。
- **playurl hook 经验**：`cdn-pick` 已在包 fetch/XHR 改 playurl 响应（换 CDN host）。

**新增**：
1. **Core 版 wbi 取 key**：`wbi.ts` 现走 `gmRequest`（Feed 的 GM），Core 无 GM。
   Core 里改从 **`localStorage.wbi_img_url` / `wbi_sub_url`** 读（B 站播放器自己缓存的），截文件名当 key——
   和 beefreely `useWebKey` 同法，**同源、免网络、免 GM**。缺失时用「捕获到的原生 fetch」打一次 nav（`credentials:'omit'`）兜底。
2. **一个精简 fetch/XHR 拦截器**（`net-hook.ts`）：支持按 URL 片段匹配 → 改请求(url/credentials) / 改响应(text/json)。
   相当于袖珍版 ajaxHooker，但**只服务本模块的固定几个接口**，写法透明、对非匹配请求原样透传。
3. **`no-login` 模块**：装配上面的配方 + document-start 的 cookie / playinfo 处理。

## 三、模块设计（`src/modules/no-login/`）

- `runAt: 'start'`（cookie、`__playinfo__`、hook 必须早于播放器）。
- **默认关**：它会让全站显示成「已登录（假账号）」，属侵入性功能，用户显式开启。
- 仅 `window.top === window.self`（v1 不进抽屉 iframe，避免 cookie/时序复杂化，后续再评）。
- 面板走标准模块设置：一个主开关即可；可留子项（如「仅 1080p、不伪造评论/动态」）后续加。

## 四、和现有模块共处

- `no-login`（改 playurl **请求**）↔ `cdn-pick`（改 playurl **响应** host）：一出一回、不同阶段，天然共存。
- `no-login` 置空 `__playinfo__` → `cdn-pick` 读 `__playinfo__` 时得 null 跳过 → 走新 playurl 请求（no-login 升级）→ 响应再由 cdn-pick 换 host。链路自洽。
- 三个 Core 网络 hook（cdn-pick / no-track / no-login）**都是自家、经 `register()` 定序**，无 beefreely 那种第三方竞态。

## 五、副作用与边界（务必对用户说清）

- **纯只读观看**：页面「以为」你登录（显示假账号 `bilibili`、6 级）。任何要真鉴权的动作（发评论、点赞、投币、历史同步）都会失败。
- **1080p 上限**：`try_look` 给到 1080p（非大会员片源）；4K/HDR/大会员专享清晰度拿不到。
- **假账号观感**：右上角会显示伪造用户（可后续美化/隐藏）。
- **登录后自动让路**：`DedeUserID__ckMd5` 只作为候选标记，最终以 nav 的 `isLogin` 为准；真登录整体不启用。
- **顺带修好 IP 属地**：评论走匿名真实响应（含 `reply_control.location`），`comment-location` 又能读到属地了。

## 六、分阶段实现

1. **P1 登录态 + 评论 + 动态**：net-hook + 假 cookie + nav 改写 + reply `credentials:'omit'`。不依赖 wbi。
2. **P2 1080p**：Core 版 wbi + playurl 请求重签 + player/v2 改写 + `__playinfo__` 置空。
3. **P3 打磨**：面板子项、抽屉 iframe 是否启用、假账号观感。

## 参考
- beefreely 源码：`src/core/index.ts`（假 cookie / 登录判断）、`src/bilibili/shared/hooks.ts`（nav/reply）、
  `src/bilibili/www/video/hooks/index.ts`（playurl/player v2）、`src/utils/wbi-sign.ts`、`src/constants/sign.ts`（localStorage 取 key）。
- wbi 算法：bilibili-API-collect `docs/misc/sign/wbi.md`。

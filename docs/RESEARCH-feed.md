# B 站首页推荐 Feed 调研

> 起因:看 [Bilibili-Gate](https://github.com/magicdawn/Bilibili-Gate) 首页自定义 feed 的原理,以及"为什么推荐内容和真 App 有差别、还很多重复"。
> 结论来自源码通读 + 联网核实(2026-07)。若日后自建 feed 功能,这份是设计依据。
>
> ⚠️ 社区文档 **SocialSisterYi/bilibili-API-collect** 于 2026-01 底收到 B 站法务函下架(默认分支改 `deprecated`、Issues 关闭)。下文接口表引自存活镜像 [pskdje/bilibili-API-collect](https://github.com/pskdje/bilibili-API-collect) 与 DeepWiki。

## TL;DR

- 首页「推荐」Tab 走的是**手机 App 推荐接口** `app.bilibili.com/x/v2/feed/index`,不是网页端接口。
- **个性化完全靠 `access_key`**;不带 = 匿名热门流,不是你账号调教出来的推荐。这是"感觉不如真 App"的头号原因。
- **重复内容**三重成因:①去重只在单次刷新内做、刷新之间零记忆;②App 接口 `idx` 是续传游标,**没有** web 端 `last_showlist`(已展示 avid)那种服务端去重;③**匿名请求会触发反爬,被喂"固定内容池 1–24h"**——这条是代码看不出来、联网才挖到的最狠原因。
- 用 **TV 端 access_key** 取个性化数据是第三方工具**事实标准**(BBDown / DownKyi / bilibili-api 等 ~250+ 仓库复用同一把泄露 appkey)。Bilibili-Gate 的做法合理、主流。

---

## 一、两条推荐线

|            | App 推荐(默认「推荐」Tab)          | PC 推荐 Tab                                                |
| ---------- | ---------------------------------- | ---------------------------------------------------------- |
| 接口       | `app.bilibili.com/x/v2/feed/index` | `api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd` |
| 个性化凭证 | **`access_key`**(App 登录 token)   | **网页 Cookie**(SESSDATA)                                  |
| 未认证时   | 匿名热门流                         | 匿名热门流                                                 |
| 分页       | `idx` 续传游标(时间戳类)           | `fresh_idx` 自增页码                                       |
| 服务端去重 | ❌ 无                               | ✅ 回传 `last_showlist`(已展示 avid),服务端避重             |
| 每页       | 16                                 | ≤30                                                        |
| 签名       | TV appkey/appsec + MD5 `sign`      | WBI(`w_rid`/`wts`)                                         |

官方文档对 App 接口的原话:「添加 `accessKey` 会返回个性化内容和横幅」。→ 不带就是通用池。
两条线**认证时都个性化,匿名时都退化成热门流**;差别在 App 线更容易重复(见下)。

## 二、Bilibili-Gate 具体怎么调(源码事实)

以下路径均在 `Bilibili-Gate/` 子仓:

- App 推荐请求:`src/modules/rec-services/app.tsx`
  - 硬编码参数 `build:'1'`, `mobi_app:'iphone'`, `device:'pad'`, `idx = 当前秒级时间戳 + randomInt(1000)`。
  - 注意 `build:'1'` 是假版本号;那套"正规" common params(`build:'37300100'` 等)在 `src/utility/app-api.ts`,是别的接口(如 liked)用的,**不是推荐 feed 用的**。
  - `getRecommendTimes` 会**并行发 N 次(默认 2)近乎相同的请求**再合并,同一时刻打同一接口天然重叠。
- 签名/凭证注入:`src/request.ts` 的 `gmrequest` 拦截器自动补 `appkey`(TV 端)+ `access_key: settings.accessKey || ''` + `sign`。→ **没配 access_key 就是空串 = 匿名。**
- 去重层级(`src/modules/rec-services/index.ts`):
  - 单次请求内:`uniqBy(param)` / `uniqBy(id)`。
  - 单次刷新内跨页:`concatRecItems` 按 **bvid** 去重;代码注释坦白 `// 可能有重复, so not 1.0`,故过量拉取 1.2×。
- **刷新即失忆**:`src/components/RecGrid/useRefresh.ts` 刷新时 `items: []` 清空、换新 `refreshKey`。**没有跨刷新/跨会话的"已展示"持久集合**(唯一有本地持久去重的是「动态」Tab 的 cache,按 `id_str`)。
- 混料:开启「显示来自其他 Tab 的内容」后,按 **7:3** 把 动态/收藏/稍后再看 洗进推荐(`app.tsx`)。收藏用 Shuffle 顺序 → 有限集反复重排,必然反复看到自己收藏过的。

## 三、"重复内容"三重成因(核实版)

1. **无跨刷新去重**:客户端只在单次刷新内按 bvid 去重,刷新之间零记忆。
2. **App 接口无服务端去重**:`idx` 是"上一批最后一项的续传游标",不是页码,且没有 web 那套 `last_showlist` 回传机制。
3. **反爬固定池(最狠)**:匿名/剥 cookie 的重复请求会被 B 站判为爬虫,随后**返回一个固定不变的内容集,持续约 1–24 小时**(TabulaBili 文档明确警告)。签名/access_key 不对时还会撞 `-663 鉴权失败`。

→ 匿名态下"同一批视频翻来覆去"很大程度是反爬主动喂的,不只是分页 bug。**配好 access_key 是釜底抽薪。**

## 四、有没有人做过类似的——对立两派

| 项目                                                                                                                                | 思路                                                             | 数据源                                  |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------- |
| [Bilibili-Gate](https://github.com/magicdawn/Bilibili-Gate)(前身 `bilibili-app-recommend`)                                          | 把 **App 推荐**搬上网页,追求"更像 App、更个性化"                 | App `feed/index`(需 access_key)+ 多 Tab |
| [EvansSec/bilibili-app-recommend](https://github.com/EvansSec/bilibili-app-recommend)                                               | 本项目改名前的历史快照/fork                                      | 同上                                    |
| [TabulaBili](https://github.com/tjsky/TabulaBili)                                                                                   | **反向**:拦截 web 推荐接口、剥 Cookie/buvid/WBI,故意**去个性化** | web `rcmd`,强制匿名                     |
| [Bilibili-Evolved](https://github.com/the1812/Bilibili-Evolved) / [bilibili-cleaner](https://github.com/festoney8/bilibili-cleaner) | 只**过滤/换肤**原生 feed,不换源                                  | 原生                                    |

"推荐重复/同质化"正是两派分水岭:Bilibili-Gate 靠**换数据源**解决(README 自述 web 自带推荐「貌似不推番剧」,换 App 接口「结果更理想」);TabulaBili 立项动机就是"反复推同质内容、视野变窄",靠**彻底去个性化**解决(每次刷新=失忆式全新访问)。

## 五、TV 端 access_key 是不是通用解法——是,事实标准

- **原理**:模拟"云视听小电视"(Android TV/OTT)扫码登录(`passport-tv-login/qrcode/auth_code` + `/poll`)。成功一次即返回 `access_token`(有效期 **180 天**)+ `refresh_token` + 一整套 web cookies(SESSDATA/bili_jct...)——**一次扫码两样都拿到**。
- **为什么用 TV 那把 key**:TV appkey **`4409e2ce8ffd12b8`**(appsec `59b43e...`)是**公开泄露、可 MD5 签名**的固定密钥,不像 web 登录要 WBI/极验验证码。
- **有多通用**:GitHub 搜这把 appkey 命中 **~250+ 仓库**,含 BBDown、DownKyi(哔哩下载姬)、Nemo2011/bilibili-api、biliup、以及 Bilibili-Gate 自身。BBDown 专门分 `login`(web)/ `logintv`(TV)两命令。
- **TV/app 线比 web cookie 多能干的**:无水印源流、更高画质(8K/HDR/DV)、TV 域番剧、`area=hk|tw` 区域解锁(绕 `-10403`)。代价:token 绑定发它的那对 appkey,换 key 调用即 `-663`。
- **纠正**:yutto v2 现在用的是 **web SESSDATA** 扫码,不是 TV key;强绑 TV-key 的主要是 BBDown/DownKyi/各 TV 客户端。

## 六、若 BiliKit-Web 自建 feed——改善优先级

1. **配好 access_key**(TV 扫码):匿名热门流 → 真·个性化,同时避开反爬固定池。**最大杠杆。**
2. **加跨刷新的 bvid「已展示」集合**(可持久化 localStorage):App 接口没有 `last_showlist`,得自己在客户端补去重。纯前端、改动最小、不依赖账号配置。
3. **少混料**:别把有限的收藏/动态洗进推荐反复出现。

> 与 BiliKit-Web 现状的关系:当前 BiliKit-Web 是纯 web 前端油猴脚本(评论/主题/播放页增强),TV access_key 只在将来做"取流/下载/区域解锁"这类 app 域功能时才需要。留在浏览器内的功能走 SESSDATA/WBI 即可。

## 参考

- 接口/签名/appkey 表(镜像):<https://github.com/pskdje/bilibili-API-collect>
- 上游(已 DMCA 限制,默认分支 `deprecated`):<https://github.com/SocialSisterYi/bilibili-API-collect>
- Bilibili-Gate:<https://github.com/magicdawn/Bilibili-Gate>
- TabulaBili(去个性化 + 反爬固定池警告):<https://github.com/tjsky/TabulaBili>
- BBDown(TV 登录实现):<https://github.com/nilaoda/BBDown> · DownKyi:<https://github.com/leiurayer/downkyi>

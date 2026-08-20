# BiliKit-Web Brand Mark

本目录保存 BiliKit-Web 图标的三层几何源文件，逐文件复制自同级项目
`BiliKit-Mac` 的 `Design/AppIcon/v1/`：

1. `01-k-lower-underlay.svg`
2. `02-k-upper-underlay.svg`
3. `03-blue-foreground.svg`

仓库中的 `assets/logo.svg` 按上述顺序直接合成三层几何；`assets/logo.png` 则由该合成 SVG
确定性导出。Web 版本刻意保留透明背景，不包含 Icon Composer 的 enclosure、Liquid Glass、
高光、折射、模糊或阴影。

画布为 1024 × 1024，颜色与 BiliKit-Mac 源文件一致：珊瑚色 `#FF607A`、蓝色
`#195CFF`。SVG 保留 Display P3 声明；PNG 使用兼容浏览器与脚本管理器的 sRGB 回退色。

这些文件属于 BiliKit-Web 品牌资产，不在 MIT License 授权范围内。具体允许与限制见仓库根目录
的 [品牌资产权利声明](../../BRAND-ASSETS.md)。

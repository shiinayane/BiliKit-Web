#!/bin/bash
# BiliKit-Web · CDN 镜像吞吐测速
#
# 配 scripts/cdn-pick.user.js 用：逐个 bilivideo 镜像下载同一段、比真实吞吐，
# 挑最快的填进 cdn-pick 的 TARGET_HOST。延迟会骗人，必须测吞吐。
#
# 用法：
#   1. 在正播放的 B 站视频页控制台跑（取一条带 upsig 的 bilivideo 分片地址）：
#        performance.getEntriesByType('resource').map(e=>e.name)
#          .filter(u=>/\.m4s/.test(u) && /bilivideo\.com/.test(u) && /upsig=/.test(u)).slice(-1)[0]
#   2. bash test/cdntest.sh '<上一步输出的完整 URL>'
#
# 要点：
#   - upsig 签名与主机名无关，故一条样本可测所有 bilivideo 镜像（换主机即可）。
#   - 必须带 Referer/UA，否则 upos 返 403。
#   - akamaized 用的是 hdnts 签名，不能用 bilivideo 样本测，已排除。
#   - 想验「回源」：分别用「热门视频」和「冷门(几百播放)视频」各测一轮——
#     冷门吞吐显著更低、海外镜像甚至 HTTP 514(回源失败)，即坐实回源。
#   - 坏窗口（正卡时）测最有意义：看谁还扛得住。
set -u
URL="${1:-}"
URL=$(printf '%s' "$URL" | sed -E "s/^[[:space:]\"']+//; s/[[:space:]\"']+$//") # 擦掉首尾引号/空白
[ -z "$URL" ] && { echo "用法: bash test/cdntest.sh '<bilivideo的.m4s完整URL>'"; exit 1; }

hosts=(
  upos-sz-mirrorhw.bilivideo.com      upos-sz-mirrorhwb.bilivideo.com
  upos-sz-mirrorali.bilivideo.com     upos-sz-mirroralib.bilivideo.com
  upos-sz-upcdnbda2.bilivideo.com     upos-sz-mirrorbos.bilivideo.com
  upos-sz-mirrorcos.bilivideo.com     upos-sz-mirrorcosb.bilivideo.com
  upos-sz-mirrorcosov.bilivideo.com   upos-sz-mirroraliov.bilivideo.com
)
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15'
orig=$(echo "$URL" | sed -E 's#^(https?://)?([^/]+)/.*#\2#')
echo "原始主机: $orig ｜ 每个镜像顺序下载前 ~20MB 测吞吐（串行，避免互抢带宽）"; echo
res=$(mktemp)
test_one(){
  local h="$1" u out
  u=$(echo "$URL" | sed -E "s#^(https?://)?[^/]+/#https://$h/#")
  out=$(curl -sS -o /dev/null -H "Range: bytes=0-20971520" -H "Referer: https://www.bilibili.com/" \
        -H "User-Agent: $UA" --connect-timeout 4 --max-time 20 \
        -w '%{speed_download} %{http_code} %{time_starttransfer}' "$u" 2>/dev/null)
  awk -v h="$h" -v o="$out" 'BEGIN{split(o,a," "); printf "%.1f %s %.0f %s\n", a[1]*8/1e6, a[2], a[3]*1000, h}'
}
[ -n "$orig" ] && test_one "$orig" >> "$res"
for h in "${hosts[@]}"; do [ "$h" = "$orig" ] && continue; test_one "$h" >> "$res"; done
printf "%8s %6s %8s   %s\n" "Mbps" "HTTP" "TTFBms" "镜像"
sort -k1 -nr "$res" | awk '{printf "%8s %6s %8s   %s\n",$1,$2,$3,$4}'
rm -f "$res"
echo; echo "（HTTP 206/200=成功；403=缺 Referer/签名失效；514=回源失败；Mbps 越高越好）"

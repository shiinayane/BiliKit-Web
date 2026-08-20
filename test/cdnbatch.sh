#!/bin/bash
# BiliKit-Web · CDN 镜像批量测速（多样本聚合）
#
# 配 cdntest.sh：单样本看不准（吞吐随时段/视频冷热波动），用一批样本聚合，
# 看哪个镜像在「中位吞吐 + 成功率」上长期最稳。
#
# 用法：
#   1. 收集若干条 bilivideo .m4s URL，每行一条存进 urls.txt（# 开头的行忽略）。
#      每条的取法：在对应视频页控制台跑——
#        performance.getEntriesByType('resource').map(e=>e.name)
#          .filter(u=>/\.m4s/.test(u)&&/bilivideo\.com/.test(u)&&/upsig=/.test(u)).slice(-1)[0]
#   2. bash test/cdnbatch.sh urls.txt
#
#   每个探测默认下 10MB（CHUNK 可调）。10 镜像 × N 样本 × 10MB ≈ N×100MB 流量。
#   样本里建议混入「冷门(几十~几百播放/刚发)」和「热门」各几条，冷门最考验回源。
#   URL 有时效(deadline 几小时)，收齐尽快跑。坏窗口(正卡时)测最有意义。
set -u
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15'
CHUNK=${CHUNK:-10485760} # 每探测下载字节数，默认 10MB；想更准 CHUNK=20971520 跑
hosts=(
  upos-sz-mirrorhw.bilivideo.com      upos-sz-mirrorhwb.bilivideo.com
  upos-sz-mirrorali.bilivideo.com     upos-sz-mirroralib.bilivideo.com
  upos-sz-upcdnbda2.bilivideo.com     upos-sz-mirrorbos.bilivideo.com
  upos-sz-mirrorcos.bilivideo.com     upos-sz-mirrorcosb.bilivideo.com
  upos-sz-mirrorcosov.bilivideo.com   upos-sz-mirroraliov.bilivideo.com
)
infile="${1:-/dev/stdin}"
[ "$infile" != "/dev/stdin" ] && [ ! -f "$infile" ] && { echo "找不到文件: $infile"; exit 1; }
raw=$(mktemp); n=0
while IFS= read -r URL || [ -n "$URL" ]; do
  # 擦掉控制台复制常带的首尾引号/空白/回车，否则主机替换错位、全镜像 403
  URL=$(printf '%s' "$URL" | sed -E "s/^[[:space:]\"']+//; s/[[:space:]\"'$(printf '\r')]+$//")
  [ -z "$URL" ] && continue
  case "$URL" in \#*) continue ;; esac
  # 音频流(30216/30232/30250/30251/30280)文件太小，测的是延迟不是吞吐 → 警告
  case "$URL" in
    *-30216.m4s*|*-30232.m4s*|*-30250.m4s*|*-30251.m4s*|*-30280.m4s*)
      echo "  ⚠ 这是音频流，文件小测不准吞吐，建议换视频流样本" >&2 ;;
  esac
  n=$((n + 1))
  echo "[$n] $(echo "$URL" | sed -E 's#\?.*##')" >&2
  for h in "${hosts[@]}"; do
    u=$(echo "$URL" | sed -E "s#^(https?://)?[^/]+/#https://$h/#")
    out=$(curl -sS -o /dev/null -H "Range: bytes=0-$CHUNK" -H "Referer: https://www.bilibili.com/" \
          -H "User-Agent: $UA" --connect-timeout 4 --max-time 20 -w '%{speed_download} %{http_code}' "$u" 2>/dev/null)
    awk -v h="$h" -v o="$out" 'BEGIN{split(o,a," "); printf "%s %.1f %s\n", h, a[1]*8/1e6, a[2]}' >> "$raw"
  done
done < "$infile"
echo >&2
echo "=== 聚合（$n 个样本）｜按中位吞吐排序 ==="
printf "%-32s %9s %8s %8s %8s\n" "镜像" "中位Mbps" "均值" "最低" "成功/总"
awk '
{ h=$1; tot[h]++
  if($3==206||$3==200){ ok[h]++; sum[h]+=$2; v[h]=v[h] $2 " " } }
END{
  for(h in tot){
    m=split(v[h],a," ")-1
    for(i=1;i<=m;i++)for(j=i+1;j<=m;j++)if(a[i]+0>a[j]+0){t=a[i];a[i]=a[j];a[j]=t}
    med=(m>0)?(m%2?a[(m+1)/2]:(a[m/2]+a[m/2+1])/2):0
    mn=(m>0)?a[1]:0; mean=(ok[h]>0)?sum[h]/ok[h]:0
    printf "%s %.1f %.1f %.1f %d/%d\n",h,med,mean,mn,ok[h]+0,tot[h]
  }
}' "$raw" | sort -k2 -nr | awk '{printf "%-32s %9s %8s %8s %8s\n",$1,$2,$3,$4,$5}'
rm -f "$raw"
echo; echo "（按中位吞吐高 + 成功率高 选；冷门样本里仍稳的才是真赢家）"

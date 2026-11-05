#!/usr/bin/env bash
# Builds the OFFICIAL Redis source into .tools/redis for Windows dev machines that
# have MSYS2 but no Docker. Uses a private MSYS2 root so the system install is untouched.
# Run with MSYS2 bash:  C:\msys64\usr\bin\bash.exe -l scripts/build-redis-msys.sh
set -euo pipefail
REDIS_VERSION="${REDIS_VERSION:-7.4.2}"
PROJECT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
ROOT="$PROJECT/.tools/msys"
OUT="$PROJECT/.tools/redis"
mkdir -p "$ROOT/var/lib/pacman" "$ROOT/var/cache/pacman/pkg" "$ROOT/var/log" "$ROOT/tmp" "$OUT"

pacman -r "$ROOT" --cachedir "$ROOT/var/cache/pacman/pkg" --noconfirm --noscriptlet --needed \
  -Sy bash coreutils sed grep gawk make gcc binutils tar gzip msys2-runtime msys2-runtime-devel msys2-w32api-headers msys2-w32api-runtime pkgconf which findutils diffutils

cd "$ROOT/tmp"
curl -fsSL "https://download.redis.io/releases/redis-${REDIS_VERSION}.tar.gz" -o redis.tar.gz
tar xzf redis.tar.gz
cat > build.sh <<INNER
#!/usr/bin/bash
export PATH=/usr/bin
cd /tmp/redis-${REDIS_VERSION}
sed -i 's/__GNU_VISIBLE/1/' /usr/include/dlfcn.h || true
make -j4 MALLOC=libc BUILD_TLS=no USE_SYSTEMD=no CFLAGS="-Wno-char-subscripts -Wno-implicit-function-declaration -Wno-int-conversion -O2" redis-server redis-cli 2>&1 -C src
INNER
"$ROOT/usr/bin/bash.exe" /tmp/build.sh || "$ROOT/usr/bin/bash.exe" "$ROOT/tmp/build.sh"
cp "$ROOT/tmp/redis-${REDIS_VERSION}/src/redis-server.exe" "$ROOT/tmp/redis-${REDIS_VERSION}/src/redis-cli.exe" "$OUT/"
cp "$ROOT/usr/bin/msys-2.0.dll" "$OUT/"
echo "built: $OUT"

#!/usr/bin/env bash
# 在 WSL 裡開一個「只給 myterminal E2E 用」的 sshd。可重複執行。
#
#   wsl.exe -u root -e bash scripts/wsl-sshd-setup.sh
#
# 會動到的東西（全部由 scripts/wsl-sshd-teardown.sh 還原）：
#   1. 安裝 openssh-server
#   2. 停用 systemd 的 ssh.socket / ssh.service（見下面的註解）
#   3. 寫入 /etc/ssh/sshd_config.d/myterminal-e2e.conf
#   4. 建立本機帳號 mtssh（密碼 mtssh-e2e，只給測試用）
#   5. 以獨立行程啟動 /usr/sbin/sshd
set -euo pipefail

PORT=2222
LOGIN=mtssh
PASSWORD=mtssh-e2e
DROPIN=/etc/ssh/sshd_config.d/myterminal-e2e.conf

if [ "$(id -u)" -ne 0 ]; then
  echo "要用 root 執行：wsl.exe -u root -e bash scripts/wsl-sshd-setup.sh" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
if ! dpkg -s openssh-server >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y openssh-server
fi

# Ubuntu 24.04 之後預設是 socket activation：ssh.socket 把 22 寫死在 unit 裡，
# sshd_config 的 Port 會被無視。這裡直接關掉它，改用獨立的 sshd 行程。
systemctl disable --now ssh.socket ssh.service sshd.service >/dev/null 2>&1 || true

mkdir -p /etc/ssh/sshd_config.d /run/sshd
cat > "$DROPIN" <<CONF
# myterminal E2E 專用，由 scripts/wsl-sshd-setup.sh 產生，不要手改。
Port $PORT
# 綁 127.0.0.1 就夠：WSL2 NAT 模式的 localhost forwarding 會把 Windows 的
# localhost:$PORT 轉進來（已實測），不需要對 LAN 開放。
ListenAddress 127.0.0.1
PasswordAuthentication yes
PermitRootLogin no
CONF

id "$LOGIN" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$LOGIN"
echo "$LOGIN:$PASSWORD" | chpasswd

/usr/sbin/sshd -t   # 設定檔有錯就不要往下走
pkill -x sshd 2>/dev/null || true
sleep 1
/usr/sbin/sshd

sleep 1
echo "--- sshd 監聽中 ---"
ss -ltn | grep ":$PORT " || { echo "沒有聽在 $PORT" >&2; exit 1; }
echo "帳號 $LOGIN / 密碼 $PASSWORD，從 Windows 連 localhost:$PORT"

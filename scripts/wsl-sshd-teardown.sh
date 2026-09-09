#!/usr/bin/env bash
# 還原 scripts/wsl-sshd-setup.sh 做的事。可重複執行。
#
#   wsl.exe -u root -e bash scripts/wsl-sshd-teardown.sh            # 留著 openssh-server
#   wsl.exe -u root -e bash scripts/wsl-sshd-teardown.sh --purge    # 連套件一起移除
set -euo pipefail

LOGIN=mtssh
DROPIN=/etc/ssh/sshd_config.d/myterminal-e2e.conf

if [ "$(id -u)" -ne 0 ]; then
  echo "要用 root 執行：wsl.exe -u root -e bash scripts/wsl-sshd-teardown.sh" >&2
  exit 1
fi

pkill -x sshd 2>/dev/null || true
rm -f "$DROPIN"
id "$LOGIN" >/dev/null 2>&1 && userdel -r "$LOGIN" 2>/dev/null || true

if [ "${1:-}" = "--purge" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get remove -y openssh-server
  echo "已移除 openssh-server。"
else
  # setup 停用過 ssh.socket / ssh.service，這裡不自動打開：這台機器本來就沒在跑 sshd。
  echo "openssh-server 留著沒動（systemd 的 ssh.socket / ssh.service 仍是停用狀態）。"
  echo "要連套件一起移除請加 --purge。"
fi
echo "清理完成。"

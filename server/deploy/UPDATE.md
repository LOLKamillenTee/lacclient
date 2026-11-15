Update on the VM:  sudo git -C /opt/lac pull && (cd /opt/lac/server/node && sudo npm install --omit=dev) && sudo systemctl restart lac-sync
Logs:              journalctl -u lac-sync -f

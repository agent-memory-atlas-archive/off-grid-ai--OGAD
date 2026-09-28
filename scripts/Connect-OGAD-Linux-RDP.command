#!/bin/zsh
# Open the OGAD Linux desktop through an SSH-protected RDP tunnel.
set -euo pipefail

key="$HOME/Downloads/ogad-win-l40s-rdp.pem"
rdp="$HOME/Downloads/ogad-linux-g5-9b-test.rdp"
host=3.110.130.32
port=3390

if [[ ! -f "$key" || ! -f "$rdp" ]]; then
  echo 'The SSH key or RDP connection file is missing from Downloads.' >&2
  exit 1
fi
chmod 600 "$key"

password_state=$(ssh -i "$key" -o BatchMode=yes -o ConnectTimeout=10 "ubuntu@$host" 'sudo passwd -S ubuntu')
if [[ "$password_state" == *' L '* ]]; then
  echo 'The Linux RDP account needs a password. Enter a new password twice.'
  echo 'The password will stay on the Linux VM. This launcher will not save it.'
  ssh -tt -i "$key" "ubuntu@$host" 'sudo passwd ubuntu'
fi

if nc -z 127.0.0.1 "$port" 2>/dev/null; then
  echo "Local port $port is already in use. Close the other tunnel and try again." >&2
  exit 1
fi

ssh -N -i "$key" -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L "127.0.0.1:$port:127.0.0.1:3389" "ubuntu@$host" &
tunnel_pid=$!
trap 'kill "$tunnel_pid" 2>/dev/null || true' EXIT INT TERM

ready=0
for attempt in {1..20}; do
  if nc -z 127.0.0.1 "$port" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$tunnel_pid" 2>/dev/null; then
    echo 'The SSH tunnel stopped. Check your network and SSH access.' >&2
    exit 1
  fi
  sleep 1
done
[[ $ready == 1 ]] || { echo 'The SSH tunnel did not open.' >&2; exit 1; }

open -a 'Windows App' "$rdp"
echo 'Windows App is open. Sign in as ubuntu with the password you set.'
echo 'Select Xorg on the Linux login screen. Keep this terminal open while you use RDP.'
read -r 'answer?Press Enter here after you disconnect to close the tunnel. '

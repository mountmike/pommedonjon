#!/bin/bash
# Phase 0 spike tool: record how reachable an iPhone stays over time.
#
# Every INTERVAL seconds it appends one JSON line with:
#   - which Bonjour instances are advertised for the device-related services
#   - whether the phone's mDNS hostname resolves, and to what
#   - whether TCP 62078 (lockdown) accepts a connection
#   - whether the host's usbmuxd lists the phone on USB / on the network
#   - a battery read through the host's usbmuxd over the network
#   - a battery read over USB, when the phone is plugged into the host
#   - the same read from a Linux container using only an exported pair record
#
# Everything is read-only. No backup is started, so the phone never prompts.
#
# Usage:
#   presence-monitor.sh UDID MDNS_HOSTNAME PAIR_RECORD_PLIST OUT_NDJSON [INTERVAL] [TICKS]
#
# Environment: PMD3 (pymobiledevice3 executable), IMAGE (container image that
# has pymobiledevice3 installed).

set -u

UDID=$1
HOST=$2
RECORD=$3
OUT=$4
INTERVAL=${5:-300}
TICKS=${6:-108}
PMD3=${PMD3:-pymobiledevice3}
IMAGE=${IMAGE:-nightstand-spike-pmd3:alpine}
SCRATCH="$OUT.scratch"

# Run a command, giving up after N seconds (macOS has no timeout(1)).
with_timeout() {
  local seconds=$1
  shift
  perl -e 'alarm shift; exec @ARGV' "$seconds" "$@"
}

# Browse one service type for 3 seconds: "ifindex:instance,ifindex:instance".
browse() {
  dns-sd -B "$1" local. >"$SCRATCH" 2>&1 &
  local pid=$!
  sleep 3
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  awk '$2 == "Add" { print $4 ":" $7 }' "$SCRATCH" | sort -u | paste -sd, -
}

# Read one value from either tool's battery output. ideviceinfo prints
# `Key: 73`; pymobiledevice3 prints JSON, `"Key": 73,`.
battery_field() {
  sed -n "s/.*$1[^0-9a-z]*\([0-9a-z]*\).*/\1/p" | head -1
}

tick=0
while [ "$tick" -lt "$TICKS" ]; do
  now=$(date +%Y-%m-%dT%H:%M:%S)

  mobdev2=$(browse _apple-mobdev2._tcp)
  remotepairing=$(browse _remotepairing._tcp)
  remoted=$(browse _remoted._tcp)

  ip=$(with_timeout 5 dscacheutil -q host -a name "$HOST" 2>/dev/null |
    awk '/^ip_address/ { print $2; exit }')

  port=unknown
  if [ -n "$ip" ]; then
    if nc -z -G 3 "$ip" 62078 >/dev/null 2>&1; then port=open; else port=closed; fi
  fi

  usb=false
  network=false
  with_timeout 15 "$PMD3" usbmux list -u --simple 2>/dev/null | grep -q "$UDID" && usb=true
  with_timeout 15 "$PMD3" usbmux list -n --simple 2>/dev/null | grep -q "$UDID" && network=true

  host_out=$(with_timeout 20 ideviceinfo -n -u "$UDID" -q com.apple.mobile.battery 2>&1)
  host_level=$(printf '%s\n' "$host_out" | battery_field BatteryCurrentCapacity)
  host_external=$(printf '%s\n' "$host_out" | battery_field ExternalConnected)

  usb_level=
  if [ "$usb" = true ]; then
    usb_level=$(with_timeout 20 ideviceinfo -u "$UDID" -q com.apple.mobile.battery 2>&1 |
      battery_field BatteryCurrentCapacity)
  fi

  container_level=
  if [ -n "$ip" ]; then
    container_level=$(with_timeout 45 docker run --rm \
      -v "$RECORD:/root/.local/share/pymobiledevice3/$UDID.plist:ro" "$IMAGE" \
      pymobiledevice3 lockdown get com.apple.mobile.battery \
      --mobdev2-host "$ip" --udid "$UDID" 2>/dev/null |
      battery_field BatteryCurrentCapacity)
  fi

  printf '{"t":"%s","mobdev2":"%s","remotepairing":"%s","remoted":"%s","resolves":%s,"port62078":"%s","usbmuxUsb":%s,"usbmuxNetwork":%s,"hostBattery":%s,"externalPower":%s,"usbBattery":%s,"containerBattery":%s}\n' \
    "$now" "$mobdev2" "$remotepairing" "$remoted" \
    "$([ -n "$ip" ] && echo true || echo false)" "$port" "$usb" "$network" \
    "${host_level:-null}" "${host_external:-null}" "${usb_level:-null}" \
    "${container_level:-null}" >>"$OUT"

  tick=$((tick + 1))
  if [ "$tick" -lt "$TICKS" ]; then sleep "$INTERVAL"; fi
done

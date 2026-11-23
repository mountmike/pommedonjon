#!/usr/bin/env python3
"""The device-protocol side of pommedonjon.

The TypeScript daemon spawns this script and reads JSON from stdout. It never
parses human-oriented output. pymobiledevice3 is used as a library because its
CLI prints no live progress unless it is attached to a terminal.

Commands:

  probe    One JSON object describing a reachable device (identity, battery,
           whether backups are encrypted). Read-only; never prompts.
  backup   Run one backup, reporting newline-delimited JSON events.
  verify   One JSON object saying whether a backup directory on disk looks
           complete. Needs no device and no pymobiledevice3.

How a device is reached (probe, backup):

  --host H --pair-record F   Straight to the phone's lockdown port over the
                             network. No usbmuxd. This is what a container
                             uses.
  --connection usb|network   Through the host's usbmuxd (macOS, or Linux with
                             usbmuxd/netmuxd).

Backup events (the "event" field):
  started             connected to the device, backup requested
  passcode-required   the phone is showing its passcode prompt
  passcode-dismissed  the prompt went away (typed, cancelled, or timed out)
  progress            {"percent": 0-100}
  log                 {"level": "info"|"warning"|"error", "message": str}
  finished            {"backupDir": str, "durationMs": int}   exit code 0
  error               {"kind": str, "message": str, "code": int|null}   exit code 1

Nothing secret is ever written to stdout: no pair record fields, no password.
"""

from __future__ import annotations

import argparse
import asyncio
import errno
import json
import logging
import plistlib
import re
import sys
import time
from pathlib import Path
from typing import Any

LOCKDOWN_PORT = 62078
PROBE_TIMEOUT_SECONDS = 20
# How long to keep dialling a phone that does not answer, and the gap
# between dials. Must stay well inside PROBE_TIMEOUT_SECONDS.
CONNECT_WINDOW_SECONDS = 12
CONNECT_RETRY_PAUSE_SECONDS = 0.5

# pymobiledevice3 watches the passcode prompt itself and only tells us through
# its logger, so these two messages are matched by text. If they change
# upstream, the events degrade to plain "log" events rather than disappearing.
PASSCODE_PROMPT_TEXT = "enter the device passcode"
PASSCODE_DISMISSED_TEXT = "passcode prompt dismissed"

# pymobiledevice3 raises a generic exception for most device-reported errors,
# with the device's reply formatted into the message, e.g.
#   The device reported an error: {'ErrorCode': 208, 'ErrorDescription': ...}.
# The code is not available as structured data, so it is read from the text.
ERROR_CODE_IN_MESSAGE = re.compile(r"['\"]ErrorCode['\"]:\s*(\d+)")
ERROR_DESCRIPTION_IN_MESSAGE = re.compile(
    r"['\"]ErrorDescription['\"]:\s*['\"]([^'\"]+)['\"]"
)

# Exception class names that mean "could not reach the phone at all", as
# opposed to "reached it and something went wrong".
UNREACHABLE_KINDS = frozenset(
    {
        "ConnectionFailedError",
        "ConnectionFailedToUsbmuxdError",
        "ConnectionTerminatedError",
        "ConnectionRefusedError",
        "ConnectionResetError",
        "ConnectionAbortedError",
        "TimeoutError",
        "CancelledError",
        "NoDeviceConnectedError",
        "DeviceNotFoundError",
        "gaierror",
    }
)
# A bare OSError only means "unreachable" when it is a network errno. Local
# faults (read-only filesystem, permission denied on the pair record) must
# not be mistaken for a phone that is away.
UNREACHABLE_ERRNOS = frozenset(
    {
        errno.ECONNREFUSED,
        errno.ECONNRESET,
        errno.ECONNABORTED,
        errno.EHOSTUNREACH,
        errno.EHOSTDOWN,
        errno.ENETUNREACH,
        errno.ENETDOWN,
        errno.ETIMEDOUT,
        errno.EPIPE,
    }
)
NOT_PAIRED_KINDS = frozenset(
    {
        "NotPairedError",
        "InvalidHostIDError",
        "PairingError",
        "FatalPairingError",
        "UserDeniedPairingError",
        "PairingDialogResponsePendingError",
    }
)


def emit(event: str, **fields: Any) -> None:
    sys.stdout.write(json.dumps({"event": event, **fields}) + "\n")
    sys.stdout.flush()


def print_json(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()


def device_error_code(error: BaseException) -> int | None:
    """Pull the MobileBackup ErrorCode out of an exception, if it carries one."""
    for arg in getattr(error, "args", ()):
        if isinstance(arg, dict) and isinstance(arg.get("ErrorCode"), int):
            return arg["ErrorCode"]
    match = ERROR_CODE_IN_MESSAGE.search(str(error))
    return int(match.group(1)) if match else None


def error_message(error: BaseException) -> str:
    """The device's own description when there is one, else the first line."""
    text = str(error)
    match = ERROR_DESCRIPTION_IN_MESSAGE.search(text)
    if match:
        return match.group(1)
    return text.splitlines()[0] if text else type(error).__name__


def failure_category(error: BaseException) -> str:
    """"unreachable", "not-paired" or "failed"."""
    names = {cls.__name__ for cls in type(error).__mro__}
    if names & NOT_PAIRED_KINDS:
        return "not-paired"
    if names & UNREACHABLE_KINDS:
        return "unreachable"
    if isinstance(error, OSError) and error.errno in UNREACHABLE_ERRNOS:
        return "unreachable"
    return "failed"


async def connect(args: argparse.Namespace):
    from pymobiledevice3.lockdown import create_using_tcp, create_using_usbmux

    if args.host:
        pair_record = plistlib.loads(Path(args.pair_record).read_bytes())
        # A phone on battery can take several seconds to accept a connection
        # (6.7 s was measured), and pymobiledevice3 gives each dial one
        # second. So "no answer" only counts after trying for a while.
        deadline = time.monotonic() + CONNECT_WINDOW_SECONDS
        while True:
            try:
                return await create_using_tcp(
                    hostname=args.host,
                    identifier=args.udid,
                    pair_record=pair_record,
                    autopair=False,
                    port=args.port,
                    keep_alive=True,
                )
            except Exception as error:  # noqa: BLE001 - re-raised unless unreachable
                if failure_category(error) != "unreachable":
                    raise
                if time.monotonic() >= deadline:
                    raise
                await asyncio.sleep(CONNECT_RETRY_PAUSE_SECONDS)
    return await create_using_usbmux(
        serial=args.udid,
        autopair=False,
        connection_type="Network" if args.connection == "network" else "USB",
    )


# --- probe -----------------------------------------------------------------


async def probe(args: argparse.Namespace) -> int:
    try:
        async with asyncio.timeout(PROBE_TIMEOUT_SECONDS):
            lockdown = await connect(args)
            try:
                values = await lockdown.get_value()
                battery = await lockdown.get_value(domain="com.apple.mobile.battery")
                backup = await lockdown.get_value(domain="com.apple.mobile.backup")
            finally:
                await lockdown.close()
    except Exception as error:  # noqa: BLE001 - every failure becomes one object
        print_json(
            {
                "ok": False,
                "category": failure_category(error),
                "kind": type(error).__name__,
                "message": error_message(error),
            }
        )
        return 1

    print_json(
        {
            "ok": True,
            "udid": values.get("UniqueDeviceID"),
            "name": values.get("DeviceName"),
            "productType": values.get("ProductType"),
            "osVersion": values.get("ProductVersion"),
            "buildVersion": values.get("BuildVersion"),
            "battery": {
                "levelPercent": battery.get("BatteryCurrentCapacity"),
                "isCharging": battery.get("BatteryIsCharging"),
                "externalPowerConnected": battery.get("ExternalConnected"),
                "fullyCharged": battery.get("FullyCharged"),
            },
            "backupEncryptionEnabled": bool(backup.get("WillEncrypt")),
        }
    )
    return 0


# --- backup ----------------------------------------------------------------


class EventLogHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        message = record.getMessage()
        lowered = message.lower()
        if PASSCODE_PROMPT_TEXT in lowered:
            emit("passcode-required")
        elif PASSCODE_DISMISSED_TEXT in lowered:
            emit("passcode-dismissed")
        elif record.levelno >= logging.INFO:
            level = (
                "error"
                if record.levelno >= logging.ERROR
                else "warning"
                if record.levelno >= logging.WARNING
                else "info"
            )
            emit("log", level=level, message=message)


async def backup(args: argparse.Namespace) -> int:
    from pymobiledevice3.services.mobilebackup2 import Mobilebackup2Service

    args.backup_root.mkdir(parents=True, exist_ok=True)
    logging.getLogger().addHandler(EventLogHandler())
    logging.getLogger().setLevel(logging.INFO)

    started_at = time.monotonic()
    last_reported: float | None = None

    def on_progress(percent: Any) -> None:
        nonlocal last_reported
        try:
            value = round(float(percent), 1)
        except (TypeError, ValueError):
            return
        if value != last_reported:
            last_reported = value
            emit("progress", percent=value)

    try:
        lockdown = await connect(args)
        async with Mobilebackup2Service(lockdown) as service:
            emit("started")
            await service.backup(
                full=args.full,
                backup_directory=str(args.backup_root),
                progress_callback=on_progress,
            )
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001 - every failure becomes one event
        emit(
            "error",
            kind=type(error).__name__,
            category=failure_category(error),
            message=error_message(error),
            code=device_error_code(error),
        )
        return 1

    emit(
        "finished",
        backupDir=str((args.backup_root / args.udid).resolve()),
        durationMs=int((time.monotonic() - started_at) * 1000),
    )
    return 0


# --- verify ----------------------------------------------------------------


def verify_backup_dir(backup_dir: Path) -> dict[str, Any]:
    """Structural check of a backup directory. Does not decrypt anything.

    Status.plist alone is not trustworthy: a run that fails at the passcode
    prompt leaves SnapshotState "finished" next to an empty Manifest.plist.
    So every file a restorable backup needs is checked.
    """
    problems: list[str] = []
    result: dict[str, Any] = {"backupDir": str(backup_dir)}

    if not backup_dir.is_dir():
        return {**result, "ok": False, "problems": ["backup directory does not exist"]}

    def load_plist(name: str) -> dict[str, Any] | None:
        path = backup_dir / name
        if not path.is_file():
            problems.append(f"{name} is missing")
            return None
        if path.stat().st_size == 0:
            problems.append(f"{name} is empty")
            return None
        try:
            value = plistlib.loads(path.read_bytes())
        except Exception:  # noqa: BLE001 - any parse failure is the same problem
            problems.append(f"{name} is not a readable plist")
            return None
        if not isinstance(value, dict):
            problems.append(f"{name} does not contain a dictionary")
            return None
        return value

    status = load_plist("Status.plist")
    if status is not None:
        state = status.get("SnapshotState")
        result["snapshotState"] = state
        result["isFullBackup"] = status.get("IsFullBackup")
        date = status.get("Date")
        result["statusDate"] = date.isoformat() + "Z" if date is not None else None
        if state != "finished":
            problems.append(f"Status.plist SnapshotState is {state!r}, not 'finished'")

    manifest = load_plist("Manifest.plist")
    if manifest is not None:
        result["isEncrypted"] = bool(manifest.get("IsEncrypted"))
        lockdown = manifest.get("Lockdown")
        if isinstance(lockdown, dict):
            result["udid"] = lockdown.get("UniqueDeviceID")
            result["osVersion"] = lockdown.get("ProductVersion")
        if manifest.get("IsEncrypted") and not manifest.get("BackupKeyBag"):
            problems.append("Manifest.plist says encrypted but has no BackupKeyBag")

    load_plist("Info.plist")

    manifest_db = backup_dir / "Manifest.db"
    if not manifest_db.is_file():
        problems.append("Manifest.db is missing")
    else:
        size = manifest_db.stat().st_size
        result["manifestDbBytes"] = size
        if size == 0:
            problems.append("Manifest.db is empty")

    return {**result, "ok": not problems, "problems": problems}


def verify(args: argparse.Namespace) -> int:
    result = verify_backup_dir(args.backup_dir)
    print_json(result)
    return 0 if result["ok"] else 1


# --- command line ----------------------------------------------------------


def add_device_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--udid", required=True)
    parser.add_argument("--connection", choices=("usb", "network"), default="usb")
    parser.add_argument(
        "--host", help="Connect straight to this address instead of through usbmuxd."
    )
    parser.add_argument("--port", type=int, default=LOCKDOWN_PORT)
    parser.add_argument("--pair-record", help="Pair record plist to use with --host.")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="pommedonjon device sidecar")
    commands = parser.add_subparsers(dest="command", required=True)

    probe_parser = commands.add_parser("probe", help="Describe a reachable device.")
    add_device_arguments(probe_parser)

    backup_parser = commands.add_parser("backup", help="Run one backup.")
    add_device_arguments(backup_parser)
    backup_parser.add_argument(
        "--backup-root",
        required=True,
        type=Path,
        help="Directory holding one subdirectory per device, named by UDID.",
    )
    backup_parser.add_argument("--full", action="store_true")

    verify_parser = commands.add_parser(
        "verify", help="Check a backup directory on disk."
    )
    verify_parser.add_argument("--backup-dir", required=True, type=Path)

    args = parser.parse_args(argv)
    if args.command in ("probe", "backup"):
        if args.host is not None and not args.host.strip():
            # An empty address (a failed name lookup upstream) must not fall
            # through to the usbmuxd path and report a misleading error.
            parser.error("--host was given but is empty")
        if args.host and not args.pair_record:
            parser.error("--host requires --pair-record")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.command == "verify":
        return verify(args)
    try:
        return asyncio.run(probe(args) if args.command == "probe" else backup(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Small JSON bridge from the Miobot admin API to the Codex Python SDK."""

from __future__ import annotations

import argparse
import dataclasses
import enum
import json
import platform
import sys
import traceback
from typing import Any


SANDBOX_PRESETS = {
    "read_only": "read_only",
    "workspace_write": "workspace_write",
    "full_access": "full_access",
}


def emit_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def write_json(payload: dict[str, Any], *, exit_code: int = 0) -> None:
    emit_json(payload)
    raise SystemExit(exit_code)


def jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, enum.Enum):
        return value.value
    if dataclasses.is_dataclass(value):
        return {field.name: jsonable(getattr(value, field.name)) for field in dataclasses.fields(value)}
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", exclude_none=True)
    if isinstance(value, dict):
        return {str(key): jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [jsonable(item) for item in value]
    return str(value)


def redacted_jsonable(value: Any) -> Any:
    data = jsonable(value)
    return redact_sensitive(data)


def redact_sensitive(value: Any) -> Any:
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if any(word in key.lower() for word in ("token", "secret", "password", "api_key", "apikey", "authorization")):
                out[key] = "[redacted]" if item else item
            else:
                out[key] = redact_sensitive(item)
        return out
    if isinstance(value, list):
        return [redact_sensitive(item) for item in value]
    return value


def import_sdk() -> tuple[Any, Any, Any, Any, str]:
    from openai_codex import Codex, CodexConfig, Sandbox, __version__

    return Codex, CodexConfig, Sandbox, __version__, ""


def sdk_status() -> None:
    payload: dict[str, Any] = {
        "ok": True,
        "python": sys.executable,
        "pythonVersion": platform.python_version(),
        "sdkAvailable": False,
        "sdkVersion": None,
        "error": "",
    }
    try:
        _codex, _config, _sandbox, version, _ = import_sdk()
        payload["sdkAvailable"] = True
        payload["sdkVersion"] = version
    except Exception as exc:  # noqa: BLE001 - status endpoint must be diagnostic.
        payload["ok"] = False
        payload["error"] = f"{type(exc).__name__}: {exc}"
    write_json(payload)


def account_status() -> None:
    Codex, CodexConfig, _Sandbox, sdk_version, _ = import_sdk()
    with Codex(CodexConfig()) as codex:
        try:
            response = codex.account(refresh_token=True)
            data = redacted_jsonable(response)
            account = data.get("account") if isinstance(data, dict) else None
            write_json(
                {
                    "success": True,
                    "sdkVersion": sdk_version,
                    "signedIn": account is not None,
                    "account": data,
                    "requiresOpenaiAuth": bool(data.get("requiresOpenaiAuth")) if isinstance(data, dict) else False,
                }
            )
        except Exception as exc:  # noqa: BLE001 - unauthenticated state is diagnostic.
            write_json(
                {
                    "success": False,
                    "sdkVersion": sdk_version,
                    "signedIn": False,
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )


def device_login() -> None:
    Codex, CodexConfig, _Sandbox, sdk_version, _ = import_sdk()
    with Codex(CodexConfig()) as codex:
        handle = codex.login_chatgpt_device_code()
        emit_json(
            {
                "event": "device_code",
                "success": True,
                "sdkVersion": sdk_version,
                "loginId": handle.login_id,
                "verificationUrl": handle.verification_url,
                "userCode": handle.user_code,
            }
        )
        completed = handle.wait()
        write_json(
            {
                "event": "completed",
                "success": True,
                "sdkVersion": sdk_version,
                "loginId": handle.login_id,
                "account": redacted_jsonable(completed),
            }
        )


def sandbox_value(Sandbox: Any, name: str) -> Any:
    normalized = SANDBOX_PRESETS.get(str(name or "").strip(), "workspace_write")
    return getattr(Sandbox, normalized)


def read_request() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("missing JSON request body")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("request body must be a JSON object")
    return payload


def run_turn() -> None:
    request = read_request()
    message = str(request.get("message") or "").strip()
    if not message:
        raise ValueError("message is required")

    cwd = str(request.get("cwd") or "").strip() or None
    thread_id = str(request.get("threadId") or "").strip() or None
    model = str(request.get("model") or "").strip() or None
    developer_instructions = str(request.get("developerInstructions") or "").strip() or None
    sandbox_name = str(request.get("sandbox") or "workspace_write").strip()

    Codex, CodexConfig, Sandbox, sdk_version, _ = import_sdk()
    sandbox = sandbox_value(Sandbox, sandbox_name)

    with Codex(CodexConfig(cwd=cwd)) as codex:
        if thread_id:
            thread = codex.thread_resume(
                thread_id,
                cwd=cwd,
                developer_instructions=developer_instructions,
                model=model,
                sandbox=sandbox,
            )
        else:
            thread = codex.thread_start(
                cwd=cwd,
                developer_instructions=developer_instructions,
                model=model,
                sandbox=sandbox,
                service_name="miobot-admin-codex",
            )

        result = thread.run(message, cwd=cwd, model=model, sandbox=sandbox)
        write_json(
            {
                "success": True,
                "sdkVersion": sdk_version,
                "threadId": thread.id,
                "turnId": getattr(result, "id", None),
                "status": jsonable(getattr(result, "status", None)),
                "error": jsonable(getattr(result, "error", None)),
                "finalResponse": getattr(result, "final_response", None),
                "durationMs": getattr(result, "duration_ms", None),
                "itemsCount": len(getattr(result, "items", []) or []),
                "usage": jsonable(getattr(result, "usage", None)),
            }
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Miobot Codex Python SDK bridge")
    parser.add_argument("--status", action="store_true", help="print SDK availability JSON")
    parser.add_argument("--account", action="store_true", help="print current Codex account JSON")
    parser.add_argument("--login-device", action="store_true", help="start ChatGPT device-code login")
    args = parser.parse_args()

    if args.status:
        sdk_status()
    if args.account:
        account_status()
    if args.login_device:
        device_login()
    run_turn()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - return a stable JSON error to Node.
        write_json(
            {
                "success": False,
                "error": f"{type(exc).__name__}: {exc}",
                "trace": traceback.format_exc(limit=8),
            },
            exit_code=1,
        )

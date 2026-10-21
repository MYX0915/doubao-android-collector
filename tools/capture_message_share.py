import argparse
import json
import time
from pathlib import Path

import frida


REMOTE = "127.0.0.1:27042"
PROCESS_NAME = "豆包"
HOOK = Path(__file__).resolve().parents[1] / "hooks" / "capture_message_share.js"
OUT = Path(__file__).resolve().parents[1] / "data" / "runtime" / "message_share_capture.jsonl"


def main():
    parser = argparse.ArgumentParser(description="Hook App-internal conversation-share requests and responses.")
    parser.add_argument("--seconds", type=int, default=180)
    parser.add_argument("--process", default=PROCESS_NAME)
    parser.add_argument("--output", type=Path, default=OUT)
    parser.add_argument("--invoke-app-share", action="store_true",
                        help="invoke MessageShareViewModel.shareMessage() inside the App after loading the hook")
    parser.add_argument("--allow-seo", action="store_true")
    args = parser.parse_args()

    device = frida.get_device_manager().add_remote_device(REMOTE)
    process = next((item for item in device.enumerate_processes() if item.name == args.process), None)
    if process is None:
        raise RuntimeError("target process is not running: " + args.process)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    session = device.attach(process.pid)
    script = session.create_script(HOOK.read_text(encoding="utf-8"))
    stream = args.output.open("w", encoding="utf-8")

    def on_message(message, data):
        if message.get("type") == "send":
            payload = message.get("payload") or {}
            stream.write(json.dumps(payload, ensure_ascii=False) + "\n")
            stream.flush()
            print(json.dumps(payload, ensure_ascii=False), flush=True)
        elif message.get("type") == "error":
            payload = {"type": "frida_error", "stack": message.get("stack", message)}
            stream.write(json.dumps(payload, ensure_ascii=False) + "\n")
            stream.flush()
            print(json.dumps(payload, ensure_ascii=False), flush=True)

    script.on("message", on_message)
    script.load()
    print(json.dumps({"type": "ready", "pid": process.pid, "output": str(args.output)}, ensure_ascii=False), flush=True)
    if args.invoke_app_share:
        result = script.exports_sync.appshare(args.allow_seo)
        print(json.dumps({"type": "app_internal_share_result", "value": result}, ensure_ascii=False), flush=True)
    try:
        time.sleep(args.seconds)
    finally:
        stream.close()
        script.unload()
        session.detach()


if __name__ == "__main__":
    main()

import argparse
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import frida

import parse_android_sse as sse_parser


REMOTE = "127.0.0.1:27042"
PROCESS_NAME = "豆包"
ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "hooks" / "capture_message_share.js"
DEFAULT_OUTPUT_DIR = ROOT / "data" / "runtime" / "latest"


def extract_question(events):
    normalized = []
    for event in events:
        if event.get("type") != "completion_request_body":
            continue
        value = event.get("value") or {}
        normalized.append({"typed_body": {"text": value.get("text", "")}})
    return sse_parser.extract_question(normalized)


def extract_share(events):
    for event in reversed(events):
        if event.get("type") in {"message_share_response_auto", "message_share_response"}:
            value = event.get("value") or {}
            if value.get("share_url"):
                return value
    return {}


def extract_message_ids(records):
    result = []
    for record in records:
        for path, value in sse_parser.walk(record):
            if path and path[-1] == "message_id" and isinstance(value, (str, int)):
                candidate = str(value)
                if candidate and candidate not in result:
                    result.append(candidate)
    return result


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)


def main():
    parser = argparse.ArgumentParser(
        description="Capture one complete App conversation into SSE, message, and product-card files."
    )
    parser.add_argument("--seconds", type=int, default=600)
    parser.add_argument("--process", default=PROCESS_NAME)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    sse_output = args.output_dir / "complete_sse.log"
    message_output = args.output_dir / "complete_message.json"
    products_output = args.output_dir / "product_cards.json"
    for path in (sse_output, message_output, products_output):
        path.write_text("", encoding="utf-8")
        os.chmod(path, 0o600)

    adb = shutil.which("adb")
    if adb is None:
        raise RuntimeError("adb not found")
    subprocess.run([adb, "forward", "tcp:27042", "tcp:27042"], check=True)

    device = frida.get_device_manager().add_remote_device(REMOTE)
    process = next((item for item in device.enumerate_processes() if item.name == args.process), None)
    if process is None:
        raise RuntimeError("target process is not running: " + args.process)

    events = []
    finished = threading.Event()
    answer_finished_at = {"time": None}
    remote_sse = {"path": ""}
    temporary = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", prefix="doubao_complete_", suffix=".jsonl", delete=False
    )
    session = device.attach(process.pid)
    script = session.create_script(HOOK.read_text(encoding="utf-8"))

    def on_message(message, data):
        if message.get("type") == "send":
            payload = message.get("payload") or {}
        else:
            payload = {"type": "frida_error", "stack": message.get("stack", message)}
        events.append(payload)
        temporary.write(json.dumps(payload, ensure_ascii=False) + "\n")
        temporary.flush()
        event_type = payload.get("type")
        if event_type == "sse_answer_finished":
            answer_finished_at["time"] = time.monotonic()
        if event_type == "sse_log_ready":
            remote_sse["path"] = (payload.get("value") or {}).get("path", "")
        if event_type in {
            "message_share_hook_ready", "sse_log_ready", "sse_answer_finished",
            "message_share_request", "message_share_response_auto", "app_internal_share_api_error",
            "app_internal_share_request_error", "frida_error", "sse_log_error",
        }:
            print(json.dumps(payload, ensure_ascii=False), flush=True)
        if event_type in {
            "message_share_response_auto", "message_share_response",
            "app_internal_share_api_error", "app_internal_share_request_error",
        }:
            finished.set()

    script.on("message", on_message)
    script.load()
    print(json.dumps({
        "type": "ready",
        "pid": process.pid,
        "outputs": [str(sse_output), str(message_output), str(products_output)],
    }, ensure_ascii=False), flush=True)

    try:
        deadline = time.monotonic() + args.seconds
        while not finished.wait(0.25):
            if time.monotonic() >= deadline:
                break
            ended_at = answer_finished_at["time"]
            if ended_at is not None and time.monotonic() - ended_at >= 30:
                print(json.dumps({"type": "share_timeout", "detail": "Saving captured data without a share response."}), flush=True)
                break
        if finished.is_set():
            time.sleep(1)
    except KeyboardInterrupt:
        print(json.dumps({"type": "capture_interrupted", "detail": "Saving captured data."}), flush=True)
    finally:
        temporary.close()
        try:
            script.unload()
        finally:
            session.detach()

    try:
        if not remote_sse["path"]:
            raise RuntimeError("device SSE log path was not reported")
        with sse_output.open("wb") as output:
            pull = subprocess.run(
                [adb, "exec-out", "cat", remote_sse["path"]],
                stdout=output,
                stderr=subprocess.PIPE,
            )
        if pull.returncode != 0:
            raise RuntimeError(pull.stderr.decode("utf-8", errors="replace"))
        os.chmod(sse_output, 0o600)

        records = sse_parser.load_sse(sse_output)
        products = sse_parser.extract_products(records)
        sse_parser.enrich_products(products, {})
        share = extract_share(events)
        message_ids = extract_message_ids(records)
        complete_message = {
            "conversation_id": sse_parser.first_value(records, "conversation_id"),
            "section_id": sse_parser.first_value(records, "section_id"),
            "message_ids": message_ids,
            "question": extract_question(events),
            "keywords": sse_parser.extract_keywords(records),
            "answer": sse_parser.extract_answer(records),
            "citations": sse_parser.extract_citations(records),
            "product_cards": products,
            "share": share,
            "share_status": "success" if share else "unavailable",
            "capture_errors": [
                event for event in events
                if event.get("type") in {
                    "app_internal_share_api_error", "app_internal_share_request_error",
                    "frida_error", "sse_log_error",
                }
            ],
            "sse_event_count": len(records),
            "end_type": sse_parser.last_value(records, "end_type"),
            "encoding": "UTF-8",
        }
        product_document = {
            "conversation_id": complete_message["conversation_id"],
            "message_ids": message_ids,
            "product_cards": products,
            "product_card_count": len(products),
            "encoding": "UTF-8",
        }
        write_json(message_output, complete_message)
        write_json(products_output, product_document)
        print(json.dumps({
            "type": "capture_complete",
            "sse_event_count": len(records),
            "answer_chars": len(complete_message["answer"]),
            "citation_count": len(complete_message["citations"]),
            "product_card_count": len(products),
            "share_url": share.get("share_url", ""),
            "outputs": [str(sse_output), str(message_output), str(products_output)],
        }, ensure_ascii=False), flush=True)
    finally:
        Path(temporary.name).unlink(missing_ok=True)


if __name__ == "__main__":
    main()

import argparse
import json
import re
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit


ID_KEYS = {"conversation_id", "section_id", "message_id"}
KEYWORD_KEYS = {"query_list", "queries"}
PRODUCT_KEYS = {
    "product_list", "product_card", "product_cards", "product_info",
    "goods", "goods_list", "commerce", "ecommerce", "item_info",
}
PRODUCT_DETAIL_BASE_URL = "https://haohuo.jinritemai.com/ecommerce/trade/detail/index"


def load_events(path):
    events = []
    if not path.exists():
        return events
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            events.append(item)
    return events


def load_sse(path):
    records = []
    if not path.exists():
        return records
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if not line.startswith("data:"):
            continue
        raw = line[5:].strip()
        if not raw or raw == "[DONE]":
            continue
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            records.append(value)
    return records


def walk(value, path=()):
    yield path, value
    if isinstance(value, dict):
        for key, child in value.items():
            yield from walk(child, path + (str(key),))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk(child, path + (str(index),))
    elif isinstance(value, str):
        candidate = value.strip()
        if candidate.startswith("{") or candidate.startswith("["):
            try:
                decoded = json.loads(candidate)
            except json.JSONDecodeError:
                return
            yield from walk(decoded, path + ("<json>",))


def first_value(records, key):
    for record in records:
        for path, value in walk(record):
            if path and path[-1] == key and isinstance(value, (str, int, float)) and value != "":
                return value
    return ""


def last_value(records, key):
    value = ""
    for record in records:
        for path, item in walk(record):
            if path and path[-1] == key and isinstance(item, (str, int, float)) and item != "":
                value = item
    return value


def append_stream_text(parts, value):
    if not isinstance(value, str) or not value:
        return
    if not parts:
        parts.append(value)
    elif value.startswith(parts[-1]):
        parts[-1] = value
    elif parts[-1].startswith(value):
        return
    else:
        parts.append(value)


def extract_question(events):
    for event in reversed(events):
        body = event.get("request_body") or event.get("typed_body") or {}
        raw = body.get("text", "") if isinstance(body, dict) else ""
        try:
            payload = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        value = payload
        for key in ("messages", 0, "content_block", 0, "content", "text_block", "text"):
            try:
                value = value[key]
            except (KeyError, IndexError, TypeError):
                value = ""
                break
        if isinstance(value, str) and value:
            return value
    return ""


def extract_keywords(records):
    result = []
    for record in records:
        for path, value in walk(record):
            if not path or path[-1] not in KEYWORD_KEYS:
                continue
            values = value if isinstance(value, list) else [value]
            for item in values:
                if isinstance(item, str):
                    candidate = item
                elif isinstance(item, dict):
                    candidate = item.get("query") or item.get("text") or item.get("keyword")
                else:
                    candidate = ""
                if isinstance(candidate, str) and candidate and candidate not in result:
                    result.append(candidate)
    return result


def extract_answer(records):
    parts = []
    for record in records:
        for path, value in walk(record):
            if not path or not isinstance(value, str):
                continue
            if path[-1] == "message":
                append_stream_text(parts, value)
            elif path[-1] == "text" and "loading_block" not in path:
                append_stream_text(parts, value)
    if not parts:
        return ""
    return "".join(parts)


def extract_citations(records):
    result = []
    for record in records:
        for path, value in walk(record):
            if not path or path[-1] != "text_card" or not isinstance(value, dict):
                continue
            title = value.get("title") or ""
            url = value.get("url") or ""
            if (title or url) and {"title": title, "url": url} not in result:
                result.append({"title": title, "url": url})
    return result


def extract_http_detail_url(value):
    """Return the HTTPS product-detail URL embedded in an App deep link."""
    if not isinstance(value, str) or not value:
        return ""
    current = value
    for _ in range(3):
        parsed = urlsplit(current)
        if parsed.scheme in {"http", "https"}:
            return current
        query = parse_qs(parsed.query)
        nested = query.get("url", [""])[0]
        if not nested:
            return ""
        current = unquote(nested)
    return ""


def extract_hook_detail_urls(events):
    result = {}
    for event in events:
        if event.get("type") not in {"intent_data", "intent_extra", "webview_load_url"}:
            continue
        value = event.get("value")
        candidates = []
        if isinstance(value, dict):
            candidates.extend(value.get(key, "") for key in ("uri", "data", "value"))
        elif isinstance(value, str):
            candidates.append(value)
        for candidate in candidates:
            url = extract_http_detail_url(candidate)
            if not url:
                continue
            product_id = parse_qs(urlsplit(url).query).get("id", [""])[0]
            result[product_id] = url
    return result


def enrich_products(products, hook_urls):
    for product in products:
        candidates = {
            str(product.get(key) or "")
            for key in ("pid", "product_id", "promotion_id", "id")
        }
        detail_url = extract_http_detail_url(product.get("product_detail_schema", ""))
        if not detail_url:
            for candidate in candidates:
                if candidate and candidate in hook_urls:
                    detail_url = hook_urls[candidate]
                    break
        product["product_detail_url"] = detail_url
        product_id = next(
            (str(product.get(key) or "") for key in ("product_id", "pid", "promotion_id", "id") if product.get(key)),
            "",
        )
        product["product_detail_simple_url"] = (
            PRODUCT_DETAIL_BASE_URL + "?id=" + product_id if product_id else ""
        )


def extract_products(records):
    result = []
    identities = set()
    for record in records:
        for path, value in walk(record):
            if not path or not isinstance(value, (dict, list)):
                continue
            key = path[-1].lower()
            is_named = key in PRODUCT_KEYS or any(
                token in key for token in ("product", "goods", "ecommerce")
            )
            is_card = isinstance(value, dict) and (
                ("price" in value and ("title" in value or "name" in value))
                or "product_id" in value
                or "sku_id" in value
            )
            if is_named or is_card:
                values = value if key in {"product_list", "goods_list"} and isinstance(value, list) else [value]
                for item in values:
                    if not isinstance(item, dict):
                        continue
                    identity = item.get("pid") or item.get("product_id") or item.get("name")
                    if not identity:
                        continue
                    if identity not in identities:
                        identities.add(identity)
                        result.append(item)
    return result


def main():
    parser = argparse.ArgumentParser(description="Parse a local App SSE capture into business JSON.")
    parser.add_argument("sse", type=Path)
    parser.add_argument("--events", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    records = load_sse(args.sse)
    hook_events = load_events(args.events) if args.events else []
    product_cards = extract_products(records)
    enrich_products(product_cards, extract_hook_detail_urls(hook_events))
    result = {
        "conversation_id": first_value(records, "conversation_id"),
        "section_id": first_value(records, "section_id"),
        "message_id": first_value(records, "message_id"),
        "question": extract_question(hook_events),
        "keywords": extract_keywords(records),
        "answer": extract_answer(records),
        "citations": extract_citations(records),
        "product_cards": product_cards,
        "sse_event_count": len(records),
        "end_type": last_value(records, "end_type"),
        "raw_sse": str(args.sse),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(args.output), "sse_event_count": len(records), "answer_chars": len(result["answer"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()

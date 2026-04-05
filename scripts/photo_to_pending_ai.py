import argparse
import base64
import json
import mimetypes
import os
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI
from supabase import create_client


PROMPT = """
You are extracting receipt line items from a grocery store receipt image.
Return ONLY valid JSON with this exact shape:
{
  "store_name": "string|null",
  "store_address": "string|null",
  "city": "string|null",
  "items": [
    {
      "name": "string",
      "quantity": number,
      "total_price": number,
      "unit_price": number
    }
  ]
}

Rules:
- Use numbers for prices and quantity.
- If quantity is missing, set it to 1.
- If unit_price is missing, set unit_price = total_price / quantity.
- Skip lines that are not products.
- Do not include commentary.
""".strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract receipt items from image using OpenAI and insert into pending_prices."
    )
    parser.add_argument("--image", required=True, help="Path to receipt image file")
    parser.add_argument("--city", default="Tashkent", help="City label for pending_prices rows")
    parser.add_argument("--telegram-id", default="photo-ai", help="submitted_by value")
    parser.add_argument("--source", default="photo_ai", help="source value")
    parser.add_argument("--model", default="gpt-4.1-mini", help="OpenAI model")
    parser.add_argument("--dry-run", action="store_true", help="Parse only, do not insert")
    return parser.parse_args()


def read_image_as_data_url(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{data}"


def extract_json(text: str) -> dict:
    raw = text.strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.startswith("json"):
            raw = raw[4:].strip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("No JSON object found in model response")
    return json.loads(raw[start : end + 1])


def normalize_item(item: dict) -> dict | None:
    name = str(item.get("name") or "").strip()
    if not name:
        return None

    quantity = float(item.get("quantity") or 1)
    if quantity <= 0:
        quantity = 1

    total_price = float(item.get("total_price") or 0)
    if total_price <= 0:
        return None

    unit_price = float(item.get("unit_price") or 0)
    if unit_price <= 0:
        unit_price = total_price / quantity

    return {
        "name": name,
        "quantity": quantity,
        "total_price": int(round(total_price)),
        "unit_price": int(round(unit_price)),
    }


def main() -> None:
    load_dotenv()
    args = parse_args()

    image_path = Path(args.image)
    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    openai_key = os.getenv("OPENAI_API_KEY")
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")

    if not openai_key:
        raise RuntimeError("OPENAI_API_KEY is required")
    if not supabase_url or not supabase_key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) are required")

    client = OpenAI(api_key=openai_key)
    image_data_url = read_image_as_data_url(image_path)

    response = client.responses.create(
        model=args.model,
        input=[
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": PROMPT},
                    {"type": "input_image", "image_url": image_data_url},
                ],
            }
        ],
    )

    payload = extract_json(response.output_text)
    items_raw = payload.get("items") or []
    items = [x for x in (normalize_item(i) for i in items_raw) if x]

    if not items:
        raise RuntimeError("No valid items extracted from image")

    print(f"Extracted {len(items)} item(s)")
    print(json.dumps({"store_name": payload.get("store_name"), "city": payload.get("city"), "items": items}, indent=2))

    if args.dry_run:
        return

    supabase = create_client(supabase_url, supabase_key)
    rows = []
    for item in items:
        rows.append(
            {
                "product_name_raw": item["name"],
                "product_id": None,
                "match_confidence": 0,
                "status": "pending",
                "price": item["total_price"],
                "quantity": item["quantity"],
                "unit_price": item["unit_price"],
                "city": payload.get("city") or args.city,
                "place_name": payload.get("store_name"),
                "place_address": payload.get("store_address"),
                "source": args.source,
                "submitted_by": str(args.telegram_id),
                "photo_url": str(image_path),
            }
        )

    result = supabase.table("pending_prices").insert(rows).execute()
    inserted_count = len(getattr(result, "data", []) or [])
    print(f"Inserted {inserted_count} row(s) into pending_prices")


if __name__ == "__main__":
    main()

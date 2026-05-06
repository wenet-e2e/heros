#!/usr/bin/env python3
import argparse
import re
from pathlib import Path


KEY_PATTERNS = {
    "HEROS_DOUBAO_BASE_URL": r'"base_url"\s*:\s*"([^"]+)"',
    "HEROS_DOUBAO_APP_ID": r'"X-Api-App-ID"\s*:\s*"([^"]+)"',
    "HEROS_DOUBAO_ACCESS_KEY": r'"X-Api-Access-Key"\s*:\s*"([^"]+)"',
    "HEROS_DOUBAO_RESOURCE_ID": r'"X-Api-Resource-Id"\s*:\s*"([^"]+)"',
    "HEROS_DOUBAO_APP_KEY": r'"X-Api-App-Key"\s*:\s*"([^"]+)"',
    "HEROS_DOUBAO_SPEAKER": r'"speaker"\s*:\s*"([^"]+)"',
    "HEROS_DOUBAO_BOT_NAME": r'"bot_name"\s*:\s*"([^"]+)"',
    "HEROS_DOUBAO_SYSTEM_ROLE": r'"system_role"\s*:\s*"([^"]+)"',
    "HEROS_DOUBAO_SPEAKING_STYLE": r'"speaking_style"\s*:\s*"([^"]+)"',
}


def extract_values(config_text: str) -> dict[str, str]:
    output: dict[str, str] = {}
    for env_key, pattern in KEY_PATTERNS.items():
        match = re.search(pattern, config_text)
        if match:
            output[env_key] = match.group(1)
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract Doubao config.py into .env.local format.")
    parser.add_argument(
        "--input",
        default="/Users/binbzha/Workspace/github/doubao_s2s/config.py",
        help="Path to doubao_s2s config.py",
    )
    parser.add_argument(
        "--output",
        default=".env.local",
        help="Output .env file path",
    )
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    values = extract_values(input_path.read_text(encoding="utf-8"))
    lines = [
        "# Auto-generated from doubao_s2s/config.py",
        "# Do not commit this file.",
        "",
    ]
    for key in KEY_PATTERNS:
        lines.append(f'{key}="{values.get(key, "")}"')
    lines.append('HEROS_DOUBAO_GREETING="你好，我是 HerOS，很高兴见到你。"')
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {output_path}")


if __name__ == "__main__":
    main()

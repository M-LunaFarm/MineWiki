import argparse
import os
import sys

import requests


def main():
    parser = argparse.ArgumentParser(description="Upload a file to Creeper CDN")
    parser.add_argument("--api-key", required=True, help="UPLOAD_API_KEY")
    parser.add_argument("--file", required=True, help="Path to file")
    parser.add_argument("--namespace", default="default", help="Namespace")
    parser.add_argument("--version", default=None, help="Version (optional)")
    parser.add_argument("--base-url", default="http://localhost:9000", help="CDN base URL")
    args = parser.parse_args()

    file_path = args.file
    if not os.path.exists(file_path):
        print(f"File not found: {file_path}", file=sys.stderr)
        sys.exit(1)

    url = args.base_url.rstrip("/") + "/api/upload"
    data = {"namespace": args.namespace}
    if args.version:
        data["version"] = args.version

    with open(file_path, "rb") as handle:
        files = {"file": (os.path.basename(file_path), handle)}
        response = requests.post(url, headers={"X-API-Key": args.api_key}, data=data, files=files)

    print(response.status_code)
    print(response.text)


if __name__ == "__main__":
    main()
